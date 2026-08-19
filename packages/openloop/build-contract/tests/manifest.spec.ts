import { describe, expect, it } from 'vitest'
import {
  parseOpenloopArtifactManifest,
  parseOpenloopBuildManifest,
} from '../src/index.ts'

const sha256 = 'a'.repeat(64)

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
  }
}

function artifactManifest() {
  return {
    coreManifestSha256: sha256,
    artifacts: {
      sidecar: { sha256 },
      web: { sha256 },
      bundleGraph: { sha256 },
    },
  }
}

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
        app: { sha256 },
        dmg: { sha256 },
        updater: { sha256 },
        ffmpeg: { sha256 },
        ffprobe: { sha256 },
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
        sidecar: { sha256: 'abc' },
      },
    })).toThrow(/sha256/iu)
    expect(() => parseOpenloopArtifactManifest({
      ...artifactManifest(),
      artifacts: {
        ...artifactManifest().artifacts,
        symbols: { sha256 },
      },
    })).toThrow(/unknown field.*symbols/iu)
  })
})
