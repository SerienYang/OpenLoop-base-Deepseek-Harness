import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, test } from 'vitest'

interface ColorValue {
  readonly colorSpace: 'srgb'
  readonly components: readonly [number, number, number]
  readonly alpha: number
  readonly hex: string
}

type TokenMap = ReadonlyMap<string, unknown>

const tokenFile = path.resolve('assets/brand/openloop.tokens.json')
const aliasPattern = /^\{([a-z0-9.-]+)\}$/u

const EXPECTED_PALETTE = {
  'color.palette.neutral.0': '#FFFFFF',
  'color.palette.neutral.50': '#FBFBFA',
  'color.palette.neutral.100': '#F7F8FA',
  'color.palette.neutral.200': '#EEF1F3',
  'color.palette.neutral.300': '#E1E4E8',
  'color.palette.neutral.400': '#C8CDD3',
  'color.palette.neutral.500': '#AEB4BC',
  'color.palette.neutral.600': '#8D96A0',
  'color.palette.neutral.700': '#666D76',
  'color.palette.neutral.800': '#3B424A',
  'color.palette.neutral.900': '#20242A',
  'color.palette.neutral.950': '#111316',
  'color.palette.neutral.1000': '#0B0D0F',
  'color.palette.success.50': '#EDF8F1',
  'color.palette.success.400': '#5FB987',
  'color.palette.success.600': '#267A4B',
  'color.palette.success.700': '#1F603D',
  'color.palette.success.900': '#122E20',
  'color.palette.warning.50': '#FFF7E6',
  'color.palette.warning.400': '#E4A11B',
  'color.palette.warning.700': '#8A5A00',
  'color.palette.warning.800': '#6E4700',
  'color.palette.warning.900': '#332508',
  'color.palette.danger.50': '#FFF1F0',
  'color.palette.danger.400': '#F97066',
  'color.palette.danger.600': '#B42318',
  'color.palette.danger.700': '#912018',
  'color.palette.danger.900': '#3A1715',
} as const

const EXPECTED_BRAND_ALIASES = {
  'color.brand.ink': 'color.palette.neutral.950',
  'color.brand.paper': 'color.palette.neutral.50',
  'color.brand.line': 'color.palette.neutral.300',
  'color.brand.muted': 'color.palette.neutral.700',
} as const

const EXPECTED_LIGHT_ALIASES = {
  'background.canvas': 'color.palette.neutral.100',
  'background.surface': 'color.palette.neutral.0',
  'background.subtle': 'color.palette.neutral.50',
  'background.inverse': 'color.palette.neutral.1000',
  'text.primary': 'color.palette.neutral.950',
  'text.secondary': 'color.palette.neutral.700',
  'text.tertiary': 'color.palette.neutral.600',
  'text.inverse': 'color.palette.neutral.50',
  'text.disabled': 'color.palette.neutral.500',
  'border.subtle': 'color.palette.neutral.300',
  'border.default': 'color.palette.neutral.400',
  'border.strong': 'color.palette.neutral.700',
  'border.focus': 'color.palette.neutral.950',
  'action.primary.background': 'color.palette.neutral.950',
  'action.primary.foreground': 'color.palette.neutral.50',
  'action.primary.hover-background': 'color.palette.neutral.900',
  'action.primary.pressed-background': 'color.palette.neutral.1000',
  'action.primary.disabled-background': 'color.palette.neutral.300',
  'action.primary.disabled-foreground': 'color.palette.neutral.600',
  'state.active.background': 'color.palette.neutral.50',
  'state.active.foreground': 'color.palette.neutral.950',
  'state.selected.background': 'color.palette.neutral.200',
  'state.selected.foreground': 'color.palette.neutral.950',
  'status.info.foreground': 'color.palette.neutral.700',
  'status.info.surface': 'color.palette.neutral.100',
  'status.info.border': 'color.palette.neutral.400',
  'status.success.foreground': 'color.palette.success.600',
  'status.success.surface': 'color.palette.success.50',
  'status.success.border': 'color.palette.success.400',
  'status.warning.foreground': 'color.palette.warning.700',
  'status.warning.surface': 'color.palette.warning.50',
  'status.warning.border': 'color.palette.warning.400',
  'status.danger.foreground': 'color.palette.danger.600',
  'status.danger.surface': 'color.palette.danger.50',
  'status.danger.border': 'color.palette.danger.400',
} as const

