/** Page-store join: directory × namespaces × credentials, with last-good rows on failure. */
import { describe, expect, it } from 'vitest'
import type { RpcResponse } from '@deepseek-ai/dsh-api-remotes/client'
import type { CredentialControlAdapter } from '@deepseek-ai/dsh-client-ui-settings/client'
import { messageOf, ModelsSettingsStore, onboardingReadiness } from '../src/client/store.ts'

let nextRpc = 0
function ok<T>(value: T): RpcResponse<T> {
  return { rpcId: `r-${nextRpc++}` as never, result: { ok: true, value } }
}
function fail<T>(message: string): RpcResponse<T> {
  return { rpcId: `r-${nextRpc++}` as never, result: { ok: false, error: { code: 'internal', message, details: {} } } }
}

const DIRECTORY = [
  { provider: 'deepseek-official', displayName: 'DeepSeek', settingsNs: 'llm-deepseek', settingsPath: [], active: true },
  { provider: 'openai', displayName: 'openai', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'openai'], active: true },
  { provider: 'anthropic', displayName: 'anthropic', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'anthropic'], active: false },
  { provider: 'ghost', displayName: 'Ghost', settingsNs: '', settingsPath: [], active: true },
]

const NAMESPACES = [
  {
    ns: 'llm-deepseek',
    schema: {},
    value: { apiKeyEnv: 'DEEPSEEK_API_KEY', baseURL: 'https://base' },
    base: { baseURL: 'https://base' },
    applies: 'live' as const,
    secrets: [],
    revision: 0,
  },
  {
    ns: 'llm-pi-ai',
    schema: {},
    value: { providers: { openai: { apiKeyEnv: 'OPENAI_API_KEY' } } },
    user: { providers: { openai: { apiKeyEnv: 'OPENAI_API_KEY' } } },
    applies: 'live' as const,
    secrets: [],
    revision: 0,
  },
]

function api(overrides: {
  providers?: () => Promise<RpcResponse<{ providers: typeof DIRECTORY }>>
  describeSettings?: () => Promise<RpcResponse<{ writable: boolean; namespaces: typeof NAMESPACES }>>
  describeCredentials?: (refs: string[]) => Promise<RpcResponse<{ credentials: Record<string, unknown> }>>
} = {}) {
  const seenRefs: string[][] = []
  const face = {
    llm: {
      providers: overrides.providers ?? (() => Promise.resolve(ok({ providers: DIRECTORY }))),
      models: () => Promise.resolve(ok({ groups: [], failures: [] })),
    },
    settings: {
      describe: overrides.describeSettings ?? (() => Promise.resolve(ok({ writable: true, hasDocument: false, namespaces: NAMESPACES }))),
      update: () => Promise.resolve(fail('unused')),
      replace: () => Promise.resolve(fail('unused')),
    },
    credentials: {
      describe: (payload: { refs: string[] }) => {
        seenRefs.push(payload.refs)
        return (overrides.describeCredentials ?? (refs => Promise.resolve(ok({
          credentials: Object.fromEntries(refs.map(ref => [ref, { configured: ref === 'OPENAI_API_KEY', writable: true }])),
        }))))(payload.refs)
      },
      set: () => Promise.resolve(ok({})),
      unset: () => Promise.resolve(ok({})),
    },
  }
  return { face: face as never, seenRefs }
}

