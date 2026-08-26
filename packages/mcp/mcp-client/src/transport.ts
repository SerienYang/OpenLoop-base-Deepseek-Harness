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
const CREDENTIAL_TOOL_ERROR_MESSAGE = 'mcp-client: credential-backed tool request failed'
const CREDENTIAL_SSE_FAILURE_MESSAGE = 'mcp-client: credential-backed SSE response was rejected'
const CREDENTIAL_CONTENT_TYPE_FAILURE_MESSAGE = 'mcp-client: credential-backed response content type was rejected'
const REDACTED_CREDENTIAL_VALUE = '[REDACTED]'
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
    const responsePolicy = credentialResponsePolicy(input, init)
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
    if (response.status === 202) {
      await discardResponseBody(response)
      return new Response(null, { status: 202 })
    }
    if (responsePolicy.mode === 'discard') {
      await discardResponseBody(response)
      return new Response(null, { status: response.status })
    }
    if (responsePolicy.mode === 'sse') {
      return sanitizeSseResponse(
        response,
        sensitiveValues,
        responsePolicy.requestIds,
      )
    }
    return sanitizeJsonRpcResponse(
      response,
      sensitiveValues,
      responsePolicy.requestIds,
      signal,
    )
  }
}

type CredentialResponseMode = 'classified' | 'discard' | 'sse'
type JsonRpcId = number | string

interface CredentialResponsePolicy {
  readonly mode: CredentialResponseMode
  readonly requestIds?: ReadonlySet<JsonRpcId>
}

function credentialResponsePolicy(
  input: URL | RequestInfo,
  init: RequestInit | undefined,
): CredentialResponsePolicy {
  const rawMethod = init?.method
    ?? (input instanceof Request ? input.method : undefined)
  if (rawMethod === undefined) return { mode: 'classified' }
  const method = rawMethod.toUpperCase()
  if (method === 'GET') return { mode: 'sse' }
  if (method === 'DELETE') return { mode: 'discard' }
  if (method !== 'POST' || typeof init?.body !== 'string') return { mode: 'classified' }

  let payload: unknown
  try {
    payload = JSON.parse(init.body) as unknown
  } catch {
    return { mode: 'classified' }
  }
  const messages = Array.isArray(payload) ? payload : [payload]
  const requestIds = new Set<JsonRpcId>()
  let hasRequest = false
  for (const value of messages) {
    if (typeof value !== 'object' || value === null || !('method' in value) || !('id' in value)) continue
    const id = (value as Record<string, unknown>)['id']
    if (id === undefined) continue
    hasRequest = true
    if (typeof id === 'string' || (typeof id === 'number' && Number.isSafeInteger(id))) {
      requestIds.add(id)
    }
  }
  return hasRequest
    ? { mode: 'classified', requestIds }
    : { mode: 'discard' }
}

async function sanitizeJsonRpcResponse(
  response: Response,
  sensitiveValues: ReadonlySet<string>,
  requestIds: ReadonlySet<JsonRpcId> | undefined,
  signal: AbortSignal | null | undefined,
): Promise<Response> {
  const contentType = response.headers.get('content-type')
  // Match the pinned SDK's case-sensitive, SSE-before-JSON substring classification.
  if (contentType?.includes('text/event-stream')) {
    return sanitizeSseResponse(response, sensitiveValues, requestIds)
  }
  if (!contentType?.includes('application/json')) {
    await discardResponseBody(response)
    throw new Error(CREDENTIAL_CONTENT_TYPE_FAILURE_MESSAGE)
  }

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
    const requestId = soleRequestId(requestIds)
    if (requestId === undefined) {
      throw new Error(CREDENTIAL_CONTENT_TYPE_FAILURE_MESSAGE)
    }
    return sanitizedJsonRpcError(requestId)
  }
  const sanitized = sanitizeJsonRpcFailures(payload, requestIds, sensitiveValues)
  if (!sanitized.changed) {
    return new Response(response.body, {
      status: response.status,
      headers: sanitizedResponseHeaders(
        response.headers,
        sensitiveValues,
        'application/json',
      ),
    })
  }
  await discardResponseBody(response)
  return new Response(JSON.stringify(sanitized.payload), {
    status: response.status,
    headers: sanitizedResponseHeaders(
      response.headers,
      sensitiveValues,
      'application/json',
    ),
  })
}

