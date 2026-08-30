import type { IncomingMessage, ServerResponse } from 'node:http'
import { symbols, type Context } from '@deepseek-ai/cordis'
import type { RuntimeBootstrap } from '@openloop/runtime-bootstrap'
import type {} from '@openloop/runtime-bootstrap'

export const OPENLOOP_BOOTSTRAP_PATH = '/api/openloop/bootstrap'
const BOOTSTRAP_COOKIE_NAME = 'openloop_bootstrap'
const MAX_REQUEST_BYTES = 8 * 1024
const TOKEN_PATTERN = /^[0-9a-f]+$/u
const SHA256_PATTERN = /^[0-9a-f]{64}$/u
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
const CREDENTIAL_REFERENCE_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/u

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

interface BootstrapCompletionRequest {
  readonly launchId: string
  readonly coreManifestSha256: string
  readonly openloopDataVersion: number
  readonly dshDataVersion: number
}

interface BootstrapWebServer {
  register(route: {
    readonly kind: 'exact'
    readonly path: string
    readonly handler: BootstrapHostRoute['handler']
  }): () => void
  tapIndex(transform: (html: string) => string): () => void
}

interface BootstrapDesktopBridge {
  getCandidateCredentialHealthPlan(): Promise<unknown>
  acknowledgeMainWebviewHealth(acknowledgement: {
    readonly launchId: string
    readonly coreManifestSha256: string
    readonly openloopDataVersion: number
    readonly dshDataVersion: number
    readonly credentialHealth?: CandidateCredentialHealthProof
  }): Promise<void>
}

interface CandidateCredentialHealthProof {
  readonly migrationTransactionId: string | null
  readonly ready: true
  readonly checkedCount: number
}

interface CandidateCredentialHealthPlan {
  readonly migrationTransactionId: string | null
  readonly references: readonly string[]
}

interface BootstrapHostContext extends Context {
  readonly desktopBridge: BootstrapDesktopBridge
  readonly credentials: {
    describe(reference: string): Promise<{
      readonly configured: boolean
      readonly source?: string
    }>
  }
  readonly webServer: BootstrapWebServer
  readonly runtimeBootstrap: RuntimeBootstrap
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    readonly runtimeBootstrap: RuntimeBootstrap
  }
}

export const inject = ['desktopBridge', 'webServer', 'runtimeBootstrap', 'credentials']

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
    const value: unknown = chunk
    if (typeof value !== 'string' && !(value instanceof Uint8Array)) {
      throw new TypeError('bootstrap request body contains an invalid chunk')
    }
    const bytes = Buffer.from(value)
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

function parseCompletionRequest(value: unknown): BootstrapCompletionRequest {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('bootstrap completion must be an object')
  }
  const record = value as Record<string, unknown>
  if (Object.keys(record).length !== 4
    || typeof record.launchId !== 'string'
    || record.launchId.length === 0
    || typeof record.coreManifestSha256 !== 'string'
    || !SHA256_PATTERN.test(record.coreManifestSha256)
    || !Number.isSafeInteger(record.openloopDataVersion)
    || (record.openloopDataVersion as number) < 0
    || !Number.isSafeInteger(record.dshDataVersion)
    || (record.dshDataVersion as number) < 0) {
    throw new Error('bootstrap completion fields are invalid')
  }
  return {
    launchId: record.launchId,
    coreManifestSha256: record.coreManifestSha256,
    openloopDataVersion: record.openloopDataVersion as number,
    dshDataVersion: record.dshDataVersion as number,
  }
}

function parseCandidateCredentialHealthPlan(value: unknown): CandidateCredentialHealthPlan {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('candidate credential health plan must be an object')
  }
  const record = value as Record<string, unknown>
  const transactionId = record.migrationTransactionId
  const references = record.references
  if (Object.keys(record).length !== 2
    || (transactionId !== null
      && (typeof transactionId !== 'string' || !UUID_PATTERN.test(transactionId)))
    || !Array.isArray(references)
    || references.some((reference: unknown) =>
      typeof reference !== 'string' || !CREDENTIAL_REFERENCE_PATTERN.test(reference))
    || new Set(references).size !== references.length
    || (transactionId === null) !== (references.length === 0)) {
    throw new Error('candidate credential health plan is invalid')
  }
  return {
    migrationTransactionId: transactionId,
    references: references as string[],
  }
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
    const brand = value.coreManifest.brand
    const brandFields = [
      'productName',
      'documentSuffix',
      'markAsset',
      'heroTitle',
      'previewLabel',
      'attribution',
    ]
    if (brand === null || typeof brand !== 'object' || Array.isArray(brand)
      || Object.keys(brand).length !== brandFields.length
      || brandFields.some(field => !Object.prototype.hasOwnProperty.call(brand, field))
      || brand.productName !== 'Openloop'
      || brand.documentSuffix !== 'Openloop'
      || typeof brand.markAsset !== 'string'
      || !brand.markAsset.startsWith('data:image/svg+xml;base64,')
      || brand.heroTitle !== 'Openloop'
      || brand.previewLabel !== 'Preview'
      || brand.attribution !== 'Built on DeepSeek Harness') {
      throw new Error('Openloop bootstrap brand identity is invalid')
    }
    Object.freeze(brand)
    Object.freeze(value.coreManifest)
    Object.freeze(value)
    Object.defineProperty(globalThis, '__OPENLOOP_BOOTSTRAP__', {
      value,
      configurable: false,
      enumerable: false,
      writable: false,
    })
    const openloopDataVersion = value.coreManifest.openloopDataVersion
    const dshDataVersion = value.coreManifest.dshDataVersion
    if (!Number.isSafeInteger(openloopDataVersion) || openloopDataVersion < 0
      || !Number.isSafeInteger(dshDataVersion) || dshDataVersion < 0) {
      throw new Error('Openloop bootstrap data identity is invalid')
    }
    const completion = await fetch('${OPENLOOP_BOOTSTRAP_PATH}', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      credentials: 'same-origin',
      cache: 'no-store',
      body: JSON.stringify({
        launchId: value.launchId,
        coreManifestSha256: value.coreManifestSha256,
        openloopDataVersion,
        dshDataVersion,
      }),
    })
    if (!completion.ok) throw new Error('Openloop bootstrap completion failed')
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

