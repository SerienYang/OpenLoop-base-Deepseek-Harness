/** Openloop browser root shell. */
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import { bindSnapshotSelector } from '@deepseek-ai/dsh-client-web-react'
import { resolveSlotLabel } from '@deepseek-ai/dsh-client-ui-slots'
import type { BoundActions } from '@deepseek-ai/dsh-client-ui-slots'
import type { ILayout } from '@deepseek-ai/dsh-client-ui-layout/client'
import type { ThemeSnapshot } from '@deepseek-ai/dsh-client-ui-theme/client'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {
  ProductSettingsApi,
  SettingsShellOwner,
} from '@deepseek-ai/dsh-client-ui-settings/client'
import {
  parseBootstrapAppView,
} from './AboutUpdateSection.tsx'
import { ConnectedAboutUpdateSection } from './ConnectedAboutUpdateSection.tsx'
import {
  createOpenloopCredentialControlAdapter,
  type OpenloopCredentialRemote,
} from './CredentialControl.tsx'
import { en, zh, type ShellKey } from './locales.ts'
import { createOpenloopShellStore, OpenloopFrame } from './OpenloopFrame.tsx'
import {
  OpenloopSettings,
  type OpenloopSettingsInjected,
  type OpenloopSettingsOnboardingStep,
  type OpenloopSettingsSection,
} from './OpenloopSettings.tsx'
import { OPENLOOP_THEME_TOKENS } from './theme-tokens.generated.ts'

export {
  createOpenloopCredentialControlAdapter,
  CredentialControl,
} from './CredentialControl.tsx'
export {
  AboutUpdateSection,
  parseBootstrapAppView,
} from './AboutUpdateSection.tsx'
export type { AppView, UpdateView } from './AboutUpdateSection.tsx'
export type { AboutUpdateSectionProps, UpdateActionView, UpdatePhase } from './AboutUpdateSection.tsx'
export type {
  CredentialControlProps,
  OpenloopCredentialRemote,
} from './CredentialControl.tsx'
export type { ShellKey } from './locales.ts'
export { OpenloopFrame } from './OpenloopFrame.tsx'
export {
  OPENLOOP_SETTINGS_SECTION_IDS,
  OpenloopSettings,
} from './OpenloopSettings.tsx'
export type {
  OpenloopSettingsInjected,
  OpenloopSettingsOnboardingStep,
  OpenloopSettingsProps,
  OpenloopSettingsSection,
} from './OpenloopSettings.tsx'
export { parseOpenloopBrand } from './brand.ts'
export type { OpenloopBrand } from './brand.ts'

type ShellActions = BoundActions<ReturnType<typeof createOpenloopShellStore>>

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Openloop shell credential-control copy. */
    'openloop.shell': ShellKey
  }

  interface SlotMap {
    /**
     * Openloop's trusted Workbench surface beside the conversation. The
     * Workbench package mounts its single WorkbenchHost occupant here.
     */
    'workbench': { kind: 'single'; scope: 'root'; owner: WorkbenchOwnerProps }
  }
}

/** Workbench owner share; the Workbench package owns its application state. */
export interface WorkbenchOwnerProps {}

class OpenloopLayoutController implements ILayout {
  private actions: ShellActions | undefined

  attach(actions: ShellActions): void {
    this.actions = actions
  }

  toggleSidebar(): void {
    this.requireActions().toggleSidebar()
  }

  openDetails(): void {
    this.requireActions().openDetails()
  }

  closeDetails(): void {
    this.requireActions().closeDetails()
  }

  private requireActions(): ShellActions {
    if (this.actions === undefined) {
      throw new Error('Openloop shell panel actions are not wired')
    }
    return this.actions
  }
}

class ThemeDocumentPresenter {
  private appliedTokens: string[] = []
  private readonly meta = document.createElement('meta')

  constructor() {
    this.meta.name = 'theme-color'
  }

  apply(snapshot: ThemeSnapshot): void {
    const scheme = snapshot.active.colorScheme
    document.documentElement.style.colorScheme = scheme
    if (scheme === 'dark') document.body.setAttribute('data-ds-dark-theme', '')
    else document.body.removeAttribute('data-ds-dark-theme')
    for (const token of this.appliedTokens) document.body.style.removeProperty(token)
    this.appliedTokens = Object.keys(snapshot.active.tokens)
    for (const [token, value] of Object.entries(snapshot.active.tokens)) {
      document.body.style.setProperty(token, value)
    }
    this.meta.content = getComputedStyle(document.body).backgroundColor
    if (!this.meta.isConnected) document.head.append(this.meta)
  }

  dispose(): void {
    document.documentElement.style.removeProperty('color-scheme')
    document.body.removeAttribute('data-ds-dark-theme')
    for (const token of this.appliedTokens) document.body.style.removeProperty(token)
    this.appliedTokens = []
    this.meta.remove()
  }
}

export const name = 'shell'
export const inject = [
  'slots',
  'theme',
  'locale',
  'remote',
  'remote.openloopDesktop',
  'openloopSettingsApi',
  'openloopUpdates',
]

/** Dictionary namespace owned by the Openloop shell. */
const NS = 'openloop.shell'

declare module '@deepseek-ai/cordis' {
  interface Context {
    openloopSettingsApi: ProductSettingsApi
  }
}

