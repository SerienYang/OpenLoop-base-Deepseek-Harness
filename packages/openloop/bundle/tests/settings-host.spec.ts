import { Readable } from 'node:stream'
import { Context } from '@deepseek-ai/cordis'
import { SettingsProvider, settingsNamespace, type SettingsNamespace } from '@deepseek-ai/dsh-settings'
import Schema from '@deepseek-ai/schemastery'
import { describe, expect, it, vi } from 'vitest'
import {
  OPENLOOP_SETTINGS_DESCRIBE_PATH,
  OPENLOOP_SETTINGS_MUTATE_PATH,
  OPENLOOP_SETTINGS_PROVIDERS_PATH,
  apply,
  type OpenloopSettingsHostRoute,
} from '../src/settings-host.ts'

interface TestSettingsDescriptor {
  readonly ns: string
  readonly schema: unknown
  readonly value: unknown
  readonly base?: unknown
  readonly user?: unknown
  readonly applies: 'live' | 'restart'
  readonly secrets?: readonly { readonly path: readonly string[]; readonly set: boolean }[]
  readonly revision: number
}

const localeSchema = {
  uid: 1,
  refs: {
    0: { type: 'string', meta: {} },
    1: { type: 'object', meta: {}, dict: { preference: 0 } },
  },
}

const piAiProviderSchema = {
  uid: 6,
  refs: {
    0: { type: 'string', meta: {} },
    1: { type: 'object', meta: {}, dict: { id: 0 } },
    2: { type: 'array', meta: {}, inner: 1 },
    3: { type: 'object', meta: {}, dict: { models: 2, baseURL: 0, apiKeyEnv: 0 } },
    4: { type: 'dict', meta: {}, inner: 3 },
    5: { type: 'object', meta: {}, dict: { providers: 4 } },
    6: { type: 'object', meta: {}, dict: { providers: 4 } },
  },
}

const agentPlanProfile = {
  models: [{ id: 'glm-5.3-flash' }],
  apiKeyEnv: 'VOLCENGINE_ARK_AGENT_PLAN_API_KEY',
  baseURL: 'https://ark.invalid',
}

function agentPlanDescriptor(options: {
  base?: unknown
  user?: unknown
} = {}): TestSettingsDescriptor {
  const value = {
    providers: {
      'volcengine-agent-plan': agentPlanProfile,
    },
  }
  return {
    ns: 'llm-pi-ai',
    schema: piAiProviderSchema,
    value,
    ...options.base === undefined ? {} : { base: options.base },
    ...options.user === undefined ? {} : { user: options.user },
    applies: 'live',
    revision: 5,
  }
}

class MemorySettings extends SettingsProvider {
  readonly writable = true
  doc: Record<string, unknown>
  persisted: Array<{ ns: SettingsNamespace; section: Record<string, unknown> }> = []

  constructor(ctx: Context, doc: Record<string, unknown>) {
    super(ctx)
    this.doc = structuredClone(doc)
  }

  protected load(): Promise<Record<string, unknown>> {
    return Promise.resolve(structuredClone(this.doc))
  }

  protected persist(ns: SettingsNamespace, section: Record<string, unknown>): Promise<void> {
    this.persisted.push({ ns, section: structuredClone(section) })
    this.doc[ns] = structuredClone(section)
    return Promise.resolve()
  }
}

function responseRecorder() {
  const state = { status: 0, body: '' }
  return {
    state,
    response: {
      writeHead(status: number): void { state.status = status },
      end(body?: string): void { state.body += body ?? '' },
    } as unknown as OpenloopSettingsHostRoute['response'],
  }
}

function request(body: unknown, session?: string): OpenloopSettingsHostRoute['request'] {
  return rawRequest(JSON.stringify(body), session)
}

function rawRequest(body: string, session?: string): OpenloopSettingsHostRoute['request'] {
  return Object.assign(Readable.from([body]), {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(session === undefined ? {} : { cookie: `openloop_bootstrap=${session}` }),
    },
  }) as unknown as OpenloopSettingsHostRoute['request']
}