const EXPECTED_DARK_ALIASES = {
  'background.canvas': 'color.palette.neutral.1000',
  'background.surface': 'color.palette.neutral.950',
  'background.subtle': 'color.palette.neutral.900',
  'background.inverse': 'color.palette.neutral.50',
  'text.primary': 'color.palette.neutral.100',
  'text.secondary': 'color.palette.neutral.500',
  'text.tertiary': 'color.palette.neutral.600',
  'text.inverse': 'color.palette.neutral.950',
  'text.disabled': 'color.palette.neutral.700',
  'border.subtle': 'color.palette.neutral.900',
  'border.default': 'color.palette.neutral.800',
  'border.strong': 'color.palette.neutral.600',
  'border.focus': 'color.palette.neutral.500',
  'action.primary.background': 'color.palette.neutral.100',
  'action.primary.foreground': 'color.palette.neutral.950',
  'action.primary.hover-background': 'color.palette.neutral.200',
  'action.primary.pressed-background': 'color.palette.neutral.0',
  'action.primary.disabled-background': 'color.palette.neutral.800',
  'action.primary.disabled-foreground': 'color.palette.neutral.600',
  'state.active.background': 'color.palette.neutral.900',
  'state.active.foreground': 'color.palette.neutral.100',
  'state.selected.background': 'color.palette.neutral.800',
  'state.selected.foreground': 'color.palette.neutral.100',
  'status.info.foreground': 'color.palette.neutral.500',
  'status.info.surface': 'color.palette.neutral.900',
  'status.info.border': 'color.palette.neutral.700',
  'status.success.foreground': 'color.palette.success.400',
  'status.success.surface': 'color.palette.success.900',
  'status.success.border': 'color.palette.success.600',
  'status.warning.foreground': 'color.palette.warning.400',
  'status.warning.surface': 'color.palette.warning.900',
  'status.warning.border': 'color.palette.warning.700',
  'status.danger.foreground': 'color.palette.danger.400',
  'status.danger.surface': 'color.palette.danger.900',
  'status.danger.border': 'color.palette.danger.600',
} as const

const EXPECTED_TOKEN_PATHS = [
  ...Object.keys(EXPECTED_PALETTE),
  ...Object.keys(EXPECTED_BRAND_ALIASES),
  ...Object.keys(EXPECTED_LIGHT_ALIASES)
    .map(role => `color.semantic.light.${role}`),
  ...Object.keys(EXPECTED_DARK_ALIASES)
    .map(role => `color.semantic.dark.${role}`),
]

const EXPECTED_GROUP_PATHS = new Set(
  EXPECTED_TOKEN_PATHS.flatMap((tokenPath) => {
    const segments = tokenPath.split('.')
    return segments
      .slice(1)
      .map((_, index) => segments.slice(0, index + 1).join('.'))
  }),
)

const CONTRAST_PAIRS = [
  ['text.primary', 'background.surface', 7],
  ['text.secondary', 'background.surface', 4.5],
  ['text.inverse', 'background.inverse', 7],
  ['action.primary.foreground', 'action.primary.background', 7],
  ['status.info.foreground', 'status.info.surface', 4.5],
  ['status.success.foreground', 'status.success.surface', 4.5],
  ['status.warning.foreground', 'status.warning.surface', 4.5],
  ['status.danger.foreground', 'status.danger.surface', 4.5],
] as const

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readDocument(): Record<string, unknown> {
  if (!fs.existsSync(tokenFile)) {
    throw new Error(`Missing OpenLoop design tokens: ${tokenFile}`)
  }
  const value: unknown = JSON.parse(fs.readFileSync(tokenFile, 'utf8'))
  if (!isRecord(value)) throw new TypeError('Token document must be an object')
  return value
}

