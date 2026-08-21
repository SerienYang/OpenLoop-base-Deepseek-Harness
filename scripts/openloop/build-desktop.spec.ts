import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach } from 'vitest'
import { describe, expect, it } from 'vitest'

const modulePath = './build-desktop.mjs'
const artifactGeneratorPath: string = './generate-artifact-manifest.mjs'
const temporaryRoots: string[] = []
const updaterPublicKey = 'dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXkgRTc2MjBGMTg0MkI0RTgxRgpSV1FmNkxSQ0dBOWk1M21sWWVjTzRJelQ1MVRHUHB2V3VjTlNDaDFDQk0wUVRhTG43M1k3R0ZPMwo='
const minisignSignature = `untrusted comment: signature from minisign secret key
RWQf6LRCGA9i59SLOFxz6NxvASXDJeRtuZykwQepbDEGt87ig1BNpWaVWuNrm73YiIiJbq71Wi+dP9eKL8OC351vwIasSSbXxwA=
trusted comment: timestamp:1555779966\tfile:test
QtKMXWyYcwdpZAlPF7tE2ENJkRd1ujvKjlj1m9RtHTBnZPa5WKU5uWRs5GoP5M/VqE81QFuMKI5k/SfNQUaOAA==`
const tauriSignature = Buffer.from(minisignSignature).toString('base64')

interface ArtifactGeneratorModule {
  readonly generateArtifactManifest: (
    options: {
      readonly core: string
      readonly sidecar: string
      readonly runtimeSbom: string
      readonly web: string
      readonly bundleGraph: string
      readonly out: string
      readonly app?: string
      readonly dmg?: string
      readonly updater?: string
    },
    dependencies: { readonly trustedRoot: string },
  ) => { readonly bytes: string }
}

interface DesktopModule {
  readonly parseDesktopBuildArguments: (args: string[]) => Record<string, string>
  readonly DesktopBuilder: new (dependencies: Record<string, unknown>) => {
    readonly build: () => Promise<void>
  }
  readonly nodeFileSystem: {
    readonly cleanDist: (...args: readonly unknown[]) => Promise<void>
    readonly generateBundleGraph: (...args: readonly unknown[]) => Promise<void>
    readonly verify: (...args: readonly unknown[]) => Promise<void>
  }
  readonly createProcessRunner: (...args: readonly unknown[]) => {
    readonly run: (...args: readonly unknown[]) => Promise<{
      readonly stdout: string
      readonly stderr: string
    }>
  }
  readonly verifyDesktopBuild: (
    context: Record<string, unknown>,
    runner: Record<string, unknown>,
  ) => Promise<void>
  readonly createDesktopBuilder: (options?: Record<string, unknown>) => {
    readonly dependencies: Record<string, unknown>
  }
}

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'openloop-desktop-builder-'))
  temporaryRoots.push(root)
  return root
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

