import { createHash } from 'node:crypto'
import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, relative } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { OpenloopBuildManifest } from '../../packages/openloop/build-contract/src/index.ts'

const roots: string[] = []
const generatorModulePath: string = './generate-build-manifest.mjs'

interface BuildOptions {
  readonly channel: string
  readonly out: string
  readonly appVersion?: string
  readonly runtimeVersion?: number
  readonly bridgeProtocolVersion?: number
  readonly uiSdkVersion?: string
  readonly pluginPackageSpecVersion?: string
  readonly openloopDataVersion?: number
  readonly dshDataVersion?: number
}

interface BuildGeneratorModule {
  readonly parseBuildManifestArguments: (args: string[]) => Record<string, unknown>
  readonly generateBuildManifest: (
    options: BuildOptions,
    dependencies?: {
      readonly baselinePath?: string
      readonly now?: number
      readonly trustedRoot?: string
    },
  ) => {
    readonly manifest: OpenloopBuildManifest
    readonly bytes: string
    readonly sha256: string
  }
}

const {
  generateBuildManifest,
  parseBuildManifestArguments,
} = await import(generatorModulePath) as BuildGeneratorModule

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'openloop-build-manifest-'))
  roots.push(root)
  return root
}

function uppercaseAlias(path: string): string {
  const alias = join(dirname(path), basename(path).toUpperCase())
  if (!existsSync(alias)) linkSync(path, alias)
  return alias
}

