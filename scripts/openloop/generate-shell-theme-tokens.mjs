import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repositoryRoot = fileURLToPath(new URL('../../', import.meta.url))
const tokenPath = resolve(repositoryRoot, 'assets/brand/openloop.tokens.json')
const outputPath = resolve(
  repositoryRoot,
  'packages/openloop/shell/src/client/theme-tokens.generated.ts',
)

const TOKEN_ROLES = {
  '--dsw-alias-bg-base': 'background.canvas',
  '--dsw-alias-bg-layer-1': 'background.surface',
  '--dsw-alias-bg-layer-2': 'background.subtle',
  '--dsw-alias-bg-overlay': 'background.surface',
  '--dsw-alias-border-l1': 'border.subtle',
  '--dsw-alias-border-l2': 'border.default',
  '--dsw-alias-brand-primary': 'action.primary.background',
  '--dsw-alias-brand-primary-new-colorprimary-new-color': 'action.primary.background',
  '--dsw-alias-button-info-fill': 'action.primary.background',
  '--dsw-alias-button-info-hover': 'action.primary.hover-background',
  '--dsw-alias-label-primary': 'text.primary',
  '--dsw-alias-label-secondary': 'text.secondary',
  '--dsw-alias-state-business-primary': 'text.primary',
  '--dsw-alias-state-business-tertiary': 'status.info.surface',
  '--dsw-alias-state-error-primary': 'status.danger.foreground',
  '--dsw-alias-state-success-primary': 'status.success.foreground',
  '--dsw-alias-state-warn-primary': 'status.warning.foreground',
  '--dsw-specific-bubble': 'background.subtle',
  '--dsw-specific-bubble-highlight': 'state.selected.background',
  '--dsw-specific-sidebar-fill': 'background.subtle',
  '--dsw-specific-sidebar-nav-item-active-accent': 'state.selected.background',
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function valueAtPath(document, path) {
  let current = document
  for (const segment of path.split('.')) {
    if (!isRecord(current) || !Object.hasOwn(current, segment)) {
      throw new Error(`Unknown Openloop token path: ${path}`)
    }
    current = current[segment]
  }
  if (!isRecord(current) || !Object.hasOwn(current, '$value')) {
    throw new Error(`Openloop token has no $value: ${path}`)
  }
  return current.$value
}

function resolveHex(document, path, stack = []) {
  if (stack.includes(path)) {
    throw new Error(`Circular Openloop token alias: ${[...stack, path].join(' -> ')}`)
  }
  const value = valueAtPath(document, path)
  if (typeof value === 'string') {
    const match = /^\{([a-z0-9.-]+)\}$/u.exec(value)
    if (match?.[1] === undefined) throw new Error(`Invalid Openloop token alias: ${value}`)
    return resolveHex(document, match[1], [...stack, path])
  }
  if (!isRecord(value) || typeof value.hex !== 'string' || !/^#[0-9A-F]{6}$/u.test(value.hex)) {
    throw new Error(`Openloop token must resolve to an uppercase hex color: ${path}`)
  }
  return value.hex
}

export function generateShellThemeTokens() {
  const document = JSON.parse(readFileSync(tokenPath, 'utf8'))
  if (!isRecord(document)) throw new TypeError('Openloop token document must be an object')
  return Object.fromEntries(Object.entries(TOKEN_ROLES).map(([name, role]) => [
    name,
    {
      light: resolveHex(document, `color.semantic.light.${role}`),
      dark: resolveHex(document, `color.semantic.dark.${role}`),
    },
  ]))
}

export function renderShellThemeTokens() {
  const entries = Object.entries(generateShellThemeTokens())
    .map(([name, modes]) => [
      `  '${name}': {`,
      `    light: '${modes.light}',`,
      `    dark: '${modes.dark}',`,
      '  },',
    ].join('\n'))
    .join('\n')
  return `/* Generated from assets/brand/openloop.tokens.json. Do not edit directly. */\n`
    + `import type { ThemeTokenOverrides } from '@deepseek-ai/dsh-client-ui-theme/client'\n\n`
    + `export const OPENLOOP_THEME_TOKENS = {\n${entries}\n} as const satisfies ThemeTokenOverrides\n`
}

function main() {
  const option = process.argv[2]
  if (option === '--json') {
    process.stdout.write(`${JSON.stringify(generateShellThemeTokens())}\n`)
    return
  }
  const rendered = renderShellThemeTokens()
  if (option === '--check') {
    if (!existsSync(outputPath) || readFileSync(outputPath, 'utf8') !== rendered) {
      process.stderr.write(
        'Openloop shell theme tokens are stale; run node scripts/openloop/generate-shell-theme-tokens.mjs\n',
      )
      process.exitCode = 1
    }
    return
  }
  if (option !== undefined) {
    throw new Error(`Unknown option: ${option}`)
  }
  writeFileSync(outputPath, rendered)
}

if (process.argv[1] !== undefined
  && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main()
}
