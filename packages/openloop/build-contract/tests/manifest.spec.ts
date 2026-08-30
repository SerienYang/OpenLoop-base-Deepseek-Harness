import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  parseOpenloopArtifactManifest,
  parseOpenloopBuildManifest,
} from '../src/index.ts'

interface PackageManifest {
  readonly name?: string
  readonly private?: boolean
  readonly openloop?: { readonly face?: string }
  readonly dependencies?: Readonly<Record<string, string>>
  readonly peerDependencies?: Readonly<Record<string, string>>
  readonly devDependencies?: Readonly<Record<string, string>>
  readonly exports?: Readonly<Record<string, unknown>>
  readonly files?: readonly string[]
}

const sha256 = 'a'.repeat(64)
const brand = {
  productName: 'Openloop',
  documentSuffix: 'Openloop',
  markAsset: 'data:image/svg+xml;base64,PHN2Zy8+',
  heroTitle: 'Openloop',
  previewLabel: 'Preview',
  attribution: 'Built on DeepSeek Harness',
} as const

function buildManifest() {
  return {
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
    brand,
  }
}

function artifactManifest() {
  return {
    coreManifestSha256: sha256,
    artifacts: {
      sidecar: sha256,
      runtimeSbom: sha256,
      web: sha256,
      bundleGraph: sha256,
    },
  }
}

describe('OpenLoop build contract package', () => {
  it('ships the required private host package surface', () => {
    const manifest = JSON.parse(
      readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
    ) as PackageManifest

    expect(manifest).toMatchObject({
      name: '@openloop/build-contract',
      private: true,
      openloop: { face: 'host' },
      dependencies: {
        '@deepseek-ai/schemastery': 'workspace:^',
      },
      exports: {
        '.': {
          types: './lib/types/index.d.ts',
          default: './lib/index.js',
        },
        './invariant': {
          types: './lib/types/invariant.d.ts',
          default: './lib/invariant.js',
        },
      },
    })
    expect(manifest.files).toEqual([
      'lib/index.js',
      'lib/invariant.js',
      'lib/types/**/*.d.ts',
    ])
    for (const dependency of ['@deepseek-ai/cordis', '@deepseek-ai/dsh-invariants']) {
      expect(manifest.peerDependencies?.[dependency]).toBe('workspace:^')
      expect(manifest.devDependencies?.[dependency]).toBe(
        manifest.peerDependencies?.[dependency],
      )
    }
  })
})

describe('OpenLoop build manifest contract', () => {
  it('parses the complete manifest', () => {
    expect(parseOpenloopBuildManifest(buildManifest())).toEqual(buildManifest())
  })

  it('rejects missing fields and unknown fields', () => {
    const { appVersion: _appVersion, ...missing } = buildManifest()

    expect(() => parseOpenloopBuildManifest(missing)).toThrow(/appVersion|missing required/u)
    expect(() => parseOpenloopBuildManifest({ ...buildManifest(), secret: 'no' }))
      .toThrow(/unknown field.*secret/iu)
  })

  it('accepts only the closed Openloop brand identity', () => {
    expect(parseOpenloopBuildManifest(buildManifest()).brand).toEqual(brand)
    expect(() => parseOpenloopBuildManifest({
      ...buildManifest(),
      brand: { ...brand, productName: 'Attacker' },
    })).toThrow(/brand|productName/iu)
    expect(() => parseOpenloopBuildManifest({
      ...buildManifest(),
      brand: { ...brand, remote: 'https://attacker.invalid/brand.json' },
    })).toThrow(/unknown field.*remote/iu)
  })

  it('rejects short or non-lowercase DSH commits', () => {
    expect(() => parseOpenloopBuildManifest({
      ...buildManifest(),
      dshCommit: '99f6f02',
    })).toThrow(/dshCommit/iu)
    expect(() => parseOpenloopBuildManifest({
      ...buildManifest(),
      dshCommit: 'A'.repeat(40),
    })).toThrow(/dshCommit/iu)
  })

  it.each([
    ['channel', 'preview'],
    ['runtimeVersion', 0],
    ['runtimeVersion', 1.5],
    ['bridgeProtocolVersion', -1],
    ['uiSdkVersion', 'v0.1.0'],
    ['pluginPackageSpecVersion', '1.0'],
    ['openloopDataVersion', -1],
    ['dshDataVersion', 0.5],
  ])('rejects invalid %s values', (field, value) => {
    expect(() => parseOpenloopBuildManifest({
      ...buildManifest(),
      [field]: value,
    })).toThrow()
  })

  it.each([
    'runtimeVersion',
    'bridgeProtocolVersion',
    'openloopDataVersion',
    'dshDataVersion',
  ])('rejects unsafe integer %s values', (field) => {
    expect(() => parseOpenloopBuildManifest({
      ...buildManifest(),
      [field]: Number.MAX_SAFE_INTEGER + 1,
    })).toThrow()
  })

  it('accepts the stable channel and semver prereleases', () => {
    expect(parseOpenloopBuildManifest({
      ...buildManifest(),
      channel: 'stable',
      appVersion: '1.2.3-rc.1+desktop',
    }).channel).toBe('stable')
  })
})

describe('OpenLoop artifact manifest contract', () => {
  it('parses required and optional artifact hashes', () => {
    const manifest = {
      ...artifactManifest(),
      artifacts: {
        ...artifactManifest().artifacts,
        app: sha256,
        dmg: sha256,
        updater: sha256,
        ffmpeg: sha256,
        ffprobe: sha256,
      },
    }

    expect(parseOpenloopArtifactManifest(manifest)).toEqual(manifest)
  })

  it('rejects missing required artifacts', () => {
    const { web: _web, ...artifacts } = artifactManifest().artifacts

    expect(() => parseOpenloopArtifactManifest({
      ...artifactManifest(),
      artifacts,
    })).toThrow(/web|missing required/u)

    const { runtimeSbom: _runtimeSbom, ...withoutRuntimeSbom } = artifactManifest().artifacts
    expect(() => parseOpenloopArtifactManifest({
      ...artifactManifest(),
      artifacts: withoutRuntimeSbom,
    })).toThrow(/runtimeSbom|missing required/u)
  })

  it('rejects short hashes and unknown artifact fields', () => {
    expect(() => parseOpenloopArtifactManifest({
      ...artifactManifest(),
      coreManifestSha256: 'abc',
    })).toThrow(/coreManifestSha256/iu)
    expect(() => parseOpenloopArtifactManifest({
      ...artifactManifest(),
      artifacts: {
        ...artifactManifest().artifacts,
        sidecar: 'abc',
      },
    })).toThrow(/sidecar/iu)
    expect(() => parseOpenloopArtifactManifest({
      ...artifactManifest(),
      artifacts: {
        ...artifactManifest().artifacts,
        sidecar: { sha256 },
      },
    })).toThrow(/sidecar/iu)
    expect(() => parseOpenloopArtifactManifest({
      ...artifactManifest(),
      artifacts: {
        ...artifactManifest().artifacts,
        symbols: sha256,
      },
    })).toThrow(/unknown field.*symbols/iu)
  })
})
