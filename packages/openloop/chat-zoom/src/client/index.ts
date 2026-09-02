import type { ClientContext, SettingsScopeSnapshot } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import {
  CHAT_ZOOM_PERCENT_FIELD,
  CHAT_ZOOM_SETTINGS_NAMESPACE,
  type ChatZoomSettings,
} from '../settings.ts'
import {
  DEFAULT_CHAT_ZOOM,
  commandFromKeyboard,
  normalizeZoom,
  stepZoom,
} from '../zoom.ts'

export const name = 'chat-zoom'
export const inject = ['connection', 'remote', 'settingsScope']

const CSS_PROPERTY = '--openloop-chat-text-scale'
const STORAGE_KEY = 'openloop.chatZoom.percent'

function processLocalStorage(): Storage | undefined {
  try {
    return globalThis.localStorage
  } catch {
    return undefined
  }
}

function readProcessLocalZoom(fallback: number): number {
  const storage = processLocalStorage()
  if (storage === undefined) return fallback
  try {
    const stored = storage.getItem(STORAGE_KEY)
    return stored === null ? fallback : normalizeZoom(Number(stored))
  } catch {
    return fallback
  }
}

function writeProcessLocalZoom(value: number): void {
  const storage = processLocalStorage()
  if (storage === undefined) return
  try {
    storage.setItem(STORAGE_KEY, String(value))
  } catch {}
}

export function apply(ctx: ClientContext): void {
  const settings = ctx.settingsScope.bind<ChatZoomSettings>({
    namespace: CHAT_ZOOM_SETTINGS_NAMESPACE,
    decode: (section) => {
      if (typeof section !== 'object' || section === null || Array.isArray(section)) return undefined
      const percent = normalizeZoom((section as { percent?: unknown }).percent)
      return { percent: percent as ChatZoomSettings['percent'] }
    },
  })
  let percent = DEFAULT_CHAT_ZOOM
  let pendingWrites = 0
  let active = true

  ctx.effect(() => {
    if (typeof document === 'undefined') return () => {}
    const root = document.documentElement
    const previous = root.style.getPropertyValue(CSS_PROPERTY)
    const publish = (value: number): void => {
      root.style.setProperty(CSS_PROPERTY, String(value / 100))
    }
    const adopt = (snapshot: SettingsScopeSnapshot<ChatZoomSettings>): void => {
      if (pendingWrites > 0) return
      percent = snapshot.status === 'ready'
        ? normalizeZoom(snapshot.value?.percent)
        : snapshot.mode === 'memory'
          ? readProcessLocalZoom(percent)
          : DEFAULT_CHAT_ZOOM
      publish(percent)
    }
    adopt(settings.getSnapshot())
    const unsubscribe = settings.subscribe(() => { adopt(settings.getSnapshot()) })
    const onKeyDown = (event: KeyboardEvent): void => {
      const command = commandFromKeyboard(event)
      if (command === undefined) return
      event.preventDefault()
      percent = stepZoom(percent, command)
      publish(percent)
      if (settings.getSnapshot().mode === 'memory') writeProcessLocalZoom(percent)
      pendingWrites += 1
      void settings.set(CHAT_ZOOM_PERCENT_FIELD, percent).finally(() => {
        pendingWrites -= 1
        if (active && pendingWrites === 0) adopt(settings.getSnapshot())
      })
    }
    document.addEventListener('keydown', onKeyDown)
    return () => {
      active = false
      unsubscribe()
      document.removeEventListener('keydown', onKeyDown)
      if (previous === '') root.style.removeProperty(CSS_PROPERTY)
      else root.style.setProperty(CSS_PROPERTY, previous)
    }
  }, 'openloop-chat-zoom: keyboard and presentation')
}
