import { Readable } from 'node:stream'
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import {
  OPENLOOP_SETTINGS_DESCRIBE_PATH,
  OPENLOOP_SETTINGS_MUTATE_PATH,
  apply,
  type OpenloopSettingsHostRoute,
} from '../src/settings-host.ts'

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
  return Object.assign(Readable.from([JSON.stringify(body)]), {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(session === undefined ? {} : { cookie: `openloop_bootstrap=${session}` }),
    },
  }) as unknown as OpenloopSettingsHostRoute['request']
}

function bench() {
  const routes = new Map<string, OpenloopSettingsHostRoute>()
  const describeSettings = vi.fn(() => [{
    ns: 'locale',
    schema: {},
    value: { preference: 'zh' },
    applies: 'live',
    revision: 2,
  }])
  const mutateSettings = vi.fn(() => Promise.resolve())
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
    listConfigurableProviders: () => [],
    listProviders: () => [],
  } as never)
  apply(ctx)
  return { routes, describeSettings, mutateSettings }
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

  it('rejects a denied mutation before calling settings.mutate', async () => {
    const b = bench()
    const route = b.routes.get(OPENLOOP_SETTINGS_MUTATE_PATH)!

    expect(await call(route, {
      ns: 'web-search-deepseek',
      ops: [{ op: 'set', path: ['baseURL'], value: 'https://attacker.invalid' }],
      expectedRevision: 2,
    }, 'a'.repeat(64))).toMatchObject({
      status: 403,
      body: { error: { code: 'SETTINGS_POLICY_DENIED' } },
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
})
