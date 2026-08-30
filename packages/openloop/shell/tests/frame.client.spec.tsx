// @vitest-environment jsdom
import { Context } from '@deepseek-ai/cordis'
import { SlotRegistry, type SessionListState } from '@deepseek-ai/dsh-client-runtime/client'
import type { ThemeTokenOverrides } from '@deepseek-ai/dsh-client-ui-theme/client'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import { apply, inject, OpenloopFrame } from '../src/client/index.ts'
import type { OpenloopFrameProps } from '../src/client/OpenloopFrame.tsx'

let activeContext: Context | undefined

afterEach(async () => {
  cleanup()
  await activeContext?.fiber.dispose()
  activeContext = undefined
})

describe('Openloop root shell Slot contract', () => {
  it('owns root once, declares the DSH shell seats, and preserves panel actions', async () => {
    const ctx = new Context()
    activeContext = ctx
    await ctx.plugin(SlotRegistry).await()
    const overrideTokens = vi.fn((_source: string, _tokens: ThemeTokenOverrides) => vi.fn())
    ctx.provide('theme', {
      getTheme: () => ({
        active: {
          colorScheme: 'dark',
          tokens: { '--dsw-alias-brand-primary': '#f7f8fa' },
        },
      }),
      overrideTokens,
    } as never)
    await ctx.plugin({ inject: [...inject], apply }).await()

    const slots = ctx.get('slots') as SlotRegistry
    expect(inject).toEqual(['slots', 'theme'])
    expect(document.body.hasAttribute('data-ds-dark-theme')).toBe(true)
    expect(document.body.style.getPropertyValue('--dsw-alias-brand-primary')).toBe('#f7f8fa')
    expect(slots.entries('root')).toHaveLength(1)
    expect(slots.spec('sidebar')).toEqual({ kind: 'single', scope: 'root' })
    expect(slots.spec('conversation')).toEqual({ kind: 'single', scope: 'session-maybe' })
    expect(slots.spec('workbench')).toEqual({ kind: 'single', scope: 'root' })
    expect(slots.spec('details')).toEqual({ kind: 'single', scope: 'session' })
    expect(slots.spec('shell.overlay')).toEqual({ kind: 'list', scope: 'root' })
    expect(overrideTokens).toHaveBeenCalledOnce()
    const [source, tokens] = overrideTokens.mock.calls[0] ?? []
    expect(source).toBe('@openloop/shell')
    expect(tokens?.['--dsw-alias-bg-base']).toEqual({
      light: '#F7F8FA',
      dark: '#0B0D0F',
    })
    expect(tokens?.['--dsw-alias-brand-primary']).toEqual({
      light: '#111316',
      dark: '#F7F8FA',
    })

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

  it('renders one workbench surface without replacing conversation or details', () => {
    const renderSlot = vi.fn((key: string) => <div data-slot={key} />)
    const props = {
      actions: {
        closeDetails: vi.fn(),
        openDetails: vi.fn(),
        toggleSidebar: vi.fn(),
      },
      renderSlot,
      useSessions: (select: (state: SessionListState) => unknown) => select({
        byId: {},
        current: undefined,
      } as SessionListState),
      useStore: (select: (state: { sidebarOpen: boolean; detailsOpen: boolean }) => unknown) =>
        select({ sidebarOpen: true, detailsOpen: false }),
    } as unknown as OpenloopFrameProps

    const view = render(<OpenloopFrame {...props} />)

    expect(renderSlot.mock.calls.map(([key]) => key)).toEqual([
      'sidebar',
      'conversation',
      'workbench',
      'details',
      'shell.overlay',
    ])
    expect(view.container.querySelectorAll('[data-openloop-workbench]')).toHaveLength(1)
    expect((view.container.firstElementChild as HTMLElement).style.gridTemplateColumns)
      .toBe('280px minmax(0, 1fr) 0px')
    expect(view.container.querySelector('[data-openloop-workbench]')?.matches(':empty'))
      .toBe(false)
    expect(view.container.querySelector('[data-slot="conversation"]')).not.toBeNull()
    expect(view.container.querySelector('[data-slot="details"]')).not.toBeNull()
  })

  it('does not reserve workbench width until an occupant renders', () => {
    const css = readFileSync(
      resolve(import.meta.dirname, '../src/client/OpenloopFrame.module.css'),
      'utf8',
    )

    expect(css).toMatch(/\.workspace\s*\{[^}]*display:\s*flex;/su)
    expect(css).toMatch(/\.workbench:empty\s*\{[^}]*display:\s*none;/su)
  })

  it('preserves normal conversation width while the workbench renders no DOM', () => {
    const renderSlot = vi.fn((key: string) =>
      key === 'workbench' ? null : <div data-slot={key} />)
    const props = {
      actions: {
        closeDetails: vi.fn(),
        openDetails: vi.fn(),
        toggleSidebar: vi.fn(),
      },
      renderSlot,
      useSessions: (select: (state: SessionListState) => unknown) => select({
        byId: {},
        current: undefined,
      } as SessionListState),
      useStore: (select: (state: { sidebarOpen: boolean; detailsOpen: boolean }) => unknown) =>
        select({ sidebarOpen: true, detailsOpen: false }),
    } as unknown as OpenloopFrameProps

    const view = render(<OpenloopFrame {...props} />)
    const frame = view.container.firstElementChild as HTMLElement
    const conversation = view.container.querySelector('[data-slot="conversation"]')
    const workbench = view.container.querySelector('[data-openloop-workbench]')

    expect(frame.style.gridTemplateColumns).toBe('280px minmax(0, 1fr) 0px')
    expect(conversation?.parentElement?.parentElement).toBe(workbench?.parentElement)
    expect(workbench?.matches(':empty')).toBe(true)
  })
})
