/**
 * Settings domain base plugin, browser half. Provides `ctx.settingsScope`, the
 * settings-namespace Host transport every preference row binds its durable
 * section through, and owns the canonical slot-type contract for the settings
 * surface. It depends on no `ui-*` presentation package, so any feature that
 * owns a preference can reach it: the settings SHELL — the `sidebar.settings`
 * occupant, its navigation, and the chrome — lives in ui-settings-general,
 * because a shell dependency on ui-sidebar would close a reference cycle
 * through ui-layout and ui-theme. Export discipline: packages/client/AGENTS.md.
 */
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type { CredentialControlAdapter } from './credential-control.ts'
import { SettingsScopeBinder } from './settings-scope.ts'

/** Browser service selecting the Settings shell and its optional product controls. */
export interface SettingsShellOwner {
  /** Stable package or product identifier for diagnostics. */
  readonly id: string
  /** Product-owned credential UI; absent in the default DSH profile. */
  readonly credentialControl?: CredentialControlAdapter
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    settingsShellOwner: SettingsShellOwner
  }
}

export type {
  CredentialControlAdapter,
  CredentialControlRenderProps,
  CredentialControlStatus,
} from './credential-control.ts'
export type {
  SettingsGeneralItemOwnerProps, SettingsHeaderOwnerProps, SettingsOnboardingOwnerProps,
  SettingsPluginsTabOwnerProps, SettingsSectionOwnerProps, SettingsTriggerOwnerProps,
} from './contract/slots.ts'
export { SettingsScopeController, SettingsScopeBinder } from './settings-scope.ts'

/**
 * Required services: none. This plugin provides both settingsScope and the
 * default Settings shell owner, so downstream browser plugins can activate
 * against one stable profile decision.
 */
export const inject = []

/**
 * Provide the settings-namespace scope service.
 *
 * Constructing the service in this plugin's fiber keeps its traced methods
 * bound to each consuming plugin's context.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  new SettingsScopeBinder(ctx)
  ctx.effect(
    () => ctx.reflect.provide('settingsShellOwner', {
      id: '@deepseek-ai/dsh-client-ui-settings-general',
    }),
    'ui-settings: default shell owner',
  )
}
