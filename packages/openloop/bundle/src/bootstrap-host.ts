import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type { RuntimeBootstrap } from '@openloop/runtime-bootstrap'
import type {} from '@openloop/runtime-bootstrap'

export const OPENLOOP_BOOTSTRAP_PATH = '/api/openloop/bootstrap'
const BOOTSTRAP_COOKIE_NAME = 'openloop_bootstrap'
const MAX_REQUEST_BYTES = 8 * 1024
const TOKEN_PATTERN = /^[0-9a-f]+$/u
const SHA256_PATTERN = /^[0-9a-f]{64}$/u

export interface BootstrapHostRoute {
  readonly path: string
  readonly request: IncomingMessage
  readonly response: ServerResponse
  readonly handler: (request: IncomingMessage, response: ServerResponse) => void | Promise<void>
}

interface BootstrapRequest {
  readonly launchId: string
  readonly token: string
}

interface BootstrapResponse {
  readonly launchId: string
  readonly coreManifest: Readonly<Record<string, unknown>>
  readonly coreManifestSha256: string
}

interface BootstrapWebServer {
  register(route: {
    readonly kind: 'exact'
    readonly path: string
    readonly handler: BootstrapHostRoute['handler']
  }): () => void
  tapIndex(transform: (html: string) => string): () => void
}

interface BootstrapHostContext extends Context {
  readonly webServer: BootstrapWebServer
  readonly runtimeBootstrap: RuntimeBootstrap
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    readonly runtimeBootstrap: RuntimeBootstrap
  }
}

export const inject = ['webServer', 'runtimeBootstrap']

function responseJson(
  response: ServerResponse,
  status: number,
  body: object,
  headers: Record<string, string | string[]> = {},
): void {
  response.writeHead(status, {
    'cache-control': 'no-store',
    'content-type': 'application/json; charset=utf-8',
    'referrer-policy': 'no-referrer',
    ...headers,
  })
  response.end(JSON.stringify(body))
}

async function readBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    total += bytes.length
    if (total > MAX_REQUEST_BYTES) throw new Error('bootstrap request is oversized')
    chunks.push(bytes)
  }
  return Buffer.concat(chunks, total)
}

function parseRequest(value: unknown): BootstrapRequest {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('bootstrap request must be an object')
  }
  const record = value as Record<string, unknown>
  if (Object.keys(record).length !== 2
    || typeof record.launchId !== 'string'
    || typeof record.token !== 'string'
    || record.launchId.length === 0
    || !TOKEN_PATTERN.test(record.token)
    || record.token.length % 2 !== 0) {
    throw new Error('bootstrap request fields are invalid')
  }
  return { launchId: record.launchId, token: record.token.toLowerCase() }
}

function cookieValue(request: IncomingMessage): string | undefined {
  const cookie = request.headers.cookie
  if (typeof cookie !== 'string') return undefined
  for (const part of cookie.split(';')) {
    const [name, ...value] = part.trim().split('=')
    if (name === BOOTSTRAP_COOKIE_NAME) return value.join('=')
  }
  return undefined
}

function bootstrapScript(): string {
  return `<script>(() => {
  const preboot = (async () => {
    const hash = globalThis.location.hash
    let response
    let expectedLaunchId
    if (hash.startsWith('#')) {
      const params = new URLSearchParams(hash.slice(1))
      const token = params.get('bootstrap')
      const launchId = params.get('launch')
      if (token !== null || launchId !== null) {
        if (token === null || launchId === null || token.length === 0 || launchId.length === 0) {
          throw new Error('Openloop bootstrap fragment is incomplete')
        }
        expectedLaunchId = launchId
        globalThis.history.replaceState(null, '', globalThis.location.pathname + globalThis.location.search)
        response = await fetch('${OPENLOOP_BOOTSTRAP_PATH}', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          credentials: 'same-origin',
          cache: 'no-store',
          body: JSON.stringify({ launchId, token }),
        })
      }
    }
    if (response === undefined) {
      response = await fetch('${OPENLOOP_BOOTSTRAP_PATH}', {
        method: 'GET',
        credentials: 'same-origin',
        cache: 'no-store',
      })
    }
    if (!response.ok) throw new Error('Openloop bootstrap exchange failed')
    const value = await response.json()
    if (value === null || typeof value !== 'object'
      || value.coreManifest === null
      || typeof value.coreManifest !== 'object'
      || Array.isArray(value.coreManifest)
      || typeof value.launchId !== 'string'
      || (expectedLaunchId !== undefined && value.launchId !== expectedLaunchId)
      || typeof value.coreManifestSha256 !== 'string'
      || !/^[0-9a-f]{64}$/.test(value.coreManifestSha256)) {
      throw new Error('Openloop bootstrap response is invalid')
    }
    Object.defineProperty(globalThis, '__OPENLOOP_BOOTSTRAP__', {
      value: Object.freeze(value),
      configurable: false,
      enumerable: false,
      writable: false,
    })
    document.documentElement.dataset.openloopBootstrap = 'ready'
  })()
  globalThis.__DSH_PREBOOT__ = preboot
})()</script>`
}

