/** Authenticated, field-scoped Settings routes for the Openloop main WebView. */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type { RuntimeBootstrap } from '@openloop/runtime-bootstrap'
import {
  allowedSettingsNamespaces,
  assertAllowedSettingsMutation,
  isAllowedSettingsReadPath,
  projectAllowedSettingsData,
  projectAllowedSettingsSchema,
  type OpenloopSettingsMutation,
} from './settings-policy.ts'

export const OPENLOOP_SETTINGS_DESCRIBE_PATH = '/api/openloop/settings/describe'
export const OPENLOOP_SETTINGS_MUTATE_PATH = '/api/openloop/settings/mutate'
export const OPENLOOP_SETTINGS_PROVIDERS_PATH = '/api/openloop/settings/providers'

const BOOTSTRAP_COOKIE_NAME = 'openloop_bootstrap'
const MAX_REQUEST_BYTES = 64 * 1024

export interface OpenloopSettingsHostRoute {
  readonly kind: 'exact'
  readonly path: string
  readonly request: IncomingMessage
  readonly response: ServerResponse
  readonly handler: (request: IncomingMessage, response: ServerResponse) => void | Promise<void>
}

interface SettingsDescriptor {
  readonly ns: string
  readonly schema: unknown
  readonly value: unknown
  readonly base?: unknown
  readonly user?: unknown
  readonly applies: 'live' | 'restart'
  readonly secrets?: readonly { readonly path: readonly string[]; readonly set: boolean }[]
  readonly revision: number
}

interface ConfigurableProvider {
  readonly provider: string
  readonly displayName: string
  readonly settingsNs: string
  readonly settingsPath: readonly string[]
  readonly declared?: boolean
}

interface SettingsHostContext extends Context {
  readonly runtimeBootstrap: RuntimeBootstrap
  readonly webServer: {
    register(route: {
      readonly kind: 'exact'
      readonly path: string
      readonly handler: OpenloopSettingsHostRoute['handler']
    }): () => void
  }
  readonly settings: {
    readonly writable: boolean
    describe(options: { readonly redactSecrets: true }): SettingsDescriptor[]
    mutate(
      namespace: string,
      ops: OpenloopSettingsMutation['ops'],
      expectedRevision: number,
    ): Promise<void>
  }
  readonly llm: {
    listProviders(): readonly { readonly id: string; readonly name: string }[]
    listConfigurableProviders(): readonly ConfigurableProvider[]
  }
  readonly credentialConsumers: {
    planDeletion(reference: string): {
      readonly consumers: readonly {
        readonly kind: string
        readonly display: {
          readonly values: Readonly<Record<string, string>>
        }
      }[]
    }
  }
}

export const inject = [
  'webServer',
  'runtimeBootstrap',
  'settings',
  'llm',
  'credentialConsumers',
]

function responseJson(response: ServerResponse, status: number, body: object): void {
  response.writeHead(status, {
    'cache-control': 'no-store',
    'content-type': 'application/json; charset=utf-8',
    'referrer-policy': 'no-referrer',
  })
  response.end(JSON.stringify(body))
}