function bench(options: {
  descriptors?: readonly TestSettingsDescriptor[]
  configurableProviders?: readonly {
    provider: string
    displayName: string
    settingsNs: string
    settingsPath: readonly string[]
    declared?: boolean
  }[]
  activeProviders?: readonly { id: string; name: string }[]
  credentialConsumers?: {
    planDeletion(reference: string): {
      consumers: readonly {
        kind: string
        display: { key: string; values: Readonly<Record<string, string>> }
      }[]
    }
  }
} = {}) {
  const routes = new Map<string, OpenloopSettingsHostRoute>()
  const defaultDescriptors = [{
    ns: 'locale',
    schema: localeSchema,
    value: { preference: 'zh' },
    applies: 'live',
    revision: 2,
  }]
  const describeSettings = vi.fn(() => options.descriptors ?? defaultDescriptors)
  const mutateSettings = vi.fn((
    _namespace: string,
    _ops: readonly { readonly value?: unknown }[],
    _expectedRevision: number,
  ) => Promise.resolve())
  const ctx = new Context()
  ctx.provide('runtimeBootstrap', {
    validateBootstrapSession: (value: string) => value === 'a'.repeat(64),
  } as never)
  ctx.provide('webServer', {
    register: (route: OpenloopSettingsHostRoute) => {
      routes.set(route.path, route)
      return () => {}
    },
  } as never)
  ctx.provide('settings', {
    writable: true,
    describe: describeSettings,
    mutate: mutateSettings,
  } as never)
  ctx.provide('llm', {
    listConfigurableProviders: () => options.configurableProviders ?? [],
    listProviders: () => options.activeProviders ?? [],
  } as never)
  ctx.provide('credentialConsumers', (options.credentialConsumers ?? {
    planDeletion: () => ({ consumers: [] }),
  }) as never)
  apply(ctx)
  return { routes, describeSettings, mutateSettings }
}

async function realSettingsBench() {
  const routes = new Map<string, OpenloopSettingsHostRoute>()
  const ctx = new Context()
  const initial = {
    'llm-deepseek': {
      thinking: false,
      maxTokens: 1024,
    },
  }
  const settingsFiber = ctx.plugin(MemorySettings, initial)
  await settingsFiber.await()
  const provider = ctx.settings as MemorySettings
  const registration = ctx.plugin({
    name: 'settings-host-real-registration',
    inject: ['settings'],
    apply(plugin) {
      plugin.settings.register(
        settingsNamespace('llm-deepseek'),
        Schema.object({
          thinking: Schema.boolean().required(),
          maxTokens: Schema.number().min(1).required(),
        }),
      )
    },
  })
  await registration.await()
  ctx.provide('runtimeBootstrap', {
    validateBootstrapSession: (value: string) => value === 'a'.repeat(64),
  } as never)
  ctx.provide('webServer', {
    register: (route: OpenloopSettingsHostRoute) => {
      routes.set(route.path, route)
      return () => {}
    },
  } as never)
  ctx.provide('llm', {
    listConfigurableProviders: () => [],
    listProviders: () => [],
  } as never)
  apply(ctx)
  return {
    routes,
    provider,
    dispose: async () => {
      await registration.dispose()
      await settingsFiber.dispose()
    },
  }
}

async function call(
  route: OpenloopSettingsHostRoute,
  body: unknown,
  session?: string,
) {
  const recorded = responseRecorder()
  await route.handler(request(body, session), recorded.response)
  return {
    status: recorded.state.status,
    body: JSON.parse(recorded.state.body) as Record<string, unknown>,
  }
}

