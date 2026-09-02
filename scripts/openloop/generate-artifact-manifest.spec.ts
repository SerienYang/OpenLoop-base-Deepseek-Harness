import { createHash } from 'node:crypto'
import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, relative } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { OpenloopArtifactManifest } from '../../packages/openloop/build-contract/src/index.ts'

const roots: string[] = []
const generatorModulePath: string = './generate-artifact-manifest.mjs'

interface ArtifactOptions {
  readonly core: string
  readonly sidecar: string
  readonly runtimeSbom: string
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
  readonly hashArtifact: (
    path: string,
    dependencies?: { readonly trustedRoot?: string },
  ) => string
  readonly generateArtifactManifest: (
    options: ArtifactOptions,
    dependencies?: { readonly trustedRoot?: string },
  ) => {
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

function uppercaseAlias(path: string): string {
  const alias = join(dirname(path), basename(path).toUpperCase())
  if (!existsSync(alias)) linkSync(path, alias)
  return alias
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
    brand: {
      productName: 'Openloop',
      documentSuffix: 'Openloop',
      markAsset: 'data:image/svg+xml;base64,PHN2Zy8+',
      heroTitle: 'Openloop',
      previewLabel: '预览版',
      attribution: 'Built on DeepSeek Harness',
    },
  }
}

function fixture() {
  const root = temporaryRoot()
  const paths = {
    core: join(root, 'core.json'),
    sidecar: join(root, 'sidecar'),
    runtimeSbom: join(root, 'runtime-sbom.json'),
    web: join(root, 'web'),
    bundleGraph: join(root, 'bundle-graph.json'),
    out: join(root, 'dist/artifacts.json'),
  }
  writeFileSync(paths.core, `${JSON.stringify(coreManifest(), null, 2)}\n`)
  writeFileSync(paths.sidecar, 'sidecar bytes')
  writeFileSync(paths.runtimeSbom, '{"version":1}\n')
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
      '--runtime-sbom', 'runtime-sbom.json',
      '--web', 'web',
      '--out', 'artifacts.json',
    ])).toThrow(/--bundle-graph/u)
    expect(() => parseArtifactManifestArguments([
      '--core', 'core.json',
      '--sidecar', 'sidecar',
      '--web', 'web',
      '--bundle-graph', 'bundle.json',
      '--out', 'artifacts.json',
    ])).toThrow(/--runtime-sbom/u)
    expect(() => parseArtifactManifestArguments([
      '--core', 'core.json',
      '--sidecar', 'sidecar',
      '--runtime-sbom', 'runtime-sbom.json',
      '--web', 'web',
      '--bundle-graph', 'bundle.json',
      '--out', 'artifacts.json',
      '--web-sha256', 'a'.repeat(64),
    ])).toThrow(/unknown option.*sha256/iu)
  })

  it('hashes the exact validated core bytes as manifest identity', () => {
    const paths = fixture()
    const dependencies = { trustedRoot: dirname(paths.core) }
    const coreBytes = readFileSync(paths.core)
    const result = generateArtifactManifest(paths, dependencies)

    expect(result.manifest.coreManifestSha256).toBe(
      createHash('sha256').update(coreBytes).digest('hex'),
    )
    expect(result.manifest.artifacts).toEqual({
      sidecar: hashArtifact(paths.sidecar, dependencies),
      runtimeSbom: hashArtifact(paths.runtimeSbom, dependencies),
      web: hashArtifact(paths.web, dependencies),
      bundleGraph: hashArtifact(paths.bundleGraph, dependencies),
    })
  })

  it('writes deterministic bytes and ignores directory creation order and mtimes', () => {
    const paths = fixture()
    const otherWeb = join(temporaryRoot(), 'web')
    const dependencies = { trustedRoot: dirname(paths.core) }
    mkdirSync(join(paths.web, 'assets'))
    writeFileSync(join(paths.web, 'assets/z.js'), 'z')
    writeFileSync(join(paths.web, 'assets/a.js'), 'a')
    mkdirSync(join(otherWeb, 'assets'), { recursive: true })
    writeFileSync(join(otherWeb, 'assets/a.js'), 'a')
    writeFileSync(join(otherWeb, 'assets/z.js'), 'z')
    writeFileSync(join(otherWeb, 'index.html'), '<main>OpenLoop</main>')

    expect(hashArtifact(paths.web, dependencies)).toBe(
      hashArtifact(otherWeb, { trustedRoot: dirname(otherWeb) }),
    )

    const first = generateArtifactManifest(paths, dependencies)
    const firstBytes = readFileSync(paths.out)
    const second = generateArtifactManifest(paths, dependencies)
    expect(readFileSync(paths.out)).toEqual(firstBytes)
    expect(second.sha256).toBe(first.sha256)
  })

  it('uses the versioned artifact hash domain and distinguishes root types', () => {
    const root = temporaryRoot()
    const emptyFile = join(root, 'empty-file')
    const emptyDirectory = join(root, 'empty-directory')
    writeFileSync(emptyFile, '')
    mkdirSync(emptyDirectory)
    const dependencies = { trustedRoot: root }

    expect(hashArtifact(emptyFile, dependencies)).toBe(
      '1b02ed3de0dc5556730ae94551e2198cb95d5692e6fe20a0ab1122a565925886',
    )
    expect(hashArtifact(emptyDirectory, dependencies)).toBe(
      '681c21e2e58bd5ae06f448af5d298bb1a6d0f0b5cab1294e51f2b58c25bbbd2b',
    )
  })

  it('includes empty directory entries and entry types in directory hashes', () => {
    const root = temporaryRoot()
    const empty = join(root, 'empty')
    const nestedEmpty = join(root, 'nested-empty')
    const fileTree = join(root, 'file-tree')
    const directoryTree = join(root, 'directory-tree')
    mkdirSync(empty)
    mkdirSync(join(nestedEmpty, 'entry'), { recursive: true })
    mkdirSync(fileTree)
    writeFileSync(join(fileTree, 'entry'), '')
    mkdirSync(join(directoryTree, 'entry'), { recursive: true })
    const dependencies = { trustedRoot: root }

    expect(hashArtifact(empty, dependencies))
      .not.toBe(hashArtifact(nestedEmpty, dependencies))
    expect(hashArtifact(fileTree, dependencies))
      .not.toBe(hashArtifact(directoryTree, dependencies))
  })

  it('preserves the output inode when canonical bytes are unchanged', () => {
    const paths = fixture()
    const dependencies = { trustedRoot: dirname(paths.core) }

    generateArtifactManifest(paths, dependencies)
    const firstInode = statSync(paths.out).ino
    generateArtifactManifest(paths, dependencies)

    expect(statSync(paths.out).ino).toBe(firstInode)
  })

  it('includes optional release artifacts only when supplied', () => {
    const paths = fixture()
    const dependencies = { trustedRoot: dirname(paths.core) }
    const optional = {
      app: join(paths.web, 'OpenLoop.app'),
      dmg: join(paths.web, 'OpenLoop.dmg'),
      updater: join(paths.web, 'OpenLoop.tar.gz'),
      ffmpeg: join(paths.web, 'ffmpeg'),
      ffprobe: join(paths.web, 'ffprobe'),
    }
    for (const [name, path] of Object.entries(optional)) writeFileSync(path, name)

    const result = generateArtifactManifest({ ...paths, ...optional }, dependencies)

    expect(Object.keys(result.manifest.artifacts)).toEqual([
      'sidecar',
      'runtimeSbom',
      'web',
      'bundleGraph',
      'app',
      'dmg',
      'updater',
      'ffmpeg',
      'ffprobe',
    ])
    expect(result.manifest.artifacts.ffprobe).toBe(
      hashArtifact(optional.ffprobe, dependencies),
    )
  })

  it('uses the repository as the default trusted root', () => {
    const paths = fixture()

    expect(() => generateArtifactManifest(paths)).toThrow(/trusted root/iu)
    expect(() => hashArtifact(paths.sidecar)).toThrow(/trusted root/iu)
    expect(() => generateArtifactManifest({
      ...paths,
      core: relative(process.cwd(), paths.core),
    })).toThrow(/trusted root/iu)
    expect(() => hashArtifact(
      relative(process.cwd(), paths.sidecar),
    )).toThrow(/trusted root/iu)
  })

  it('rejects invalid core manifests, missing inputs, and direct or nested symlinks', () => {
    const invalid = fixture()
    writeFileSync(invalid.core, JSON.stringify({
      ...coreManifest(),
      dshCommit: 'short',
    }))
    expect(() => generateArtifactManifest(
      invalid,
      { trustedRoot: dirname(invalid.core) },
    )).toThrow(/dshCommit/iu)

    const missing = fixture()
    rmSync(missing.sidecar)
    expect(() => generateArtifactManifest(
      missing,
      { trustedRoot: dirname(missing.core) },
    )).toThrow(/sidecar.*missing|missing.*sidecar/iu)

    const escaped = fixture()
    const outside = join(temporaryRoot(), 'outside.js')
    writeFileSync(outside, 'outside')
    symlinkSync(outside, join(escaped.web, 'linked.js'))
    expect(() => generateArtifactManifest(
      escaped,
      { trustedRoot: dirname(escaped.core) },
    )).toThrow(/symlink/iu)

    const direct = fixture()
    const realSidecar = join(dirname(direct.sidecar), 'real-sidecar')
    writeFileSync(realSidecar, 'sidecar bytes')
    rmSync(direct.sidecar)
    symlinkSync(realSidecar, direct.sidecar)
    expect(() => generateArtifactManifest(
      direct,
      { trustedRoot: dirname(direct.core) },
    )).toThrow(/symlink/iu)
  })

  it('rejects an intermediate symlink component in an input path', () => {
    const paths = fixture()
    const root = dirname(paths.core)
    const real = join(root, 'real-inputs')
    const alias = join(root, 'input-alias')
    mkdirSync(join(real, 'nested'), { recursive: true })
    writeFileSync(join(real, 'nested/sidecar'), 'sidecar bytes')
    symlinkSync(real, alias, 'dir')

    expect(() => generateArtifactManifest({
      ...paths,
      sidecar: join(alias, 'nested/sidecar'),
    }, { trustedRoot: root })).toThrow(/symlink/iu)

    writeFileSync(join(real, 'nested/artifact'), 'artifact bytes')
    expect(() => hashArtifact(
      join(alias, 'nested/artifact'),
      { trustedRoot: root },
    )).toThrow(/symlink/iu)
  })

  it('rejects output overlap and a symlinked output parent using resolved paths', () => {
    const overlap = fixture()
    const nestedOutput = join(overlap.web, 'generated/artifact-manifest.json')
    expect(() => generateArtifactManifest({
      ...overlap,
      out: nestedOutput,
    }, { trustedRoot: dirname(overlap.core) })).toThrow(/overlap/iu)
    expect(existsSync(dirname(nestedOutput))).toBe(false)

    const webAlias = join(dirname(overlap.web), 'web-alias')
    symlinkSync(overlap.web, webAlias, 'dir')
    expect(() => generateArtifactManifest({
      ...overlap,
      out: join(webAlias, 'artifact-manifest.json'),
    }, { trustedRoot: dirname(overlap.core) })).toThrow(/symlink|overlap/iu)

    const redirected = fixture()
    const root = dirname(redirected.core)
    const realOutput = join(root, 'real-output')
    const outputAlias = join(root, 'output-alias')
    mkdirSync(join(realOutput, 'nested'), { recursive: true })
    symlinkSync(realOutput, outputAlias, 'dir')
    expect(() => generateArtifactManifest({
      ...redirected,
      out: join(outputAlias, 'nested/artifact-manifest.json'),
    }, { trustedRoot: root })).toThrow(/symlink/iu)
    expect(() => readFileSync(join(realOutput, 'nested/artifact-manifest.json')))
      .toThrow()
  })

  it('rejects a case alias of the core manifest input', () => {
    const paths = fixture()
    const coreBytes = readFileSync(paths.core)

    expect(() => generateArtifactManifest({
      ...paths,
      out: uppercaseAlias(paths.core),
    }, { trustedRoot: dirname(paths.core) })).toThrow(/overlap/iu)
    expect(readFileSync(paths.core)).toEqual(coreBytes)
  })

  it('uses directory identity to reject a case alias nested inside an input tree', () => {
    const paths = fixture()
    const canonicalWeb = join(dirname(paths.web), 'Web')
    renameSync(paths.web, canonicalWeb)
    const caseAlias = paths.web
    const outputRoot = existsSync(caseAlias) ? caseAlias : canonicalWeb
    const output = join(outputRoot, 'nested/manifest.json')

    if (existsSync(caseAlias)) {
      expect(statSync(caseAlias).dev).toBe(statSync(canonicalWeb).dev)
      expect(statSync(caseAlias).ino).toBe(statSync(canonicalWeb).ino)
    }

    expect(() => generateArtifactManifest({
      ...paths,
      web: canonicalWeb,
      out: output,
    }, { trustedRoot: dirname(paths.core) })).toThrow(/overlap/iu)
    expect(existsSync(output)).toBe(false)
  })
})
