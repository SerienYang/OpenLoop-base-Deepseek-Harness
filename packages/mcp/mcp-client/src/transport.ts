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
const CREDENTIAL_JSON_RPC_ERROR_MESSAGE = 'mcp-client: credential-backed JSON-RPC request failed'

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
    if (input instanceof Request) {
      for (const [name, value] of input.headers) headers.set(name, value)
    }
    for (const [name, value] of new Headers(init?.headers)) headers.set(name, value)
    const signal = init?.signal
      ?? (input instanceof Request ? input.signal : undefined)
    const resolvedByReference = new Map<CredentialRef, Promise<ResolvedCredential | undefined>>()
    for (const [name, source] of Object.entries(options.credentialHeaders)) {
      const ref = safeCredentialRef(source.ref)
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
      headers.set(name, `${source.prefix ?? ''}${value}`)
    }
    const response = await dispatch(input, { ...init, headers, redirect: 'manual' })
    if (!response.ok) {
      await discardResponseBody(response)
      if (REDIRECT_STATUSES.has(response.status)) {
        throw new Error(`mcp-client: credential-backed request redirect was blocked (status ${response.status})`)
      }
      return new Response(null, { status: response.status })
    }
    return sanitizeJsonRpcResponse(response)
  }
}

async function sanitizeJsonRpcResponse(response: Response): Promise<Response> {
  const contentType = response.headers.get('content-type')
    ?.split(';', 1)[0]
    ?.trim()
    .toLowerCase()
  if (contentType !== 'application/json') return response

  let payload: unknown
  try {
    payload = await readBoundedJson(response.clone())
  } catch {
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

async function readBoundedJson(response: Response): Promise<unknown> {
  const reader = response.body?.getReader()
  if (reader === undefined) throw new Error('response body is missing')
  const chunks: Uint8Array[] = []
  let bytes: Uint8Array | undefined
  let length = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
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
    reader.releaseLock()
    bytes?.fill(0)
    for (const chunk of chunks) chunk.fill(0)
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

function missingCredentialResolver(reference: CredentialRef): Promise<undefined> {
  void reference
  return Promise.resolve(undefined)
}
