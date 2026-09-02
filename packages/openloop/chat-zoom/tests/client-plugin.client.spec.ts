// @vitest-environment jsdom
import { Context } from '@deepseek-ai/cordis'
import type { SettingsScopeSnapshot } from '@deepseek-ai/dsh-client-runtime/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { apply, inject } from '../src/client/index.ts'
import type { ChatZoomSettings } from '../src/settings.ts'

function ready(percent: ChatZoomSettings['percent']): SettingsScopeSnapshot<ChatZoomSettings> {
  return {
    status: 'ready',
    value: { percent },
    base: { percent: 100 },
    user: { percent },
    revision: 1,
    writable: true,
    mode: 'host',
  }
}

function unavailable(): SettingsScopeSnapshot<ChatZoomSettings> {
  return {
    status: 'unavailable',
    value: undefined,
    base: undefined,
    user: undefined,
    revision: undefined,
    writable: false,
    mode: 'memory',
  }
}

function bench(
  initial: SettingsScopeSnapshot<ChatZoomSettings> = ready(100),
) {
  const ctx = new Context()
  let snapshot = initial
  const subscribers = new Set<() => void>()
  const set = vi.fn<(field: string, value: unknown) => Promise<void>>(() => Promise.resolve())
  const scope = {
    getSnapshot: () => snapshot,
    subscribe: (listener: () => void) => {
      subscribers.add(listener)
      return () => { subscribers.delete(listener) }
    },
    set,
    unset: vi.fn(() => Promise.resolve()),
  }
  ctx.provide('connection', {} as never)
  ctx.provide('remote', {} as never)
  ctx.provide('settingsScope', { bind: () => scope } as never)
  return {
    ctx,
    set,
    publish: (next: SettingsScopeSnapshot<ChatZoomSettings>) => {
      snapshot = next
      for (const subscriber of subscribers) subscriber()
    },
  }
}

function shortcut(key: string, init: KeyboardEventInit = {}): KeyboardEvent {
  const event = new KeyboardEvent('keydown', {
    key,
    metaKey: true,
    cancelable: true,
    ...init,
  })
  document.dispatchEvent(event)
  return event
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  localStorage.clear()
  document.documentElement.style.removeProperty('--openloop-chat-text-scale')
})

describe('chat zoom browser plugin', () => {
  it('publishes Host state and handles Command shortcuts without page zoom', async () => {
    const b = bench(ready(120))
    const fiber = b.ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    expect(document.documentElement.style.getPropertyValue('--openloop-chat-text-scale')).toBe('1.2')

    const increase = shortcut('+', { shiftKey: true })
    expect(increase.defaultPrevented).toBe(true)
    expect(document.documentElement.style.getPropertyValue('--openloop-chat-text-scale')).toBe('1.3')
    expect(b.set).toHaveBeenLastCalledWith('percent', 130)

    shortcut('-')
    expect(b.set).toHaveBeenLastCalledWith('percent', 120)
    shortcut('0')
    expect(b.set).toHaveBeenLastCalledWith('percent', 100)

    const ignored = shortcut('a')
    expect(ignored.defaultPrevented).toBe(false)
    expect(b.set).toHaveBeenCalledTimes(3)
    await fiber.dispose()
  })

  it('adopts Host recovery state and restores the previous CSS value on disposal', async () => {
    document.documentElement.style.setProperty('--openloop-chat-text-scale', '')
    const b = bench(ready(130))
    const fiber = b.ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    b.publish(ready(90))
    expect(document.documentElement.style.getPropertyValue('--openloop-chat-text-scale')).toBe('0.9')

    await fiber.dispose()
    expect(document.documentElement.style.getPropertyValue('--openloop-chat-text-scale')).toBe('')
    const after = shortcut('+', { shiftKey: true })
    expect(after.defaultPrevented).toBe(false)
  })

  it('does not let an intermediate Host response lose rapid shortcut increments', async () => {
    const b = bench(ready(100))
    let settleFirst!: () => void
    b.set.mockImplementationOnce(() => new Promise<void>((resolve) => { settleFirst = resolve }))
    const fiber = b.ctx.plugin({ inject: [...inject], apply })
    await fiber.await()

    shortcut('+', { shiftKey: true })
    shortcut('+', { shiftKey: true })
    b.publish(ready(110))
    shortcut('+', { shiftKey: true })

    expect(document.documentElement.style.getPropertyValue('--openloop-chat-text-scale')).toBe('1.3')
    expect(b.set).toHaveBeenLastCalledWith('percent', 130)
    settleFirst()
    await fiber.dispose()
  })

  it('persists process-local zoom when Host settings are unavailable', async () => {
    const first = bench(unavailable())
    const firstFiber = first.ctx.plugin({ inject: [...inject], apply })
    await firstFiber.await()

    shortcut('+', { shiftKey: true })
    await vi.waitFor(() => {
      expect(document.documentElement.style.getPropertyValue('--openloop-chat-text-scale'))
        .toBe('1.1')
    })
    await firstFiber.dispose()

    const second = bench(unavailable())
    const secondFiber = second.ctx.plugin({ inject: [...inject], apply })
    await secondFiber.await()
    expect(document.documentElement.style.getPropertyValue('--openloop-chat-text-scale')).toBe('1.1')
    await secondFiber.dispose()
  })

  it('keeps process-local zoom usable when storage access is denied', async () => {
    vi.spyOn(globalThis, 'localStorage', 'get').mockImplementation(() => {
      throw new DOMException('denied', 'SecurityError')
    })
    const b = bench(unavailable())
    const fiber = b.ctx.plugin({ inject: [...inject], apply })
    await expect(fiber.await()).resolves.toBeDefined()

    expect(() => shortcut('+', { shiftKey: true })).not.toThrow()
    await Promise.resolve()
    expect(document.documentElement.style.getPropertyValue('--openloop-chat-text-scale')).toBe('1.1')
    await fiber.dispose()
  })

  it('falls back for unavailable state and is safe without a document', async () => {
    const b = bench()
    const actualDocument = globalThis.document
    vi.stubGlobal('document', undefined)
    await expect(b.ctx.plugin({ inject: [...inject], apply }).await()).resolves.toBeDefined()
    vi.stubGlobal('document', actualDocument)
  })
})