function flattenTokens(
  value: unknown,
  prefix = '',
  result = new Map<string, unknown>(),
): Map<string, unknown> {
  if (!isRecord(value)) return result
  if ('$value' in value) {
    result.set(prefix, value.$value)
    return result
  }
  for (const [key, child] of Object.entries(value)) {
    if (key.startsWith('$')) continue
    flattenTokens(child, prefix === '' ? key : `${prefix}.${key}`, result)
  }
  return result
}

function entriesWithPrefix(
  tokens: TokenMap,
  prefix: string,
): Record<string, unknown> {
  return Object.fromEntries(
    [...tokens].filter(([path]) => path.startsWith(prefix)),
  )
}

function expectedAliases(
  prefix: string,
  aliases: Readonly<Record<string, string>>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(aliases)
      .map(([role, target]) => [`${prefix}.${role}`, `{${target}}`]),
  )
}

function concreteColor(value: unknown, tokenPath: string): ColorValue {
  if (!isRecord(value)) {
    throw new TypeError(`${tokenPath} must contain a DTCG color object`)
  }
  const components = value.components
  if (
    value.colorSpace !== 'srgb'
    || !Array.isArray(components)
    || components.length !== 3
    || components.some(component => typeof component !== 'number')
    || value.alpha !== 1
    || typeof value.hex !== 'string'
  ) {
    throw new TypeError(`${tokenPath} must contain a complete sRGB color`)
  }
  return value as unknown as ColorValue
}

function resolveToken(
  tokenPath: string,
  tokens: TokenMap,
  stack: readonly string[] = [],
): ColorValue {
  if (stack.includes(tokenPath)) {
    throw new Error(`Circular token alias: ${[...stack, tokenPath].join(' -> ')}`)
  }
  const value = tokens.get(tokenPath)
  if (value === undefined) throw new Error(`Unknown token alias: ${tokenPath}`)
  if (typeof value === 'string') {
    const target = aliasPattern.exec(value)?.[1]
    if (target === undefined) throw new Error(`Invalid token alias: ${value}`)
    return resolveToken(target, tokens, [...stack, tokenPath])
  }
  return concreteColor(value, tokenPath)
}

function hexComponents(hex: string): readonly number[] {
  return [1, 3, 5].map(index =>
    Number.parseInt(hex.slice(index, index + 2), 16) / 255)
}

function linearChannel(channel: number): number {
  return channel <= 0.04045
    ? channel / 12.92
    : ((channel + 0.055) / 1.055) ** 2.4
}

function luminance(color: ColorValue): number {
  const [red, green, blue] = color.components.map(linearChannel)
  if (red === undefined || green === undefined || blue === undefined) {
    throw new TypeError('Color requires three channels')
  }
  return red * 0.2126 + green * 0.7152 + blue * 0.0722
}

function contrastRatio(foreground: ColorValue, background: ColorValue): number {
  const [lighter, darker] = [
    luminance(foreground),
    luminance(background),
  ].sort((left, right) => right - left)
  if (lighter === undefined || darker === undefined) {
    throw new TypeError('Contrast requires two colors')
  }
  return (lighter + 0.05) / (darker + 0.05)
}

function disallowedReservedPaths(
  value: unknown,
  prefix = '',
  result: string[] = [],
): string[] {
  if (!isRecord(value)) return result
  const allowed = new Set([
    '$deprecated',
    '$description',
    '$extensions',
    ...('$value' in value ? ['$value'] : []),
    ...(prefix === 'color' ? ['$type'] : []),
  ])
  for (const key of Object.keys(value)) {
    if (key.startsWith('$') && !allowed.has(key)) {
      result.push(prefix === '' ? key : `${prefix}.${key}`)
    }
  }
  if ('$value' in value) {
    for (const key of Object.keys(value).filter(key => !key.startsWith('$'))) {
      result.push(prefix === '' ? key : `${prefix}.${key}`)
    }
    return result
  }
  for (const [key, child] of Object.entries(value)) {
    if (key.startsWith('$')) continue
    disallowedReservedPaths(
      child,
      prefix === '' ? key : `${prefix}.${key}`,
      result,
    )
  }
  return result
}

