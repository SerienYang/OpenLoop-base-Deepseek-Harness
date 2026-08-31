// @vitest-environment jsdom
import { Context } from '@deepseek-ai/cordis'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { SlotRegistry, type SessionListState } from '@deepseek-ai/dsh-client-runtime/client'
import type { CredentialControlAdapter } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { ThemeTokenOverrides } from '@deepseek-ai/dsh-client-ui-theme/client'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { type ReactNode, useSyncExternalStore } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen } from '@testing-library/react'
import { apply, inject, OpenloopFrame } from '../src/client/index.ts'
import { computeOpenloopColumns } from '../src/client/columns.ts'
import {
  createOpenloopShellStore,
  type OpenloopFrameProps,
} from '../src/client/OpenloopFrame.tsx'
import css from '../src/client/OpenloopFrame.module.css'

let activeContext: Context | undefined
let frameWidth = 1280
let fireResize: (() => void) | undefined

class ResizeObserverStub {
  readonly #callback: ResizeObserverCallback

  constructor(callback: ResizeObserverCallback) {
    this.#callback = callback
  }

  observe(): void {
    fireResize = () => { this.#callback([], this) }
  }

  unobserve(): void {}

  disconnect(): void {
    fireResize = undefined
  }
}

beforeEach(() => {
  frameWidth = 1280
  fireResize = undefined
  window.innerWidth = frameWidth
  vi.stubGlobal('ResizeObserver', ResizeObserverStub)
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(() => ({
    width: frameWidth,
    height: 760,
    top: 0,
    right: frameWidth,
    bottom: 760,
    left: 0,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  }))
})

afterEach(async () => {
  cleanup()
  await activeContext?.fiber.dispose()
  activeContext = undefined
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

function stableAnchorRenderer(workbenchOccupant?: ReactNode) {
  const probe = vi.fn((
    key: string,
    _owner: object,
    options?: { fallback?: ReactNode },
  ) => (
    <div data-slot={key} style={{ display: 'contents' }}>
      {key === 'workbench'
        ? (workbenchOccupant ?? options?.fallback ?? null)
        : <div data-slot-occupant={key} />}
    </div>
  ))
  return {
    probe,
    renderSlot: probe as unknown as OpenloopFrameProps['renderSlot'],
  }
}

function hookOf<T>(instance: {
  subscribe: (listener: () => void) => () => void
  getSnapshot: () => T
}) {
  return function useSelector<S>(select: (state: T) => S): S {
    return select(useSyncExternalStore(instance.subscribe, instance.getSnapshot))
  }
}

describe('Openloop column concessions', () => {
  it('keeps preferred widths when the 640px workspace floor fits', () => {
    expect(computeOpenloopColumns(1280, true, true)).toEqual({
      sidebar: 280,
      workspace: 640,
      details: 360,
    })
  })

  it('derives a rail and closes details at the 760px Tauri minimum', () => {
    expect(computeOpenloopColumns(760, false, true)).toEqual({
      sidebar: 56,
      workspace: 704,
      details: 0,
    })
  })

  it('honors a narrow manual expansion instead of forcing the rail in the solver', () => {
    expect(computeOpenloopColumns(760, true, false)).toEqual({
      sidebar: 280,
      workspace: 480,
      details: 0,
    })
    expect(computeOpenloopColumns(760, false, false)).toEqual({
      sidebar: 56,
      workspace: 704,
      details: 0,
    })
  })

  it.each([
    [995, false, 0],
    [996, false, 300],
    [1023, false, 327],
    [1024, false, 328],
    [1219, false, 360],
    [1220, true, 300],
    [1280, true, 360],
  ])('keeps details visible across adjacent width %ipx when constraints allow it', (
    width,
    sidebarExpanded,
    details,
  ) => {
    expect(computeOpenloopColumns(width, sidebarExpanded, true).details).toBe(details)
  })

  it('restores preferred columns after a narrow derived concession', () => {
    expect(computeOpenloopColumns(760, false, true).details).toBe(0)
    expect(computeOpenloopColumns(1280, true, true)).toEqual({
      sidebar: 280,
      workspace: 640,
      details: 360,
    })
  })
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
    const locale = new LocaleRuntime(ctx)
    ctx.provide('locale', locale)
    const openloopDesktop = {
      describeCredential: vi.fn(() => Promise.resolve({
        ok: true as const,
        value: { configured: true, source: 'keychain', writable: true },
      })),
      openCredentialReplacement: vi.fn(),
      unsetCredential: vi.fn(),
    }
    ctx.provide('remote', { openloopDesktop } as never)
    ctx.provide('remote.openloopDesktop', openloopDesktop)
    await ctx.plugin({ inject: [...inject], apply }).await()

    const slots = ctx.get('slots') as SlotRegistry
    expect(inject).toEqual(['slots', 'theme', 'locale', 'remote', 'remote.openloopDesktop'])
    expect(ctx.get('credentialControl')).toBeDefined()
    locale.setLocale('en')
    const credentialControl = ctx.get('credentialControl') as CredentialControlAdapter
    const credential = render(credentialControl.render({
      reference: 'DEEPSEEK_API_KEY',
      label: 'API key',
    }))
    expect(await screen.findByText('API key is securely stored')).toBeTruthy()
    expect(screen.getByText('macOS Keychain · saved value is never shown')).toBeTruthy()
    locale.setLocale('zh')
    credential.rerender(credentialControl.render({
      reference: 'DEEPSEEK_API_KEY',
      label: 'API 密钥',
    }))
    expect(await screen.findByText('API 密钥已安全保存')).toBeTruthy()
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
    const { probe, renderSlot } = stableAnchorRenderer(<div data-testid="workbench-occupant" />)
    const props = {
      actions: {
        closeDetails: vi.fn(),
        openDetails: vi.fn(),
        setNarrow: vi.fn(),
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

    expect(probe.mock.calls.map(([key]) => key)).toEqual([
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
    expect(view.queryByTestId('workbench-occupant')).not.toBeNull()
    expect(view.container.querySelector('[data-openloop-workbench-empty]')).toBeNull()
  })

  it('reserves 42% with a 320px minimum only while a workbench occupant renders', () => {
    const css = readFileSync(
      resolve(import.meta.dirname, '../src/client/OpenloopFrame.module.css'),
      'utf8',
    )

    expect(css).toMatch(/\.workspace\s*\{[^}]*display:\s*flex;/su)
    expect(css).toMatch(/\.workbench\s*\{[^}]*flex:\s*0 1 42%;[^}]*width:\s*42%;[^}]*min-width:\s*320px;/su)
    expect(css).toMatch(/\.workbench:has\(\[data-openloop-workbench-empty\]\)\s*\{[^}]*display:\s*none;/su)
  })

  it('collapses the workbench when the stable Slot anchor renders its empty fallback', () => {
    const { renderSlot } = stableAnchorRenderer()
    const props = {
      actions: {
        closeDetails: vi.fn(),
        openDetails: vi.fn(),
        setNarrow: vi.fn(),
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
    const anchor = workbench?.querySelector('[data-slot="workbench"]')
    const marker = anchor?.querySelector('[data-openloop-workbench-empty]')
    const workbenchClass = css.workbench

    expect(frame.style.gridTemplateColumns).toBe('280px minmax(0, 1fr) 0px')
    expect(conversation?.parentElement?.parentElement).toBe(workbench?.parentElement)
    expect(workbenchClass).toBeDefined()
    expect(workbench?.classList.contains(workbenchClass as string)).toBe(true)
    expect(anchor).not.toBeNull()
    expect(workbench?.matches(':empty')).toBe(false)
    expect(marker?.parentElement).toBe(anchor)
  })

  it('concedes to the rail and closes details at 760px without changing preferences', () => {
    frameWidth = 760
    window.innerWidth = frameWidth
    const { probe, renderSlot } = stableAnchorRenderer(<div data-testid="workbench-occupant" />)
    const closeDetails = vi.fn()
    const props = {
      actions: {
        closeDetails,
        openDetails: vi.fn(),
        setNarrow: vi.fn(),
        toggleSidebar: vi.fn(),
      },
      renderSlot,
      useSessions: (select: (state: SessionListState) => unknown) => select({
        byId: { current: { blank: false } },
        current: 'current',
      } as unknown as SessionListState),
      useStore: (select: (state: { sidebarOpen: boolean; detailsOpen: boolean }) => unknown) =>
        select({ sidebarOpen: true, detailsOpen: true }),
    } as unknown as OpenloopFrameProps

    const view = render(<OpenloopFrame {...props} />)
    const frame = view.container.firstElementChild as HTMLElement
    const sidebarCalls = () => probe.mock.calls.filter(([key]) => key === 'sidebar')

    expect(frame.style.gridTemplateColumns).toBe('56px minmax(0, 1fr) 0px')
    expect(frame.hasAttribute('data-sidebar-collapsed')).toBe(true)
    expect(frame.hasAttribute('data-details-collapsed')).toBe(true)
    expect(sidebarCalls().at(-1)?.[1]).toEqual({ collapsed: true, width: 56 })
    expect(view.queryByTestId('workbench-occupant')).not.toBeNull()
    expect(closeDetails).not.toHaveBeenCalled()

    frameWidth = 1280
    act(() => { fireResize?.() })

    expect(frame.style.gridTemplateColumns).toBe('280px minmax(0, 1fr) 360px')
    expect(frame.hasAttribute('data-sidebar-collapsed')).toBe(false)
    expect(frame.hasAttribute('data-details-collapsed')).toBe(false)
    expect(sidebarCalls().at(-1)?.[1]).toEqual({ collapsed: false, width: 280 })
    expect(closeDetails).not.toHaveBeenCalled()
  })

  it('toggles a temporary narrow expansion and restores the wide sidebar preference', () => {
    frameWidth = 760
    window.innerWidth = frameWidth
    const instance = createOpenloopShellStore().create()
    const { probe, renderSlot } = stableAnchorRenderer()
    const props = {
      actions: instance.actions,
      renderSlot,
      useSessions: (select: (state: SessionListState) => unknown) => select({
        byId: {},
        current: undefined,
      } as SessionListState),
      useStore: hookOf(instance.store),
    } as unknown as OpenloopFrameProps
    const view = render(<OpenloopFrame {...props} />)
    const frame = view.container.firstElementChild as HTMLElement
    const sidebarOwner = () => probe.mock.calls.filter(([key]) => key === 'sidebar').at(-1)?.[1]

    expect(frame.style.gridTemplateColumns).toBe('56px minmax(0, 1fr) 0px')
    expect(sidebarOwner()).toEqual({ collapsed: true, width: 56 })

    act(() => { instance.actions.toggleSidebar() })
    expect(frame.style.gridTemplateColumns).toBe('280px minmax(0, 1fr) 0px')
    expect(sidebarOwner()).toEqual({ collapsed: false, width: 280 })

    act(() => { instance.actions.toggleSidebar() })
    expect(frame.style.gridTemplateColumns).toBe('56px minmax(0, 1fr) 0px')
    expect(sidebarOwner()).toEqual({ collapsed: true, width: 56 })

    act(() => { instance.actions.toggleSidebar() })
    expect(frame.style.gridTemplateColumns).toBe('280px minmax(0, 1fr) 0px')

    frameWidth = 1280
    act(() => { fireResize?.() })
    expect(frame.style.gridTemplateColumns).toBe('280px minmax(0, 1fr) 0px')
    expect(instance.store.getSnapshot()).toMatchObject({
      sidebarOpen: true,
      narrow: false,
      narrowExpanded: false,
    })
  })

  it('keeps open details visible across every adjacent responsive boundary', () => {
    frameWidth = 995
    window.innerWidth = frameWidth
    const instance = createOpenloopShellStore().create()
    instance.actions.openDetails()
    const { renderSlot } = stableAnchorRenderer()
    const props = {
      actions: instance.actions,
      renderSlot,
      useSessions: (select: (state: SessionListState) => unknown) => select({
        byId: { current: { blank: false } },
        current: 'current',
      } as unknown as SessionListState),
      useStore: hookOf(instance.store),
    } as unknown as OpenloopFrameProps
    const view = render(<OpenloopFrame {...props} />)
    const frame = view.container.firstElementChild as HTMLElement

    for (const [width, expected] of [
      [995, '56px minmax(0, 1fr) 0px'],
      [996, '56px minmax(0, 1fr) 300px'],
      [1023, '56px minmax(0, 1fr) 327px'],
      [1024, '56px minmax(0, 1fr) 328px'],
      [1219, '56px minmax(0, 1fr) 360px'],
      [1220, '280px minmax(0, 1fr) 300px'],
      [1280, '280px minmax(0, 1fr) 360px'],
    ] as const) {
      frameWidth = width
      act(() => { fireResize?.() })
      expect(frame.style.gridTemplateColumns).toBe(expected)
    }
  })

  it.each([
    ['undefined', undefined],
    ['blank', 'blank-session'],
  ])('retains the last valid session across the %s gap before closing details for the next session', (
    _label,
    gapSession,
  ) => {
    const closeDetails = vi.fn()
    const { renderSlot } = stableAnchorRenderer()
    const actions = {
      closeDetails,
      openDetails: vi.fn(),
      setNarrow: vi.fn(),
      toggleSidebar: vi.fn(),
    }
    const useStore = (
      select: (state: { sidebarOpen: boolean; detailsOpen: boolean }) => unknown,
    ) => select({ sidebarOpen: true, detailsOpen: true })
    const frame = (current: string | undefined, blank = false) => (
      <OpenloopFrame {...{
        actions,
        renderSlot,
        useSessions: (select: (state: SessionListState) => unknown) => select({
          byId: current === undefined ? {} : { [current]: { blank } },
          current,
        } as SessionListState),
        useStore,
      } as unknown as OpenloopFrameProps}
      />
    )

    const view = render(frame(undefined))
    view.rerender(frame('session-a'))
    expect(closeDetails).not.toHaveBeenCalled()

    view.rerender(frame(gapSession, gapSession !== undefined))
    view.rerender(frame('session-b'))

    expect(closeDetails).toHaveBeenCalledOnce()
  })
})
