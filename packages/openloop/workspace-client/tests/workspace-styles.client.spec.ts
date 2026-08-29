import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const css = readFileSync(
  fileURLToPath(new URL('../src/client/Workspace.module.css', import.meta.url)),
  'utf8',
)

function declarations(selector: string): Map<string, string> {
  const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, ' ')
  for (const [, selectorList = '', body = ''] of withoutComments.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (!selectorList.split(',').map(value => value.trim()).includes(selector)) continue
    const result = new Map<string, string>()
    for (const part of body.split(';')) {
      const colon = part.indexOf(':')
      if (colon === -1) continue
      result.set(
        part.slice(0, colon).trim(),
        part.slice(colon + 1).trim().replace(/\s+/g, ' '),
      )
    }
    return result
  }
  throw new Error(`Workspace.module.css has no ${selector} rule`)
}

describe('Workspace surface layout contracts', () => {
  it('reserves stable columns for every ready-row item', () => {
    expect(declarations('.workspaceRow').get('grid-template-columns'))
      .toBe('12px minmax(0, 1fr) auto auto auto')
  })

  it('keeps the Settings modal content in a bounded vertical scroll chain', () => {
    expect(declarations('.settingsDialog').get('min-height')).toBe('0')
    expect(declarations('.settingsContent').get('min-height')).toBe('0')
    expect(declarations('.settingsContent').get('overflow-y')).toBe('auto')
  })
})