function writeBaseline(
  root: string,
  overrides: Record<string, unknown> = {},
): string {
  const baseline = join(root, 'upstream-baseline.json')
  writeFileSync(baseline, `${JSON.stringify({
    sourceType: 'release',
    sourceRef: 'dsh-v0.1.0-rc.7',
    commit: '99f6f02fecdb7dff40c3fbc9470f5907c29f74ca',
    approvedAt: '2026-08-18T12:12:25Z',
    capturedAt: '2026-08-18T12:12:25Z',
    ...overrides,
  }, null, 2)}\n`)
  return baseline
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('OpenLoop build manifest generator', () => {
  it('parses required output and channel with explicit version overrides', () => {
    expect(parseBuildManifestArguments([
      '--channel', 'stable',
      '--out', 'dist-openloop/core.json',
      '--app-version', '1.2.3',
      '--runtime-version', '2',
      '--bridge-protocol-version', '3',
      '--ui-sdk-version', '4.5.6',
      '--plugin-package-spec-version', '7.8.9',
      '--openloop-data-version', '10',
      '--dsh-data-version', '11',
    ])).toEqual({
      channel: 'stable',
      out: 'dist-openloop/core.json',
      appVersion: '1.2.3',
      runtimeVersion: 2,
      bridgeProtocolVersion: 3,
      uiSdkVersion: '4.5.6',
      pluginPackageSpecVersion: '7.8.9',
      openloopDataVersion: 10,
      dshDataVersion: 11,
    })
  })

  it('rejects missing required arguments and artifact hash inputs', () => {
    expect(() => parseBuildManifestArguments(['--channel', 'test'])).toThrow(/--out/u)
    expect(() => parseBuildManifestArguments([
      '--channel', 'test',
      '--out', 'core.json',
      '--sidecar-sha256', 'a'.repeat(64),
    ])).toThrow(/unknown option.*sidecar/iu)
  })

  it('rejects duplicate options exactly once', () => {
    expect(() => parseBuildManifestArguments([
      '--channel', 'test',
      '--channel', 'stable',
      '--out', 'core.json',
    ])).toThrow('--channel may be specified only once')
    expect(() => parseBuildManifestArguments([
      '--channel', 'test',
      '--out', 'first.json',
      '--out', 'second.json',
    ])).toThrow('--out may be specified only once')
  })

  it('uses approved baseline identity and sensible initial defaults', () => {
    const root = temporaryRoot()
    const out = join(root, 'core.json')
    const result = generateBuildManifest(
      { channel: 'test', out },
      {
        baselinePath: writeBaseline(root),
        trustedRoot: root,
      },
    )

    expect(result.manifest).toEqual({
      appVersion: '0.1.0',
      channel: 'test',
      dshTag: 'dsh-v0.1.0-rc.7',
      dshCommit: '99f6f02fecdb7dff40c3fbc9470f5907c29f74ca',
      runtimeVersion: 1,
      bridgeProtocolVersion: 1,
      uiSdkVersion: '0.1.0',
      pluginPackageSpecVersion: '0.1.0',
      openloopDataVersion: 0,
      dshDataVersion: 0,
    })
    expect(result.bytes).toBe(readFileSync(out, 'utf8'))
    expect(result.sha256).toBe(
      createHash('sha256').update(result.bytes).digest('hex'),
    )
  })

  it('writes byte-identical canonical JSON on repeated generation', () => {
    const root = temporaryRoot()
    const first = join(root, 'first.json')
    const second = join(root, 'nested/second.json')
    const dependencies = {
      baselinePath: writeBaseline(root),
      trustedRoot: root,
    }

    const firstResult = generateBuildManifest({ channel: 'test', out: first }, dependencies)
    const secondResult = generateBuildManifest({ channel: 'test', out: second }, dependencies)

    expect(readFileSync(first)).toEqual(readFileSync(second))
    expect(firstResult.sha256).toBe(secondResult.sha256)
    expect(firstResult.bytes.endsWith('\n')).toBe(true)
  })

  it('preserves the output inode when canonical bytes are unchanged', () => {
    const root = temporaryRoot()
    const out = join(root, 'core.json')
    const dependencies = {
      baselinePath: writeBaseline(root),
      trustedRoot: root,
    }

    generateBuildManifest({ channel: 'test', out }, dependencies)
    const firstInode = statSync(out).ino
    generateBuildManifest({ channel: 'test', out }, dependencies)

    expect(statSync(out).ino).toBe(firstInode)
  })

  it('compares existing output as exact bytes before preserving its inode', () => {
    const root = temporaryRoot()
    const out = join(root, 'core.json')
    const dependencies = {
      baselinePath: writeBaseline(root, { sourceRef: 'dsh-\uFFFD' }),
      trustedRoot: root,
    }
    const result = generateBuildManifest({ channel: 'test', out }, dependencies)
    const expected = Buffer.from(result.bytes)
    const replacement = Buffer.from('\uFFFD')
    const replacementIndex = expected.indexOf(replacement)
    const lossyEquivalent = Buffer.concat([
      expected.subarray(0, replacementIndex),
      Buffer.from([0xff]),
      expected.subarray(replacementIndex + replacement.length),
    ])
    writeFileSync(out, lossyEquivalent)

    generateBuildManifest({ channel: 'test', out }, dependencies)

    expect(readFileSync(out)).toEqual(expected)
  })

  it('validates explicit version overrides before writing', () => {
    const root = temporaryRoot()
    const out = join(root, 'core.json')

    expect(() => generateBuildManifest({
      channel: 'test',
      out,
      runtimeVersion: 0,
    }, {
      baselinePath: writeBaseline(root),
      trustedRoot: root,
    })).toThrow(/runtimeVersion/iu)
  })

  it('uses the repository as the default trusted root', () => {
    const root = temporaryRoot()
    const baseline = writeBaseline(root)

    expect(() => generateBuildManifest(
      { channel: 'test', out: join(root, 'core.json') },
      { baselinePath: baseline },
    )).toThrow(/trusted root/iu)
    expect(() => generateBuildManifest({
      channel: 'test',
      out: relative(process.cwd(), join(root, 'relative-core.json')),
    })).toThrow(/trusted root/iu)
  })

  it('refuses to overwrite its approved baseline input', () => {
    const baseline = writeBaseline(temporaryRoot())
    const source = readFileSync(baseline, 'utf8')

    expect(() => generateBuildManifest(
      { channel: 'test', out: baseline },
      {
        baselinePath: baseline,
        trustedRoot: dirname(baseline),
      },
    )).toThrow(/output.*baseline|baseline.*output/iu)
    expect(readFileSync(baseline, 'utf8')).toBe(source)
  })

  it('refuses a case alias of its approved baseline input', () => {
    const root = temporaryRoot()
    const baseline = writeBaseline(root)
    const source = readFileSync(baseline, 'utf8')

    expect(() => generateBuildManifest(
      { channel: 'test', out: uppercaseAlias(baseline) },
      {
        baselinePath: baseline,
        trustedRoot: root,
      },
    )).toThrow(/output.*baseline|baseline.*output/iu)
    expect(readFileSync(baseline, 'utf8')).toBe(source)
  })

  it.each(['release', 'tag', 'approved_commit'])(
    'accepts the %s baseline source type and preserves sourceRef as dshTag',
    (sourceType) => {
      const root = temporaryRoot()
      const baseline = writeBaseline(root, {
        sourceType,
        sourceRef: `${sourceType}-reference`,
      })
      const result = generateBuildManifest(
        { channel: 'test', out: join(root, 'core.json') },
        {
          baselinePath: baseline,
          now: Date.parse('2026-08-20T00:00:00Z'),
          trustedRoot: root,
        },
      )

      expect(result.manifest.dshTag).toBe(`${sourceType}-reference`)
    },
  )

  it.each([
    ['unknown source type', { sourceType: 'branch' }],
    ['empty source ref', { sourceRef: '   ' }],
    ['source ref with leading whitespace', { sourceRef: ' dsh-v0.1.0-rc.7' }],
    ['source ref with trailing whitespace', { sourceRef: 'dsh-v0.1.0-rc.7 ' }],
    ['short commit', { commit: '99f6f02' }],
    ['uppercase commit', { commit: 'A'.repeat(40) }],
    ['missing approvedAt', { approvedAt: undefined }],
    ['missing capturedAt', { capturedAt: undefined }],
    ['invalid approvedAt', { approvedAt: 'not-a-date' }],
    ['invalid capturedAt', { capturedAt: 'not-a-date' }],
    ['impossible approvedAt', { approvedAt: '2026-02-30T12:00:00Z' }],
    ['future approvedAt', { approvedAt: '2026-08-21T00:00:00Z' }],
    ['future capturedAt', { capturedAt: '2026-08-21T00:00:00Z' }],
    ['capture before approval', {
      approvedAt: '2026-08-19T00:00:00Z',
      capturedAt: '2026-08-18T00:00:00Z',
    }],
  ])('rejects malformed baseline metadata: %s', (_label, overrides) => {
    const root = temporaryRoot()
    const baseline = writeBaseline(root, overrides)

    expect(() => generateBuildManifest(
      { channel: 'test', out: join(root, 'core.json') },
      {
        baselinePath: baseline,
        now: Date.parse('2026-08-20T00:00:00Z'),
        trustedRoot: root,
      },
    )).toThrow(/baseline|approvedAt|capturedAt|sourceType|sourceRef|commit/iu)
  })

  it('compares arbitrary fractional seconds without millisecond truncation', () => {
    const root = temporaryRoot()
    const baseline = writeBaseline(root, {
      approvedAt: '2026-08-18T12:12:25.0009Z',
      capturedAt: '2026-08-18T12:12:25.0001Z',
    })

    expect(() => generateBuildManifest(
      { channel: 'test', out: join(root, 'core.json') },
      {
        baselinePath: baseline,
        now: Date.parse('2026-08-20T00:00:00Z'),
        trustedRoot: root,
      },
    )).toThrow(/capturedAt.*approvedAt|precede/iu)
  })

  it('rejects an intermediate symlink in the baseline path', () => {
    const root = temporaryRoot()
    const real = join(root, 'real')
    const alias = join(root, 'alias')
    const nested = join(real, 'nested')
    mkdirSync(nested, { recursive: true })
    const baseline = writeBaseline(nested)
    symlinkSync(real, alias, 'dir')

    expect(() => generateBuildManifest(
      { channel: 'test', out: join(root, 'core.json') },
      {
        baselinePath: join(alias, 'nested/upstream-baseline.json'),
        trustedRoot: root,
      },
    )).toThrow(/symlink/iu)
    expect(readFileSync(baseline, 'utf8')).toContain('"sourceType": "release"')
  })

  it('refuses to write through a symlinked output parent', () => {
    const root = temporaryRoot()
    const baseline = writeBaseline(root)
    const realOutput = join(root, 'real-output')
    const outputAlias = join(root, 'output-alias')
    mkdirSync(join(realOutput, 'nested'), { recursive: true })
    symlinkSync(realOutput, outputAlias, 'dir')

    expect(() => generateBuildManifest(
      { channel: 'test', out: join(outputAlias, 'nested/core.json') },
      {
        baselinePath: baseline,
        trustedRoot: root,
      },
    )).toThrow(/symlink/iu)
    expect(() => readFileSync(join(realOutput, 'nested/core.json'))).toThrow()
  })
})
