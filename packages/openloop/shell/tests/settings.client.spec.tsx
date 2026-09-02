// @vitest-environment jsdom
import { Context } from '@deepseek-ai/cordis'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import {
  createSnapshotStore,
  SlotRegistry,
  type SessionListState,
} from '@deepseek-ai/dsh-client-runtime/client'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import {
  apply as applyGeneral,
  inject as injectGeneral,
} from '@deepseek-ai/dsh-client-ui-settings-general/client'
import {
  apply as applyModels,
  inject as injectModels,
} from '@deepseek-ai/dsh-client-ui-settings-models/client'
import {
  apply as applyPlugins,
  inject as injectPlugins,
} from '@deepseek-ai/dsh-client-ui-settings-plugins/client'
import type {
  CredentialControlAdapter,
  SettingsShellOwner,
} from '@deepseek-ai/dsh-client-ui-settings/client'
import {
  apply as applyWorkspace,
  inject as injectWorkspace,
} from '@openloop/workspace-client/client'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  type ComponentProps,
  type ReactNode,
  useState,
} from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  AboutUpdateSection,
  apply,
  inject,
  OpenloopSettings,
  type OpenloopSettingsInjected,
  parseBootstrapAppView,
  type ShellKey,
} from '../src/client/index.ts'
import { en as shellEn, zh as shellZh } from '../src/client/locales.ts'

