/**
 * Transport factory: creates the appropriate MCP transport based on the
 * plugin's resolved config. Stdio spawns a child process (with credential
 * scrubbing); Streamable HTTP connects to a URL.
 *
 * @module
 */

import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { scrubbedParentEnv } from '@deepseek-ai/dsh-subprocess'
import type { CredentialRef, ResolvedCredential } from '@deepseek-ai/dsh-credentials'
import type { Config, CredentialHeaderConfig } from './index.ts'
import { safeCredentialRef } from './credential-ref.ts'

const HEADER_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/u
const HEADER_VALUE = /^[\x21-\x7e]+$/u
const HEADER_PREFIX = /^[\x20-\x7e]*$/u
const RESERVED_MCP_HEADERS = new Set([
  'accept',
  'content-type',
  'last-event-id',
  'mcp-protocol-version',
  'mcp-session-id',
])
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])
/** Maximum JSON body cloned for credential-safe JSON-RPC error inspection. */
const MAX_CREDENTIAL_JSON_RESPONSE_BYTES = 1024 * 1024
/** Bounds retained bytes while one credential-backed SSE event is inspected. */
const MAX_CREDENTIAL_SSE_EVENT_BYTES = 1024 * 1024
const MAX_CREDENTIAL_SSE_LINE_BYTES = 256 * 1024
const CREDENTIAL_JSON_RPC_ERROR_MESSAGE = 'mcp-client: credential-backed JSON-RPC request failed'
const CREDENTIAL_SSE_FAILURE_MESSAGE = 'mcp-client: credential-backed SSE response was rejected'
const LF = 0x0a
const CR = 0x0d
const SPACE = 0x20
const UTF8_BOM = [0xef, 0xbb, 0xbf] as const
const DATA_FIELD = new TextEncoder().encode('data')
const SAFE_SSE_ERROR_PREFIX = new TextEncoder().encode('event: message\ndata: ')
const SSE_EVENT_END = new TextEncoder().encode('\n\n')

/** Resolve one credential reference for the current HTTP request. */
export type CredentialResolver =
  (reference: CredentialRef) => Promise<ResolvedCredential | undefined>

/** Inputs for a fetch wrapper that injects credential-backed headers. */
export interface CredentialResolvingFetchOptions {
  readonly headers: Readonly<Record<string, string>>
  readonly credentialHeaders: Readonly<Record<string, CredentialHeaderConfig>>
  readonly resolve: CredentialResolver
  readonly fetch?: typeof globalThis.fetch
}

/**
 * The subprocess seam's scrubbed parent env (credential-shaped and stale
 * `DSH_*` names dropped), plus the spec's explicit env. The MCP SDK owns the
 * actual spawn, so this transport shares the scrub definition rather than the
 * spawn path.
 */
function buildChildEnv(extra: Record<string, string>): Record<string, string> {
  return { ...scrubbedParentEnv(), ...extra }
}

/**
 * Create an MCP transport from the resolved plugin config.
 *
 * @param config - Resolved plugin config discriminated on `transport`.
 * @param resolveCredential - Optional resolver used by credential-backed HTTP headers.
 * @returns A connected-ready MCP Transport (stdio or Streamable HTTP).
 */
export function createTransport(
  config: Config,
  resolveCredential?: CredentialResolver,
): Transport {
  switch (config.transport) {
    case 'stdio':
      return new StdioClientTransport({
        command: config.command,
        args: config.args,
        env: buildChildEnv(config.env),
        cwd: config.cwd,
      })
    case 'streamable-http':
      validateCredentialHeaders(config.headers, config.credentialHeaders ?? {})
      // The MCP SDK's StreamableHTTPClientTransport has optional callback
      // properties typed without `| undefined` (exactOptionalPropertyTypes
      // mismatch with the Transport interface); the SDK constructed the
      // object, so the cast records only that widening.
      return new StreamableHTTPClientTransport(
        new URL(config.url),
        {
          requestInit: { headers: config.headers },
          ...Object.keys(config.credentialHeaders ?? {}).length === 0
            ? {}
            : {
              fetch: createCredentialResolvingFetch({
                headers: config.headers,
                credentialHeaders: config.credentialHeaders ?? {},
                resolve: resolveCredential ?? missingCredentialResolver,
              }),
            },
        },
      ) as Transport
  }
}

/**
 * Validate credential-backed header declarations without reading a secret.
 * @param literalHeaders - Existing literal request headers.
 * @param credentialHeaders - Header-to-reference declarations.
 */