describe('ModelsSettingsStore', () => {
  it('joins rows with configured, removable, and credential state', async () => {
    const { face, seenRefs } = api()
    const store = new ModelsSettingsStore(face)
    await store.load()
    const state = store.store.getSnapshot()
    expect(state.status).toBe('ready')
    expect(state.writable).toBe(true)
    expect(state.credentialError).toBeNull()
    expect(seenRefs).toEqual([['DEEPSEEK_API_KEY', 'OPENAI_API_KEY']])
    const byProvider = new Map(state.rows.map(row => [row.entry.provider, row]))
    expect(byProvider.get('deepseek-official')).toMatchObject({
      configured: true,
      removable: false,
      apiKeyEnv: 'DEEPSEEK_API_KEY',
      credential: { configured: false, writable: true },
    })
    expect(byProvider.get('openai')).toMatchObject({
      configured: true,
      removable: true,
      apiKeyEnv: 'OPENAI_API_KEY',
      credential: { configured: true },
    })
    expect(byProvider.get('anthropic')).toMatchObject({ configured: false, removable: false })
    expect(byProvider.get('anthropic')?.apiKeyEnv).toBeUndefined()
    expect(byProvider.get('ghost')).toMatchObject({ configured: false, removable: false })
    expect(state.namespaces.get('llm-pi-ai')?.ns).toBe('llm-pi-ai')
  })

  it('degrades the credential badge, not the page, when the credential domain fails', async () => {
    const { face } = api({ describeCredentials: () => Promise.resolve(fail('no provider')) })
    const store = new ModelsSettingsStore(face)
    await store.load()
    const state = store.store.getSnapshot()
    expect(state.status).toBe('ready')
    expect(state.credentialError).toBe('no provider')
    expect(state.rows.every(row => row.credential === undefined)).toBe(true)
  })

  it('settles a credential transport rejection without leaving the store loading', async () => {
    const { face } = api({
      describeCredentials: () => Promise.reject(new Error('credential transport down')),
    })
    const store = new ModelsSettingsStore(face)
    await expect(store.load()).resolves.toBeUndefined()
    expect(store.store.getSnapshot()).toMatchObject({
      status: 'ready',
      credentialError: 'credential transport down',
    })
  })

  it('stringifies a non-Error credential transport rejection', async () => {
    const { face } = api({
      // oxlint-disable-next-line typescript/prefer-promise-reject-errors -- the non-Error rejection is the scenario
      describeCredentials: () => Promise.reject('credential transport refusal'),
    })
    const store = new ModelsSettingsStore(face)
    await expect(store.load()).resolves.toBeUndefined()
    expect(store.store.getSnapshot().credentialError).toBe('credential transport refusal')
  })

  it('preserves successful credential statuses after a later business failure', async () => {
    let load = 0
    const { face } = api({
      describeCredentials: (refs) => {
        load += 1
        if (load === 1) {
          return Promise.resolve(ok({
            credentials: Object.fromEntries(
              refs.map(ref => [ref, { configured: true, source: 'keychain', writable: true }]),
            ),
          }))
        }
        return Promise.resolve(fail<{ credentials: Record<string, unknown> }>('credential unavailable'))
      },
    })
    const store = new ModelsSettingsStore(face)
    await store.load()

    await store.load()

    const state = store.store.getSnapshot()
    expect(state.credentialError).toBe('credential unavailable')
    expect(state.rows.filter(row => row.apiKeyEnv !== undefined).every(row =>
      row.credential?.configured === true && row.credential.source === 'keychain',
    )).toBe(true)
  })

  it('preserves successful credential statuses after a later transport rejection', async () => {
    let load = 0
    const { face } = api({
      describeCredentials: (refs) => {
        load += 1
        if (load === 1) {
          return Promise.resolve(ok({
            credentials: Object.fromEntries(
              refs.map(ref => [ref, { configured: true, source: 'keychain', writable: true }]),
            ),
          }))
        }
        return Promise.reject(new Error('credential transport down'))
      },
    })
    const store = new ModelsSettingsStore(face)
    await store.load()

    await store.load()

    const state = store.store.getSnapshot()
    expect(state.credentialError).toBe('credential transport down')
    expect(state.rows.filter(row => row.apiKeyEnv !== undefined).every(row =>
      row.credential?.configured === true && row.credential.source === 'keychain',
    )).toBe(true)
  })

  it('preserves successful injected-adapter statuses after a later rejection', async () => {
    let rejecting = false
    const credentialControl: CredentialControlAdapter = {
      describe: async (ref) => {
        if (rejecting) throw new Error('host credential transport down')
        return { configured: ref === 'OPENAI_API_KEY', source: 'keychain', writable: true }
      },
      render: () => null,
      materializeApiKeyEnv: true,
      deleteCredentialWithProfile: false,
    }
    const { face } = api()
    const store = new ModelsSettingsStore(face, credentialControl)
    await store.load()
    rejecting = true

    await store.load()

    const state = store.store.getSnapshot()
    expect(state.credentialError).toBe('credential status is unavailable')
    expect(state.rows.find(row => row.apiKeyEnv === 'DEEPSEEK_API_KEY')?.credential).toEqual({
      configured: false,
      source: 'keychain',
      writable: true,
    })
    expect(state.rows.find(row => row.apiKeyEnv === 'OPENAI_API_KEY')?.credential).toEqual({
      configured: true,
      source: 'keychain',
      writable: true,
    })
  })

  it('keeps mixed adapter results independent and redacts one stable failure state', async () => {
    let load = 0
    const credentialControl: CredentialControlAdapter = {
      describe: async (ref) => {
        if (load === 0) {
          return { configured: true, source: 'keychain', writable: true }
        }
        if (ref === 'OPENAI_API_KEY') {
          return { configured: false, source: 'environment', writable: false }
        }
        throw new Error(`${ref} unavailable`)
      },
      render: () => null,
      materializeApiKeyEnv: true,
      deleteCredentialWithProfile: false,
    }
    const { face } = api({
      describeSettings: () => Promise.resolve(ok({
        writable: true,
        hasDocument: false,
        namespaces: load === 0
          ? NAMESPACES
          : NAMESPACES.map(namespace => namespace.ns === 'llm-pi-ai'
            ? {
              ...namespace,
              value: { providers: {
                openai: { apiKeyEnv: 'OPENAI_API_KEY' },
                anthropic: { apiKeyEnv: 'ANTHROPIC_API_KEY' },
              } },
              user: { providers: {
                openai: { apiKeyEnv: 'OPENAI_API_KEY' },
                anthropic: { apiKeyEnv: 'ANTHROPIC_API_KEY' },
              } },
              revision: 1,
            }
            : namespace) as typeof NAMESPACES,
      })),
    })
    const store = new ModelsSettingsStore(face, credentialControl)
    await store.load()
    load = 1

    await store.load()

    const state = store.store.getSnapshot()
    expect(state.credentialError).toBe('credential status is unavailable')
    expect(state.credentialError).not.toContain('DEEPSEEK_API_KEY')
    expect(state.credentialError).not.toContain('ANTHROPIC_API_KEY')
    expect(state.rows.find(row => row.apiKeyEnv === 'DEEPSEEK_API_KEY')?.credential).toEqual({
      configured: true,
      source: 'keychain',
      writable: true,
    })
    expect(state.rows.find(row => row.apiKeyEnv === 'OPENAI_API_KEY')?.credential).toEqual({
      configured: false,
      source: 'environment',
      writable: false,
    })
    expect(state.rows.find(row => row.apiKeyEnv === 'ANTHROPIC_API_KEY')?.credential).toBeUndefined()
  })

  it('keeps onboarding available when only another credential reference fails', async () => {
    let rejectDeepSeek = false
    const credentialControl: CredentialControlAdapter = {
      describe: async (ref) => {
        if (ref === 'DEEPSEEK_API_KEY' && !rejectDeepSeek) {
          return { configured: false, writable: true }
        }
        throw new Error(`${ref} unavailable`)
      },
      render: () => null,
      materializeApiKeyEnv: true,
      deleteCredentialWithProfile: false,
    }
    const { face } = api({
      providers: () => Promise.resolve(ok({
        providers: DIRECTORY.filter(entry => entry.provider !== 'ghost'),
      })),
    })
    const store = new ModelsSettingsStore(face, credentialControl)

    await store.load()

    const state = store.store.getSnapshot()
    expect(state.credentialError).toBe('credential status is unavailable')
    expect(state.rows.find(row => row.apiKeyEnv === 'DEEPSEEK_API_KEY')?.credential).toEqual({
      configured: false,
      writable: true,
    })
    expect(state.rows.find(row => row.apiKeyEnv === 'OPENAI_API_KEY')?.credential).toBeUndefined()
    expect(onboardingReadiness(state)).toEqual({ kind: 'credential-missing' })

    rejectDeepSeek = true
    await store.load()

    const lastGoodState = store.store.getSnapshot()
    expect(lastGoodState.credentialError).toBe('credential status is unavailable')
    expect(lastGoodState.rows.find(row => row.apiKeyEnv === 'DEEPSEEK_API_KEY')?.credential).toEqual({
      configured: false,
      writable: true,
    })
    expect(onboardingReadiness(lastGoodState)).toEqual({ kind: 'credential-missing' })
  })

  it('does not retain credential status for removed or changed references', async () => {
    let rotated = false
    let credentialLoad = 0
    const { face, seenRefs } = api({
      describeSettings: () => Promise.resolve(ok({
        writable: true,
        hasDocument: false,
        namespaces: rotated
          ? [{
            ns: 'llm-deepseek',
            schema: {},
            value: { apiKeyEnv: 'ROTATED_API_KEY' },
            base: {},
            applies: 'live' as const,
            secrets: [],
            revision: 1,
          }]
          : NAMESPACES,
      }) as never),
      describeCredentials: (refs) => {
        credentialLoad += 1
        if (credentialLoad === 1) {
          return Promise.resolve(ok({
            credentials: Object.fromEntries(
              refs.map(ref => [ref, { configured: true, source: 'keychain', writable: true }]),
            ),
          }))
        }
        return Promise.reject(new Error('credential transport down'))
      },
    })
    const store = new ModelsSettingsStore(face)
    await store.load()
    rotated = true

    await store.load()

    expect(seenRefs).toEqual([
      ['DEEPSEEK_API_KEY', 'OPENAI_API_KEY'],
      ['ROTATED_API_KEY'],
    ])
    const state = store.store.getSnapshot()
    expect(state.rows.find(row => row.entry.provider === 'deepseek-official')).toMatchObject({
      apiKeyEnv: 'ROTATED_API_KEY',
      credential: undefined,
    })
    expect(state.rows.find(row => row.entry.provider === 'openai')?.apiKeyEnv).toBeUndefined()
    expect(state.rows.find(row => row.entry.provider === 'openai')?.credential).toBeUndefined()
  })

  it('surfaces a directory failure and keeps the last good rows', async () => {
    const { face } = api()
    const store = new ModelsSettingsStore(face)
    await store.load()
    expect(store.store.getSnapshot().rows).toHaveLength(4)
    const broken = api({ providers: () => Promise.resolve(fail('directory down')) })
    const failing = new ModelsSettingsStore(broken.face)
    await failing.load()
    expect(failing.store.getSnapshot()).toMatchObject({ status: 'error', error: 'directory down' })
    // The first store's snapshot is untouched by the second's failure.
    expect(store.store.getSnapshot().status).toBe('ready')
  })

  it('lets the newest load win over a stale slow response', async () => {
    let release: (() => void) | undefined
    const gate = new Promise<void>((resolve) => { release = resolve })
    let call = 0
    const { face } = api({
      providers: async () => {
        call += 1
        if (call === 1) {
          await gate
          return fail('stale slow failure')
        }
        return ok({ providers: DIRECTORY })
      },
    })
    const store = new ModelsSettingsStore(face)
    const first = store.load()
    const second = store.load()
    release?.()
    await Promise.all([first, second])
    expect(store.store.getSnapshot().status).toBe('ready')
  })
})