function error(response: ServerResponse, status: number, code: string): void {
  responseJson(response, status, { ok: false, error: { code, message: code } })
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

async function readJson(request: IncomingMessage): Promise<unknown> {
  let total = 0
  const chunks: Buffer[] = []
  for await (const chunk of request) {
    const bytes = Buffer.from(chunk as Uint8Array)
    total += bytes.length
    if (total > MAX_REQUEST_BYTES) throw new Error('request is oversized')
    chunks.push(bytes)
  }
  return JSON.parse(Buffer.concat(chunks, total).toString('utf8')) as unknown
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function namespaceView(
  descriptor: SettingsDescriptor,
  providers: ReadonlySet<string>,
): Record<string, unknown> {
  return {
    ns: descriptor.ns,
    schema: projectAllowedSettingsSchema(descriptor.ns, descriptor.schema, providers),
    value: projectAllowedSettingsData(
      descriptor.ns,
      descriptor.value,
      descriptor.schema,
      providers,
    ),
    ...descriptor.base === undefined ? {} : {
      base: projectAllowedSettingsData(
        descriptor.ns,
        descriptor.base,
        descriptor.schema,
        providers,
      ),
    },
    ...descriptor.user === undefined ? {} : {
      user: projectAllowedSettingsData(
        descriptor.ns,
        descriptor.user,
        descriptor.schema,
        providers,
      ),
    },
    applies: descriptor.applies,
    secrets: (descriptor.secrets ?? [])
      .filter(secret => isAllowedSettingsReadPath(
        descriptor.ns,
        secret.path,
        providers,
      ))
      .map(secret => ({
        path: [...secret.path],
        set: secret.set,
      })),
    revision: descriptor.revision,
  }
}

function valueAt(source: unknown, path: readonly string[]): unknown {
  let current = source
  for (const segment of path) {
    if (!isRecord(current)) return undefined
    current = current[segment]
  }
  return current
}

function providerIsInBase(
  provider: ConfigurableProvider,
  descriptors: readonly SettingsDescriptor[],
): boolean {
  if (provider.settingsNs !== 'llm-pi-ai'
    || provider.settingsPath.length !== 2
    || provider.settingsPath[0] !== 'providers'
    || provider.settingsPath[1] !== provider.provider) {
    return false
  }
  const descriptor = descriptors.find(candidate => candidate.ns === 'llm-pi-ai')
  return valueAt(descriptor?.base, provider.settingsPath) !== undefined
}

function trustedBuiltInProviders(
  ctx: SettingsHostContext,
  descriptors: readonly SettingsDescriptor[],
): {
  readonly entries: readonly ConfigurableProvider[]
  readonly providers: ReadonlySet<string>
} {
  const entries = ctx.llm.listConfigurableProviders()
    .filter(provider => provider.declared !== true || providerIsInBase(provider, descriptors))
  return {
    entries,
    providers: new Set(entries.map(provider => provider.provider)),
  }
}

function authenticated(
  request: IncomingMessage,
  response: ServerResponse,
  runtime: RuntimeBootstrap,
): boolean {
  const session = cookieValue(request)
  if (session !== undefined && runtime.validateBootstrapSession(session)) return true
  error(response, 401, 'SETTINGS_UNAUTHORIZED')
  return false
}

async function handleDescribe(
  ctx: SettingsHostContext,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  let body: unknown
  try {
    body = await readJson(request)
  } catch {
    error(response, 400, 'SETTINGS_INVALID_REQUEST')
    return
  }
  if (!isRecord(body) || Object.keys(body).length !== 1 || !Array.isArray(body.namespaces)) {
    error(response, 400, 'SETTINGS_INVALID_REQUEST')
    return
  }
  const requested = body.namespaces
  const allowed = new Set(allowedSettingsNamespaces())
  if (requested.length === 0
    || requested.some(value => typeof value !== 'string' || !allowed.has(value))
    || new Set(requested).size !== requested.length) {
    error(response, 403, 'SETTINGS_POLICY_DENIED')
    return
  }
  const selected = new Set(requested as string[])
  const descriptors = ctx.settings.describe({ redactSecrets: true })
  const { providers } = trustedBuiltInProviders(ctx, descriptors)
  const namespaces = descriptors
    .filter(descriptor => selected.has(descriptor.ns))
    .map(descriptor => namespaceView(descriptor, providers))
  responseJson(response, 200, {
    ok: true,
    value: { writable: ctx.settings.writable, hasDocument: false, namespaces },
  })
}

async function handleMutate(
  ctx: SettingsHostContext,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  let body: unknown
  try {
    body = await readJson(request)
    if (!isRecord(body)
      || Object.keys(body).some(key => !['ns', 'ops', 'expectedRevision'].includes(key))
      || typeof body.ns !== 'string'
      || !Array.isArray(body.ops)
      || typeof body.expectedRevision !== 'number') {
      throw new Error('invalid')
    }
    const descriptors = body.ns === 'llm-pi-ai'
      ? ctx.settings.describe({ redactSecrets: true })
      : []
    const { providers } = trustedBuiltInProviders(ctx, descriptors)
    assertAllowedSettingsMutation(body as unknown as OpenloopSettingsMutation, providers)
  } catch (cause) {
    const code = cause instanceof Error && cause.message === 'SETTINGS_POLICY_DENIED'
      ? 'SETTINGS_POLICY_DENIED'
      : 'SETTINGS_INVALID_REQUEST'
    error(response, code === 'SETTINGS_POLICY_DENIED' ? 403 : 400, code)
    return
  }
  const mutation = body as unknown as OpenloopSettingsMutation
  try {
    await ctx.settings.mutate(mutation.ns, mutation.ops, mutation.expectedRevision)
  } catch (cause) {
    const record = cause as { readonly name?: unknown; readonly code?: unknown }
    if (record.name === 'SettingsConflictError' || record.code === 'SETTINGS_CONFLICT') {
      error(response, 409, 'SETTINGS_CONFLICT')
    } else if (cause instanceof TypeError || record.code === 'SETTINGS_VALIDATION_FAILED') {
      error(response, 422, 'SETTINGS_VALIDATION_FAILED')
    } else {
      error(response, 503, 'SETTINGS_UNAVAILABLE')
    }
    return
  }
  const descriptors = ctx.settings.describe({ redactSecrets: true })
  const descriptor = descriptors.find(candidate => candidate.ns === mutation.ns)
  if (descriptor === undefined) {
    error(response, 503, 'SETTINGS_UNAVAILABLE')
    return
  }
  const { providers } = trustedBuiltInProviders(ctx, descriptors)
  responseJson(response, 200, {
    ok: true,
    value: namespaceView(descriptor, providers),
  })
}

async function handleProviders(
  ctx: SettingsHostContext,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  let body: unknown
  try {
    body = await readJson(request)
  } catch {
    error(response, 400, 'SETTINGS_INVALID_REQUEST')
    return
  }
  if (!isRecord(body) || Object.keys(body).length !== 0) {
    error(response, 400, 'SETTINGS_INVALID_REQUEST')
    return
  }
  const active = new Set(ctx.llm.listProviders().map(provider => provider.id))
  const descriptors = ctx.settings.describe({ redactSecrets: true })
  const namespaces = new Map(descriptors.map(descriptor => [descriptor.ns, descriptor]))
  const { entries } = trustedBuiltInProviders(ctx, descriptors)
  const providers = entries
    .map(provider => ({
      provider: provider.provider,
      displayName: provider.displayName,
      settingsNs: provider.settingsNs,
      settingsPath: [...provider.settingsPath],
      active: active.has(provider.provider),
      builtIn: true,
      ...(() => {
        const profile = valueAt(namespaces.get(provider.settingsNs)?.value, provider.settingsPath)
        const credentialRef = isRecord(profile) ? profile.apiKeyEnv : undefined
        if (typeof credentialRef !== 'string') return {}
        const consumers = ctx.credentialConsumers.planDeletion(credentialRef).consumers
        return consumers.some(consumer =>
          consumer.kind === 'model-route'
          && consumer.display.values.routeId === provider.provider)
          ? { credentialRef }
          : {}
      })(),
    }))
  responseJson(response, 200, { ok: true, value: { providers } })
}

function route(
  ctx: SettingsHostContext,
  path: string,
  body: (
    ctx: SettingsHostContext,
    request: IncomingMessage,
    response: ServerResponse,
  ) => Promise<void>,
): { readonly kind: 'exact'; readonly path: string; readonly handler: OpenloopSettingsHostRoute['handler'] } {
  return {
    kind: 'exact',
    path,
    handler: async (request, response) => {
      if (request.method !== 'POST'
        || request.headers['content-type']?.split(';', 1)[0]?.trim() !== 'application/json') {
        error(response, 405, 'SETTINGS_METHOD_NOT_ALLOWED')
        return
      }
      if (!authenticated(request, response, ctx.runtimeBootstrap)) return
      await body(ctx, request, response)
    },
  }
}

export function apply(ctx: Context): void {
  const host = ctx as SettingsHostContext
  const routes = [
    route(host, OPENLOOP_SETTINGS_DESCRIBE_PATH, handleDescribe),
    route(host, OPENLOOP_SETTINGS_MUTATE_PATH, handleMutate),
    route(host, OPENLOOP_SETTINGS_PROVIDERS_PATH, handleProviders),
  ]
  host.effect(() => {
    const disposers = routes.map(entry => host.webServer.register(entry))
    return () => { for (const dispose of disposers) dispose() }
  }, 'openloop-settings: authenticated routes')
}
