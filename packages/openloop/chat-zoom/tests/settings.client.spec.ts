import { Context } from '@deepseek-ai/cordis'
import { SettingsProvider, settingsNamespace, type SettingsNamespace } from '@deepseek-ai/dsh-settings'
import { describe, expect, it } from 'vitest'
import {
  CHAT_ZOOM_SETTINGS_NAMESPACE,
  apply,
} from '../src/index.ts'

class MemorySettings extends SettingsProvider {
  readonly writable = true
  protected load(): Promise<Record<string, unknown>> { return Promise.resolve({}) }
  protected persist(_ns: SettingsNamespace, _section: Record<string, unknown>): Promise<void> {
    return Promise.resolve()
  }
}

describe('chat zoom Host settings', () => {
  it('registers a durable bounded percentage and disposes it with the plugin', async () => {
    const ctx = new Context()
    await ctx.plugin(MemorySettings).await()
    const fiber = ctx.plugin({ apply })
    await fiber.await()

    const ns = settingsNamespace(CHAT_ZOOM_SETTINGS_NAMESPACE)
    expect(ctx.settings.get(ns)).toEqual({ percent: 100 })
    await ctx.settings.update(ns, { percent: 130 })
    expect(ctx.settings.get(ns)).toEqual({ percent: 130 })
    await expect(ctx.settings.update(ns, { percent: 115 })).rejects.toThrow()

    await fiber.dispose()
    expect(ctx.settings.describe().map(row => row.ns)).not.toContain(ns)
  })

  it('does not require the optional settings service', () => {
    expect(() => { apply(new Context()) }).not.toThrow()
  })
})