function inspectGroupShape(
  value: unknown,
  prefix = '',
  groups = new Set<string>(),
  problems: string[] = [],
): {
  readonly groups: ReadonlySet<string>
  readonly problems: readonly string[]
} {
  if (!isRecord(value)) return { groups, problems }
  if ('$value' in value) return { groups, problems }
  if (prefix !== '') groups.add(prefix)

  for (const [key, child] of Object.entries(value)) {
    if (key.startsWith('$')) continue
    const childPath = prefix === '' ? key : `${prefix}.${key}`
    if (!isRecord(child)) {
      problems.push(`${childPath} must be a token or token group`)
      continue
    }
    inspectGroupShape(child, childPath, groups, problems)
  }
  return { groups, problems }
}

function documentProblems(document: Record<string, unknown>): string[] {
  const problems: string[] = []
  const rootGroups = Object.keys(document)
    .filter(key => !key.startsWith('$'))
    .sort()
  if (rootGroups.join(',') !== 'color') {
    problems.push('the token document may only contain the color token group')
  }

  if (!isRecord(document.color)) {
    problems.push('color must be a DTCG token group')
    return problems
  }
  if (document.color.$type !== 'color') {
    problems.push('color must declare the DTCG color type')
  }
  const colorGroups = Object.keys(document.color)
    .filter(key => !key.startsWith('$'))
    .sort()
  if (colorGroups.join(',') !== 'brand,palette,semantic') {
    problems.push(
      'color may only contain brand, palette, and semantic token groups',
    )
  }
  for (const tokenPath of disallowedReservedPaths(document)) {
    problems.push(
      `${tokenPath} is outside the approved named token architecture`,
    )
  }
  const shape = inspectGroupShape(document)
  problems.push(...shape.problems)
  for (const groupPath of shape.groups) {
    if (!EXPECTED_GROUP_PATHS.has(groupPath)) {
      problems.push(`unexpected token group: ${groupPath}`)
    }
  }
  for (const groupPath of EXPECTED_GROUP_PATHS) {
    if (!shape.groups.has(groupPath)) {
      problems.push(`missing token group: ${groupPath}`)
    }
  }
  const tokens = flattenTokens(document)
  const expectedTokens = new Set(EXPECTED_TOKEN_PATHS)
  for (const tokenPath of tokens.keys()) {
    if (!expectedTokens.has(tokenPath)) {
      problems.push(`unexpected token: ${tokenPath}`)
    }
  }
  for (const tokenPath of expectedTokens) {
    if (!tokens.has(tokenPath)) {
      problems.push(`missing token: ${tokenPath}`)
    }
  }

  for (const [tokenPath, value] of tokens) {
    if (typeof value === 'string') continue
    let color: ColorValue
    try {
      color = concreteColor(value, tokenPath)
    }
    catch (error) {
      problems.push(
        error instanceof Error ? error.message : `${tokenPath} is invalid`,
      )
      continue
    }
    if (color.components.some(component => component < 0 || component > 1)) {
      problems.push(`${tokenPath} components must stay in the sRGB 0..1 range`)
    }
    if (!/^#[0-9A-F]{6}$/u.test(color.hex)) {
      problems.push(`${tokenPath} hex must use uppercase six-digit notation`)
      continue
    }
    const expected = hexComponents(color.hex)
    if (color.components.some((component, index) =>
      Math.abs(component - (expected[index] ?? -1)) > 0.000001)) {
      problems.push(`${tokenPath} hex must match its sRGB components`)
    }
  }

  return problems
}