interface OpenloopBootstrapGlobal {
  readonly __OPENLOOP_BOOTSTRAP__?: unknown
}

/** Register one Openloop root owner, its child surfaces, and product theme tokens. */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'openloop-shell: copy dictionaries')
  const t = ctx.locale.bind(NS)
  const desktop = (
    ctx.remote as unknown as { openloopDesktop: OpenloopCredentialRemote }
  ).openloopDesktop
  const settingsApi = ctx.openloopSettingsApi
  const settingsShellOwner: SettingsShellOwner = Object.freeze({
    id: '@openloop/shell',
    credentialControl: createOpenloopCredentialControlAdapter(desktop, t),
    settingsApi,
  })
  ctx.effect(
    () => ctx.reflect.provide('settingsShellOwner', settingsShellOwner),
    'openloop-shell: settings owner + Host credential control',
  )

  const layout = new OpenloopLayoutController()
  ctx.effect(() => {
    const disposeService = ctx.reflect.provide('layout', layout)
    const disposeRegistration = ctx.slots.register({
      name: 'root',
      children: {
        'sidebar': { kind: 'single', scope: 'root' },
        'conversation': { kind: 'single', scope: 'session-maybe' },
        'workbench': { kind: 'single', scope: 'root' },
        'details': { kind: 'single', scope: 'session' },
        'shell.overlay': { kind: 'list', scope: 'root' },
      },
      store: createOpenloopShellStore,
      inject: (actions: ShellActions) => {
        layout.attach(actions)
        return {}
      },
    }, OpenloopFrame)
    return () => {
      disposeRegistration()
      void disposeService()
    }
  }, 'openloop-shell: layout service + root registration')

  ctx.effect(
    () => ctx.theme.overrideTokens('@openloop/shell', OPENLOOP_THEME_TOKENS),
    'openloop-shell: brand theme tokens',
  )

  let rowsVersion = -1
  let rowsRevision = -1
  let rows: readonly OpenloopSettingsSection[] = []
  let onboardingVersion = -1
  let onboardingSteps: readonly OpenloopSettingsOnboardingStep[] = []
  const settingsInjected = (): OpenloopSettingsInjected => ({
    hooks: {
      sections: {
        getSnapshot: () => {
          const version = ctx.slots.getVersion('settings.section')
          const revision = ctx.locale.getSnapshot().revision
          if (version !== rowsVersion || revision !== rowsRevision) {
            rowsVersion = version
            rowsRevision = revision
            rows = ctx.slots.entriesOfSlot('settings.section')
              .map(entry => ({
                /* v8 ignore next -- list entries always have ids. */
                id: entry.options.id ?? '',
                order: entry.options.order ?? 0,
                label: resolveSlotLabel(entry.options.label) ?? '',
              }))
          }
          return rows
        },
        subscribe: (listener) => {
          const offSections = ctx.slots.subscribe('settings.section', listener)
          const offLocale = ctx.locale.subscribe(listener)
          return () => {
            offSections()
            offLocale()
          }
        },
      },
      onboardingSteps: {
        getSnapshot: () => {
          const version = ctx.slots.getVersion('settings.onboarding')
          if (version !== onboardingVersion) {
            onboardingVersion = version
            onboardingSteps = ctx.slots.entriesOfSlot('settings.onboarding')
              .map(entry => ({
                /* v8 ignore next -- list entries always have ids. */
                id: entry.options.id ?? '',
                order: entry.options.order ?? 0,
              }))
              .sort((left, right) => left.order - right.order)
          }
          return onboardingSteps
        },
        subscribe: listener => ctx.slots.subscribe('settings.onboarding', listener),
      },
    },
  })
  ctx.slots.inject('sidebar.settings', () => ctx.slots.register({
    name: 'sidebar.settings',
    locale: NS,
    children: {
      'settings.action': { kind: 'list', scope: 'root' },
      'settings.section': { kind: 'list', scope: 'root' },
      'settings.onboarding': { kind: 'list', scope: 'root' },
    },
    inject: settingsInjected,
  }, OpenloopSettings))

  const bootstrap = globalThis as typeof globalThis & OpenloopBootstrapGlobal
  const app = parseBootstrapAppView(bootstrap.__OPENLOOP_BOOTSTRAP__)
  const updates = ctx.openloopUpdates
  const useUpdate = bindSnapshotSelector(updates.view)
  ctx.effect(() => {
    void updates.refresh().catch(() => {})
    return () => {}
  }, 'openloop-shell: refresh update status on mount')
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'about-update',
    order: 40,
    label: () => t('aboutNav'),
    locale: NS,
    inject: () => ({
      app,
      useUpdate,
      onCheck: () => { void updates.checkForUpdate().catch(() => {}) },
      onInstallAndRestart: () => {
        void updates.installUpdateAndRestart().catch(() => {})
      },
    }),
  }, ConnectedAboutUpdateSection))

  ctx.effect(() => {
    const presenter = new ThemeDocumentPresenter()
    presenter.apply(ctx.theme.getTheme())
    const off = ctx.on('theme/change', (snapshot) => { presenter.apply(snapshot) })
    return () => {
      off()
      presenter.dispose()
    }
  }, 'openloop-shell: theme presenter')
}
