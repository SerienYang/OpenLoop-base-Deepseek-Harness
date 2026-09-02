/** Openloop-only settings scope that never crosses the browser/Host boundary. */

import { Service } from '@deepseek-ai/cordis'
import type { Context } from '@deepseek-ai/cordis'
import type {
  SettingsScope,
  SettingsScopeSnapshot,
  SettingsScopeSpec,
} from '@deepseek-ai/dsh-client-runtime/client'

export const inject: string[] = []

/**
 * Supplies the settingsScope contract required by shared DSH clients while
 * Openloop keeps the legacy Host settings API outside its browser policy.
 */
export class OpenloopSettingsScopeBinder extends Service {
  constructor(ctx: Context) {
    super(ctx, 'settingsScope')
  }

  bind<T>(_spec: SettingsScopeSpec<T>): SettingsScope<T> {
    const snapshot: SettingsScopeSnapshot<T> = {
      status: 'unavailable',
      value: undefined,
      base: undefined,
      user: undefined,
      revision: undefined,
      writable: false,
      mode: 'memory',
    }
    return {
      getSnapshot: () => snapshot,
      subscribe: () => () => {},
      set: () => Promise.resolve(),
      unset: () => Promise.resolve(),
    }
  }
}

export function apply(ctx: Context): void {
  new OpenloopSettingsScopeBinder(ctx)
}
