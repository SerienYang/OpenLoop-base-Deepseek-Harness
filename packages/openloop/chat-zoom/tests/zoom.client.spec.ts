import { describe, expect, it } from 'vitest'
import {
  DEFAULT_CHAT_ZOOM,
  commandFromKeyboard,
  normalizeZoom,
  stepZoom,
} from '../src/zoom.ts'

describe('chat zoom model', () => {
  it('steps by ten percent and clamps to the supported range', () => {
    expect(stepZoom(100, 'increase')).toBe(110)
    expect(stepZoom(160, 'increase')).toBe(160)
    expect(stepZoom(100, 'decrease')).toBe(90)
    expect(stepZoom(80, 'decrease')).toBe(80)
    expect(stepZoom(140, 'reset')).toBe(DEFAULT_CHAT_ZOOM)
  })

  it('accepts only supported integer percentages', () => {
    expect(normalizeZoom(80)).toBe(80)
    expect(normalizeZoom(130)).toBe(130)
    expect(normalizeZoom(160)).toBe(160)
    expect(normalizeZoom(115)).toBe(DEFAULT_CHAT_ZOOM)
    expect(normalizeZoom('130')).toBe(DEFAULT_CHAT_ZOOM)
    expect(normalizeZoom(null)).toBe(DEFAULT_CHAT_ZOOM)
  })
})

describe('chat zoom keyboard shortcuts', () => {
  it.each([
    ['=', false, 'increase'],
    ['+', true, 'increase'],
    ['-', false, 'decrease'],
    ['_', true, 'decrease'],
    ['0', false, 'reset'],
  ] as const)('maps Command+%s to %s', (key, shiftKey, command) => {
    expect(commandFromKeyboard({
      key,
      metaKey: true,
      ctrlKey: false,
      altKey: false,
      shiftKey,
    })).toBe(command)
  })

  it.each([
    { key: '=', metaKey: false, ctrlKey: false, altKey: false, shiftKey: false },
    { key: '=', metaKey: true, ctrlKey: true, altKey: false, shiftKey: false },
    { key: '-', metaKey: true, ctrlKey: false, altKey: true, shiftKey: false },
    { key: 'a', metaKey: true, ctrlKey: false, altKey: false, shiftKey: false },
  ])('ignores unsupported shortcut $key', (event) => {
    expect(commandFromKeyboard(event)).toBeUndefined()
  })
})
