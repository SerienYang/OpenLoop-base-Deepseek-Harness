// @vitest-environment jsdom
import { Context } from '@deepseek-ai/cordis'
import { SlotRegistry } from '@deepseek-ai/dsh-client-runtime/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { apply, inject } from '../src/client/index.ts'

let activeContext: Context | undefined

afterEach(async () => {
  await activeContext?.fiber.dispose()
  activeContext = undefined
})

describe('Openloop root shell Slot contract', () => {
  it('owns root once, declares the DSH shell seats, and preserves panel actions', async () => {
    const ctx = new Context()
    activeContext = ctx
    await ctx.plugin(SlotRegistry).await()
    ctx.provide('theme', {
      getTheme: () => ({
        active: {
          colorScheme: 'dark',
          tokens: { '--dsw-alias-brand-primary': '#f7f8fa' },
        },
      }),
    } as never)
    await ctx.plugin({ inject: [...inject], apply }).await()

    const slots = ctx.get('slots') as SlotRegistry
    expect(inject).toEqual(['slots', 'theme'])
    expect(document.body.hasAttribute('data-ds-dark-theme')).toBe(true)
    expect(document.body.style.getPropertyValue('--dsw-alias-brand-primary')).toBe('#f7f8fa')
    expect(slots.entries('root')).toHaveLength(1)
    expect(slots.spec('sidebar')).toEqual({ kind: 'single', scope: 'root' })
    expect(slots.spec('conversation')).toEqual({ kind: 'single', scope: 'session-maybe' })
    expect(slots.spec('details')).toEqual({ kind: 'single', scope: 'session' })
    expect(slots.spec('shell.overlay')).toEqual({ kind: 'list', scope: 'root' })

    const panelActions = {
      toggleSidebar: vi.fn(),
      openDetails: vi.fn(),
      closeDetails: vi.fn(),
    }
    const injected = slots.entries('root')[0]?.inject?.({
      ...panelActions,
    } as never) as {
      toggleSidebar?: () => void
      openDetails?: () => void
      closeDetails?: () => void
    } | undefined
    expect(injected).toEqual({})

    const layout = ctx.get('layout') as {
      toggleSidebar(): void
      openDetails(): void
      closeDetails(): void
    }
    layout.toggleSidebar()
    layout.openDetails()
    layout.closeDetails()
    expect(panelActions.toggleSidebar).toHaveBeenCalledOnce()
    expect(panelActions.openDetails).toHaveBeenCalledOnce()
    expect(panelActions.closeDetails).toHaveBeenCalledOnce()
  })
})
