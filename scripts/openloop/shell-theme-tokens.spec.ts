import { spawnSync } from 'node:child_process'
import { globSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { composeEntries } from '@deepseek-ai/dsh-app-boot'
import { entryListSchema } from '@deepseek-ai/cordis-plugin-include'
import { OPENLOOP_PROFILE_BUNDLES } from '@openloop/bundle'
import * as yaml from 'js-yaml'
import { describe, expect, it } from 'vitest'

const generator = 'scripts/openloop/generate-shell-theme-tokens.mjs'
const frameStyles = 'packages/openloop/shell/src/client/OpenloopFrame.module.css'
const inputBarStyles = 'packages/client/ui-conversation/src/client/skeleton/InputBar.module.css'
const directDeepSeekConsumers = [
  'packages/client/ui-primitives/src/StateDot.module.css',
  'packages/client/ui-conversation/src/client/chat/ChatView.module.css',
]
const brandAccentBindings = [
  {
    file: 'packages/client/ui-conversation/src/client/skeleton/EmptyHero.tsx',
    token: '--dsw-specific-hero-glow',
    fallback: '#6187D8',
    light: '#666D76',
    dark: '#AEB4BC',
  },
  {
    file: 'packages/client/ui-attachment/src/DropOverlay.tsx',
    token: '--dsw-specific-drop-overlay-back-card',
    fallback: '#9CE5ED',
    light: '#EEF1F3',
    dark: '#3B424A',
  },
  {
    file: 'packages/client/ui-attachment/src/DropOverlay.tsx',
    token: '--dsw-specific-drop-overlay-side-card',
    fallback: '#679EFE',
    light: '#0B0D0F',
    dark: '#FBFBFA',
  },
  {
    file: 'packages/client/ui-attachment/src/DropOverlay.tsx',
    token: '--dsw-specific-drop-overlay-front-card',
    fallback: '#3964FE',
    light: '#111316',
    dark: '#F7F8FA',
  },
] as const
const foregroundBindings = [
  {
    file: inputBarStyles,
    token: '--dsw-alias-button-info-foreground',
    fallback: '#fff',
    background: '--dsw-alias-button-info-fill',
    light: '#FBFBFA',
    dark: '#111316',
  },
  {
    file: 'packages/client/ui-attachment/src/DropOverlay.tsx',
    token: '--dsw-specific-drop-overlay-back-card-foreground',
    fallback: 'white',
    background: '--dsw-specific-drop-overlay-back-card',
    light: '#111316',
    dark: '#F7F8FA',
  },
  {
    file: 'packages/client/ui-attachment/src/DropOverlay.tsx',
    token: '--dsw-specific-drop-overlay-side-card-foreground',
    fallback: 'white',
    background: '--dsw-specific-drop-overlay-side-card',
    light: '#FBFBFA',
    dark: '#111316',
  },
  {
    file: 'packages/client/ui-attachment/src/DropOverlay.tsx',
    token: '--dsw-specific-drop-overlay-front-card-foreground',
    fallback: 'white',
    background: '--dsw-specific-drop-overlay-front-card',
    light: '#FBFBFA',
    dark: '#111316',
  },
] as const
const repositoryRoot = resolve(import.meta.dirname, '../..')
const staticDeepseekPattern = /var\((--dsw-static-deepseek-[a-z0-9-]+)\)/gu
const directBrandAccentPattern =
  /(?:\b(?:fill|stroke)=["']|(?:background(?:-color)?|border-color|color|fill|stroke)\s*:\s*)#(?:6187d8|9ce5ed|679efe|3964fe)\b/giu

interface PackageManifest {
  readonly name?: string
  readonly dsh?: {
    readonly bundle?: { readonly patch?: string }
    readonly client?: { readonly platform?: string }
  }
}

function packageName(specifier: string): string {
  return specifier.startsWith('@')
    ? specifier.split('/').slice(0, 2).join('/')
    : specifier.split('/', 1)[0] ?? specifier
}

function enabledClientPackageDirectories(): string[] {
  const require = createRequire(import.meta.url)
  const manifests = new Map<string, { readonly directory: string; readonly value: PackageManifest }>()
  for (const relative of globSync('packages/*/*/package.json', { cwd: repositoryRoot })) {
    const value = JSON.parse(readFileSync(join(repositoryRoot, relative), 'utf8')) as PackageManifest
    if (value.name !== undefined) {
      manifests.set(value.name, { directory: dirname(join(repositoryRoot, relative)), value })
    }
  }
  const layers = OPENLOOP_PROFILE_BUNDLES.map((bundle) => {
    const manifestPath = require.resolve(`${bundle}/package.json`)
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as PackageManifest
    return yaml.load(readFileSync(
      join(dirname(manifestPath), manifest.dsh?.bundle?.patch ?? ''),
      'utf8',
    ), { schema: entryListSchema })
  })
  const entries = composeEntries(layers as Parameters<typeof composeEntries>[0])
  const queue = entries.flatMap((entry) => {
    if (entry.disabled === true || typeof entry.name !== 'string') return []
    return manifests.get(entry.name)?.value.dsh?.client?.platform === 'web'
      ? [entry.name]
      : []
  })
  const reachable = new Set<string>()
  while (queue.length > 0) {
    const current = queue.shift()
    if (current === undefined || reachable.has(current)) continue
    reachable.add(current)
    const manifest = manifests.get(current)
    if (manifest === undefined) continue
    for (const file of globSync('src/**/*.{ts,tsx}', { cwd: manifest.directory })) {
      const source = readFileSync(join(manifest.directory, file), 'utf8')
      for (const match of source.matchAll(
        /(?:from\s*|import\s*\(\s*|import\s*)['"]([^'"]+)['"]/gu,
      )) {
        const dependency = packageName(match[1] ?? '')
        if (manifests.has(dependency) && !reachable.has(dependency)) queue.push(dependency)
      }
    }
  }
  return [...reachable]
    .flatMap(name => manifests.get(name)?.directory ?? [])
    .sort()
}

function enabledStaticDeepseekTokens(): string[] {
  const tokens = new Set<string>()
  for (const directory of enabledClientPackageDirectories()) {
    if (directory.endsWith('/packages/client/ui-theme')) continue
    for (const file of globSync('src/**/*.css', { cwd: directory })) {
      const css = readFileSync(join(directory, file), 'utf8')
      for (const match of css.matchAll(staticDeepseekPattern)) {
        if (match[1] !== undefined) tokens.add(match[1])
      }
    }
  }
  return [...tokens].sort()
}

function directlyDeclaredBrandAccents(): string[] {
  const matches: string[] = []
  for (const directory of enabledClientPackageDirectories()) {
    for (const file of globSync('src/**/*.{css,ts,tsx}', { cwd: directory })) {
      const source = readFileSync(join(directory, file), 'utf8')
      for (const match of source.matchAll(directBrandAccentPattern)) {
        matches.push(`${join(directory, file)}: ${match[0]}`)
      }
    }
  }
  return matches.sort()
}

function contrastRatio(foreground: string, background: string): number {
  const luminance = (hex: string): number => {
    const channels = [1, 3, 5].map((index) => {
      const value = Number.parseInt(hex.slice(index, index + 2), 16) / 255
      return value <= 0.04045
        ? value / 12.92
        : ((value + 0.055) / 1.055) ** 2.4
    })
    return (channels[0] ?? 0) * 0.2126
      + (channels[1] ?? 0) * 0.7152
      + (channels[2] ?? 0) * 0.0722
  }
  const values = [luminance(foreground), luminance(background)]
    .sort((left, right) => right - left)
  return ((values[0] ?? 0) + 0.05) / ((values[1] ?? 0) + 0.05)
}

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
    expect(tokens['--dsw-alias-label-primary-bluish']).toEqual({
      light: '#111316',
      dark: '#F7F8FA',
    })
    const directlyConsumedTokens = new Set(directDeepSeekConsumers.flatMap(file =>
      [...readFileSync(file, 'utf8').matchAll(/--dsw-static-deepseek-[a-z0-9-]+/gu)]
        .map(match => match[0])))
    expect([...directlyConsumedTokens].sort()).toEqual([
      '--dsw-static-deepseek-200',
      '--dsw-static-deepseek-450',
      '--dsw-static-deepseek-500',
    ])
    expect([...directlyConsumedTokens].every(token => Object.hasOwn(tokens, token))).toBe(true)
    expect(Object.values(tokens).every(value =>
      /^#[0-9A-F]{6}$/u.test(value.light)
      && /^#[0-9A-F]{6}$/u.test(value.dark))).toBe(true)
  })

  it('overrides every static DeepSeek color consumed by the enabled Openloop UI', () => {
    const result = spawnSync(process.execPath, [generator, '--json'], {
      encoding: 'utf8',
    })

    expect(result.status, result.stderr).toBe(0)
    const tokens = JSON.parse(result.stdout) as Record<
      string,
      { readonly light: string; readonly dark: string }
    >
    const staticOverrides = Object.keys(tokens)
      .filter(token => token.startsWith('--dsw-static-deepseek-'))
      .sort()

    expect(staticOverrides).toEqual(enabledStaticDeepseekTokens())
    expect(staticOverrides.map(token => tokens[token]?.dark)).toEqual([
      '#3B424A',
      '#F7F8FA',
      '#AEB4BC',
    ])
  })

  it('keeps DSH fallbacks while routing branded SVG decoration through theme tokens', () => {
    for (const binding of brandAccentBindings) {
      const source = readFileSync(binding.file, 'utf8')
      expect(source).toContain(`var(${binding.token}, ${binding.fallback})`)
    }
  })

  it('keeps DSH white glyph fallbacks while pairing Openloop foregrounds with backgrounds', () => {
    const result = spawnSync(process.execPath, [generator, '--json'], {
      encoding: 'utf8',
    })

    expect(result.status, result.stderr).toBe(0)
    const tokens = JSON.parse(result.stdout) as Record<
      string,
      { readonly light: string; readonly dark: string }
    >
    for (const binding of foregroundBindings) {
      const source = readFileSync(binding.file, 'utf8')
      expect(source).toContain(`var(${binding.token}, ${binding.fallback})`)
      expect(tokens[binding.token]).toEqual({
        light: binding.light,
        dark: binding.dark,
      })
      const background = tokens[binding.background]
      expect(background).toBeDefined()
      expect(contrastRatio(binding.light, background?.light ?? binding.light))
        .toBeGreaterThanOrEqual(4.5)
      expect(contrastRatio(binding.dark, background?.dark ?? binding.dark))
        .toBeGreaterThanOrEqual(4.5)
    }
  })

  it('maps branded SVG decoration to neutral Openloop semantic roles', () => {
    const result = spawnSync(process.execPath, [generator, '--json'], {
      encoding: 'utf8',
    })

    expect(result.status, result.stderr).toBe(0)
    const tokens = JSON.parse(result.stdout) as Record<
      string,
      { readonly light: string; readonly dark: string }
    >
    for (const binding of brandAccentBindings) {
      expect(tokens[binding.token]).toEqual({
        light: binding.light,
        dark: binding.dark,
      })
    }
  })

  it('has no direct branded cyan or blue decoration in the enabled Openloop UI', () => {
    expect(directlyDeclaredBrandAccents()).toEqual([])
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
