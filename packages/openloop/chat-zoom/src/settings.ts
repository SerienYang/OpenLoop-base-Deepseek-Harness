import z from '@deepseek-ai/schemastery'

export const CHAT_ZOOM_SETTINGS_NAMESPACE = 'openloop-chat-zoom'
export const CHAT_ZOOM_PERCENT_FIELD = 'percent'

export interface ChatZoomSettings {
  percent: 80 | 90 | 100 | 110 | 120 | 130 | 140 | 150 | 160
}

export const ChatZoomSettingsSchema: z<ChatZoomSettings> = z.object({
  [CHAT_ZOOM_PERCENT_FIELD]: z.union([80, 90, 100, 110, 120, 130, 140, 150, 160]).default(100),
})