function injectBootstrapScript(html: string): string {
  const script = bootstrapScript()
  const head = html.indexOf('<head>')
  if (head !== -1) return `${html.slice(0, head + 6)}${script}${html.slice(head + 6)}`
  return `${script}${html}`
}

async function handleBootstrap(
  request: IncomingMessage,
  response: ServerResponse,
  runtime: RuntimeBootstrap,
): Promise<void> {
  if (request.method === 'GET') {
    const session = cookieValue(request)
    if (session === undefined || !runtime.validateBootstrapSession(session)) {
      responseJson(response, 401, { error: 'bootstrap session is not current' })
      return
    }
    const manifest = runtime.coreManifest()
    const sha256 = runtime.coreManifestSha256()
    if (manifest === undefined || sha256 === undefined || !SHA256_PATTERN.test(sha256)) {
      responseJson(response, 503, { error: 'Openloop build identity is unavailable' })
      return
    }
    responseJson(response, 200, {
      launchId: runtime.launchId(),
      coreManifest: manifest,
      coreManifestSha256: sha256,
    })
    return
  }
  if (request.method !== 'POST' || request.headers['content-type']?.split(';', 1)[0]?.trim() !== 'application/json') {
    responseJson(response, 405, { error: 'method not allowed' })
    return
  }
  let parsed: BootstrapRequest
  try {
    parsed = parseRequest(JSON.parse((await readBody(request)).toString('utf8')) as unknown)
  } catch {
    responseJson(response, 400, { error: 'invalid bootstrap request' })
    return
  }
  if (parsed.launchId !== runtime.launchId()) {
    responseJson(response, 401, { error: 'bootstrap launch is not current' })
    return
  }
  const manifest = runtime.coreManifest()
  const sha256 = runtime.coreManifestSha256()
  if (manifest === undefined || sha256 === undefined || !SHA256_PATTERN.test(sha256)) {
    responseJson(response, 503, { error: 'Openloop build identity is unavailable' })
    return
  }
  const tokenResult = runtime.consumeBootstrapTokenIfMatches(Buffer.from(parsed.token, 'hex'))
  if (tokenResult !== 'consumed') {
    responseJson(
      response,
      tokenResult === 'expired' ? 410 : 401,
      { error: tokenResult === 'expired' ? 'bootstrap token is expired' : 'bootstrap token is invalid' },
    )
    return
  }
  const session = runtime.issueBootstrapSession()
  if (session.length !== 64) {
    responseJson(response, 503, { error: 'Openloop bootstrap session is unavailable' })
    return
  }
  const body: BootstrapResponse = {
    launchId: parsed.launchId,
    coreManifest: manifest,
    coreManifestSha256: sha256,
  }
  responseJson(response, 200, body, {
    'set-cookie': `${BOOTSTRAP_COOKIE_NAME}=${session}; Path=/; HttpOnly; SameSite=Strict`,
  })
}

export function apply(ctx: Context): void {
  const bootstrapCtx = ctx as BootstrapHostContext
  const route = {
    kind: 'exact',
    path: OPENLOOP_BOOTSTRAP_PATH,
    handler: (request: IncomingMessage, response: ServerResponse) =>
      handleBootstrap(request, response, bootstrapCtx.runtimeBootstrap),
  } as const
  bootstrapCtx.effect(
    () => bootstrapCtx.webServer.register(route),
    'openloop-bootstrap: route',
  )
  bootstrapCtx.effect(
    () => bootstrapCtx.webServer.tapIndex(injectBootstrapScript),
    'openloop-bootstrap: pre-plugin script',
  )
}