function sanitizeSseResponse(
  response: Response,
  sensitiveValues: ReadonlySet<string>,
  requestIds?: ReadonlySet<JsonRpcId>,
): Response {
  const body = response.body
  if (body === null) {
    return new Response(failedSseStream(), {
      status: response.status,
      headers: sanitizedResponseHeaders(
        response.headers,
        sensitiveValues,
        'text/event-stream',
      ),
    })
  }
  const sanitizer = new CredentialSseSanitizer(requestIds, sensitiveValues)
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
    headers: sanitizedResponseHeaders(
      response.headers,
      sensitiveValues,
      'text/event-stream',
    ),
  })
}

function sanitizedResponseHeaders(
  source: Headers,
  sensitiveValues: ReadonlySet<string>,
  contentType: string,
): Headers {
  const headers = new Headers()
  for (const [name, value] of source) {
    if (name.toLowerCase() === 'authorization') continue
    if ([...sensitiveValues].some(secret => secret.length > 0
      && (name.includes(secret.toLowerCase()) || value.includes(secret)))) continue
    headers.append(name, value)
  }
  headers.set('content-type', contentType)
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

  constructor(
    private readonly requestIds: ReadonlySet<JsonRpcId> | undefined,
    private readonly sensitiveValues: ReadonlySet<string>,
  ) {}

  write(chunk: Uint8Array, controller: TransformStreamDefaultController<Uint8Array>): void {
    for (const byte of chunk) this.#writeByte(byte, controller)
  }

  finish(controller: TransformStreamDefaultController<Uint8Array>): void {
    // eventsource-parser does not consume an unterminated final line. Preserve
    // safe tails exactly, but never forward credential material.
    if (this.#eventLength > 0) {
      const tail = this.#copyEvent()
      if (containsSensitiveText(
        new TextDecoder().decode(tail),
        this.sensitiveValues,
      )) {
        tail.fill(0)
      } else {
        controller.enqueue(tail)
      }
    }
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
    const eventContainsSensitiveValue = containsSensitiveText(
      new TextDecoder().decode(event),
      this.sensitiveValues,
    )
    if (this.#dataRanges.length === 0) {
      if (!eventContainsSensitiveValue) controller.enqueue(event)
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
    const sanitized = sanitizeJsonRpcFailures(
      payload,
      this.requestIds,
      this.sensitiveValues,
    )
    if (!sanitized.changed && !eventContainsSensitiveValue) {
      controller.enqueue(event)
      this.clear()
      return
    }
    controller.enqueue(sanitizedSseEvent(
      sanitized.changed ? sanitized.payload : payload,
    ))
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

function sanitizeJsonRpcFailures(
  payload: unknown,
  requestIds: ReadonlySet<JsonRpcId> | undefined,
  sensitiveValues: ReadonlySet<string>,
): JsonRpcSanitization {
  const redacted = redactSensitiveJson(payload, sensitiveValues)
  if (Array.isArray(redacted.value)) {
    let changed = false
    const messages: unknown[] = []
    for (const message of redacted.value) {
      const sanitized = sanitizeJsonRpcFailure(message, requestIds, sensitiveValues)
      if (sanitized !== undefined) changed = true
      messages.push(sanitized ?? message)
    }
    return changed || redacted.changed
      ? { changed: true, payload: messages }
      : { changed: false }
  }
  const sanitized = sanitizeJsonRpcFailure(
    redacted.value,
    requestIds,
    sensitiveValues,
  )
  if (sanitized !== undefined) return { changed: true, payload: sanitized }
  return redacted.changed
    ? { changed: true, payload: redacted.value }
    : { changed: false }
}

interface RedactedJson {
  readonly value: unknown
  readonly changed: boolean
}

function redactSensitiveJson(
  value: unknown,
  sensitiveValues: ReadonlySet<string>,
): RedactedJson {
  if (typeof value === 'string') {
    const redacted = redactSensitiveText(value, sensitiveValues)
    return { value: redacted, changed: redacted !== value }
  }
  if (Array.isArray(value)) {
    const redactedItems = value.map(item => redactSensitiveJson(item, sensitiveValues))
    const changed = redactedItems.some(item => item.changed)
    const items = redactedItems.map(item => item.value)
    return changed ? { value: items, changed: true } : { value, changed: false }
  }
  if (typeof value !== 'object' || value === null) {
    return { value, changed: false }
  }

  const redactedEntries = Object.entries(value).map(([key, entry]) => {
    const redactedKey = redactSensitiveText(key, sensitiveValues)
    const redactedValue = redactSensitiveJson(entry, sensitiveValues)
    return {
      changed: redactedKey !== key || redactedValue.changed,
      entry: [redactedKey, redactedValue.value] as const,
    }
  })
  const changed = redactedEntries.some(entry => entry.changed)
  return changed
    ? { value: Object.fromEntries(redactedEntries.map(entry => entry.entry)), changed: true }
    : { value, changed: false }
}

function redactSensitiveText(
  value: string,
  sensitiveValues: ReadonlySet<string>,
): string {
  let redacted = value
  for (const secret of sensitiveValues) {
    if (secret.length > 0) redacted = redacted.split(secret).join(REDACTED_CREDENTIAL_VALUE)
  }
  return redacted
}

function containsSensitiveText(
  value: string,
  sensitiveValues: ReadonlySet<string>,
): boolean {
  return [...sensitiveValues].some(secret => secret.length > 0 && value.includes(secret))
}

function sanitizeJsonRpcFailure(
  value: unknown,
  requestIds: ReadonlySet<JsonRpcId> | undefined,
  sensitiveValues: ReadonlySet<string>,
): Record<string, unknown> | undefined {
  if (typeof value !== 'object'
    || value === null
    || Array.isArray(value)
    || (value as Record<string, unknown>)['jsonrpc'] !== '2.0') {
    return undefined
  }
  const message = value as Record<string, unknown>
  const id = message['id']
  if (Object.hasOwn(message, 'error')) {
    const safeId = safeJsonRpcResponseId(id, requestIds, sensitiveValues)
    return {
      jsonrpc: '2.0',
      id: safeId,
      error: {
        code: -32_000,
        message: CREDENTIAL_JSON_RPC_ERROR_MESSAGE,
      },
    }
  }
  const result = message['result']
  if (typeof result !== 'object'
    || result === null
    || Array.isArray(result)
    || (result as Record<string, unknown>)['isError'] !== true) {
    return undefined
  }
  const safeId = safeJsonRpcResponseId(id, requestIds, sensitiveValues)
  return {
    jsonrpc: '2.0',
    id: safeId,
    result: {
      content: [{ type: 'text', text: CREDENTIAL_TOOL_ERROR_MESSAGE }],
      isError: true,
    },
  }
}

function safeJsonRpcResponseId(
  id: unknown,
  requestIds: ReadonlySet<JsonRpcId> | undefined,
  sensitiveValues: ReadonlySet<string>,
): JsonRpcId {
  const validId = typeof id === 'string'
    || (typeof id === 'number' && Number.isSafeInteger(id))
  if (requestIds !== undefined) {
    if (validId && requestIds.has(id)) return id
    const requestId = soleRequestId(requestIds)
    if (requestId !== undefined) return requestId
    throw new Error(CREDENTIAL_CONTENT_TYPE_FAILURE_MESSAGE)
  }
  if (!validId
    || (typeof id === 'string'
      && [...sensitiveValues].some(secret => secret.length > 0 && id.includes(secret)))) {
    throw new Error(CREDENTIAL_CONTENT_TYPE_FAILURE_MESSAGE)
  }
  return id
}

function soleRequestId(requestIds: ReadonlySet<JsonRpcId> | undefined): JsonRpcId | undefined {
  if (requestIds?.size !== 1) return undefined
  return requestIds.values().next().value
}

function sanitizedJsonRpcError(id: JsonRpcId): Response {
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
