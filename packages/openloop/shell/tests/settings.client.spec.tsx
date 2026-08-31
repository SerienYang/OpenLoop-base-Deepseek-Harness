// @vitest-environment jsdom
import { Context } from '@deepseek-ai/cordis'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { SlotRegistry } from '@deepseek-ai/dsh-client-runtime/client'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  type ComponentProps,
  type ReactNode,
} from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  AboutUpdateSection,
  apply,
  inject,
  OpenloopSettings,
  parseBootstrapAppView,
} from '../src/client/index.ts'

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
    workspace: 'Workspace',
    plugins: 'Plugins',
    'about-update': 'About & Updates',
  },
  zh: {
    general: '通用',
    models: '模型与凭据',
    workspace: '工作区',
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
}: {
  locale?: keyof typeof LABELS
  wide?: boolean
  rows?: readonly Row[]
  steps?: readonly Step[]
  onboardingActive?: boolean
} = {}) {
  const sectionRows = rows ?? [
    { id: 'plugins', order: 30, label: LABELS[locale].plugins },
    { id: 'unknown', order: -100, label: 'Unknown' },
    { id: 'workspace', order: 20, label: LABELS[locale].workspace },
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
  return {
    ...render(<OpenloopSettings {...props} />),
    calls,
  }
}

function openSettings(locale: keyof typeof SHELL_COPY = 'en') {
  fireEvent.click(screen.getByRole('button', { name: SHELL_COPY[locale].settings }))
}

describe('Openloop Settings navigation', () => {
  it.each(['zh', 'en'] as const)('shows exactly five %s sections in fixed order', (locale) => {
    mountSettings({ locale })
    openSettings(locale)

    expect(screen.getAllByRole('tab').map(tab => tab.textContent)).toEqual([
      LABELS[locale].general,
      LABELS[locale].models,
      LABELS[locale].workspace,
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
    expect(screen.getByTestId('section-workspace')).toBeTruthy()

    fireEvent.keyDown(tabs[2]!, { key: 'ArrowDown' })
    expect(tabs[3]).toBe(document.activeElement)
    expect(tabs[3]?.getAttribute('aria-selected')).toBe('true')
    fireEvent.keyDown(tabs[3]!, { key: 'ArrowLeft' })
    expect(tabs[2]).toBe(document.activeElement)
    fireEvent.keyDown(tabs[2]!, { key: 'End' })
    expect(tabs[4]).toBe(document.activeElement)
    fireEvent.keyDown(tabs[4]!, { key: 'Home' })
    expect(tabs[0]).toBe(document.activeElement)
    fireEvent.keyDown(tabs[0]!, { key: 'ArrowUp' })
    expect(tabs[4]).toBe(document.activeElement)
  })

  it('has one dialog and closes by icon, mask, and Escape with focus returned to the trigger', () => {
    mountSettings()
    const trigger = screen.getByRole<HTMLButtonElement>('button', { name: 'Settings' })

    openSettings()
    expect(screen.getByRole('dialog', { name: 'Settings' })).toBeTruthy()
    expect(screen.getAllByRole('dialog')).toHaveLength(1)
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
  }

  it('renders identity and an unavailable update without enabling actions', () => {
    render(
      <AboutUpdateSection
        app={readyApp}
        update={{
          phase: 'unavailable',
          lastCheckedAt: '2026-08-30T10:00:00.000Z',
          actions: {
            check: { enabled: false },
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
    expect(screen.getByText('2026-08-30T10:00:00.000Z')).toBeTruthy()
    expect(screen.getByText('Update service unavailable')).toBeTruthy()
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Check for updates' }).disabled)
      .toBe(true)
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
    })
    const bootstrap = Object.freeze({ coreManifest })

    expect(parseBootstrapAppView(bootstrap)).toEqual({
      state: 'ready',
      version: '1.2.3',
      channel: 'stable',
      dshCommit: 'b'.repeat(40),
    })
    expect(parseBootstrapAppView({ coreManifest })).toEqual({
      state: 'error',
      message: 'Openloop build information is unavailable.',
    })
    expect(parseBootstrapAppView(Object.freeze({
      coreManifest: Object.freeze({
        appVersion: '1.2.3',
        channel: 'preview',
        dshCommit: 'secret',
      }),
    }))).toEqual({
      state: 'error',
      message: 'Openloop build information is unavailable.',
    })
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

    expect(ctx.get('settingsShellOwner')).toEqual({ id: '@openloop/shell' })
    expect(slots.entries('sidebar.settings')[0]?.component).toBe(OpenloopSettings)
    expect(slots.spec('settings.action')).toEqual({ kind: 'list', scope: 'root' })
    expect(slots.spec('settings.section')).toEqual({ kind: 'list', scope: 'root' })
    expect(slots.spec('settings.onboarding')).toEqual({ kind: 'list', scope: 'root' })
    expect(slots.spec('settings.trigger')).toBeUndefined()
    expect(slots.spec('settings.header')).toBeUndefined()
    expect(slots.spec('settings.close')).toBeUndefined()
    expect(slots.entries('settings.section')[0]?.options).toMatchObject({
      id: 'about-update',
      order: 40,
    })
    expect(slots.entries('settings.section')[0]?.options.label).toBeTypeOf('function')

    locale.setLocale('zh')
    expect((slots.entries('settings.section')[0]?.options.label as () => string)())
      .toBe('关于与更新')
    await fiber.dispose()
  })
})