export function validateCredentialHeaders(
  literalHeaders: Readonly<Record<string, string>>,
  credentialHeaders: Readonly<Record<string, CredentialHeaderConfig>>,
): void {
  const literalNames = new Set(Object.keys(literalHeaders).map(name => name.toLowerCase()))
  const credentialNames = new Set<string>()
  for (const [name, source] of Object.entries(credentialHeaders)) {
    const folded = name.toLowerCase()
    if (!HEADER_NAME.test(name)) {
      throw new TypeError(`mcp-client: ${JSON.stringify(name)} is an invalid HTTP header name`)
    }
    if (RESERVED_MCP_HEADERS.has(folded)) {
      throw new TypeError(`mcp-client: ${JSON.stringify(name)} is a reserved MCP header`)
    }
    if (literalNames.has(folded)) {
      throw new TypeError(`mcp-client: credential header ${JSON.stringify(name)} duplicates a literal header`)
    }
    if (credentialNames.has(folded)) {
      throw new TypeError(`mcp-client: credential header ${JSON.stringify(name)} is duplicated`)
    }
    credentialNames.add(folded)
    safeCredentialRef(source.ref)
    if (source.prefix !== undefined && !HEADER_PREFIX.test(source.prefix)) {
      throw new TypeError(`mcp-client: credential header ${JSON.stringify(name)} has an unsafe prefix`)
    }
  }
}

/**
 * Build a fetch function that resolves every configured secret for every request.
 * @param options - Literal headers, credential declarations, resolver, and optional fetch implementation.
 * @returns Fetch implementation suitable for the MCP SDK.
 */
export function createCredentialResolvingFetch(
  options: CredentialResolvingFetchOptions,
): typeof globalThis.fetch {
  validateCredentialHeaders(options.headers, options.credentialHeaders)
  const dispatch = options.fetch ?? globalThis.fetch
  return async (input, init) => {
    const headers = new Headers(options.headers)
    const sensitiveValues = new Set<string>()
    if (input instanceof Request) {
      for (const [name, value] of input.headers) headers.set(name, value)
    }
    for (const [name, value] of new Headers(init?.headers)) headers.set(name, value)
    const signal = init?.signal
      ?? (input instanceof Request ? input.signal : undefined)
    const resolvedByReference = new Map<CredentialRef, Promise<ResolvedCredential | undefined>>()
    for (const [name, source] of Object.entries(options.credentialHeaders)) {
      const ref = safeCredentialRef(source.ref)
      sensitiveValues.add(ref)
      let pending = resolvedByReference.get(ref)
      if (pending === undefined) {
        pending = resolveCredentialForRequest(options.resolve, ref, signal)
        resolvedByReference.set(ref, pending)
      }
      const resolved = await pending
      if (resolved === undefined || resolved.value.length === 0) {
        throw new Error('mcp-client: configured credential is not available')
      }
      const value = resolved.value.trim()
      if (!HEADER_VALUE.test(value)) {
        throw new Error('mcp-client: configured credential has an unsafe HTTP header value')
      }
      const headerValue = `${source.prefix ?? ''}${value}`
      sensitiveValues.add(resolved.value)
      sensitiveValues.add(value)
      sensitiveValues.add(headerValue)
      headers.set(name, headerValue)
    }
    const response = await dispatch(input, { ...init, headers, redirect: 'manual' })
    if (!response.ok) {
      await discardResponseBody(response)
      if (REDIRECT_STATUSES.has(response.status)) {
        throw new Error(`mcp-client: credential-backed request redirect was blocked (status ${response.status})`)
      }
      return new Response(null, { status: response.status })
    }
    return sanitizeJsonRpcResponse(response, sensitiveValues, signal)
  }
}