describe('Openloop Settings module surface', () => {
  it('exports the settings owner, About view, and bootstrap parser', () => {
    expect(OpenloopSettings).toBeTypeOf('function')
    expect(AboutUpdateSection).toBeTypeOf('function')
    expect(parseBootstrapAppView).toBeTypeOf('function')
  })
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

type Row = { readonly id: string; readonly order: number; readonly label: string }
type Step = { readonly id: string; readonly order: number }
type SettingsProps = ComponentProps<typeof OpenloopSettings> & {
  readonly wide: boolean
  readonly useSections: (select: (rows: readonly Row[]) => unknown) => unknown
  readonly useOnboardingSteps: (select: (steps: readonly Step[]) => unknown) => unknown
  readonly useSessions: (select: (state: unknown) => unknown) => unknown
  readonly renderSlot: (
    key: string,
    owner: Record<string, unknown>,
    options?: { readonly only?: string },
  ) => ReactNode
  readonly t: (key: string) => string
}

const LABELS = {
  en: {
    general: 'General',
    models: 'Models & Credentials',
    plugins: 'Plugins',
    'about-update': 'About & Updates',
  },
  zh: {
    general: '通用',
    models: '模型与凭据',
    plugins: '插件',
    'about-update': '关于与更新',
  },
} as const

const SHELL_COPY = {
  en: {
    settings: 'Settings',
    settingsClose: 'Close Settings',
    settingsDismiss: 'Dismiss Settings',
  },
  zh: {
    settings: '设置',
    settingsClose: '关闭设置',
    settingsDismiss: '关闭设置',
  },
} as const

function mountSettings({
  locale = 'en',
  wide = true,
  rows,
  steps = [],
  onboardingActive = false,
  section,
  container,
}: {
  locale?: keyof typeof LABELS
  wide?: boolean
  rows?: readonly Row[]
  steps?: readonly Step[]
  onboardingActive?: boolean
  section?: (owner: Record<string, unknown>, only: string | undefined) => ReactNode
  container?: HTMLElement
} = {}) {
  const sectionRows = rows ?? [
    { id: 'plugins', order: 30, label: LABELS[locale].plugins },
    { id: 'unknown', order: -100, label: 'Unknown' },
    { id: 'general', order: 50, label: LABELS[locale].general },
    { id: 'about-update', order: 0, label: LABELS[locale]['about-update'] },
    { id: 'models', order: 10, label: LABELS[locale].models },
  ]
  const calls: Array<{
    readonly key: string
    readonly owner: Record<string, unknown>
    readonly only?: string
  }> = []
  const renderSlot = (
    key: string,
    owner: Record<string, unknown>,
    options?: { readonly only?: string },
  ): ReactNode => {
    calls.push(options?.only === undefined
      ? { key, owner }
      : { key, owner, only: options.only })
    if (key === 'settings.section') {
      if (section !== undefined) return section(owner, options?.only)
      return <div data-testid={`section-${options?.only ?? 'all'}`}>{options?.only}</div>
    }
    if (key === 'settings.action') return <button type="button">Header action</button>
    return <div data-testid={`slot-${key}-${options?.only ?? 'all'}`} />
  }
  const useSections = (select: (value: readonly Row[]) => unknown) => select(sectionRows)
  const useOnboardingSteps = (select: (value: readonly Step[]) => unknown) => select(steps)
  const useSessions = (select: (value: unknown) => unknown) => select(onboardingActive
    ? { phase: 'ready', current: undefined, byId: {} }
    : {
      phase: 'ready',
      current: 'active',
      byId: { active: { blank: false } },
    })
  const t = (key: string) => SHELL_COPY[locale][key as keyof typeof SHELL_COPY.en] ?? key
  const props = {
    wide,
    useSections,
    useOnboardingSteps,
    useSessions,
    renderSlot,
    t,
  } as unknown as SettingsProps
  const view = container === undefined
    ? render(<OpenloopSettings {...props} />)
    : render(<OpenloopSettings {...props} />, { container })
  return {
    ...view,
    calls,
  }
}

function openSettings(locale: keyof typeof SHELL_COPY = 'en') {
  fireEvent.click(screen.getByRole('button', { name: SHELL_COPY[locale].settings }))
}

function provideUpdates(ctx: Context) {
  const view = createSnapshotStore({
    phase: 'idle' as const,
    actions: {
      check: { enabled: true },
      installAndRestart: { enabled: false },
    },
  })
  const updates = {
    view,
    refresh: vi.fn(() => Promise.resolve()),
    checkForUpdate: vi.fn(() => Promise.resolve()),
    installUpdateAndRestart: vi.fn(() => Promise.resolve('cancelled' as const)),
  }
  ctx.provide('openloopUpdates', updates as never)
  return updates
}

function DynamicSection() {
  const [transientDisabled, setTransientDisabled] = useState(false)
  return (
    <>
      <button type="button" onClick={() => { setTransientDisabled(true) }}>
        Current last
      </button>
      <button type="button" disabled={transientDisabled}>Transient last</button>
    </>
  )
}

describe('Openloop Settings navigation', () => {
  it.each(['zh', 'en'] as const)('shows exactly four %s sections in fixed order', (locale) => {
    mountSettings({ locale })
    openSettings(locale)

    expect(screen.getAllByRole('tab').map(tab => tab.textContent)).toEqual([
      LABELS[locale].general,
      LABELS[locale].models,
      LABELS[locale].plugins,
      LABELS[locale]['about-update'],
    ])
    expect(screen.queryByText('Unknown')).toBeNull()
  })

  it('switches on click and implements vertical and horizontal tab keyboard navigation', () => {
    mountSettings()
    openSettings()
    const tabs = screen.getAllByRole<HTMLButtonElement>('tab')
    const tablist = screen.getByRole('tablist', { name: 'Settings' })
    expect(tablist).toBeTruthy()
    expect(tabs[0]?.getAttribute('aria-selected')).toBe('true')
    expect(tabs[0]?.getAttribute('aria-controls')).toBe('openloop-settings-panel-general')
    expect(screen.getByRole('tabpanel').getAttribute('aria-labelledby'))
      .toBe('openloop-settings-tab-general')

    fireEvent.click(tabs[2]!)
    expect(tabs[2]?.getAttribute('aria-selected')).toBe('true')
    expect(screen.getByTestId('section-plugins')).toBeTruthy()

    fireEvent.keyDown(tabs[2]!, { key: 'ArrowDown' })
    expect(tabs[3]).toBe(document.activeElement)
    expect(tabs[3]?.getAttribute('aria-selected')).toBe('true')
    fireEvent.keyDown(tabs[3]!, { key: 'ArrowLeft' })
    expect(tabs[2]).toBe(document.activeElement)
    fireEvent.keyDown(tabs[2]!, { key: 'End' })
    expect(tabs[3]).toBe(document.activeElement)
    fireEvent.keyDown(tabs[3]!, { key: 'Home' })
    expect(tabs[0]).toBe(document.activeElement)
    fireEvent.keyDown(tabs[0]!, { key: 'ArrowUp' })
    expect(tabs[3]).toBe(document.activeElement)
  })

  it('moves focus to the active tab when the dialog opens', () => {
    mountSettings()
    openSettings()

    expect(screen.getByRole('tab', { name: 'General' })).toBe(document.activeElement)
  })

  it('cycles Tab in both directions using the currently focusable dialog elements', () => {
    mountSettings({ section: () => <DynamicSection /> })
    openSettings()

    const first = screen.getByRole<HTMLButtonElement>('button', { name: 'Header action' })
    const transientLast = screen.getByRole<HTMLButtonElement>('button', {
      name: 'Transient last',
    })
    transientLast.focus()
    fireEvent.keyDown(transientLast, { key: 'Tab' })
    expect(first).toBe(document.activeElement)

    first.focus()
    fireEvent.keyDown(first, { key: 'Tab', shiftKey: true })
    expect(transientLast).toBe(document.activeElement)

    fireEvent.click(screen.getByRole('button', { name: 'Current last' }))
    expect(transientLast.disabled).toBe(true)
    const currentLast = screen.getByRole<HTMLButtonElement>('button', { name: 'Current last' })
    currentLast.focus()
    fireEvent.keyDown(currentLast, { key: 'Tab' })
    expect(first).toBe(document.activeElement)
  })

  it('has one dialog and closes by icon, mask, and Escape with focus returned to the trigger', () => {
    mountSettings()
    const trigger = screen.getByRole<HTMLButtonElement>('button', { name: 'Settings' })

    openSettings()
    expect(screen.getByRole('dialog', { name: 'Settings' })).toBeTruthy()
    expect(screen.getAllByRole('dialog')).toHaveLength(1)
    const mask = screen.getByTestId('openloop-settings-mask')
    expect(mask.getAttribute('aria-hidden')).toBe('true')
    expect(mask).toHaveProperty('tabIndex', -1)
    fireEvent.click(screen.getByRole('button', { name: 'Close Settings' }))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(trigger).toBe(document.activeElement)

    openSettings()
    fireEvent.click(screen.getByTestId('openloop-settings-mask'))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(trigger).toBe(document.activeElement)

    openSettings()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(trigger).toBe(document.activeElement)
  })

  it('portals outside #root and restores its prior inert value on close and unmount', () => {
    const appRoot = document.createElement('div')
    appRoot.id = 'root'
    document.body.append(appRoot)
    const view = mountSettings({ container: appRoot })

    openSettings()
    const dialog = screen.getByRole('dialog', { name: 'Settings' })
    expect(appRoot.contains(dialog)).toBe(false)
    expect(appRoot.inert).toBe(true)

    fireEvent.click(screen.getByRole('button', { name: 'Close Settings' }))
    expect(appRoot.inert).toBe(false)

    appRoot.inert = true
    openSettings()
    view.unmount()
    expect(appRoot.inert).toBe(true)
    appRoot.remove()
  })

  it('uses icon-only rail affordance with an accessible tooltip label', () => {
    mountSettings({ wide: false })
    const trigger = screen.getByRole('button', { name: 'Settings' })
    expect(trigger.textContent).toBe('')
    fireEvent.focus(trigger)
    expect(screen.getByRole('tooltip').textContent).toBe('Settings')
  })

  it('mounts only one onboarding step and lets it open a fixed section', () => {
    const { calls } = mountSettings({
      onboardingActive: true,
      steps: [
        { id: 'welcome', order: -100 },
        { id: 'credential', order: 0 },
      ],
    })
    const first = calls.find(call => call.key === 'settings.onboarding')
    expect(first?.only).toBe('welcome')

    act(() => {
      ;(first?.owner.openSection as (id: string) => void)('models')
    })
    expect(screen.getByRole('dialog')).toBeTruthy()
    expect(screen.getByTestId('section-models')).toBeTruthy()

    act(() => {
      ;(first?.owner.complete as () => void)()
    })
    const onboarding = calls.filter(call => call.key === 'settings.onboarding')
    expect(onboarding.at(-1)?.only).toBe('credential')
  })

  it('defines stable compact geometry and independent nav/content scrolling for narrow windows', () => {
    mountSettings()
    openSettings()
    expect(screen.getByTestId('openloop-settings-nav-scroll')).toBeTruthy()
    expect(screen.getByTestId('openloop-settings-content-scroll')).toBeTruthy()
    expect(screen.getByTestId('section-general').closest('[data-settings-card]')).toBeNull()

    const css = readFileSync(
      resolve(import.meta.dirname, '../src/client/OpenloopSettings.module.css'),
      'utf8',
    )
    expect(css).toMatch(/border-radius:\s*8px/u)
    expect(css).toMatch(/height:\s*min\([^;]+100vh/u)
    expect(css.match(/overflow-y:\s*auto/gu)?.length).toBeGreaterThanOrEqual(2)
    expect(css).toMatch(/@media\s*\(max-width:\s*640px\)/u)
  })
})

describe('About and Updates typed view', () => {
  const readyApp = {
    state: 'ready' as const,
    version: '1.2.3',
    channel: 'test' as const,
    dshCommit: 'a'.repeat(40),
    attribution: 'Built on DeepSeek Harness' as const,
  }

  it('renders identity and an idle update with only checking enabled', () => {
    render(
      <AboutUpdateSection
        app={readyApp}
        update={{
          phase: 'idle',
          lastCheckedAt: '2026-08-30T10:00:00.000Z',
          actions: {
            check: { enabled: true },
            installAndRestart: { enabled: false },
          },
        }}
        onCheck={vi.fn()}
        onInstallAndRestart={vi.fn()}
      />,
    )

    expect(screen.getByText('1.2.3')).toBeTruthy()
    expect(screen.getByText('test')).toBeTruthy()
    expect(screen.getByText('a'.repeat(40))).toBeTruthy()
    expect(screen.getByText('Built on DeepSeek Harness')).toBeTruthy()
    expect(screen.getByText('2026-08-30T10:00:00.000Z')).toBeTruthy()
    expect(screen.getByText('Ready to check')).toBeTruthy()
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Check for updates' }).disabled)
      .toBe(false)
    expect(screen.getByRole<HTMLButtonElement>('button', {
      name: 'Install and restart',
    }).disabled).toBe(true)
  })

  it('renders errors, progress semantics, and action capabilities without transport details', () => {
    const onCheck = vi.fn()
    const onInstallAndRestart = vi.fn()
    const view = render(
      <AboutUpdateSection
        app={{ state: 'error', message: 'Build identity unavailable' }}
        update={{
          phase: 'failed',
          message: 'Update check failed',
          actions: {
            check: { enabled: true },
            installAndRestart: { enabled: false },
          },
        }}
        onCheck={onCheck}
        onInstallAndRestart={onInstallAndRestart}
      />,
    )
    expect(screen.getAllByRole('alert').map(alert => alert.textContent)).toEqual([
      'Build identity unavailable',
      'Update check failed',
    ])
    fireEvent.click(screen.getByRole('button', { name: 'Check for updates' }))
    expect(onCheck).toHaveBeenCalledOnce()
    expect(onInstallAndRestart).not.toHaveBeenCalled()

    view.rerender(
      <AboutUpdateSection
        app={readyApp}
        update={{
          phase: 'downloading',
          targetVersion: '1.3.0',
          progress: 42,
          actions: {
            check: { enabled: false },
            installAndRestart: { enabled: true },
          },
        }}
        onCheck={onCheck}
        onInstallAndRestart={onInstallAndRestart}
      />,
    )
    expect(screen.getByRole<HTMLProgressElement>('progressbar')).toHaveProperty('value', 42)
    fireEvent.click(screen.getByRole('button', { name: 'Install and restart' }))
    expect(onInstallAndRestart).toHaveBeenCalledOnce()
  })

  it('parses only a frozen bootstrap with valid app identity', () => {
    const coreManifest = Object.freeze({
      appVersion: '1.2.3',
      channel: 'stable',
      dshCommit: 'b'.repeat(40),
      brand: Object.freeze({
        attribution: 'Built on DeepSeek Harness',
      }),
    })
    const bootstrap = Object.freeze({ coreManifest })

    expect(parseBootstrapAppView(bootstrap)).toEqual({
      state: 'ready',
      version: '1.2.3',
      channel: 'stable',
      dshCommit: 'b'.repeat(40),
      attribution: 'Built on DeepSeek Harness',
    })
    expect(parseBootstrapAppView({ coreManifest })).toEqual({
      state: 'error',
    })
    expect(parseBootstrapAppView(Object.freeze({
      coreManifest: Object.freeze({
        appVersion: '1.2.3',
        channel: 'preview',
        dshCommit: 'secret',
      }),
    }))).toEqual({
      state: 'error',
    })
  })

  it.each([
    ['en', undefined, 'Openloop build information is unavailable.'],
    ['en', Object.freeze({ coreManifest: Object.freeze({}) }), 'Openloop build information is unavailable.'],
    ['zh', undefined, 'Openloop 构建信息不可用。'],
    ['zh', Object.freeze({ coreManifest: Object.freeze({}) }), 'Openloop 构建信息不可用。'],
  ] as const)('localizes %s bootstrap errors without parser-owned copy', (locale, bootstrap, expected) => {
    const app = parseBootstrapAppView(bootstrap)
    expect(app).toEqual({ state: 'error' })
    const dictionary = locale === 'zh' ? shellZh : shellEn
    const translate: TranslateNS<'openloop.shell'> = key =>
      dictionary[key as ShellKey] ?? key
    render(
      <AboutUpdateSection
        app={app}
        update={{
          phase: 'idle',
          actions: {
            check: { enabled: true },
            installAndRestart: { enabled: false },
          },
        }}
        onCheck={vi.fn()}
        onInstallAndRestart={vi.fn()}
        t={translate}
      />,
    )

    expect(screen.getByRole('alert').textContent).toBe(expected)
  })

  it('contains no update transport calls or sensitive update identity fields', () => {
    const source = readFileSync(
      resolve(import.meta.dirname, '../src/client/AboutUpdateSection.tsx'),
      'utf8',
    )
    expect(source).not.toMatch(/getAppInfo|getUpdateStatus|\bupdateId\b|downloadUrl|updater\./u)
  })
})

describe('Openloop Settings slot owner', () => {
  it('provides the marker, owns sidebar.settings once, and declares only additive child slots', async () => {
    const ctx = new Context()
    await ctx.plugin(SlotRegistry).await()
    const locale = new LocaleRuntime(ctx)
    ctx.provide('locale', locale)
    ctx.provide('theme', {
      getTheme: () => ({ active: { colorScheme: 'dark', tokens: {} } }),
      overrideTokens: () => () => {},
    } as never)
    const openloopDesktop = {
      describeCredential: vi.fn(),
      openCredentialReplacement: vi.fn(),
      unsetCredential: vi.fn(),
    }
    ctx.provide('remote', { openloopDesktop } as never)
    ctx.provide('remote.openloopDesktop', openloopDesktop)
    const settingsApi = {
      settings: { describe: vi.fn(), mutate: vi.fn() },
      llm: { providers: vi.fn(), discoverModels: vi.fn() },
    }
    ctx.provide('openloopSettingsApi', settingsApi as never)
    provideUpdates(ctx)

    const fiber = ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    const slots = ctx.get('slots') as SlotRegistry
    slots.register({
      name: 'sidebar',
      children: { 'sidebar.settings': { kind: 'single', scope: 'root' } },
    } as never, () => null)
    await vi.waitFor(() => {
      expect(slots.entries('sidebar.settings')).toHaveLength(1)
    })

    const owner = ctx.get('settingsShellOwner') as SettingsShellOwner
    expect(owner.id).toBe('@openloop/shell')
    expect(owner.credentialControl).toBeDefined()
    expect(owner.settingsApi).toBe(settingsApi)
    expect(slots.entries('sidebar.settings')[0]?.component).toBe(OpenloopSettings)
    expect(slots.spec('settings.action')).toEqual({ kind: 'list', scope: 'root' })
    expect(slots.spec('settings.section')).toEqual({ kind: 'list', scope: 'root' })
    expect(slots.spec('settings.onboarding')).toEqual({ kind: 'list', scope: 'root' })
    expect(slots.spec('settings.trigger')).toBeUndefined()
    expect(slots.spec('settings.header')).toBeUndefined()
    expect(slots.spec('settings.close')).toBeUndefined()
    expect(slots.entriesOfSlot('settings.section')
      .map(entry => entry.options.id)
      .sort()).toEqual([
      'about-update',
    ])
    const about = slots.entriesOfSlot('settings.section')
      .find(entry => entry.options.id === 'about-update')
    expect(about?.options).toMatchObject({
      id: 'about-update',
      order: 40,
    })
    expect(about?.options.label).toBeTypeOf('function')

    locale.setLocale('zh')
    expect((about?.options.label as () => string)())
      .toBe('关于与更新')
    await fiber.dispose()
  })

  it('projects the rendered settings.section winner and falls back across HMR disposal', async () => {
    const ctx = new Context()
    await ctx.plugin(SlotRegistry).await()
    const locale = new LocaleRuntime(ctx)
    ctx.provide('locale', locale)
    ctx.provide('theme', {
      getTheme: () => ({ active: { colorScheme: 'dark', tokens: {} } }),
      overrideTokens: () => () => {},
    } as never)
    const openloopDesktop = {
      describeCredential: vi.fn(),
      openCredentialReplacement: vi.fn(),
      unsetCredential: vi.fn(),
    }
    ctx.provide('remote', { openloopDesktop } as never)
    ctx.provide('remote.openloopDesktop', openloopDesktop)
    provideUpdates(ctx)

    const fiber = ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    const slots = ctx.get('slots') as SlotRegistry
    slots.register({
      name: 'sidebar',
      children: { 'sidebar.settings': { kind: 'single', scope: 'root' } },
    } as never, () => null)
    await vi.waitFor(() => {
      expect(slots.entries('sidebar.settings')).toHaveLength(1)
    })
    const shell = slots.entries('sidebar.settings')[0]!
    const sections = (
      shell.inject as unknown as () => OpenloopSettingsInjected
    )().hooks.sections
    const LosingSection = () => null
    const WinningSection = () => null
    const disposeLosing = slots.register({
      name: 'settings.section',
      id: 'models',
      priority: 10,
      label: 'Losing models',
    } as never, LosingSection)
    const registerWinner = () => slots.register({
      name: 'settings.section',
      id: 'models',
      priority: -10,
      label: 'Winning models',
    } as never, WinningSection)
    let disposeWinner = registerWinner()

    expect(slots.entriesOfSlot('settings.section')
      .find(entry => entry.options.id === 'models')?.component).toBe(WinningSection)
    expect(sections.getSnapshot()
      .filter(row => row.id === 'models')
      .map(row => row.label)).toEqual(['Winning models'])

    disposeWinner()
    expect(slots.entriesOfSlot('settings.section')
      .find(entry => entry.options.id === 'models')?.component).toBe(LosingSection)
    expect(sections.getSnapshot()
      .filter(row => row.id === 'models')
      .map(row => row.label)).toEqual(['Losing models'])

    disposeWinner = registerWinner()
    expect(sections.getSnapshot()
      .filter(row => row.id === 'models')
      .map(row => row.label)).toEqual(['Winning models'])

    disposeWinner()
    disposeLosing()
    await fiber.dispose()
  })

  it('projects the settings.onboarding winner and falls back across HMR disposal', async () => {
    const ctx = new Context()
    await ctx.plugin(SlotRegistry).await()
    const locale = new LocaleRuntime(ctx)
    ctx.provide('locale', locale)
    ctx.provide('theme', {
      getTheme: () => ({ active: { colorScheme: 'dark', tokens: {} } }),
      overrideTokens: () => () => {},
    } as never)
    const openloopDesktop = {
      describeCredential: vi.fn(),
      openCredentialReplacement: vi.fn(),
      unsetCredential: vi.fn(),
    }
    ctx.provide('remote', { openloopDesktop } as never)
    ctx.provide('remote.openloopDesktop', openloopDesktop)
    provideUpdates(ctx)

    const fiber = ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    const slots = ctx.get('slots') as SlotRegistry
    slots.register({
      name: 'sidebar',
      children: { 'sidebar.settings': { kind: 'single', scope: 'root' } },
    } as never, () => null)
    await vi.waitFor(() => {
      expect(slots.entries('sidebar.settings')).toHaveLength(1)
    })
    const shell = slots.entries('sidebar.settings')[0]!
    const onboarding = (
      shell.inject as unknown as () => OpenloopSettingsInjected
    )().hooks.onboardingSteps
    const disposeLosing = slots.register({
      name: 'settings.onboarding',
      id: 'welcome',
      order: -100,
      priority: 10,
    } as never, () => null)
    const registerWinner = () => slots.register({
      name: 'settings.onboarding',
      id: 'welcome',
      order: 20,
      priority: -10,
    } as never, () => null)
    let disposeWinner = registerWinner()

    expect(onboarding.getSnapshot()).toEqual([{ id: 'welcome', order: 20 }])
    disposeWinner()
    expect(onboarding.getSnapshot()).toEqual([{ id: 'welcome', order: -100 }])
    disposeWinner = registerWinner()
    expect(onboarding.getSnapshot()).toEqual([{ id: 'welcome', order: 20 }])

    disposeWinner()
    disposeLosing()
    await fiber.dispose()
  })

  it('activates early browser contributors only after the atomic Openloop owner arrives', async () => {
    const ctx = new Context()
    await ctx.plugin(SlotRegistry).await()
    const slots = ctx.get('slots') as SlotRegistry
    const locale = new LocaleRuntime(ctx)
    ctx.provide('locale', locale)
    ctx.provide('theme', {
      getTheme: () => ({ active: { colorScheme: 'dark', tokens: {} } }),
      overrideTokens: () => () => {},
    } as never)
    const openloopDesktop = {
      describeCredential: vi.fn(() => Promise.resolve({
        ok: true as const,
        value: { configured: true, source: 'keychain', writable: true },
      })),
      openCredentialReplacement: vi.fn(),
      unsetCredential: vi.fn(),
    }
    ctx.provide('remote', {
      openloopDesktop,
      $on: () => () => {},
    } as never)
    ctx.provide('remote.openloopDesktop', openloopDesktop)
    provideUpdates(ctx)
    ctx.provide('connection', {
      isLoopback: true,
      api: {
        settings: {
          describe: vi.fn(() => Promise.resolve({
            rpcId: 'settings' as never,
            result: { ok: false as const, error: {} },
          })),
        },
        credentials: {
          describe: vi.fn(() => Promise.resolve({
            rpcId: 'credentials' as never,
            result: { ok: false as const, error: {} },
          })),
        },
      },
    } as never)
    const unavailableScope = {
      getSnapshot: () => ({
        status: 'unavailable' as const,
        value: undefined,
        base: undefined,
        user: undefined,
        revision: undefined,
        writable: false,
        mode: 'memory' as const,
      }),
      subscribe: () => () => {},
      set: () => Promise.resolve(),
      unset: () => Promise.resolve(),
    }
    ctx.provide('settingsScope', { bind: () => unavailableScope } as never)
    const sessions = createSnapshotStore<SessionListState>({
      ids: [],
      byId: {},
      current: undefined,
      phase: 'ready',
      subagentsByParent: {},
      jobsBySession: {},
      currentAddress: undefined,
    })
    ctx.provide('sessions', { list: sessions, open: vi.fn() } as never)
    ctx.provide('openloopWorkspaces', {
      grants: createSnapshotStore({ items: [], state: 'idle', error: null }),
      authorize: vi.fn(),
      reauthorize: vi.fn(),
      renameWorkspace: vi.fn(),
      revoke: vi.fn(),
      reveal: vi.fn(),
      connectWorkspace: vi.fn(),
    } as never)
    ctx.provide('conversation', { blocks: { setOwned: vi.fn() } } as never)

    const contributorFibers = [
      ctx.plugin({ inject: [...injectGeneral], apply: applyGeneral }),
      ctx.plugin({ inject: [...injectModels], apply: applyModels }),
      ctx.plugin({ inject: [...injectPlugins], apply: applyPlugins }),
      ctx.plugin({ inject: [...injectWorkspace], apply: applyWorkspace }),
    ]
    await Promise.resolve()
    expect(ctx.get('settingsShellOwner')).toBeUndefined()
    expect(slots.entries('settings.section')).toEqual([])

    const shellFiber = ctx.plugin({ inject: [...inject], apply })
    await shellFiber.await()
    await Promise.all(contributorFibers.map(fiber => fiber.await()))
    const disposeSidebar = slots.register({
      name: 'sidebar',
      children: { 'sidebar.settings': { kind: 'single', scope: 'root' } },
    } as never, () => null)

    await vi.waitFor(() => {
      expect(slots.entries('sidebar.settings')).toHaveLength(1)
      expect(slots.entriesOfSlot('settings.section')).toHaveLength(4)
    })
    const owner = ctx.get('settingsShellOwner') as SettingsShellOwner
    expect(owner.id).toBe('@openloop/shell')
    expect(owner.credentialControl).toBeDefined()
    expect(slots.entries('sidebar.settings')[0]?.component).toBe(OpenloopSettings)
    expect(slots.entriesOfSlot('settings.section').map(entry => entry.options.id)).toEqual([
      'general',
      'models',
      'plugins',
      'about-update',
    ])

    const models = slots.entriesOfSlot('settings.section')
      .find(entry => entry.options.id === 'models')!
    const modelsFace = (models.inject as () => {
      credentialControl?: CredentialControlAdapter
    })()
    expect(modelsFace.credentialControl).toBe(owner.credentialControl)
    const webSearch = slots.entries('settings.plugin.item')
      .find(entry => entry.options.key === 'web-search-deepseek')!
    const webSearchFace = (webSearch.inject as () => {
      credentialControl?: CredentialControlAdapter
    })()
    expect(webSearchFace.credentialControl).toBe(owner.credentialControl)

    disposeSidebar()
    expect(slots.entries('sidebar.settings')).toEqual([])
    const disposeReplacementSidebar = slots.register({
      name: 'sidebar',
      children: { 'sidebar.settings': { kind: 'single', scope: 'root' } },
    } as never, () => null)
    await vi.waitFor(() => {
      expect(slots.entries('sidebar.settings')).toHaveLength(1)
      expect(slots.entriesOfSlot('settings.section')).toHaveLength(4)
    })

    disposeReplacementSidebar()
    await shellFiber.dispose()
    await vi.waitFor(() => {
      expect(ctx.get('settingsShellOwner')).toBeUndefined()
      expect(slots.entriesOfSlot('settings.section')).toEqual([])
    })

    const replacementShellFiber = ctx.plugin({ inject: [...inject], apply })
    await replacementShellFiber.await()
    const disposeFinalSidebar = slots.register({
      name: 'sidebar',
      children: { 'sidebar.settings': { kind: 'single', scope: 'root' } },
    } as never, () => null)
    await vi.waitFor(() => {
      expect(slots.entries('sidebar.settings')).toHaveLength(1)
      expect(slots.entriesOfSlot('settings.section')).toHaveLength(4)
    })
    expect((ctx.get('settingsShellOwner') as SettingsShellOwner).id).toBe('@openloop/shell')

    disposeFinalSidebar()
    await replacementShellFiber.dispose()
    for (const fiber of contributorFibers) await fiber.dispose()
  })
})
