/** Host registration for the durable Openloop chat zoom preference. */
import type { Context } from '@deepseek-ai/cordis'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'
import {
  CHAT_ZOOM_SETTINGS_NAMESPACE,
  ChatZoomSettingsSchema,
} from './settings.ts'

export const name = 'chat-zoom'

export {
  CHAT_ZOOM_PERCENT_FIELD,
  CHAT_ZOOM_SETTINGS_NAMESPACE,
  ChatZoomSettingsSchema,
  type ChatZoomSettings,
} from './settings.ts'

export function apply(ctx: Context): void {
  ctx.inject(['settings'], (settingsCtx) => {
    settingsCtx.settings.register(
      settingsNamespace(CHAT_ZOOM_SETTINGS_NAMESPACE),
      ChatZoomSettingsSchema,
    )
  })
}