describe('OpenLoop design tokens', () => {
  test('publishes the approved DTCG token file', () => {
    expect(fs.existsSync(tokenFile)).toBe(true)
    const document = readDocument()
    expect(document.color).toMatchObject({ $type: 'color' })
    expect(documentProblems(document)).toEqual([])
  })

  test('keeps the approved palette and brand aliases exact', () => {
    const tokens = flattenTokens(readDocument())
    const palette = entriesWithPrefix(tokens, 'color.palette.')
    const brand = entriesWithPrefix(tokens, 'color.brand.')

    expect(Object.keys(palette).sort()).toEqual(
      Object.keys(EXPECTED_PALETTE).sort(),
    )
    for (const [tokenPath, expectedHex] of Object.entries(EXPECTED_PALETTE)) {
      const color = concreteColor(palette[tokenPath], tokenPath)
      expect(color.hex).toBe(expectedHex)
      expect(color.components).toHaveLength(3)
      for (const [index, component] of color.components.entries()) {
        expect(component).toBeCloseTo(hexComponents(expectedHex)[index] ?? -1, 6)
      }
    }

    expect(brand).toEqual(expectedAliases('color.brand', {
      ink: EXPECTED_BRAND_ALIASES['color.brand.ink'],
      paper: EXPECTED_BRAND_ALIASES['color.brand.paper'],
      line: EXPECTED_BRAND_ALIASES['color.brand.line'],
      muted: EXPECTED_BRAND_ALIASES['color.brand.muted'],
    }))
  })

  test('keeps Light and Dark semantic paths and aliases exact', () => {
    const tokens = flattenTokens(readDocument())
    const light = entriesWithPrefix(tokens, 'color.semantic.light.')
    const dark = entriesWithPrefix(tokens, 'color.semantic.dark.')

    expect(light).toEqual(expectedAliases(
      'color.semantic.light',
      EXPECTED_LIGHT_ALIASES,
    ))
    expect(dark).toEqual(expectedAliases(
      'color.semantic.dark',
      EXPECTED_DARK_ALIASES,
    ))
    expect(
      Object.keys(light).map(path => path.replace('.light.', '.theme.')).sort(),
    ).toEqual(
      Object.keys(dark).map(path => path.replace('.dark.', '.theme.')).sort(),
    )
  })

  test('resolves every alias without cycles or missing targets', () => {
    const tokens = flattenTokens(readDocument())
    for (const [tokenPath, value] of tokens) {
      if (typeof value === 'string') {
        expect(() => resolveToken(tokenPath, tokens)).not.toThrow()
      }
    }
  })

  test('keeps routine interaction and information roles monochrome', () => {
    const tokens = flattenTokens(readDocument())
    const neutralRoles = [
      'border.focus',
      'state.active.background',
      'state.active.foreground',
      'state.selected.background',
      'state.selected.foreground',
      'status.info.foreground',
      'status.info.surface',
      'status.info.border',
    ]

    for (const theme of ['light', 'dark']) {
      for (const role of neutralRoles) {
        const value = tokens.get(`color.semantic.${theme}.${role}`)
        expect(value).toMatch(/^\{color\.palette\.neutral\./u)
      }
    }
    expect([...tokens.keys()].filter(tokenPath =>
      /(?:accent|blue|cyan|purple|gradient)/iu.test(tokenPath))).toEqual([])
  })

  test('meets the approved Light and Dark contrast targets', () => {
    const tokens = flattenTokens(readDocument())

    for (const theme of ['light', 'dark']) {
      for (const [foreground, background, minimum] of CONTRAST_PAIRS) {
        const foregroundPath = `color.semantic.${theme}.${foreground}`
        const backgroundPath = `color.semantic.${theme}.${background}`
        expect(
          contrastRatio(
            resolveToken(foregroundPath, tokens),
            resolveToken(backgroundPath, tokens),
          ),
          `${theme}: ${foreground} on ${background}`,
        ).toBeGreaterThanOrEqual(minimum)
      }
    }
  })

  test('rejects token groups outside the approved three-layer architecture', () => {
    const document = structuredClone(readDocument())
    if (!isRecord(document.color)) throw new TypeError('Missing color group')
    document.color.rogue = {
      surprise: {
        $value: {
          colorSpace: 'srgb',
          components: [1, 0, 1],
          alpha: 1,
          hex: '#FF00FF',
        },
      },
    }

    expect(documentProblems(document)).toContain(
      'color may only contain brand, palette, and semantic token groups',
    )
  })

  test('rejects DTCG root tokens that bypass named architecture groups', () => {
    const document = structuredClone(readDocument())
    if (!isRecord(document.color)) throw new TypeError('Missing color group')
    document.color.$root = {
      $value: {
        colorSpace: 'srgb',
        components: [1, 0, 1],
        alpha: 1,
        hex: '#FF00FF',
      },
    }

    expect(documentProblems(document)).toContain(
      'color.$root is outside the approved named token architecture',
    )
  })

  test('rejects DTCG group inheritance outside the explicit alias map', () => {
    const document = structuredClone(readDocument())
    if (!isRecord(document.color)) throw new TypeError('Missing color group')
    if (!isRecord(document.color.brand)) throw new TypeError('Missing brand group')
    document.color.brand.$extends = '{color.palette.neutral}'

    expect(documentProblems(document)).toContain(
      'color.brand.$extends is outside the approved named token architecture',
    )
  })

  test('rejects reserved properties that override explicit color semantics', () => {
    const document = structuredClone(readDocument())
    if (!isRecord(document.color)) throw new TypeError('Missing color group')
    if (!isRecord(document.color.brand)) throw new TypeError('Missing brand group')
    if (!isRecord(document.color.semantic)) {
      throw new TypeError('Missing semantic group')
    }
    document.color.brand.$ref = '#/color/palette/neutral'
    document.color.semantic.$type = 'dimension'

    expect(documentProblems(document)).toEqual(expect.arrayContaining([
      'color.brand.$ref is outside the approved named token architecture',
      'color.semantic.$type is outside the approved named token architecture',
    ]))
  })

  test('rejects token and group hybrids with hidden child tokens', () => {
    const document = structuredClone(readDocument())
    if (!isRecord(document.color)) throw new TypeError('Missing color group')
    if (!isRecord(document.color.brand)) throw new TypeError('Missing brand group')
    if (!isRecord(document.color.brand.ink)) {
      throw new TypeError('Missing brand ink token')
    }
    document.color.brand.ink.hidden = {
      $value: '{color.palette.neutral.0}',
    }

    expect(documentProblems(document)).toContain(
      'color.brand.ink.hidden is outside the approved named token architecture',
    )
  })

  test('rejects hidden empty groups and primitive group children', () => {
    const document = structuredClone(readDocument())
    if (!isRecord(document.color)) throw new TypeError('Missing color group')
    if (!isRecord(document.color.brand)) throw new TypeError('Missing brand group')
    document.color.brand.empty = {}
    document.color.brand.raw = '#FF00FF'

    expect(documentProblems(document)).toEqual(expect.arrayContaining([
      'unexpected token group: color.brand.empty',
      'color.brand.raw must be a token or token group',
    ]))
  })

  test('rejects extra tokens attached directly to approved groups', () => {
    const document = structuredClone(readDocument())
    if (!isRecord(document.color)) throw new TypeError('Missing color group')
    if (!isRecord(document.color.semantic)) {
      throw new TypeError('Missing semantic group')
    }
    document.color.semantic.rogue = {
      $value: '{color.palette.neutral.0}',
    }

    expect(documentProblems(document)).toContain(
      'unexpected token: color.semantic.rogue',
    )
  })

  test('rejects malformed concrete colors anywhere in the document', () => {
    const document = structuredClone(readDocument())
    if (!isRecord(document.color)) throw new TypeError('Missing color group')
    if (!isRecord(document.color.palette)) {
      throw new TypeError('Missing palette group')
    }
    if (!isRecord(document.color.palette.neutral)) {
      throw new TypeError('Missing neutral palette')
    }
    if (!isRecord(document.color.palette.neutral['0'])) {
      throw new TypeError('Missing neutral.0 token')
    }
    const token = document.color.palette.neutral['0']
    if (!isRecord(token.$value)) throw new TypeError('Missing neutral.0 value')
    token.$value.components = [2, 1, 1]
    token.$value.hex = '#000000'

    expect(documentProblems(document)).toEqual(expect.arrayContaining([
      'color.palette.neutral.0 components must stay in the sRGB 0..1 range',
      'color.palette.neutral.0 hex must match its sRGB components',
    ]))
  })
})