describe('Openloop settings Host routes', () => {
  it('rejects requests without the current bootstrap session before reading settings', async () => {
    const b = bench()
    const route = b.routes.get(OPENLOOP_SETTINGS_DESCRIBE_PATH)!

    expect(await call(route, { namespaces: ['locale'] })).toMatchObject({
      status: 401,
      body: { error: { code: 'SETTINGS_UNAUTHORIZED' } },
    })
    expect(b.describeSettings).not.toHaveBeenCalled()
  })

  it.each(['short', 'b'.repeat(64)])(
    'rejects malformed or stale bootstrap session %s before reading settings',
    async (session) => {
      const b = bench()
      const route = b.routes.get(OPENLOOP_SETTINGS_DESCRIBE_PATH)!

      expect(await call(route, { namespaces: ['locale'] }, session)).toMatchObject({
        status: 401,
        body: { error: { code: 'SETTINGS_UNAUTHORIZED' } },
      })
      expect(b.describeSettings).not.toHaveBeenCalled()
    },
  )

  it('returns only requested allowed namespaces through an authenticated session', async () => {
    const b = bench()
    const route = b.routes.get(OPENLOOP_SETTINGS_DESCRIBE_PATH)!

    const response = await call(route, { namespaces: ['locale'] }, 'a'.repeat(64))

    expect(response).toMatchObject({
      status: 200,
      body: {
        ok: true,
        value: {
          writable: true,
          hasDocument: false,
          namespaces: [{ ns: 'locale', value: { preference: 'zh' }, revision: 2 }],
        },
      },
    })
    expect(b.describeSettings).toHaveBeenCalledWith({ redactSecrets: true })
  })

  it('recursively projects schema, value, base, and user without leaking denied or unknown fields', async () => {
    const schema = {
      uid: 6,
      refs: {
        0: { type: 'string', meta: {} },
        1: { type: 'string', meta: {} },
        2: { type: 'object', meta: {}, dict: { id: 0, endpoint: 1 } },
        3: { type: 'array', meta: {}, inner: 2 },
        4: { type: 'object', meta: {}, dict: { models: 3, baseURL: 1, apiKeyEnv: 1 } },
        5: { type: 'dict', meta: {}, inner: 4 },
        6: { type: 'object', meta: {}, dict: { providers: 5, credentials: 1 } },
      },
    }
    const layer = {
      providers: {
        openai: {
          models: [{ id: 'gpt-test', endpoint: 'https://secret.invalid', unknown: true }],
          baseURL: 'https://secret.invalid',
          apiKeyEnv: 'OPENAI_API_KEY',
          unknown: true,
        },
        custom: { models: [{ id: 'custom' }] },
      },
      credentials: { token: 'secret' },
    }
    const b = bench({
      descriptors: [{
        ns: 'llm-pi-ai',
        schema,
        value: layer,
        base: layer,
        user: layer,
        applies: 'live',
        secrets: [
          { path: ['providers', 'openai', 'models'], set: true },
          { path: ['providers', 'openai', 'apiKeyEnv'], set: true },
        ],
        revision: 4,
      }],
      configurableProviders: [{
        provider: 'openai',
        displayName: 'OpenAI',
        settingsNs: 'llm-pi-ai',
        settingsPath: ['providers', 'openai'],
        declared: false,
      }],
    })

    const response = await call(
      b.routes.get(OPENLOOP_SETTINGS_DESCRIBE_PATH)!,
      { namespaces: ['llm-pi-ai'] },
      'a'.repeat(64),
    )

    expect(response.status).toBe(200)
    expect(response.body).toMatchObject({
      value: {
        namespaces: [{
          value: { providers: { openai: { models: [{ id: 'gpt-test' }] } } },
          base: { providers: { openai: { models: [{ id: 'gpt-test' }] } } },
          user: { providers: { openai: { models: [{ id: 'gpt-test' }] } } },
          secrets: [{ path: ['providers', 'openai', 'models'], set: true }],
        }],
      },
    })
    expect(JSON.stringify(response.body))
      .not.toMatch(/baseURL|endpoint|credentials|apiKeyEnv|secret\.invalid|unknown|custom/u)
  })

  it('lists and projects a declared provider backed by the exact bundled base path', async () => {
    const layer = {
      providers: {
        'volcengine-agent-plan': agentPlanProfile,
      },
    }
    const b = bench({
      descriptors: [agentPlanDescriptor({ base: layer })],
      configurableProviders: [{
        provider: 'volcengine-agent-plan',
        displayName: '火山方舟 Agent Plan',
        settingsNs: 'llm-pi-ai',
        settingsPath: ['providers', 'volcengine-agent-plan'],
        declared: true,
      }],
    })

    const providersResponse = await call(
      b.routes.get(OPENLOOP_SETTINGS_PROVIDERS_PATH)!,
      {},
      'a'.repeat(64),
    )
    const describeResponse = await call(
      b.routes.get(OPENLOOP_SETTINGS_DESCRIBE_PATH)!,
      { namespaces: ['llm-pi-ai'] },
      'a'.repeat(64),
    )

    expect(providersResponse).toMatchObject({
      status: 200,
      body: {
        value: {
          providers: [{
            provider: 'volcengine-agent-plan',
            displayName: '火山方舟 Agent Plan',
            builtIn: true,
          }],
        },
      },
    })
    expect(describeResponse).toMatchObject({
      status: 200,
      body: {
        value: {
          namespaces: [{
            value: {
              providers: {
                'volcengine-agent-plan': {
                  models: [{ id: 'glm-5.3-flash' }],
                },
              },
            },
          }],
        },
      },
    })
    expect(JSON.stringify([providersResponse.body, describeResponse.body]))
      .not.toMatch(/baseURL|apiKeyEnv|VOLCENGINE_ARK_AGENT_PLAN_API_KEY|ark\.invalid/u)
  })

  it('allows model mutation for a declared provider backed by the exact bundled base path', async () => {
    const layer = {
      providers: {
        'volcengine-agent-plan': agentPlanProfile,
      },
    }
    const b = bench({
      descriptors: [agentPlanDescriptor({ base: layer })],
      configurableProviders: [{
        provider: 'volcengine-agent-plan',
        displayName: '火山方舟 Agent Plan',
        settingsNs: 'llm-pi-ai',
        settingsPath: ['providers', 'volcengine-agent-plan'],
        declared: true,
      }],
    })
    const ops = [{
      op: 'set' as const,
      path: ['providers', 'volcengine-agent-plan', 'models'],
      value: [{ id: 'glm-5.3-flash' }],
    }]

    const response = await call(
      b.routes.get(OPENLOOP_SETTINGS_MUTATE_PATH)!,
      { ns: 'llm-pi-ai', ops, expectedRevision: 5 },
      'a'.repeat(64),
    )

    expect(response.status).toBe(200)
    expect(b.mutateSettings).toHaveBeenCalledWith('llm-pi-ai', ops, 5)
  })

  it.each([
    {
      label: 'only in value and user',
      descriptor: agentPlanDescriptor({
        user: { providers: { 'volcengine-agent-plan': agentPlanProfile } },
      }),
      settingsNs: 'llm-pi-ai',
      settingsPath: ['providers', 'volcengine-agent-plan'],
    },
    {
      label: 'registered under another namespace',
      descriptor: agentPlanDescriptor({
        base: { providers: { 'volcengine-agent-plan': agentPlanProfile } },
      }),
      settingsNs: 'llm-custom',
      settingsPath: ['providers', 'volcengine-agent-plan'],
    },
    {
      label: 'registered at a non-exact path',
      descriptor: agentPlanDescriptor({
        base: { providers: { 'volcengine-agent-plan': agentPlanProfile } },
      }),
      settingsNs: 'llm-pi-ai',
      settingsPath: ['providers', 'volcengine-agent-plan', 'profile'],
    },
  ])('excludes and denies a declared provider $label', async ({
    descriptor,
    settingsNs,
    settingsPath,
  }) => {
    const b = bench({
      descriptors: [descriptor],
      configurableProviders: [{
        provider: 'volcengine-agent-plan',
        displayName: '火山方舟 Agent Plan',
        settingsNs,
        settingsPath,
        declared: true,
      }],
    })

    const providersResponse = await call(
      b.routes.get(OPENLOOP_SETTINGS_PROVIDERS_PATH)!,
      {},
      'a'.repeat(64),
    )
    const mutationResponse = await call(
      b.routes.get(OPENLOOP_SETTINGS_MUTATE_PATH)!,
      {
        ns: 'llm-pi-ai',
        ops: [{
          op: 'set',
          path: ['providers', 'volcengine-agent-plan', 'models'],
          value: [{ id: 'glm-5.3-flash' }],
        }],
        expectedRevision: 5,
      },
      'a'.repeat(64),
    )

    expect(providersResponse).toMatchObject({
      status: 200,
      body: { value: { providers: [] } },
    })
    expect(mutationResponse).toMatchObject({
      status: 403,
      body: { error: { code: 'SETTINGS_POLICY_DENIED' } },
    })
    expect(b.mutateSettings).not.toHaveBeenCalled()
  })

  it('projects only credential references owned by the matching registered Host model consumer', async () => {
    const b = bench({
      descriptors: [{
        ns: 'llm-pi-ai',
        schema: {},
        value: {
          providers: {
            openai: {
              apiKeyEnv: 'OPENAI_API_KEY',
              apiKey: 'must-not-leak',
              baseURL: 'https://proxy.invalid',
            },
          },
        },
        applies: 'live',
        revision: 4,
      }],
      configurableProviders: [{
        provider: 'openai',
        displayName: 'OpenAI',
        settingsNs: 'llm-pi-ai',
        settingsPath: ['providers', 'openai'],
        declared: false,
      }, {
        provider: 'custom-route',
        displayName: 'Custom Route',
        settingsNs: 'llm-pi-ai',
        settingsPath: ['providers', 'custom-route'],
        declared: true,
      }],
      activeProviders: [
        { id: 'openai', name: 'OpenAI' },
        { id: 'custom-route', name: 'Custom Route' },
      ],
      credentialConsumers: {
        planDeletion: () => ({
          consumers: [{
            kind: 'model-route',
            display: {
              key: 'openloop.credentials.consumer.model-route',
              values: { routeId: 'openai' },
            },
          }],
        }),
      },
    })
    const route = b.routes.get(OPENLOOP_SETTINGS_PROVIDERS_PATH)!

    const response = await call(route, {}, 'a'.repeat(64))

    expect(response).toMatchObject({
      status: 200,
      body: {
        value: {
          providers: [{
            provider: 'openai',
            builtIn: true,
            credentialRef: 'OPENAI_API_KEY',
          }],
        },
      },
    })
    expect(JSON.stringify(response.body)).not.toContain('must-not-leak')
    expect(JSON.stringify(response.body)).not.toContain('proxy.invalid')
    expect((response.body as {
      value: { providers: Array<Record<string, unknown>> }
    }).value.providers).toHaveLength(1)
    expect((response.body as {
      value: { providers: Array<Record<string, unknown>> }
    }).value.providers[0]).not.toHaveProperty('declared')
  })

  it('omits a credential reference without a matching registered Host model consumer', async () => {
    const descriptors: TestSettingsDescriptor[] = [{
      ns: 'llm-pi-ai',
      schema: {},
      value: { providers: { openai: { apiKeyEnv: 'OPENAI_API_KEY' } } },
      applies: 'live',
      revision: 4,
    }]
    const configurableProviders = [{
      provider: 'openai',
      displayName: 'OpenAI',
      settingsNs: 'llm-pi-ai',
      settingsPath: ['providers', 'openai'],
      declared: false,
    }]
    const missing = bench({ descriptors, configurableProviders })
    const wrongConsumer = bench({
      descriptors,
      configurableProviders,
      credentialConsumers: {
        planDeletion: () => ({
          consumers: [{
            kind: 'plugin',
            display: {
              key: 'openloop.credentials.consumer.web-search-deepseek',
              values: {},
            },
          }],
        }),
      },
    })

    for (const b of [missing, wrongConsumer]) {
      const response = await call(
        b.routes.get(OPENLOOP_SETTINGS_PROVIDERS_PATH)!,
        {},
        'a'.repeat(64),
      )
      expect(response.body).toMatchObject({
        value: { providers: [{ provider: 'openai' }] },
      })
      expect(JSON.stringify(response.body)).not.toContain('credentialRef')
      expect(JSON.stringify(response.body)).not.toContain('OPENAI_API_KEY')
    }
  })

  it('rejects a denied mutation before calling settings.mutate', async () => {
    const b = bench()
    const route = b.routes.get(OPENLOOP_SETTINGS_MUTATE_PATH)!

    expect(await call(route, {
      ns: 'web-search-deepseek',
      ops: [
        { op: 'set', path: ['maxUses'], value: 4 },
        { op: 'set', path: ['baseURL'], value: 'https://attacker.invalid' },
      ],
      expectedRevision: 2,
    }, 'a'.repeat(64))).toMatchObject({
      status: 403,
      body: { error: { code: 'SETTINGS_POLICY_DENIED' } },
    })
    expect(b.mutateSettings).not.toHaveBeenCalled()
  })

  it('atomically rejects mixed valid and schema-invalid operations without persistence', async () => {
    const b = await realSettingsBench()
    try {
      const route = b.routes.get(OPENLOOP_SETTINGS_MUTATE_PATH)!
      const response = await call(route, {
        ns: 'llm-deepseek',
        ops: [
          { op: 'set', path: ['thinking'], value: true },
          { op: 'set', path: ['maxTokens'], value: 0 },
        ],
        expectedRevision: 0,
      }, 'a'.repeat(64))

      expect(response).toMatchObject({
        status: 422,
        body: { error: { code: 'SETTINGS_VALIDATION_FAILED' } },
      })
      expect(b.provider.persisted).toEqual([])
      expect(b.provider.doc).toEqual({
        'llm-deepseek': { thinking: false, maxTokens: 1024 },
      })
      expect(b.provider.describe({ redactSecrets: true })[0]).toMatchObject({
        value: { thinking: false, maxTokens: 1024 },
        user: { thinking: false, maxTokens: 1024 },
        revision: 0,
      })
    } finally {
      await b.dispose()
    }
  })

  it('rejects duplicate namespace reads before describing settings', async () => {
    const b = bench()
    const route = b.routes.get(OPENLOOP_SETTINGS_DESCRIBE_PATH)!

    expect(await call(
      route,
      { namespaces: ['locale', 'locale'] },
      'a'.repeat(64),
    )).toMatchObject({
      status: 403,
      body: { error: { code: 'SETTINGS_POLICY_DENIED' } },
    })
    expect(b.describeSettings).not.toHaveBeenCalled()
  })

  it.each([
    ['not-json', '{'],
    ['oversized', JSON.stringify({ namespaces: ['locale'], padding: 'x'.repeat(65 * 1024) })],
  ])('rejects %s bodies before describing settings', async (_label, body) => {
    const b = bench()
    const route = b.routes.get(OPENLOOP_SETTINGS_DESCRIBE_PATH)!
    const recorded = responseRecorder()

    await route.handler(rawRequest(body, 'a'.repeat(64)), recorded.response)

    expect(recorded.state.status).toBe(400)
    expect(JSON.parse(recorded.state.body)).toMatchObject({
      error: { code: 'SETTINGS_INVALID_REQUEST' },
    })
    expect(b.describeSettings).not.toHaveBeenCalled()
  })

  it('rejects a malformed revision before mutating settings', async () => {
    const b = bench()
    const route = b.routes.get(OPENLOOP_SETTINGS_MUTATE_PATH)!

    expect(await call(route, {
      ns: 'locale',
      ops: [{ op: 'set', path: ['preference'], value: 'en' }],
      expectedRevision: '2',
    }, 'a'.repeat(64))).toMatchObject({
      status: 400,
      body: { error: { code: 'SETTINGS_INVALID_REQUEST' } },
    })
    expect(b.mutateSettings).not.toHaveBeenCalled()
  })

  it('commits an allowed revision-fenced mutation and returns the new descriptor', async () => {
    const b = bench()
    const route = b.routes.get(OPENLOOP_SETTINGS_MUTATE_PATH)!

    const response = await call(route, {
      ns: 'locale',
      ops: [{ op: 'set', path: ['preference'], value: 'en' }],
      expectedRevision: 2,
    }, 'a'.repeat(64))

    expect(response.status).toBe(200)
    expect(b.mutateSettings).toHaveBeenCalledWith(
      'locale',
      [{ op: 'set', path: ['preference'], value: 'en' }],
      2,
    )
  })

  it('prevents a stale client from overwriting a newer mutation', async () => {
    const b = bench()
    let preference = 'zh'
    let revision = 2
    b.describeSettings.mockImplementation(() => [{
      ns: 'locale',
      schema: localeSchema,
      value: { preference },
      applies: 'live',
      revision,
    }])
    b.mutateSettings.mockImplementation(async (_namespace, _ops, expectedRevision) => {
      if (expectedRevision !== revision) {
        const conflict = new Error('stale revision')
        conflict.name = 'SettingsConflictError'
        throw conflict
      }
      preference = 'en'
      revision += 1
    })
    const route = b.routes.get(OPENLOOP_SETTINGS_MUTATE_PATH)!

    const first = await call(route, {
      ns: 'locale',
      ops: [{ op: 'set', path: ['preference'], value: 'en' }],
      expectedRevision: 2,
    }, 'a'.repeat(64))
    const stale = await call(route, {
      ns: 'locale',
      ops: [{ op: 'set', path: ['preference'], value: 'zh' }],
      expectedRevision: 2,
    }, 'a'.repeat(64))

    expect(first).toMatchObject({
      status: 200,
      body: { value: { value: { preference: 'en' }, revision: 3 } },
    })
    expect(stale).toMatchObject({
      status: 409,
      body: { error: { code: 'SETTINGS_CONFLICT' } },
    })
    expect({ preference, revision }).toEqual({ preference: 'en', revision: 3 })
  })

  it.each([
    [{ name: 'SettingsConflictError' }, 409, 'SETTINGS_CONFLICT'],
    [new TypeError('invalid setting'), 422, 'SETTINGS_VALIDATION_FAILED'],
    [new Error('settings storage unavailable'), 503, 'SETTINGS_UNAVAILABLE'],
  ])('maps mutation failure %o without reading a post-write descriptor', async (
    failure,
    status,
    code,
  ) => {
    const b = bench()
    b.mutateSettings.mockRejectedValueOnce(failure)
    const route = b.routes.get(OPENLOOP_SETTINGS_MUTATE_PATH)!

    const response = await call(route, {
      ns: 'locale',
      ops: [{ op: 'set', path: ['preference'], value: 'en' }],
      expectedRevision: 2,
    }, 'a'.repeat(64))

    expect(response).toMatchObject({ status, body: { error: { code } } })
    expect(b.describeSettings).not.toHaveBeenCalled()
  })

  it('reports unavailable when a successful write has no descriptor', async () => {
    const b = bench()
    b.describeSettings.mockReturnValueOnce([])
    const route = b.routes.get(OPENLOOP_SETTINGS_MUTATE_PATH)!

    const response = await call(route, {
      ns: 'locale',
      ops: [{ op: 'set', path: ['preference'], value: 'en' }],
      expectedRevision: 2,
    }, 'a'.repeat(64))

    expect(response).toMatchObject({
      status: 503,
      body: { error: { code: 'SETTINGS_UNAVAILABLE' } },
    })
  })
})