describe('Openloop desktop build orchestrator', () => {
  it.each(['none', 'app', 'dmg', 'all'] as const)(
    'parses the single supported target with %s bundles',
    async (bundle) => {
      const { parseDesktopBuildArguments } = await import(modulePath) as DesktopModule

      expect(parseDesktopBuildArguments([
        '--channel',
        'test',
        '--target',
        'aarch64-apple-darwin',
        '--bundle',
        bundle,
      ])).toEqual({
        channel: 'test',
        target: 'aarch64-apple-darwin',
        bundle,
      })
    },
  )

  it.each([
    [['--channel', 'test', '--channel', 'stable', '--target', 'aarch64-apple-darwin', '--bundle', 'app'], /--channel.*once/u],
    [['--channel', 'test', '--target', 'aarch64-apple-darwin', '--bundle', 'app', '--out', '/tmp/app'], /unknown option --out/u],
    [['--channel', 'test', '--target', 'aarch64-apple-darwin'], /--bundle is required/u],
    [['--channel', 'preview', '--target', 'aarch64-apple-darwin', '--bundle', 'app'], /channel.*test or stable/u],
    [['--channel', 'test', '--target', 'x86_64-apple-darwin', '--bundle', 'app'], /target.*aarch64/u],
    [['--channel', 'test', '--target', 'aarch64-apple-darwin', '--bundle', 'pkg'], /bundle.*none.*app.*dmg.*all/u],
  ] as const)('rejects ambiguous or unsupported arguments %#', async (args, error) => {
    const { parseDesktopBuildArguments } = await import(modulePath) as DesktopModule

    expect(() => parseDesktopBuildArguments([...args])).toThrow(error)
  })

  it('runs the eight desktop build stages in strict order', async () => {
    const { DesktopBuilder } = await import(modulePath) as DesktopModule
    const events: string[] = []
    const runner = {
      run: async ({ command, args }: { command: string; args: string[] }) => {
        events.push(`run:${command} ${args.join(' ')}`)
        return { stdout: '', stderr: '' }
      },
    }
    let verifyContext: Record<string, unknown> | undefined
    const files = {
      cleanDist: async () => events.push('1:clean'),
      readDesktopPackage: async () => ({ version: '1.2.3' }),
      generateBundleGraph: async () => undefined,
      verify: async (context: Record<string, unknown>) => {
        verifyContext = context
        events.push('8:verify')
      },
    }
    let runtimeOptions: Record<string, unknown> | undefined
    const createRuntimeBuilder = (options: Record<string, unknown>) => {
      runtimeOptions = options
      return {
        build: async () => events.push('4:runtime'),
      }
    }
    const generateBuildManifest = () => {
      events.push('2:core')
      return { manifest: { appVersion: '1.2.3' } }
    }
    let artifactGeneration = 0
    const generateArtifactManifest = () => {
      artifactGeneration += 1
      events.push(artifactGeneration === 1 ? '5:base' : '7:final')
      return { manifest: { artifacts: {} } }
    }
    const builder = new DesktopBuilder({
      root: '/repo',
      updaterPublicKey,
      options: {
        channel: 'test',
        target: 'aarch64-apple-darwin',
        bundle: 'app',
      },
      runner,
      files,
      createRuntimeBuilder,
      generateBuildManifest,
      generateArtifactManifest,
    })

    await builder.build()

    expect(runtimeOptions).toMatchObject({
      root: '/repo',
      target: 'aarch64-apple-darwin',
      skipBuild: true,
      runner,
    })
    expect(verifyContext).toMatchObject({ root: '/repo' })
    expect(events).toEqual([
      '1:clean',
      '2:core',
      'run:pnpm run build',
      '4:runtime',
      '5:base',
      `run:pnpm exec tauri build --target aarch64-apple-darwin --bundles app --config {"identifier":"ai.openloop.desktop.test","version":"1.2.3","bundle":{"createUpdaterArtifacts":false},"plugins":{"updater":{"pubkey":"${updaterPublicKey}","endpoints":["https://github.com/SerienYang/OpenLoop-base-Deepseek-Harness/releases/download/openloop-test-rolling/latest-test-k1.json"]}}} --ci`,
      '7:final',
      '8:verify',
    ])
  })

  it.each([
    ['none', ['--no-bundle'], []],
    ['app', ['--bundles', 'app'], ['app']],
    ['dmg', ['--bundles', 'dmg'], ['app', 'dmg']],
    ['all', ['--bundles', 'app,dmg'], ['app', 'dmg', 'updater']],
  ] as const)('maps %s to Tauri and final artifact inputs', async (
    bundle,
    expectedBundleArgs,
    expectedReleaseArtifacts,
  ) => {
    const { DesktopBuilder } = await import(modulePath) as DesktopModule
    const commands: Array<{ command: string; args: string[]; cwd: string }> = []
    const manifests: Array<Record<string, string>> = []
    const runner = {
      run: async (command: { command: string; args: string[]; cwd: string }) => {
        commands.push(command)
        return { stdout: '', stderr: '' }
      },
    }
    const builder = new DesktopBuilder({
      root: '/repo',
      updaterPublicKey,
      options: {
        channel: 'stable',
        target: 'aarch64-apple-darwin',
        bundle,
      },
      runner,
      files: {
        cleanDist: async () => undefined,
        readDesktopPackage: async () => ({ version: '1.2.3' }),
        generateBundleGraph: async () => undefined,
        verify: async () => undefined,
      },
      createRuntimeBuilder: () => ({ build: async () => undefined }),
      generateBuildManifest: (options: Record<string, string>) => {
        expect(options.appVersion).toBe('1.2.3')
        expect(options.channel).toBe('stable')
      },
      generateArtifactManifest: (options: Record<string, string>) => {
        manifests.push(options)
      },
    })

    await builder.build()

    const tauri = commands[1]
    expect(tauri?.args).toEqual([
      'exec',
      'tauri',
      'build',
      '--target',
      'aarch64-apple-darwin',
      ...expectedBundleArgs,
      '--config',
      `{"identifier":"ai.openloop.desktop","version":"1.2.3","bundle":{"createUpdaterArtifacts":${bundle === 'all' ? 'true' : 'false'}},"plugins":{"updater":{"pubkey":"${updaterPublicKey}","endpoints":["https://github.com/SerienYang/OpenLoop-base-Deepseek-Harness/releases/download/openloop-stable-rolling/latest-stable-k1.json"]}}}`,
      '--ci',
    ])
    expect(tauri?.cwd).toBe('/repo/apps/openloop-desktop')
    expect(manifests).toHaveLength(2)
    expect(Object.keys(manifests[0] ?? {}).sort()).toEqual([
      'bundleGraph',
      'core',
      'out',
      'runtimeSbom',
      'sidecar',
      'web',
    ])
    const releaseArtifacts = Object.keys(manifests[1] ?? {})
      .filter(key => key === 'app' || key === 'dmg' || key === 'updater')
    expect(releaseArtifacts).toEqual(expectedReleaseArtifacts)
    const releaseArtifactNames: readonly string[] = expectedReleaseArtifacts
    if (releaseArtifactNames.includes('app')) {
      expect(manifests[1]?.app).toBe(
        '/repo/apps/openloop-desktop/src-tauri/target/aarch64-apple-darwin/release/bundle/macos/Openloop.app',
      )
    }
    if (releaseArtifactNames.includes('dmg')) {
      expect(manifests[1]?.dmg).toBe(
        '/repo/apps/openloop-desktop/src-tauri/target/aarch64-apple-darwin/release/bundle/dmg/Openloop_1.2.3_aarch64.dmg',
      )
    }
    if (releaseArtifactNames.includes('updater')) {
      expect(manifests[1]?.updater).toBe(
        '/repo/apps/openloop-desktop/src-tauri/target/aarch64-apple-darwin/release/bundle/macos/Openloop.app.tar.gz',
      )
    }
  })

  it.each(['none', 'app', 'dmg', 'all'] as const)(
    'fails closed before a %s build when the updater public key is absent',
    async (bundle) => {
      const { DesktopBuilder } = await import(modulePath) as DesktopModule
      const events: string[] = []
      const builder = new DesktopBuilder({
        root: '/repo',
        updaterPublicKey: ' \n',
        options: {
          channel: 'test',
          target: 'aarch64-apple-darwin',
          bundle,
        },
        runner: { run: async () => {
          events.push('run')
          return { stdout: '', stderr: '' }
        } },
        files: {
          cleanDist: async () => events.push('clean'),
          readDesktopPackage: async () => ({ version: '1.2.3' }),
        },
        createRuntimeBuilder: () => ({ build: async () => undefined }),
        generateBuildManifest: () => undefined,
        generateArtifactManifest: () => undefined,
      })

      await expect(builder.build()).rejects.toThrow(/OPENLOOP_UPDATER_PUBLIC_KEY/iu)
      expect(events).toEqual([])
    },
  )

  it('accepts an absent dist directory covered by the fixed ignore rule', async () => {
    const { createProcessRunner, nodeFileSystem } = await import(modulePath) as DesktopModule
    const root = temporaryRoot()
    const dist = join(root, 'dist-openloop')
    execFileSync('git', ['init', '-q'], { cwd: root })
    writeFileSync(join(root, '.gitignore'), 'dist-openloop/\n')

    await expect(nodeFileSystem.cleanDist(root, dist, createProcessRunner()))
      .resolves.toBeUndefined()
    expect(existsSync(dist)).toBe(false)
  })

  it('refuses a tracked regular file at the fixed dist directory path', async () => {
    const { createProcessRunner, nodeFileSystem } = await import(modulePath) as DesktopModule
    const root = temporaryRoot()
    const dist = join(root, 'dist-openloop')
    execFileSync('git', ['init', '-q'], { cwd: root })
    writeFileSync(join(root, '.gitignore'), 'dist-openloop/\n')
    writeFileSync(dist, 'tracked payload\n')
    execFileSync('git', ['add', '-f', 'dist-openloop'], { cwd: root })

    await expect(nodeFileSystem.cleanDist(root, dist, createProcessRunner()))
      .rejects.toThrow(/real directory/iu)
    expect(readFileSync(dist, 'utf8')).toBe('tracked payload\n')
  })

  it('deletes only a git-ignored real dist-openloop directory', async () => {
    const { nodeFileSystem } = await import(modulePath) as DesktopModule
    const root = temporaryRoot()
    const dist = join(root, 'dist-openloop')
    const keep = join(root, 'keep')
    mkdirSync(dist)
    mkdirSync(keep)
    writeFileSync(join(dist, 'old'), 'old')
    writeFileSync(join(keep, 'data'), 'keep')
    const commands: unknown[] = []
    const runner = {
      run: async (command: unknown) => {
        commands.push(command)
        return { stdout: '', stderr: '' }
      },
    }

    await nodeFileSystem.cleanDist(root, dist, runner)

    expect(commands).toEqual([{
      command: 'git',
      args: ['check-ignore', '-q', '--', 'dist-openloop/'],
      cwd: root,
    }])
    expect(existsSync(dist)).toBe(false)
    expect(readFileSync(join(keep, 'data'), 'utf8')).toBe('keep')

    mkdirSync(dist)
    writeFileSync(join(dist, 'old'), 'old')
    await expect(nodeFileSystem.cleanDist(root, join(root, 'other'), runner))
      .rejects.toThrow(/exactly.*dist-openloop|fixed.*dist-openloop/iu)
    expect(existsSync(dist)).toBe(true)

    const outside = temporaryRoot()
    writeFileSync(join(outside, 'outside'), 'outside')
    rmSync(dist, { recursive: true })
    symlinkSync(outside, dist, 'dir')
    await expect(nodeFileSystem.cleanDist(root, dist, runner))
      .rejects.toThrow(/symlink/iu)
    expect(readFileSync(join(outside, 'outside'), 'utf8')).toBe('outside')

    rmSync(dist)
    mkdirSync(dist)
    symlinkSync(outside, join(dist, 'nested'), 'dir')
    await expect(nodeFileSystem.cleanDist(root, dist, runner))
      .rejects.toThrow(/symlink/iu)
    expect(readFileSync(join(outside, 'outside'), 'utf8')).toBe('outside')

    rmSync(dist, { recursive: true })
    mkdirSync(dist)
    writeFileSync(join(dist, 'old'), 'old')
    const rejectingRunner = {
      run: async () => {
        throw new Error('not ignored')
      },
    }
    await expect(nodeFileSystem.cleanDist(root, dist, rejectingRunner))
      .rejects.toThrow(/not ignored/u)
    expect(readFileSync(join(dist, 'old'), 'utf8')).toBe('old')

    const rootAlias = join(temporaryRoot(), 'root-alias')
    symlinkSync(root, rootAlias, 'dir')
    await expect(nodeFileSystem.cleanDist(
      rootAlias,
      join(rootAlias, 'dist-openloop'),
      runner,
    )).rejects.toThrow(/repository root.*symlink/iu)
  })

  it('writes a canonical fixed-path Web bundle graph and rejects symlinks', async () => {
    const { nodeFileSystem } = await import(modulePath) as DesktopModule
    const root = temporaryRoot()
    const web = join(root, 'apps/web/dist')
    const graph = join(root, 'dist-openloop/openloop-web-bundle-graph.json')
    mkdirSync(join(web, 'assets'), { recursive: true })
    writeFileSync(join(web, 'index.html'), '<main>Openloop</main>\n')
    writeFileSync(join(web, 'assets/z.js'), 'z\n')
    writeFileSync(join(web, 'assets/a.js'), 'a\n')

    await nodeFileSystem.generateBundleGraph(root, web, graph)
    const first = readFileSync(graph, 'utf8')
    await nodeFileSystem.generateBundleGraph(root, web, graph)

    expect(readFileSync(graph, 'utf8')).toBe(first)
    expect(first.endsWith('\n')).toBe(true)
    expect(JSON.parse(first)).toEqual({
      version: 1,
      root: 'apps/web/dist',
      files: [
        {
          path: 'assets/a.js',
          size: 2,
          sha256: createHash('sha256').update('a\n').digest('hex'),
        },
        {
          path: 'assets/z.js',
          size: 2,
          sha256: createHash('sha256').update('z\n').digest('hex'),
        },
        {
          path: 'index.html',
          size: 22,
          sha256: createHash('sha256').update('<main>Openloop</main>\n').digest('hex'),
        },
      ],
    })

    await expect(nodeFileSystem.generateBundleGraph(
      root,
      web,
      join(root, 'other.json'),
    )).rejects.toThrow(/fixed.*bundle graph|exactly.*bundle graph/iu)

    const outside = temporaryRoot()
    writeFileSync(join(outside, 'linked.js'), 'outside')
    symlinkSync(join(outside, 'linked.js'), join(web, 'linked.js'))
    await expect(nodeFileSystem.generateBundleGraph(root, web, graph))
      .rejects.toThrow(/symlink/iu)
  })

  it('spawns subprocesses with argv and shell disabled', async () => {
    const { createProcessRunner } = await import(modulePath) as DesktopModule
    const calls: unknown[][] = []
    const spawn = (...args: unknown[]) => {
      calls.push(args)
      const child = new EventEmitter() as EventEmitter & {
        stdout: EventEmitter
        stderr: EventEmitter
      }
      child.stdout = new EventEmitter()
      child.stderr = new EventEmitter()
      queueMicrotask(() => {
        child.stdout.emit('data', Buffer.from('stdout\n'))
        child.stderr.emit('data', Buffer.from('stderr\n'))
        child.emit('exit', 0, null)
      })
      return child
    }
    const runner = createProcessRunner(spawn)

    const result = await runner.run({
      command: 'tool',
      args: ['--value', 'with spaces;$(no-shell)'],
      cwd: '/repo',
      capture: true,
    })

    expect(result).toEqual({ stdout: 'stdout\n', stderr: 'stderr\n' })
    expect(calls).toEqual([[
      'tool',
      ['--value', 'with spaces;$(no-shell)'],
      expect.objectContaining({
        cwd: '/repo',
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
      }),
    ]])
  })

  it('verifies final hashes, embedded base identity, App binaries, signatures, and health', async () => {
    const { verifyDesktopBuild } = await import(modulePath) as DesktopModule
    const { generateArtifactManifest } = await import(
      artifactGeneratorPath,
    ) as ArtifactGeneratorModule
    const root = temporaryRoot()
    const dist = join(root, 'dist-openloop')
    const core = join(dist, 'openloop-core.json')
    const artifacts = join(dist, 'openloop-artifacts.json')
    const sidecar = join(dist, 'openloop-runtime-aarch64-apple-darwin')
    const runtimeSbom = join(dist, 'openloop-runtime-sbom-inputs.json')
    const web = join(root, 'apps/web/dist')
    const bundleGraph = join(dist, 'openloop-web-bundle-graph.json')
    const release = join(
      root,
      'apps/openloop-desktop/src-tauri/target/aarch64-apple-darwin/release',
    )
    const app = join(release, 'bundle/macos/Openloop.app')
    const updater = join(release, 'bundle/macos/Openloop.app.tar.gz')
    const updaterSignature = `${updater}.sig`
    const dmg = join(release, 'bundle/dmg/Openloop_1.2.3_aarch64.dmg')
    const macOS = join(app, 'Contents/MacOS')
    const main = join(macOS, 'openloop-desktop')
    const bundledSidecar = join(macOS, 'openloop-runtime')
    const helper = join(macOS, 'openloop-runtime-spawn-helper')
    mkdirSync(dist, { recursive: true })
    mkdirSync(web, { recursive: true })
    mkdirSync(macOS, { recursive: true })
    writeFileSync(core, `${JSON.stringify({
      appVersion: '1.2.3',
      channel: 'test',
      dshTag: 'dsh-v0.1.0-rc.7',
      dshCommit: '99f6f02fecdb7dff40c3fbc9470f5907c29f74ca',
      runtimeVersion: 1,
      bridgeProtocolVersion: 1,
      uiSdkVersion: '0.1.0',
      pluginPackageSpecVersion: '0.1.0',
      openloopDataVersion: 0,
      dshDataVersion: 0,
    }, null, 2)}\n`)
    writeFileSync(sidecar, 'sidecar')
    writeFileSync(runtimeSbom, '{"version":1}\n')
    writeFileSync(join(web, 'index.html'), '<main>Openloop</main>\n')
    writeFileSync(bundleGraph, '{"version":1}\n')
    mkdirSync(join(release, 'bundle/dmg'), { recursive: true })
    writeFileSync(updater, 'test')
    writeFileSync(updaterSignature, `${tauriSignature}\n`)
    writeFileSync(dmg, 'disk image')
    const baseInputs = {
      core,
      sidecar,
      runtimeSbom,
      web,
      bundleGraph,
      out: artifacts,
    }
    const base = generateArtifactManifest(baseInputs, { trustedRoot: root })
    writeFileSync(main, Buffer.concat([Buffer.from('main\0'), Buffer.from(base.bytes)]))
    writeFileSync(bundledSidecar, 'sidecar')
    writeFileSync(helper, 'helper')
    writeFileSync(join(app, 'Contents/Info.plist'), 'plist')
    for (const executable of [sidecar, main, bundledSidecar, helper]) {
      chmodSync(executable, 0o755)
    }
    generateArtifactManifest(
      { ...baseInputs, app, dmg, updater },
      { trustedRoot: root },
    )
    const coreSha256 = createHash('sha256').update(readFileSync(core)).digest('hex')
    const validReadiness = {
      type: 'openloop.runtime.ready',
      version: 1,
      profile: 'openloop',
      host: '127.0.0.1',
      port: 49152,
      origin: 'http://127.0.0.1:49152',
      coreManifestSha256: coreSha256,
      healthSmoke: { method: 'GET', path: '/', status: 200 },
    }
    let readinessPayload: Record<string, unknown> = validReadiness
    let healthSmokeStderr = ''
    const plistValues: Record<string, string> = {
      CFBundleIdentifier: 'ai.openloop.desktop.test',
      CFBundleShortVersionString: '1.2.3',
      CFBundleVersion: '1.2.3',
    }
    const commands: Array<{ command: string; args: string[] }> = []
    const runner = {
      run: async (command: { command: string; args: string[] }) => {
        commands.push(command)
        if (command.command === 'lipo') return { stdout: 'arm64\n', stderr: '' }
        if (command.command === 'plutil') {
          return { stdout: `${plistValues[command.args[1] ?? ''] ?? ''}\n`, stderr: '' }
        }
        if (command.command === 'codesign' && command.args[0] === '-d') {
          return {
            stdout: '',
            stderr: 'Signature=adhoc\nflags=0x10002(adhoc,runtime)\n',
          }
        }
        if (command.command === bundledSidecar) {
          return {
            stdout: `${JSON.stringify(readinessPayload)}\n`,
            stderr: healthSmokeStderr,
          }
        }
        return { stdout: '', stderr: '' }
      },
    }
    const context = {
      root,
      ...baseInputs,
      artifacts,
      app,
      dmg,
      updater,
      updaterSignature,
      updaterPublicKey,
      desktopVersion: '1.2.3',
      release,
      options: {
        channel: 'test',
        target: 'aarch64-apple-darwin',
        bundle: 'all',
      },
    }

    await expect(verifyDesktopBuild(context, runner)).resolves.toBeUndefined()
    const finalManifest = JSON.parse(readFileSync(artifacts, 'utf8')) as {
      readonly artifacts: Record<string, string>
    }
    expect(finalManifest.artifacts.updater).toMatch(/^[0-9a-f]{64}$/u)
    expect(commands.filter(command => command.command === 'lipo')).toHaveLength(3)
    expect(commands).toContainEqual({
      command: 'codesign',
      args: ['--verify', '--deep', '--strict', app],
      capture: true,
    })
    expect(commands).toContainEqual({
      command: bundledSidecar,
      args: ['--health-smoke'],
      capture: true,
    })

    healthSmokeStderr = 'unexpected diagnostic\n'
    await expect(verifyDesktopBuild(context, runner))
      .rejects.toThrow(/stderr/iu)
    healthSmokeStderr = ''

    writeFileSync(updaterSignature, '')
    await expect(verifyDesktopBuild(context, runner))
      .rejects.toThrow(/signature.*empty|empty.*signature/iu)
    writeFileSync(updaterSignature, `${tauriSignature}\n`)

    writeFileSync(updater, 'Test')
    generateArtifactManifest(
      { ...baseInputs, app, dmg, updater },
      { trustedRoot: root },
    )
    await expect(verifyDesktopBuild(context, runner))
      .rejects.toThrow(/signature|Minisign|verify/iu)
    writeFileSync(updater, 'test')
    generateArtifactManifest(
      { ...baseInputs, app, dmg, updater },
      { trustedRoot: root },
    )

    const decodedWrongKey = Buffer.from(updaterPublicKey, 'base64').toString('utf8')
    const [wrongComment, encodedWrongKey] = decodedWrongKey.trimEnd().split('\n')
    const wrongKeyBytes = Buffer.from(encodedWrongKey ?? '', 'base64')
    wrongKeyBytes[10] = (wrongKeyBytes[10] ?? 0) ^ 0xff
    const wrongPublicKey = Buffer.from(
      `${wrongComment ?? 'untrusted comment: wrong key'}\n${wrongKeyBytes.toString('base64')}\n`,
    ).toString('base64')
    await expect(verifyDesktopBuild(
      { ...context, updaterPublicKey: wrongPublicKey },
      runner,
    )).rejects.toThrow(/signature|Minisign|key|verify/iu)

    for (const key of ['CFBundleShortVersionString', 'CFBundleVersion']) {
      plistValues[key] = '9.9.9'
      await expect(verifyDesktopBuild(context, runner))
        .rejects.toThrow(new RegExp(`${key}|version`, 'iu'))
      plistValues[key] = '1.2.3'
    }

    await expect(verifyDesktopBuild(
      { ...context, desktopVersion: '9.9.9' },
      runner,
    )).rejects.toThrow(/core|desktop|version/iu)

    const wrongDmg = join(release, 'bundle/dmg/Openloop_9.9.9_aarch64.dmg')
    writeFileSync(wrongDmg, 'disk image')
    generateArtifactManifest(
      { ...baseInputs, app, dmg: wrongDmg, updater },
      { trustedRoot: root },
    )
    await expect(verifyDesktopBuild({ ...context, dmg: wrongDmg }, runner))
      .rejects.toThrow(/filename|file name|version|DMG/iu)
    generateArtifactManifest(
      { ...baseInputs, app, dmg, updater },
      { trustedRoot: root },
    )

    const invalidReadinessCases: Array<[string, Record<string, unknown>]> = [
      ['missing type', Object.fromEntries(
        Object.entries(validReadiness).filter(([key]) => key !== 'type'),
      )],
      ['extra field', { ...validReadiness, extra: true }],
      ['wrong version', { ...validReadiness, version: 2 }],
      ['wrong profile', { ...validReadiness, profile: 'dsh' }],
      ['wrong host', { ...validReadiness, host: 'localhost' }],
      ['port zero', { ...validReadiness, port: 0 }],
      ['port unsafe', { ...validReadiness, port: Number.MAX_SAFE_INTEGER + 1 }],
      ['port fractional', { ...validReadiness, port: 49152.5 }],
      ['origin mismatch', { ...validReadiness, origin: 'http://127.0.0.1:49153' }],
      ['hash mismatch', { ...validReadiness, coreManifestSha256: 'b'.repeat(64) }],
      ['missing health smoke', Object.fromEntries(
        Object.entries(validReadiness).filter(([key]) => key !== 'healthSmoke'),
      )],
      ['extra health smoke field', {
        ...validReadiness,
        healthSmoke: { ...validReadiness.healthSmoke as Record<string, unknown>, extra: true },
      }],
      ['wrong health smoke', {
        ...validReadiness,
        healthSmoke: { method: 'POST', path: '/', status: 200 },
      }],
    ]
    for (const [label, payload] of invalidReadinessCases) {
      readinessPayload = payload
      await expect(verifyDesktopBuild(context, runner), label)
        .rejects.toThrow(/readiness.*contract|port|origin|stderr/iu)
    }
    readinessPayload = validReadiness

    writeFileSync(runtimeSbom, '{"version":2}\n')
    await expect(verifyDesktopBuild(context, runner))
      .rejects.toThrow(/runtimeSbom.*hash|hash.*runtimeSbom/iu)

    writeFileSync(runtimeSbom, '{"version":1}\n')
    generateArtifactManifest(baseInputs, { trustedRoot: root })
    const rawMain = join(release, 'openloop-desktop')
    writeFileSync(rawMain, 'raw main')
    chmodSync(rawMain, 0o755)
    const rawRunner = {
      run: async (command: { command: string; args: string[] }) => {
        if (command.command === 'lipo') return { stdout: 'arm64\n', stderr: '' }
        if (command.command === 'codesign' && command.args[0] === '-d') {
          return {
            stdout: '',
            stderr: 'Signature=adhoc\nflags=0x2(adhoc)\n',
          }
        }
        return { stdout: '', stderr: '' }
      },
    }
    await expect(verifyDesktopBuild({
      ...context,
      app: undefined,
      dmg: undefined,
      updater: undefined,
      updaterSignature: undefined,
      options: { ...context.options, bundle: 'none' },
    }, rawRunner)).resolves.toBeUndefined()
  })

  it('wires the production verifier and default desktop builder without import side effects', async () => {
    const {
      createDesktopBuilder,
      DesktopBuilder,
      nodeFileSystem,
      verifyDesktopBuild,
    } = await import(modulePath) as DesktopModule
    const runner = { run: async () => ({ stdout: '', stderr: '' }) }
    const builder = createDesktopBuilder({ root: '/repo', runner })

    expect(builder).toBeInstanceOf(DesktopBuilder)
    expect(nodeFileSystem.verify).toBe(verifyDesktopBuild)
  })
})