async function sanitizeJsonRpcResponse(
  response: Response,
  sensitiveValues: ReadonlySet<string>,
  signal: AbortSignal | null | undefined,
): Promise<Response> {
  const contentType = response.headers.get('content-type')
    ?.toLowerCase()
  // Match the pinned SDK's SSE-before-JSON substring classification.
  if (contentType?.includes('text/event-stream')) {
    return sanitizeSseResponse(response, sensitiveValues)
  }
  if (!contentType?.includes('application/json')) return response

  let payload: unknown
  try {
    payload = await readBoundedJson(response.clone(), signal)
  } catch (error) {
    if (signal?.aborted === true) {
      void discardResponseBody(response)
      throw abortReason(signal)
    }
    if (isAbortError(error)) {
      void discardResponseBody(response)
      throw new DOMException('This operation was aborted', 'AbortError')
    }
    await discardResponseBody(response)
    return sanitizedJsonRpcError(null)
  }
  const sanitized = sanitizeJsonRpcErrors(payload)
  if (!sanitized.changed) return response
  await discardResponseBody(response)
  return new Response(JSON.stringify(sanitized.payload), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

function sanitizeSseResponse(
  response: Response,
  sensitiveValues: ReadonlySet<string>,
): Response {
  const body = response.body
  if (body === null) {
    return new Response(failedSseStream(), {
      status: response.status,
      headers: sanitizedSseHeaders(response.headers, sensitiveValues),
    })
  }
  const sanitizer = new CredentialSseSanitizer()
  const transformed = body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      try {
        sanitizer.write(chunk, controller)
      } catch {
        sanitizer.clear()
        throw credentialSseFailure()
      }
    },
    flush(controller) {
      try {
        sanitizer.finish(controller)
      } catch {
        sanitizer.clear()
        throw credentialSseFailure()
      }
    },
  }))
  return new Response(containSseStreamFailures(transformed), {
    status: response.status,
    headers: sanitizedSseHeaders(response.headers, sensitiveValues),
  })
}

function sanitizedSseHeaders(
  source: Headers,
  sensitiveValues: ReadonlySet<string>,
): Headers {
  const headers = new Headers()
  for (const [name, value] of source) {
    if (name.toLowerCase() === 'authorization') continue
    if ([...sensitiveValues].some(secret => secret.length > 0 && value.includes(secret))) continue
    headers.append(name, value)
  }
  headers.set('content-type', 'text/event-stream')
  return headers
}

function containSseStreamFailures(source: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
  const reader = source.getReader()
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read()
        if (done) {
          reader.releaseLock()
          controller.close()
        } else {
          controller.enqueue(value)
        }
      } catch {
        try { reader.releaseLock() } catch { /* the stream may still be settling */ }
        controller.error(credentialSseFailure())
      }
    },
    async cancel() {
      try {
        await reader.cancel()
      } catch {
        // Upstream cancellation diagnostics are server-controlled.
      } finally {
        releaseResponseReader(reader)
      }
    },
  })
}

function failedSseStream(): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.error(credentialSseFailure())
    },
  })
}

function credentialSseFailure(): Error {
  return new Error(CREDENTIAL_SSE_FAILURE_MESSAGE)
}

interface DataRange {
  readonly start: number
  readonly end: number
}

class CredentialSseSanitizer {
  readonly #event = new Uint8Array(MAX_CREDENTIAL_SSE_EVENT_BYTES)
  readonly #dataRanges: DataRange[] = []
  #eventLength = 0
  #lineStart = 0
  #pendingCr = false
  #pendingLineEnd = 0
  #streamStart = true

  write(chunk: Uint8Array, controller: TransformStreamDefaultController<Uint8Array>): void {
    for (const byte of chunk) this.#writeByte(byte, controller)
  }

  finish(controller: TransformStreamDefaultController<Uint8Array>): void {
    // eventsource-parser does not consume an unterminated final line. Preserve
    // the bounded tail exactly so successful streams keep the same semantics.
    if (this.#eventLength > 0) controller.enqueue(this.#copyEvent())
    this.clear()
  }

  clear(): void {
    this.#event.fill(0, 0, this.#eventLength)
    this.#eventLength = 0
    this.#lineStart = 0
    this.#pendingCr = false
    this.#pendingLineEnd = 0
    this.#dataRanges.length = 0
  }

  #writeByte(byte: number, controller: TransformStreamDefaultController<Uint8Array>): void {
    if (this.#pendingCr) {
      this.#pendingCr = false
      if (byte === LF) {
        this.#append(byte)
        this.#finishLine(this.#pendingLineEnd, controller)
        return
      }
      this.#finishLine(this.#pendingLineEnd, controller)
    }

    if (byte === CR) {
      this.#pendingLineEnd = this.#eventLength
      this.#append(byte)
      this.#pendingCr = true
      return
    }
    if (byte === LF) {
      const lineEnd = this.#eventLength
      this.#append(byte)
      this.#finishLine(lineEnd, controller)
      return
    }
    this.#append(byte)
    if (this.#eventLength - this.#lineStart > MAX_CREDENTIAL_SSE_LINE_BYTES) {
      throw credentialSseFailure()
    }
  }

