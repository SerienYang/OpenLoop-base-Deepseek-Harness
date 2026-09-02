const CHAT_ZOOM_LEVELS = [80, 90, 100, 110, 120, 130, 140, 150, 160] as const
export const DEFAULT_CHAT_ZOOM = 100

export type ChatZoomCommand = 'increase' | 'decrease' | 'reset'

export interface KeyboardShortcut {
  readonly key: string
  readonly metaKey: boolean
  readonly ctrlKey: boolean
  readonly altKey: boolean
  readonly shiftKey: boolean
}

export function normalizeZoom(value: unknown): number {
  return typeof value === 'number'
    && Number.isInteger(value)
    && CHAT_ZOOM_LEVELS.includes(value as (typeof CHAT_ZOOM_LEVELS)[number])
    ? value
    : DEFAULT_CHAT_ZOOM
}

export function stepZoom(current: number, command: ChatZoomCommand): number {
  if (command === 'reset') return DEFAULT_CHAT_ZOOM
  const normalized = normalizeZoom(current)
  const index = CHAT_ZOOM_LEVELS.indexOf(normalized as (typeof CHAT_ZOOM_LEVELS)[number])
  const offset = command === 'increase' ? 1 : -1
  const next = Math.max(0, Math.min(CHAT_ZOOM_LEVELS.length - 1, index + offset))
  return CHAT_ZOOM_LEVELS[next] ?? DEFAULT_CHAT_ZOOM
}

export function commandFromKeyboard(event: KeyboardShortcut): ChatZoomCommand | undefined {
  if (!event.metaKey || event.ctrlKey || event.altKey) return undefined
  if (event.key === '+' || event.key === '=') return 'increase'
  if (event.key === '-' || event.key === '_') return 'decrease'
  if (event.key === '0') return 'reset'
  return undefined
}
