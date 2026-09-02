/** Authenticated Settings foundation for the Openloop main WebView. */

import type { Context } from '@deepseek-ai/cordis'
import {
  SettingsScopeBinder,
  type ProductSettingsApi,
} from '@deepseek-ai/dsh-client-ui-settings/client'
import { OpenloopSettingsApi } from './settings-api.ts'

export { OpenloopSettingsApi } from './settings-api.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    openloopSettingsApi: ProductSettingsApi
  }
}

export const inject = ['connection', 'remote']

export function apply(
  ctx: Context,
  api: ProductSettingsApi = new OpenloopSettingsApi(),
): () => void {
  new SettingsScopeBinder(ctx, api)
  const removeApi = ctx.reflect.provide('openloopSettingsApi', api)
  return () => { void removeApi() }
}