  #append(byte: number): void {
    if (this.#eventLength >= MAX_CREDENTIAL_SSE_EVENT_BYTES) {
      throw credentialSseFailure()
    }
    this.#event[this.#eventLength++] = byte
  }

  #finishLine(lineEnd: number, controller: TransformStreamDefaultController<Uint8Array>): void {
    const streamStart = this.#streamStart
    this.#streamStart = false
    if (lineEnd === this.#lineStart) {
      this.#emitEvent(controller)
      return
    }
    const value = this.#dataValueRange(this.#lineStart, lineEnd, streamStart)
    if (value !== undefined) this.#dataRanges.push(value)
    this.#lineStart = this.#eventLength
  }

  #dataValueRange(start: number, end: number, streamStart: boolean): DataRange | undefined {
    if (streamStart
      && end - start >= UTF8_BOM.length
      && UTF8_BOM.every((byte, index) => this.#event[start + index] === byte)) {
      start += UTF8_BOM.length
    }
    const fieldLength = DATA_FIELD.byteLength
    if (end - start < fieldLength) return undefined
    for (let index = 0; index < fieldLength; index += 1) {
      if (this.#event[start + index] !== DATA_FIELD[index]) return undefined
    }
    const separator = this.#event[start + fieldLength]
    if (separator !== undefined && separator !== 0x3a) return undefined
    let valueStart = start + fieldLength
    if (separator === 0x3a) valueStart += 1
    if (this.#event[valueStart] === SPACE) valueStart += 1
    return { start: valueStart, end }
  }

  #emitEvent(controller: TransformStreamDefaultController<Uint8Array>): void {
    const event = this.#copyEvent()
    if (this.#dataRanges.length === 0) {
      controller.enqueue(event)
      this.clear()
      return
    }

    const dataLength = this.#dataRanges.reduce(
      (total, range) => total + range.end - range.start,
      Math.max(0, this.#dataRanges.length - 1),
    )
    const data = new Uint8Array(dataLength)
    let offset = 0
    for (const [index, range] of this.#dataRanges.entries()) {
      if (index > 0) data[offset++] = LF
      const part = this.#event.subarray(range.start, range.end)
      data.set(part, offset)
      offset += part.byteLength
    }

    let payload: unknown
    try {
      payload = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(data)) as unknown
    } finally {
      data.fill(0)
    }
    const sanitized = sanitizeJsonRpcErrors(payload)
    if (!sanitized.changed) {
      controller.enqueue(event)
      this.clear()
      return
    }
    controller.enqueue(sanitizedSseEvent(sanitized.payload))
    this.clear()
  }

  #copyEvent(): Uint8Array {
    return this.#event.slice(0, this.#eventLength)
  }
}

function sanitizedSseEvent(payload: unknown): Uint8Array {
  const data = new TextEncoder().encode(JSON.stringify(payload))
  const event = new Uint8Array(
    SAFE_SSE_ERROR_PREFIX.byteLength + data.byteLength + SSE_EVENT_END.byteLength,
  )
  event.set(SAFE_SSE_ERROR_PREFIX)
  event.set(data, SAFE_SSE_ERROR_PREFIX.byteLength)
  event.set(SSE_EVENT_END, SAFE_SSE_ERROR_PREFIX.byteLength + data.byteLength)
  data.fill(0)
  return event
}

async function readBoundedJson(
  response: Response,
  signal: AbortSignal | null | undefined,
): Promise<unknown> {
  const reader = response.body?.getReader()
  if (reader === undefined) throw new Error('response body is missing')
  const chunks: Uint8Array[] = []
  let bytes: Uint8Array | undefined
  let length = 0
  try {
    while (true) {
      const { done, value } = await readResponseChunk(reader, signal)
      if (done) break
      length += value.byteLength
      if (length > MAX_CREDENTIAL_JSON_RESPONSE_BYTES) {
        void reader.cancel().catch(() => {
          // The caller cancels the original tee branch; ignore server errors
          // while this clone branch settles.
        })
        throw new Error('response body exceeds the credential JSON inspection limit')
      }
      chunks.push(value.slice())
    }
    bytes = new Uint8Array(length)
    let offset = 0
    for (const chunk of chunks) {
      bytes.set(chunk, offset)
      offset += chunk.byteLength
    }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown
  } finally {
    releaseResponseReader(reader)
    bytes?.fill(0)
    for (const chunk of chunks) chunk.fill(0)
  }
}

