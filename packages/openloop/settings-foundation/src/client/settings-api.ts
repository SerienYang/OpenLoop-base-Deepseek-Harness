import type {
  IApiClient,
  RpcResponse,
} from '@deepseek-ai/dsh-api-remotes/client'
import type { ProductSettingsApi } from '@deepseek-ai/dsh-client-ui-settings/client'

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

type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
type DescribeResponse = Awaited<ReturnType<IApiClient['settings']['describe']>>
type MutateResponse = Awaited<ReturnType<IApiClient['settings']['mutate']>>
type ProvidersResponse = Awaited<ReturnType<IApiClient['llm']['providers']>>
type DiscoverResponse = Awaited<ReturnType<IApiClient['llm']['discoverModels']>>

let rpcSequence = 0

function rpcId(): never {
  rpcSequence += 1
  return `openloop-settings-${String(rpcSequence)}` as never
}

function failed<T>(code: string, message = code): RpcResponse<T> {
  return {
    rpcId: rpcId(),
    result: { ok: false, error: { code, message, details: {} } },
  }
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
    typeof record.error?.code === 'string' ? record.error.code : 'settings-unavailable',
    typeof record.error?.message === 'string' ? record.error.message : 'settings unavailable',
  )
}

/** Same-origin adapter for the authenticated Openloop settings Host routes. */
export class OpenloopSettingsApi implements ProductSettingsApi {
  readonly settings: ProductSettingsApi['settings']
  readonly llm: ProductSettingsApi['llm']

  constructor(private readonly fetcher: Fetcher = globalThis.fetch.bind(globalThis)) {
    this.settings = {
      describe: async (_payload, signal) => this.call(
        DESCRIBE_PATH,
        { namespaces: NAMESPACES },
        signal,
      ) as Promise<DescribeResponse>,
      mutate: async (payload, signal) => this.call(
        MUTATE_PATH,
        payload,
        signal,
      ) as Promise<MutateResponse>,
      openDocument: async () => failed('policy-denied'),
      update: async () => failed('policy-denied'),
      replace: async () => failed('policy-denied'),
    }
    this.llm = {
      providers: async (_payload, signal) => this.call(
        PROVIDERS_PATH,
        {},
        signal,
      ) as Promise<ProvidersResponse>,
      discoverModels: async () => failed(
        'policy-denied',
        'Model discovery is unavailable in Openloop',
      ) as DiscoverResponse,
    }
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
      return decode<T>(response)
    } catch {
      return failed('settings-unavailable')
    }
  }
}