describe('edge joins', () => {
  it('treats a non-object profile as having no credential reference', async () => {
    const { face } = api({
      describeSettings: () => Promise.resolve(ok({
        writable: true,
        hasDocument: false,
        namespaces: [{
          ns: 'llm-pi-ai',
          schema: {},
          value: { providers: { weird: 'oops' } },
          applies: 'live' as const,
          secrets: [],
          revision: 0,
        }] as never,
      })),
      providers: () => Promise.resolve(ok({
        providers: [
          { provider: 'weird', displayName: 'weird', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'weird'], active: false },
        ] as never,
      })),
    })
    const store = new ModelsSettingsStore(face)
    await store.load()
    const state = store.store.getSnapshot()
    expect(state.rows[0]).toMatchObject({ configured: true, removable: false })
    expect(state.rows[0]?.apiKeyEnv).toBeUndefined()
  })

  it('skips the credential describe entirely when no row names a reference', async () => {
    const { face, seenRefs } = api({
      describeSettings: () => Promise.resolve(ok({
        writable: true,
        hasDocument: false,
        namespaces: [{ ns: 'llm-pi-ai', schema: {}, value: { providers: {} }, applies: 'live' as const, secrets: [], revision: 0 }] as never,
      })),
      providers: () => Promise.resolve(ok({
        providers: [
          { provider: 'anthropic', displayName: 'anthropic', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'anthropic'], active: false },
        ] as never,
      })),
    })
    const store = new ModelsSettingsStore(face)
    await store.load()
    expect(seenRefs).toEqual([])
    expect(store.store.getSnapshot().status).toBe('ready')
  })

  it('surfaces a settings describe failure', async () => {
    const { face } = api({ describeSettings: () => Promise.resolve(fail('settings down')) })
    const store = new ModelsSettingsStore(face)
    await store.load()
    expect(store.store.getSnapshot()).toMatchObject({ status: 'error', error: 'settings down' })
  })

  it('stringifies a non-Error load failure', async () => {
    // The wire can surface non-Error throwables; the store must stringify them.
    // oxlint-disable-next-line typescript/prefer-promise-reject-errors -- the non-Error rejection is the scenario
    const { face } = api({ providers: () => Promise.reject('plain refusal') })
    const store = new ModelsSettingsStore(face)
    await store.load()
    expect(store.store.getSnapshot()).toMatchObject({ status: 'error', error: 'plain refusal' })
  })

  it('drops a stale successful response after a newer load finished', async () => {
    let release: (() => void) | undefined
    const gate = new Promise<void>((resolve) => { release = resolve })
    let call = 0
    const { face } = api({
      providers: async () => {
        call += 1
        if (call === 1) {
          await gate
          return ok({ providers: [] as never })
        }
        return ok({ providers: DIRECTORY })
      },
    })
    const store = new ModelsSettingsStore(face)
    const first = store.load()
    const second = store.load()
    await second
    release?.()
    await first
    // The stale empty directory never overwrote the newer join.
    expect(store.store.getSnapshot().rows).toHaveLength(4)
  })
})

describe('messageOf', () => {
  it('reads an Error message, and stringifies anything else a rejection may carry', () => {
    // The wire layer rejects with an Error, but a host or a runtime can reject
    // with any value, and the page still has to render something.
    expect(messageOf(new Error('connection lost'))).toBe('connection lost')
    expect(messageOf('the host refused')).toBe('the host refused')
    expect(messageOf(undefined)).toBe('undefined')
  })
})
