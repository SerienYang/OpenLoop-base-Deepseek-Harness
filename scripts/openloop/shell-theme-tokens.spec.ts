import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const generator = 'scripts/openloop/generate-shell-theme-tokens.mjs'
const frameStyles = 'packages/openloop/shell/src/client/OpenloopFrame.module.css'

describe('Openloop shell theme tokens', () => {
  it('keeps the generated runtime mapping synchronized with the DTCG source', () => {
    const result = spawnSync(process.execPath, [generator, '--check'], {
      encoding: 'utf8',
    })

    expect(result.status, result.stderr || result.stdout).toBe(0)
  })

  it('sources both modes from monochrome DTCG roles without a dark cyan accent', () => {
    const result = spawnSync(process.execPath, [generator, '--json'], {
      encoding: 'utf8',
    })

    expect(result.status, result.stderr).toBe(0)
    const tokens = JSON.parse(result.stdout) as Record<
      string,
      { readonly light: string; readonly dark: string }
    >
    expect(tokens['--dsw-alias-bg-base']).toEqual({
      light: '#F7F8FA',
      dark: '#0B0D0F',
    })
    expect(tokens['--dsw-alias-brand-primary']).toEqual({
      light: '#111316',
      dark: '#F7F8FA',
    })
    expect(tokens['--dsw-alias-brand-primary-new-colorprimary-new-color']).toEqual({
      light: '#111316',
      dark: '#F7F8FA',
    })
    expect(Object.values(tokens).every(value =>
      /^#[0-9A-F]{6}$/u.test(value.light)
      && /^#[0-9A-F]{6}$/u.test(value.dark))).toBe(true)
  })

  it('keeps frame CSS on theme aliases instead of copied semantic hex values', () => {
    const css = readFileSync(frameStyles, 'utf8')

    expect(css).not.toMatch(/#[0-9a-f]{6}/iu)
    expect(css).toContain('var(--dsw-alias-bg-base)')
    expect(css).toContain('var(--dsw-specific-sidebar-fill)')
    expect(css).toContain('var(--dsw-alias-border-l1)')
    expect(css).toContain('var(--dsw-alias-border-l2)')
  })
})
