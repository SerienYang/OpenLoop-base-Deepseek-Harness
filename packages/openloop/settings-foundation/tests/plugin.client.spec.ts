import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import {
  apply,
  inject,
  OpenloopSettingsScopeBinder,
} from '../src/client/index.ts'

describe('Openloop settings foundation', () => {
  it('provides unavailable memory scopes without Host transport dependencies', async () => {
    const ctx = new Context()
    const fiber = ctx.plugin({ inject: [...inject], apply })
    await fiber.await()

    expect(inject).toEqual([])
    const binder = ctx.get('settingsScope') as OpenloopSettingsScopeBinder
    expect(binder).toBeInstanceOf(OpenloopSettingsScopeBinder)

    const scope = binder.bind<{ preference: string }>({ namespace: 'theme' })
    const snapshot = scope.getSnapshot()
    const listener = vi.fn()
    const unsubscribe = scope.subscribe(listener)

    expect(snapshot).toEqual({
      status: 'unavailable',
      value: undefined,
      base: undefined,
      user: undefined,
      revision: undefined,
      writable: false,
      mode: 'memory',
    })
    await scope.set('preference', 'dark')
    await scope.unset('preference')
    expect(scope.getSnapshot()).toBe(snapshot)
    expect(listener).not.toHaveBeenCalled()

    unsubscribe()
    await fiber.dispose()
    expect(ctx.get('settingsScope')).toBeUndefined()
  })
})
