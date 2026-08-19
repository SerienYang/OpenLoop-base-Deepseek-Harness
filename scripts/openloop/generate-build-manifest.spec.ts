import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
    dependencies?: { readonly baselinePath?: string },
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

  it('uses approved baseline identity and sensible initial defaults', () => {
    const out = join(temporaryRoot(), 'core.json')
    const result = generateBuildManifest({ channel: 'test', out })

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

    const firstResult = generateBuildManifest({ channel: 'test', out: first })
    const secondResult = generateBuildManifest({ channel: 'test', out: second })

    expect(readFileSync(first)).toEqual(readFileSync(second))
    expect(firstResult.sha256).toBe(secondResult.sha256)
    expect(firstResult.bytes.endsWith('\n')).toBe(true)
  })

  it('validates explicit version overrides before writing', () => {
    const out = join(temporaryRoot(), 'core.json')

    expect(() => generateBuildManifest({
      channel: 'test',
      out,
      runtimeVersion: 0,
    })).toThrow(/runtimeVersion/iu)
  })

  it('refuses to overwrite its approved baseline input', () => {
    const baseline = join(temporaryRoot(), 'upstream-baseline.json')
    const source = `${JSON.stringify({
      sourceType: 'release',
      sourceRef: 'dsh-v0.1.0-rc.7',
      commit: '99f6f02fecdb7dff40c3fbc9470f5907c29f74ca',
    }, null, 2)}\n`
    writeFileSync(baseline, source)

    expect(() => generateBuildManifest(
      { channel: 'test', out: baseline },
      { baselinePath: baseline },
    )).toThrow(/output.*baseline|baseline.*output/iu)
    expect(readFileSync(baseline, 'utf8')).toBe(source)
  })
})
