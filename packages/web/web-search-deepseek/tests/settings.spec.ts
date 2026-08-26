/** The `web-search-deepseek` settings section layered over the composition entry. */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Fiber } from '@deepseek-ai/cordis'
import { SettingsProvider } from '@deepseek-ai/dsh-settings'
import type { SettingsNamespace } from '@deepseek-ai/dsh-settings'
import WebRuntime from '@deepseek-ai/dsh-web'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import * as deepseekPlugin from '@deepseek-ai/dsh-web-search-deepseek'
import { WEB_SEARCH_DEEPSEEK_SETTINGS_NAMESPACE } from '@deepseek-ai/dsh-web-search-deepseek'

/** The smallest real provider: one in-memory document, always writable. */
class MemorySettings extends SettingsProvider {
  doc: Record<string, unknown> = {}

  get writable(): boolean {
    return true
  }

  protected load(): Promise<Record<string, unknown>> {
    return Promise.resolve(structuredClone(this.doc))
  }

  protected persist(ns: SettingsNamespace, section: Record<string, unknown>): Promise<void> {
    this.doc = { ...this.doc, [ns]: structuredClone(section) }
    return Promise.resolve()
  }
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

/** The smallest Anthropic-shaped answer the provider accepts — enough to observe the request. */
const ONE_RESULT = {
  content: [
    { type: 'text', text: 'ok' },
    {
      type: 'web_search_tool_result',
      content: [{ type: 'web_search_result', url: 'https://a.test', title: 'A' }],
    },
  ],
}

async function boot(): Promise<{ ctx: Context; settingsFiber: Fiber; pluginFiber: Fiber }> {
  const ctx = new Context()
  await ctx.plugin(WebRuntime, {})
  const settingsFiber = ctx.plugin(MemorySettings)
  await settingsFiber.await()
  const pluginFiber = ctx.plugin(deepseekPlugin, { apiKey: 'ds-key', baseURL: 'https://search.entry.test/v1' })
  await pluginFiber.await()
  return { ctx, settingsFiber, pluginFiber }
}

afterEach(() => {
  vi.restoreAllMocks()
})

/**
 * Run one search and answer the endpoint it reached. A fresh `Response` per
 * call because a body can only be read once, and the call history is cleared
 * because repeated `spyOn` returns the same spy.
 * @param ctx - context whose `ctx.web` serves the search.
 * @returns the URL the provider fetched.
 */
async function searchOnce(ctx: Context): Promise<string> {
  const fetchSpy = vi.spyOn(globalThis, 'fetch')
    .mockImplementation(() => Promise.resolve(jsonResponse(ONE_RESULT)))
  fetchSpy.mockClear()
  await ctx.web.search({ query: 'anything' })
  return String((fetchSpy.mock.calls.at(-1)?.[0] as URL | string | undefined) ?? '')
}

describe('web-search-deepseek settings section', () => {
  it('registers only the credential reference that actually wins after settings changes', async () => {
    const firstDispose = vi.fn()
    const secondDispose = vi.fn()
    const secondReplace = vi.fn()
    const registerDeepSeekWebSearch = vi.fn()
      .mockReturnValueOnce({ replace: vi.fn(), dispose: firstDispose })
      .mockReturnValueOnce({ replace: secondReplace, dispose: secondDispose })
    const ctx = new Context()
    await ctx.plugin(WebRuntime, {})
    await ctx.plugin(MemorySettings)
    ctx.provide('credentialConsumers', { registerDeepSeekWebSearch } as never)
    const pluginFiber = ctx.plugin(deepseekPlugin, {
      apiKeyEnv: 'ACTIVE_REFERENCE',
    })
    await pluginFiber.await()

    expect(registerDeepSeekWebSearch).toHaveBeenCalledTimes(1)
    expect(registerDeepSeekWebSearch)
      .toHaveBeenLastCalledWith(credentialRef('ACTIVE_REFERENCE'))

    await ctx.settings.update(WEB_SEARCH_DEEPSEEK_SETTINGS_NAMESPACE, {
      apiKey: 'literal-first',
      apiKeyEnv: 'IGNORED_REFERENCE',
    })
    await vi.waitFor(() => {
      expect(firstDispose).toHaveBeenCalledTimes(1)
    })
    expect(registerDeepSeekWebSearch).toHaveBeenCalledTimes(1)

    await ctx.settings.replace(WEB_SEARCH_DEEPSEEK_SETTINGS_NAMESPACE, {
      apiKeyEnv: 'ACTIVE_REFERENCE',
    })
    await vi.waitFor(() => {
      expect(registerDeepSeekWebSearch).toHaveBeenCalledTimes(2)
    })
    expect(registerDeepSeekWebSearch)
      .toHaveBeenLastCalledWith(credentialRef('ACTIVE_REFERENCE'))

    await ctx.settings.update(WEB_SEARCH_DEEPSEEK_SETTINGS_NAMESPACE, {
      apiKeyEnv: 'ROTATED_REFERENCE',
    })
    await vi.waitFor(() => {
      expect(secondReplace).toHaveBeenCalledWith(credentialRef('ROTATED_REFERENCE'))
    })
    expect(registerDeepSeekWebSearch).toHaveBeenCalledTimes(2)

    await pluginFiber.dispose()
    expect(secondDispose).toHaveBeenCalledTimes(1)
    await ctx.fiber.dispose()
  })

  it('keeps the prior consumer after a refused reference replacement and survives a revert', async () => {
    let activeReference = credentialRef('ACTIVE_REFERENCE')
    const replace = vi.fn((reference: ReturnType<typeof credentialRef>) => {
      if (reference === 'REJECTED_REFERENCE') throw new Error('consumer capacity exceeded')
      activeReference = reference
    })
    const ctx = new Context()
    await ctx.plugin(WebRuntime, {})
    await ctx.plugin(MemorySettings)
    ctx.provide('credentialConsumers', {
      registerDeepSeekWebSearch: vi.fn((reference: ReturnType<typeof credentialRef>) => {
        activeReference = reference
        return { replace, dispose: vi.fn() }
      }),
    } as never)
    await ctx.plugin(deepseekPlugin, { apiKeyEnv: 'ACTIVE_REFERENCE' })

    await ctx.settings.update(WEB_SEARCH_DEEPSEEK_SETTINGS_NAMESPACE, {
      apiKeyEnv: 'REJECTED_REFERENCE',
    })
    expect(activeReference).toBe(credentialRef('ACTIVE_REFERENCE'))

    await ctx.settings.replace(WEB_SEARCH_DEEPSEEK_SETTINGS_NAMESPACE, {})
    expect(activeReference).toBe(credentialRef('ACTIVE_REFERENCE'))
    expect(replace).toHaveBeenCalledTimes(1)
    await ctx.fiber.dispose()
  })

  it('serves a stored endpoint to the next search without re-registering the provider', async () => {
    const bench = await boot()
    expect(await searchOnce(bench.ctx)).toContain('https://search.entry.test/v1')

    await bench.ctx.settings.update(WEB_SEARCH_DEEPSEEK_SETTINGS_NAMESPACE, {
      baseURL: 'https://search.stored.test/v1',
    })

    expect(await searchOnce(bench.ctx)).toContain('https://search.stored.test/v1')
    await bench.ctx.fiber.dispose()
  })

  it('keeps the literal key out of every described layer', async () => {
    const bench = await boot()
    await bench.ctx.settings.update(WEB_SEARCH_DEEPSEEK_SETTINGS_NAMESPACE, { apiKey: 'ds-stored-secret' })

    const [descriptor] = bench.ctx.settings.describe({ redactSecrets: true })
      .filter(row => String(row.ns) === 'web-search-deepseek')

    expect(JSON.stringify(descriptor)).not.toContain('ds-stored-secret')
    expect(descriptor?.secrets).toEqual([{ path: ['apiKey'], set: true }])
    await bench.ctx.fiber.dispose()
  })

  it('falls back to the composition entry when the settings provider detaches', async () => {
    const bench = await boot()
    await bench.ctx.settings.update(WEB_SEARCH_DEEPSEEK_SETTINGS_NAMESPACE, {
      baseURL: 'https://search.stored.test/v1',
    })
    expect(await searchOnce(bench.ctx)).toContain('https://search.stored.test/v1')

    await bench.settingsFiber.dispose()

    expect(await searchOnce(bench.ctx)).toContain('https://search.entry.test/v1')
    await bench.ctx.fiber.dispose()
  })

  it('releases the namespace when the plugin unloads', async () => {
    const bench = await boot()
    expect(bench.ctx.settings.describe().map(row => String(row.ns))).toContain('web-search-deepseek')

    await bench.pluginFiber.dispose()

    expect(bench.ctx.settings.describe().map(row => String(row.ns))).not.toContain('web-search-deepseek')
    await bench.ctx.fiber.dispose()
  })
})