async function candidateCredentialHealthProof(
  ctx: BootstrapHostContext,
): Promise<CandidateCredentialHealthProof | undefined> {
  const plan = parseCandidateCredentialHealthPlan(
    await ctx.desktopBridge.getCandidateCredentialHealthPlan(),
  )
  if (plan.migrationTransactionId === null) return undefined
  const injected = ctx.get('credentials')
  if (injected === undefined) {
    throw new Error('candidate credential provider is unavailable')
  }
  const original = Reflect.get(injected, symbols.original) as unknown
  const credentials = typeof original === 'object' && original !== null
    ? original as BootstrapHostContext['credentials']
    : injected
  for (const reference of plan.references) {
    const status = await credentials.describe(reference)
    if (!status.configured || status.source !== 'keychain') {
      throw new Error('candidate credential is not Keychain-backed')
    }
  }
  return {
    migrationTransactionId: plan.migrationTransactionId,
    ready: true,
    checkedCount: plan.references.length,
  }
}

async function handleBootstrap(
  request: IncomingMessage,
  response: ServerResponse,
  runtime: RuntimeBootstrap,
  desktopBridge: BootstrapDesktopBridge,
  ctx: BootstrapHostContext,
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
  if (request.method === 'PUT') {
    const session = cookieValue(request)
    if (session === undefined || !runtime.validateBootstrapSession(session)) {
      responseJson(response, 401, { error: 'bootstrap session is not current' })
      return
    }
    if (request.headers['content-type']?.split(';', 1)[0]?.trim() !== 'application/json') {
      responseJson(response, 405, { error: 'method not allowed' })
      return
    }
    let completion: BootstrapCompletionRequest
    try {
      completion = parseCompletionRequest(
        JSON.parse((await readBody(request)).toString('utf8')) as unknown,
      )
    } catch {
      responseJson(response, 400, { error: 'invalid bootstrap completion' })
      return
    }
    const manifest = runtime.coreManifest()
    const sha256 = runtime.coreManifestSha256()
    if (manifest === undefined || sha256 === undefined || !SHA256_PATTERN.test(sha256)) {
      responseJson(response, 503, { error: 'Openloop build identity is unavailable' })
      return
    }
    if (completion.launchId !== runtime.launchId()
      || completion.coreManifestSha256 !== sha256
      || completion.openloopDataVersion !== manifest.openloopDataVersion
      || completion.dshDataVersion !== manifest.dshDataVersion) {
      responseJson(response, 401, { error: 'bootstrap completion identity is not current' })
      return
    }
    let credentialHealth: CandidateCredentialHealthProof | undefined
    try {
      credentialHealth = await candidateCredentialHealthProof(ctx)
    } catch {
      responseJson(response, 503, { error: 'Openloop candidate credential health failed' })
      return
    }
    const claim = runtime.claimBootstrapCompletion(session)
    if (claim !== 'claimed' && claim !== 'local-committed') {
      responseJson(
        response,
        claim === 'completed' ? 410 : claim === 'busy' ? 409 : 401,
        { error: `bootstrap completion is ${claim}` },
      )
      return
    }
    if (claim === 'claimed' && !runtime.commitBootstrapCompletion(session)) {
      runtime.releaseBootstrapCompletion(session)
      responseJson(response, 409, { error: 'bootstrap completion commit failed' })
      return
    }
    try {
      await desktopBridge.acknowledgeMainWebviewHealth({
        ...completion,
        ...(credentialHealth === undefined ? {} : { credentialHealth }),
      })
    } catch {
      runtime.releaseBootstrapCompletion(session)
      responseJson(response, 503, { error: 'Openloop main WebView health was rejected' })
      return
    }
    if (!runtime.markBootstrapCompletionAcknowledged(session)) {
      responseJson(response, 409, { error: 'bootstrap completion acknowledgement failed' })
      return
    }
    responseJson(response, 200, { completed: true })
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
  const tokenResult = runtime.claimBootstrapTokenIfMatches(Buffer.from(parsed.token, 'hex'))
  if (tokenResult.status !== 'claimed') {
    responseJson(
      response,
      tokenResult.status === 'expired' ? 410 : 401,
      { error: tokenResult.status === 'expired' ? 'bootstrap token is expired' : 'bootstrap token is invalid' },
    )
    return
  }
  const session = runtime.issueBootstrapSession(tokenResult.claimId)
  if (session === undefined || session.length !== 64) {
    responseJson(response, 503, { error: 'Openloop bootstrap session is unavailable' })
    return
  }
  const openloopDataVersion = manifest.openloopDataVersion
  const dshDataVersion = manifest.dshDataVersion
  if (!Number.isSafeInteger(openloopDataVersion)
    || (openloopDataVersion as number) < 0
    || !Number.isSafeInteger(dshDataVersion)
    || (dshDataVersion as number) < 0) {
    responseJson(response, 503, { error: 'Openloop data identity is unavailable' })
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
      handleBootstrap(
        request,
        response,
        bootstrapCtx.runtimeBootstrap,
        bootstrapCtx.desktopBridge,
        bootstrapCtx,
      ),
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
