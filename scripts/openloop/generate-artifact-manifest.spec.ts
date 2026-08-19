import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { OpenloopArtifactManifest } from '../../packages/openloop/build-contract/src/index.ts'

const roots: string[] = []
const generatorModulePath: string = './generate-artifact-manifest.mjs'

interface ArtifactOptions {
  readonly core: string
  readonly sidecar: string
  readonly web: string
  readonly bundleGraph: string
  readonly out: string
  readonly app?: string
  readonly dmg?: string
  readonly updater?: string
  readonly ffmpeg?: string
  readonly ffprobe?: string
}

interface ArtifactGeneratorModule {
  readonly parseArtifactManifestArguments: (args: string[]) => Record<string, unknown>
  readonly hashArtifact: (path: string) => string
  readonly generateArtifactManifest: (options: ArtifactOptions) => {
    readonly manifest: OpenloopArtifactManifest
    readonly bytes: string
    readonly sha256: string
  }
}

const {
  generateArtifactManifest,
  hashArtifact,
  parseArtifactManifestArguments,
} = await import(generatorModulePath) as ArtifactGeneratorModule

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'openloop-artifact-manifest-'))
  roots.push(root)
  return root
}

function coreManifest(): Record<string, unknown> {
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

function fixture() {
  const root = temporaryRoot()
  const paths = {
    core: join(root, 'core.json'),
    sidecar: join(root, 'sidecar'),
    web: join(root, 'web'),
    bundleGraph: join(root, 'bundle-graph.json'),
    out: join(root, 'dist/artifacts.json'),
  }
  writeFileSync(paths.core, `${JSON.stringify(coreManifest(), null, 2)}\n`)
  writeFileSync(paths.sidecar, 'sidecar bytes')
  mkdirSync(paths.web)
  writeFileSync(join(paths.web, 'index.html'), '<main>OpenLoop</main>')
  writeFileSync(paths.bundleGraph, '{"entry":"index.html"}\n')
  return paths
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('OpenLoop artifact manifest generator', () => {
  it('requires every base input and accepts paths rather than caller-provided hashes', () => {
    expect(() => parseArtifactManifestArguments([
      '--core', 'core.json',
      '--sidecar', 'sidecar',
      '--web', 'web',
      '--out', 'artifacts.json',
    ])).toThrow(/--bundle-graph/u)
    expect(() => parseArtifactManifestArguments([
      '--core', 'core.json',
      '--sidecar', 'sidecar',
      '--web', 'web',
      '--bundle-graph', 'bundle.json',
      '--out', 'artifacts.json',
      '--web-sha256', 'a'.repeat(64),
    ])).toThrow(/unknown option.*sha256/iu)
  })

  it('hashes the exact validated core bytes as manifest identity', () => {
    const paths = fixture()
    const coreBytes = readFileSync(paths.core)
    const result = generateArtifactManifest(paths)

    expect(result.manifest.coreManifestSha256).toBe(
      createHash('sha256').update(coreBytes).digest('hex'),
    )
    expect(result.manifest.artifacts).toEqual({
      sidecar: hashArtifact(paths.sidecar),
      web: hashArtifact(paths.web),
      bundleGraph: hashArtifact(paths.bundleGraph),
    })
  })

  it('writes deterministic bytes and ignores directory creation order and mtimes', () => {
    const paths = fixture()
    const otherWeb = join(temporaryRoot(), 'web')
    mkdirSync(join(paths.web, 'assets'))
    writeFileSync(join(paths.web, 'assets/z.js'), 'z')
    writeFileSync(join(paths.web, 'assets/a.js'), 'a')
    mkdirSync(join(otherWeb, 'assets'), { recursive: true })
    writeFileSync(join(otherWeb, 'assets/a.js'), 'a')
    writeFileSync(join(otherWeb, 'assets/z.js'), 'z')
    writeFileSync(join(otherWeb, 'index.html'), '<main>OpenLoop</main>')

    expect(hashArtifact(paths.web)).toBe(hashArtifact(otherWeb))

    const first = generateArtifactManifest(paths)
    const firstBytes = readFileSync(paths.out)
    const second = generateArtifactManifest(paths)
    expect(readFileSync(paths.out)).toEqual(firstBytes)
    expect(second.sha256).toBe(first.sha256)
  })

  it('includes optional release artifacts only when supplied', () => {
    const paths = fixture()
    const optional = {
      app: join(paths.web, 'OpenLoop.app'),
      dmg: join(paths.web, 'OpenLoop.dmg'),
      updater: join(paths.web, 'OpenLoop.tar.gz'),
      ffmpeg: join(paths.web, 'ffmpeg'),
      ffprobe: join(paths.web, 'ffprobe'),
    }
    for (const [name, path] of Object.entries(optional)) writeFileSync(path, name)

    const result = generateArtifactManifest({ ...paths, ...optional })

    expect(Object.keys(result.manifest.artifacts)).toEqual([
      'sidecar',
      'web',
      'bundleGraph',
      'app',
      'dmg',
      'updater',
      'ffmpeg',
      'ffprobe',
    ])
    expect(result.manifest.artifacts.ffprobe).toBe(hashArtifact(optional.ffprobe))
  })

  it('rejects invalid core manifests, missing inputs, and direct or nested symlinks', () => {
    const invalid = fixture()
    writeFileSync(invalid.core, JSON.stringify({
      ...coreManifest(),
      dshCommit: 'short',
    }))
    expect(() => generateArtifactManifest(invalid)).toThrow(/dshCommit/iu)

    const missing = fixture()
    rmSync(missing.sidecar)
    expect(() => generateArtifactManifest(missing)).toThrow(/sidecar.*missing|missing.*sidecar/iu)

    const escaped = fixture()
    const outside = join(temporaryRoot(), 'outside.js')
    writeFileSync(outside, 'outside')
    symlinkSync(outside, join(escaped.web, 'linked.js'))
    expect(() => generateArtifactManifest(escaped)).toThrow(/symlink/iu)

    const direct = fixture()
    const realSidecar = join(dirname(direct.sidecar), 'real-sidecar')
    writeFileSync(realSidecar, 'sidecar bytes')
    rmSync(direct.sidecar)
    symlinkSync(realSidecar, direct.sidecar)
    expect(() => generateArtifactManifest(direct)).toThrow(/symlink/iu)
  })

  it('rejects an intermediate symlink component in an input path', () => {
    const paths = fixture()
    const root = dirname(paths.core)
    const real = join(root, 'real-inputs')
    const alias = join(root, 'input-alias')
    mkdirSync(real)
    writeFileSync(join(real, 'sidecar'), 'sidecar bytes')
    symlinkSync(real, alias, 'dir')

    expect(() => generateArtifactManifest({
      ...paths,
      sidecar: join(alias, 'sidecar'),
    })).toThrow(/symlink/iu)

    const nested = join(real, 'nested')
    mkdirSync(nested)
    writeFileSync(join(nested, 'artifact'), 'artifact bytes')
    expect(() => hashArtifact(join(alias, 'nested/artifact'))).toThrow(/symlink/iu)
  })

  it('rejects output overlap and a symlinked output parent using resolved paths', () => {
    const overlap = fixture()
    const nestedOutput = join(overlap.web, 'generated/artifact-manifest.json')
    expect(() => generateArtifactManifest({
      ...overlap,
      out: nestedOutput,
    })).toThrow(/overlap/iu)
    expect(existsSync(dirname(nestedOutput))).toBe(false)

    const webAlias = join(dirname(overlap.web), 'web-alias')
    symlinkSync(overlap.web, webAlias, 'dir')
    expect(() => generateArtifactManifest({
      ...overlap,
      out: join(webAlias, 'artifact-manifest.json'),
    })).toThrow(/symlink|overlap/iu)

    const redirected = fixture()
    const root = dirname(redirected.core)
    const realOutput = join(root, 'real-output')
    const outputAlias = join(root, 'output-alias')
    mkdirSync(realOutput)
    symlinkSync(realOutput, outputAlias, 'dir')
    expect(() => generateArtifactManifest({
      ...redirected,
      out: join(outputAlias, 'artifact-manifest.json'),
    })).toThrow(/symlink/iu)
    expect(() => readFileSync(join(realOutput, 'artifact-manifest.json')))
      .toThrow()
  })
})
