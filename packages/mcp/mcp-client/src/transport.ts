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
import { credentialRef, type CredentialRef, type ResolvedCredential } from '@deepseek-ai/dsh-credentials'
import type { Config, CredentialHeaderConfig } from './index.ts'

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
    const callerHeaders = init?.headers
      ?? (input instanceof Request ? input.headers : undefined)
    for (const [name, value] of new Headers(callerHeaders)) headers.set(name, value)
    for (const [name, source] of Object.entries(options.credentialHeaders)) {
      const ref = safeCredentialRef(source.ref)
      const resolved = await options.resolve(ref)
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
    if (REDIRECT_STATUSES.has(response.status)) {
      await response.body?.cancel().catch(() => {})
      throw new Error('mcp-client: credential-backed request redirect was blocked')
    }
    return response
  }
}

function safeCredentialRef(reference: string): CredentialRef {
  try {
    return credentialRef(reference)
  } catch {
    throw new TypeError('mcp-client: invalid credential reference')
  }
}

function missingCredentialResolver(reference: CredentialRef): Promise<undefined> {
  void reference
  return Promise.resolve(undefined)
}