function readResponseChunk(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal: AbortSignal | null | undefined,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  if (signal === undefined || signal === null) return reader.read()
  if (signal.aborted) {
    void reader.cancel().catch(() => {})
    return Promise.reject(abortReason(signal))
  }
  return new Promise((resolve, reject) => {
    let settled = false
    const onAbort = (): void => {
      if (settled) return
      settled = true
      signal.removeEventListener('abort', onAbort)
      reject(abortReason(signal))
      void reader.cancel().catch(() => {})
    }
    signal.addEventListener('abort', onAbort, { once: true })
    reader.read().then(
      (value) => {
        if (settled) return
        settled = true
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      },
      (error: unknown) => {
        if (settled) return
        settled = true
        signal.removeEventListener('abort', onAbort)
        reject(error instanceof Error
          ? error
          : new Error('mcp-client: credential-backed response body read failed'))
      },
    )
  })
}

function releaseResponseReader(reader: ReadableStreamDefaultReader<Uint8Array>): void {
  try {
    reader.releaseLock()
  } catch {
    void reader.closed.then(
      () => {
        try { reader.releaseLock() } catch { /* already released */ }
      },
      () => {
        try { reader.releaseLock() } catch { /* already released */ }
      },
    )
  }
}

type JsonRpcSanitization =
  | { readonly changed: false }
  | { readonly changed: true; readonly payload: unknown }

function sanitizeJsonRpcErrors(payload: unknown): JsonRpcSanitization {
  if (Array.isArray(payload)) {
    let changed = false
    const messages: unknown[] = []
    for (const message of payload as unknown[]) {
      const sanitized = sanitizeJsonRpcError(message)
      if (sanitized !== undefined) changed = true
      messages.push(sanitized ?? message)
    }
    return changed ? { changed: true, payload: messages } : { changed: false }
  }
  const sanitized = sanitizeJsonRpcError(payload)
  return sanitized === undefined
    ? { changed: false }
    : { changed: true, payload: sanitized }
}

function sanitizeJsonRpcError(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'object'
    || value === null
    || Array.isArray(value)
    || (value as Record<string, unknown>)['jsonrpc'] !== '2.0'
    || !Object.hasOwn(value, 'error')) {
    return undefined
  }
  const id = (value as Record<string, unknown>)['id']
  return {
    jsonrpc: '2.0',
    id: typeof id === 'number' && Number.isSafeInteger(id) ? id : null,
    error: {
      code: -32_000,
      message: CREDENTIAL_JSON_RPC_ERROR_MESSAGE,
    },
  }
}

function sanitizedJsonRpcError(id: number | null): Response {
  return new Response(JSON.stringify({
    jsonrpc: '2.0',
    id,
    error: {
      code: -32_000,
      message: CREDENTIAL_JSON_RPC_ERROR_MESSAGE,
    },
  }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

async function discardResponseBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel()
  } catch {
    // Cleanup diagnostics are server-controlled and may echo credential data.
  }
}

function resolveCredentialForRequest(
  resolve: CredentialResolver,
  reference: CredentialRef,
  signal: AbortSignal | null | undefined,
): Promise<ResolvedCredential | undefined> {
  if (signal?.aborted === true) return Promise.reject(abortReason(signal))
  const resolution = Promise.resolve().then(() => resolve(reference))
  if (signal === undefined || signal === null) return resolution
  return new Promise((resolveRequest, rejectRequest) => {
    let settled = false
    const finish = (
      settle: (value: ResolvedCredential | undefined) => void,
      value: ResolvedCredential | undefined,
    ): void => {
      if (settled) return
      settled = true
      signal.removeEventListener('abort', onAbort)
      settle(value)
    }
    const fail = (error: unknown): void => {
      if (settled) return
      settled = true
      signal.removeEventListener('abort', onAbort)
      rejectRequest(error instanceof Error
        ? error
        : new Error('mcp-client: credential resolution failed'))
    }
    const onAbort = (): void => {
      fail(abortReason(signal))
    }
    signal.addEventListener('abort', onAbort, { once: true })
    resolution.then(
      (value) => { finish(resolveRequest, value) },
      (error: unknown) => { fail(error) },
    )
  })
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new DOMException('This operation was aborted', 'AbortError')
}

function isAbortError(error: unknown): boolean {
  return typeof error === 'object'
    && error !== null
    && 'name' in error
    && error.name === 'AbortError'
}

function missingCredentialResolver(reference: CredentialRef): Promise<undefined> {
  void reference
  return Promise.resolve(undefined)
}
