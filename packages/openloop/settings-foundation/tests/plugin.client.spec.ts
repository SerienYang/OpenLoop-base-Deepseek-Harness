import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { describe, expect, it, vi } from 'vitest'
import { TestRemote } from '@deepseek-ai/dsh-client-test-runtime'
import {
  apply,
  inject,
  OpenloopSettingsApi,
} from '../src/client/index.ts'

function response(value: unknown): Response {
  return {
    ok: true,
    json: () => Promise.resolve(value),
  } as Response
}

describe('Openloop settings foundation', () => {
  it('provides host-backed scopes through the authenticated settings routes', async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(response({
        ok: true,
        value: {
          writable: true,
          hasDocument: false,
          namespaces: [{
            ns: 'locale',
            schema: z.object({
              preference: z.union(['zh', 'en']).default('zh'),
            }).toJSON(),
            value: { preference: 'zh' },
            applies: 'live',
            secrets: [],
            revision: 2,
          }],
        },
      }))
      .mockResolvedValueOnce(response({
        ok: true,
        value: {
          ns: 'locale',
          schema: z.object({
            preference: z.union(['zh', 'en']).default('zh'),
          }).toJSON(),
          value: { preference: 'en' },
          applies: 'live',
          secrets: [],
          revision: 3,
        },
      }))
    const ctx = new Context()
    ctx.provide('connection', { isLoopback: true, api: {} } as never)
    new TestRemote(ctx)
    const fiber = ctx.plugin({
      inject: [...inject],
      apply: plugin => apply(plugin, new OpenloopSettingsApi(fetcher)),
    })
    await fiber.await()

    expect(inject).toEqual(['connection', 'remote'])
    const scope = ctx.settingsScope.bind<{ preference: string }>({ namespace: 'locale' })
    await vi.waitFor(() => {
      expect(scope.getSnapshot()).toMatchObject({
        status: 'ready',
        value: { preference: 'zh' },
        revision: 2,
        writable: true,
        mode: 'host',
      })
    })

    await scope.set('preference', 'en')

    expect(fetcher).toHaveBeenNthCalledWith(
      1,
      '/api/openloop/settings/describe',
      expect.objectContaining({
        method: 'POST',
        credentials: 'same-origin',
        body: JSON.stringify({
          namespaces: [
            'locale',
            'ui-theme',
            'ui-conversation',
            'agent-loop',
            'shell',
            'web-search-deepseek',
            'llm-deepseek',
            'llm-pi-ai',
            'ui-onboarding',
          ],
        }),
      }),
    )
    expect(fetcher).toHaveBeenNthCalledWith(
      2,
      '/api/openloop/settings/mutate',
      expect.objectContaining({
        method: 'POST',
        credentials: 'same-origin',
        body: JSON.stringify({
          ns: 'locale',
          ops: [{ op: 'set', path: ['preference'], value: 'en' }],
          expectedRevision: 2,
        }),
      }),
    )
    expect(scope.getSnapshot()).toMatchObject({
      status: 'ready',
      value: { preference: 'en' },
      revision: 3,
    })
    await fiber.dispose()
  })

  it('does not expose endpoint discovery through the product API', async () => {
    const api = new OpenloopSettingsApi(vi.fn())
    const result = await api.llm.discoverModels({ settingsNs: 'llm-pi-ai' })
    expect(result.result).toMatchObject({
      ok: false,
      error: { code: 'policy-denied' },
    })
  })

  it('stops providing settings services with the plugin lifetime', async () => {
    const ctx = new Context()
    ctx.provide('connection', { isLoopback: true, api: {} } as never)
    new TestRemote(ctx)
    const fiber = ctx.plugin({
      inject: [...inject],
      apply: plugin => apply(plugin, new OpenloopSettingsApi(vi.fn())),
    })
    await fiber.await()
    expect(ctx.get('settingsScope')).toBeDefined()
    expect(ctx.get('openloopSettingsApi')).toBeDefined()

    await fiber.dispose()
    expect(ctx.get('settingsScope')).toBeUndefined()
    expect(ctx.get('openloopSettingsApi')).toBeUndefined()
  })
})
