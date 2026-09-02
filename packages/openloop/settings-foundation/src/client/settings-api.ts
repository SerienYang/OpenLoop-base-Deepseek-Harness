import type {
  ConfigurableProviderView,
  RpcResponse,
} from '@deepseek-ai/dsh-api-remotes/client'
import type { ProductSettingsApi } from '@deepseek-ai/dsh-client-ui-settings/client/scope'

const DESCRIBE_PATH = '/api/openloop/settings/describe'
const MUTATE_PATH = '/api/openloop/settings/mutate'
const PROVIDERS_PATH = '/api/openloop/settings/providers'
const NAMESPACES = [
  'locale',
  'ui-theme',
  'ui-conversation',
  'agent-loop',
  'shell',
  'web-search-deepseek',
  'llm-deepseek',
  'llm-pi-ai',
  'ui-onboarding',
] as const

const SIMPLE_FIELDS: Readonly<Record<string, ReadonlySet<string>>> = {
  locale: new Set(['preference']),
  'ui-theme': new Set(['preference']),
  'ui-conversation': new Set(['busyEnter']),
  'agent-loop': new Set(['maxParallelToolCalls']),
  shell: new Set(['timeoutMs', 'maxOutputBytes']),
  'web-search-deepseek': new Set(['maxUses']),
  'llm-deepseek': new Set([
    'thinking',
    'reasoningEffort',
    'maxTokens',
    'defaultContextWindow',
    'streamIdleTimeoutMs',
    'retryPolicy',
    'models',
  ]),
  'ui-onboarding': new Set(['welcomeNoticeVersion']),
}
const PI_AI_FIELDS = new Set([
  'displayName',
  'models',
  'modelOverrides',
  'compat',
  'defaultContextWindow',
  'defaultMaxTokens',
  'defaultInput',
  'streamIdleTimeoutMs',
  'retryPolicy',
])
const FORBIDDEN_VALUE_KEYS = new Set([
  'apiKey',
  'apiKeyEnv',
  'baseURL',
  'credential',
  'credentialMode',
  'secret',
])

type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

let rpcSequence = 0

function rpcId(): never {
  rpcSequence += 1
  return `openloop-settings-${String(rpcSequence)}` as never
}

function failed<T>(code: string, message = code): RpcResponse<T> {
  return {
    rpcId: rpcId(),
    result: { ok: false, error: { code: code as never, message, details: {} } },
  }
}

function clientErrorCode(code: unknown): string {
  if (code === 'SETTINGS_CONFLICT') return 'settings-conflict'
  if (code === 'SETTINGS_POLICY_DENIED' || code === 'SETTINGS_UNAUTHORIZED') return 'policy-denied'
  if (code === 'SETTINGS_INVALID_REQUEST') return 'bad-request'
  return 'settings-rejected'
}

function containsForbiddenKey(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsForbiddenKey)
  if (typeof value !== 'object' || value === null) return false
  return Object.entries(value).some(([key, child]) =>
    FORBIDDEN_VALUE_KEYS.has(key) || containsForbiddenKey(child))
}

async function decode<T>(response: Response): Promise<RpcResponse<T>> {
  let body: unknown
  try {
    body = await response.json()
  } catch {
    return failed('settings-unavailable')
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return failed('settings-unavailable')
  }
  const record = body as {
    readonly ok?: unknown
    readonly value?: unknown
    readonly error?: { readonly code?: unknown; readonly message?: unknown }
  }
  if (response.ok && record.ok === true) {
    return { rpcId: rpcId(), result: { ok: true, value: record.value as T } }
  }
  return failed(
    clientErrorCode(record.error?.code),
    typeof record.error?.message === 'string' ? record.error.message : 'settings unavailable',
  )
}

/** Same-origin adapter for the authenticated Openloop settings Host routes. */
export class OpenloopSettingsApi implements ProductSettingsApi {
  readonly settings: ProductSettingsApi['settings']
  readonly llm: ProductSettingsApi['llm']
  private readonly builtInProviders = new Set<string>()

  constructor(private readonly fetcher: Fetcher = globalThis.fetch.bind(globalThis)) {
    this.settings = {
      describe: (_payload, signal) => this.call(
        DESCRIBE_PATH,
        { namespaces: NAMESPACES },
        signal,
      ),
      mutate: (payload, signal) => {
        if (payload.ops.some(op =>
          !this.canMutate(payload.ns, op.path)
          || (op.op === 'set' && containsForbiddenKey(op.value)))) {
          return Promise.resolve(failed('policy-denied'))
        }
        return this.call(MUTATE_PATH, payload, signal)
      },
    }
    this.llm = {
      providers: async (_payload, signal) => {
        const response = await this.call<{ providers: ConfigurableProviderView[] }>(
          PROVIDERS_PATH,
          {},
          signal,
        )
        if (response.result.ok) {
          this.builtInProviders.clear()
          for (const provider of response.result.value.providers) {
            if (provider.builtIn === true) this.builtInProviders.add(provider.provider)
          }
        }
        return response
      },
    }
  }

  /** Mirror the Host allowlist so controls rejected by policy are not rendered. */
  readonly canMutate = (namespace: string, path: readonly string[]): boolean => {
    if (namespace === 'llm-pi-ai') {
      return path.length === 3
        && path[0] === 'providers'
        && this.builtInProviders.has(path[1] ?? '')
        && PI_AI_FIELDS.has(path[2] ?? '')
    }
    const fields = SIMPLE_FIELDS[namespace]
    return fields !== undefined && path.length === 1 && fields.has(path[0] ?? '')
  }

  private async call<T>(
    path: string,
    payload: unknown,
    signal?: AbortSignal,
  ): Promise<RpcResponse<T>> {
    try {
      const response = await this.fetcher(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        credentials: 'same-origin',
        cache: 'no-store',
        body: JSON.stringify(payload),
        ...signal === undefined ? {} : { signal },
      })
      return await decode<T>(response)
    } catch {
      return failed('settings-unavailable')
    }
  }
}
