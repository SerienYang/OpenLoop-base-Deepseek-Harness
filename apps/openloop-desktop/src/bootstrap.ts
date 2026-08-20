export interface BootstrapFragment {
  readonly bootstrapToken: string
  readonly launchId: string
}

export interface BootstrapResponse {
  readonly launchId: string
  readonly coreManifest: Readonly<Record<string, unknown>>
  readonly coreManifestSha256: string
}

interface BootstrapLocation {
  readonly hash: string
  readonly pathname: string
  readonly search: string
}

interface BootstrapHistory {
  replaceState(data: unknown, unused: string, url?: string | URL | null): void
}

export interface BootstrapExchangeOptions {
  readonly fetcher?: typeof fetch
  readonly history?: BootstrapHistory
  readonly location?: BootstrapLocation
}

const HASH_KEY_PATTERN = /^[a-z][a-z0-9-]*$/iu
const SHA256_PATTERN = /^[0-9a-f]{64}$/u

function parseResponse(value: unknown, expectedLaunchId?: string): BootstrapResponse {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Openloop bootstrap response is invalid')
  }
  const record = value as Record<string, unknown>
  if (Object.keys(record).length !== 3
    || typeof record.launchId !== 'string'
    || record.launchId.length === 0
    || (expectedLaunchId !== undefined && record.launchId !== expectedLaunchId)
    || typeof record.coreManifest !== 'object'
    || record.coreManifest === null
    || Array.isArray(record.coreManifest)
    || typeof record.coreManifestSha256 !== 'string'
    || !SHA256_PATTERN.test(record.coreManifestSha256)) {
    throw new Error('Openloop bootstrap response is invalid')
  }
  return {
    launchId: record.launchId,
    coreManifest: record.coreManifest as Readonly<Record<string, unknown>>,
    coreManifestSha256: record.coreManifestSha256,
  }
}

export function parseBootstrapFragment(hash: string): BootstrapFragment | undefined {
  if (hash === '') return undefined
  if (!hash.startsWith('#')) throw new Error('Openloop bootstrap hash is invalid')
  const params = new URLSearchParams(hash.slice(1))
  const bootstrapToken = params.get('bootstrap')
  const launchId = params.get('launch')
  if (bootstrapToken === null && launchId === null) return undefined
  if (bootstrapToken === null || bootstrapToken.length === 0) {
    throw new Error('Openloop bootstrap token is missing')
  }
  if (launchId === null || launchId.length === 0) {
    throw new Error('Openloop bootstrap launch is missing')
  }
  for (const key of params.keys()) {
    if (!HASH_KEY_PATTERN.test(key) || (key !== 'bootstrap' && key !== 'launch')) {
      throw new Error('Openloop bootstrap hash contains an unknown field')
    }
  }
  return { bootstrapToken, launchId }
}

function clearFragment(history: BootstrapHistory, location: BootstrapLocation): void {
  history.replaceState(null, '', `${location.pathname}${location.search}`)
}

export async function bootstrapFromLocation(
  options: BootstrapExchangeOptions = {},
): Promise<BootstrapResponse | undefined> {
  const fetcher = options.fetcher ?? fetch
  const history = options.history ?? window.history
  const location = options.location ?? window.location
  const fragment = parseBootstrapFragment(location.hash)
  if (fragment !== undefined) clearFragment(history, location)
  let response: Response
  try {
    response = await fetcher('/api/openloop/bootstrap', fragment === undefined
      ? {
        method: 'GET',
        credentials: 'same-origin',
        cache: 'no-store',
      }
      : {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        credentials: 'same-origin',
        cache: 'no-store',
        body: JSON.stringify({
          launchId: fragment.launchId,
          token: fragment.bootstrapToken,
        }),
      })
  } catch (error) {
    throw new Error('Openloop bootstrap exchange failed', { cause: error })
  }
  if (!response.ok) throw new Error(`Openloop bootstrap exchange failed (${String(response.status)})`)
  try {
    const value = await response.json() as unknown
    return parseResponse(value, fragment?.launchId)
  } catch (error) {
    throw new Error('Openloop bootstrap response could not be verified', { cause: error })
  }
}
