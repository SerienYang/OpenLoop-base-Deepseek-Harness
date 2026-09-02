import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join } from 'node:path'
import { PassThrough, Writable } from 'node:stream'
import { afterEach } from 'vitest'
import { describe, expect, it } from 'vitest'
import { decodeLaunchSecretsFrame } from '../../apps/openloop-runtime/src/launch-secrets.ts'
import { DesktopBridgeClient } from '../../packages/openloop/desktop-bridge-host/src/client.ts'

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
  readonly acquireDesktopBuildLock: (root: string) => () => void
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
  readonly createVerifierBridge: (
    options: {
      readonly launchId: string
      readonly bridgeSecret: Uint8Array
      readonly socketPath: string
    },
    dependencies?: Record<string, unknown>,
  ) => Promise<() => Promise<void>>
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
  it('excludes a concurrent process and releases the shared build lock', async () => {
    const { acquireDesktopBuildLock } = await import(modulePath) as DesktopModule
    const root = temporaryRoot()
    const moduleUrl = new URL(modulePath, import.meta.url).href
    const contender = `
      import { acquireDesktopBuildLock } from ${JSON.stringify(moduleUrl)}
      try {
        const release = acquireDesktopBuildLock(${JSON.stringify(root)})
        release()
      } catch (error) {
        process.stderr.write(error instanceof Error ? error.message : String(error))
        process.exitCode = 1
      }
    `
    const release = acquireDesktopBuildLock(root)

    const blocked = spawnSync(
      process.execPath,
      ['--input-type=module', '--eval', contender],
      { encoding: 'utf8' },
    )
    expect(blocked.status).toBe(1)
    expect(blocked.stderr).toContain('desktop build lock is held')

    release()
    const acquired = spawnSync(
      process.execPath,
      ['--input-type=module', '--eval', contender],
      { encoding: 'utf8' },
    )
    expect(acquired.status, acquired.stderr).toBe(0)
    expect(existsSync(join(root, '.artifacts/openloop-desktop-build.lock'))).toBe(false)
  })

  it('fails closed without deleting a stale shared build lock', async () => {
    const { acquireDesktopBuildLock } = await import(modulePath) as DesktopModule
    const root = temporaryRoot()
    const lock = join(root, '.artifacts/openloop-desktop-build.lock')
    mkdirSync(join(root, '.artifacts'))
    const completed = spawnSync(process.execPath, ['--eval', ''])
    expect(completed.status).toBe(0)
    const record = `${String(completed.pid)} 00000000-0000-4000-8000-000000000000\n`
    writeFileSync(lock, record)

    expect(() => acquireDesktopBuildLock(root)).toThrow(/stale desktop build lock/iu)
    expect(readFileSync(lock, 'utf8')).toBe(record)
  })

  it('releases the shared build lock when a build stage fails', async () => {
    const { DesktopBuilder } = await import(modulePath) as DesktopModule
    const root = temporaryRoot()
    const lock = join(root, '.artifacts/openloop-desktop-build.lock')
    const builder = new DesktopBuilder({
      root,
      updaterPublicKey,
      options: {
        channel: 'test',
        target: 'aarch64-apple-darwin',
        bundle: 'app',
      },
      runner: { run: async () => ({ stdout: '', stderr: '' }) },
      files: {
        cleanDist: async () => {
          expect(existsSync(lock)).toBe(true)
          throw new Error('stage failed')
        },
      },
      createRuntimeBuilder: () => ({ build: async () => undefined }),
      generateBuildManifest: () => undefined,
      generateArtifactManifest: () => undefined,
    })

    await expect(builder.build()).rejects.toThrow('stage failed')
    expect(existsSync(lock)).toBe(false)
  })

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
      withBuildLock: async (_root: string, operation: () => Promise<void>) => {
        events.push('lock:acquire')
        try {
          await operation()
        } finally {
          events.push('lock:release')
        }
      },
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
      'lock:acquire',
      '1:clean',
      '2:core',
      'run:pnpm run build',
      '4:runtime',
      '5:base',
      `run:pnpm exec tauri build --target aarch64-apple-darwin --bundles app --config {"identifier":"ai.openloop.desktop.test","version":"1.2.3","bundle":{"createUpdaterArtifacts":false},"plugins":{"updater":{"pubkey":"${updaterPublicKey}","endpoints":["https://github.com/SerienYang/OpenLoop-base-Deepseek-Harness/releases/download/openloop-test-rolling/latest-test-k1.json"]}}} --ci`,
      '7:final',
      '8:verify',
      'lock:release',
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
      withBuildLock: async (_root: string, operation: () => Promise<void>) => {
        await operation()
      },
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
        withBuildLock: async (_root: string, operation: () => Promise<void>) => {
          await operation()
        },
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

  it('writes optional input to fd3 without changing argv or environment', async () => {
    const { createProcessRunner } = await import(modulePath) as DesktopModule
    const calls: unknown[][] = []
    const received: Buffer[] = []
    const input = Buffer.from('fd3-only-secret')
    const spawn = (...args: unknown[]) => {
      calls.push(args)
      const child = new EventEmitter() as EventEmitter & {
        stdout: EventEmitter
        stderr: EventEmitter
        stdio: Array<null | PassThrough>
      }
      child.stdout = new EventEmitter()
      child.stderr = new EventEmitter()
      const fd3 = new PassThrough()
      fd3.on('data', (chunk: Buffer) => received.push(Buffer.from(chunk)))
      child.stdio = [null, null, null, fd3]
      setImmediate(() => child.emit('exit', 0, null))
      return child
    }
    const runner = createProcessRunner(spawn)

    await expect(runner.run({
      command: 'tool',
      args: ['--health-smoke'],
      capture: true,
      fd3Input: input,
      timeoutMs: 1_000,
    })).resolves.toEqual({ stdout: '', stderr: '' })

    expect(Buffer.concat(received).toString('utf8')).toBe('fd3-only-secret')
    expect(input.equals(Buffer.alloc(input.length))).toBe(true)
    expect(calls).toEqual([[
      'tool',
      ['--health-smoke'],
      expect.objectContaining({
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe', 'pipe'],
      }),
    ]])
    const spawnOptions = calls[0]?.[2] as { env?: Record<string, string> }
    expect(JSON.stringify(spawnOptions.env)).not.toContain('fd3-only-secret')
  })

  it('rejects a failed fd3 write, terminates the child, and clears the input', async () => {
    const { createProcessRunner } = await import(modulePath) as DesktopModule
    const input = Buffer.from('fd3-write-failure-secret')
    let killed = false
    const spawn = () => {
      const child = new EventEmitter() as EventEmitter & {
        stdout: EventEmitter
        stderr: EventEmitter
        stdio: Array<null | Writable>
        kill: () => boolean
      }
      child.stdout = new EventEmitter()
      child.stderr = new EventEmitter()
      child.stdio = [
        null,
        null,
        null,
        new Writable({
          write(_chunk, _encoding, callback) {
            callback(new Error('injected fd3 write failure'))
          },
        }),
      ]
      child.kill = () => {
        killed = true
        return true
      }
      return child
    }
    const runner = createProcessRunner(spawn, {
      terminateWaitMs: 1,
      killWaitMs: 1,
    })

    await expect(runner.run({
      command: 'tool',
      args: ['--health-smoke'],
      capture: true,
      fd3Input: input,
      timeoutMs: 1_000,
    })).rejects.toThrow(/fd3.*write|write.*fd3/iu)
    expect(killed).toBe(true)
    expect(input.equals(Buffer.alloc(input.length))).toBe(true)
  })

  it('reaps a timed-out fd3 child with bounded TERM then KILL waits', async () => {
    const { createProcessRunner } = await import(modulePath) as DesktopModule
    const signals: NodeJS.Signals[] = []
    let reaped = false
    const spawn = () => {
      const child = new EventEmitter() as EventEmitter & {
        stdout: EventEmitter
        stderr: EventEmitter
        stdio: Array<null | PassThrough>
        kill: (signal?: NodeJS.Signals) => boolean
      }
      child.stdout = new EventEmitter()
      child.stderr = new EventEmitter()
      child.stdio = [null, null, null, new PassThrough()]
      child.kill = (signal = 'SIGTERM') => {
        signals.push(signal)
        if (signal === 'SIGKILL') {
          setTimeout(() => {
            reaped = true
            child.emit('exit', null, 'SIGKILL')
          }, 5)
        }
        return true
      }
      return child
    }
    const runner = createProcessRunner(spawn, {
      terminateWaitMs: 5,
      killWaitMs: 25,
    })

    await expect(runner.run({
      command: 'tool',
      args: ['--health-smoke'],
      capture: true,
      fd3Input: Buffer.from('secret'),
      timeoutMs: 5,
    })).rejects.toThrow(/timed out/iu)
    expect(signals).toEqual(['SIGTERM', 'SIGKILL'])
    expect(reaped).toBe(true)
  })

  it('closes the verifier bridge when socket chmod fails after listen', async () => {
    const { createVerifierBridge } = await import(modulePath) as DesktopModule
    let closed = false
    const server = new EventEmitter() as EventEmitter & {
      listen: (_path: string, callback: () => void) => void
      close: (callback: (error?: Error) => void) => void
    }
    server.listen = (_path, callback) => {
      callback()
    }
    server.close = (callback) => {
      closed = true
      callback()
    }

    await expect(createVerifierBridge({
      launchId: '00000000-0000-4000-8000-000000000000',
      bridgeSecret: new Uint8Array(32),
      socketPath: '/tmp/openloop-verifier-test.sock',
    }, {
      createServer: () => server,
      chmod: async () => {
        throw new Error('injected chmod failure')
      },
    })).rejects.toThrow('injected chmod failure')
    expect(closed).toBe(true)
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
      brand: {
        productName: 'Openloop',
        documentSuffix: 'Openloop',
        markAsset: 'data:image/svg+xml;base64,PHN2Zy8+',
        heroTitle: 'Openloop',
        previewLabel: '预览版',
        attribution: 'Built on DeepSeek Harness',
      },
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
    const validReadiness = (launchId: string): Record<string, unknown> => ({
      type: 'openloop.runtime.ready',
      version: 1,
      launchId,
      profile: 'openloop',
      host: '127.0.0.1',
      port: 49152,
      origin: 'http://127.0.0.1:49152',
      coreManifestSha256: coreSha256,
      healthSmoke: { method: 'GET', path: '/', status: 200 },
      candidateHealth: { webAsset: true, bootstrapExchange: true },
    })
    let readinessTransform = (
      readiness: Record<string, unknown>,
    ): Record<string, unknown> => readiness
    let healthSmokeStderr = ''
    const plistValues: Record<string, string> = {
      CFBundleIdentifier: 'ai.openloop.desktop.test',
      CFBundleShortVersionString: '1.2.3',
      CFBundleVersion: '1.2.3',
    }
    const commands: Array<{
      command: string
      args: string[]
      capture?: boolean
      env?: Record<string, string>
      fd3Input?: Uint8Array
      timeoutMs?: number
    }> = []
    const healthLaunches: Array<ReturnType<typeof decodeLaunchSecretsFrame>> = []
    const runner = {
      run: async (command: {
        command: string
        args: string[]
        capture?: boolean
        env?: Record<string, string>
        fd3Input?: Uint8Array
        timeoutMs?: number
      }) => {
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
          if (command.fd3Input === undefined) throw new Error('test: fd3 input is missing')
          const launch = decodeLaunchSecretsFrame(command.fd3Input)
          healthLaunches.push(launch)
          expect(launch.launchId).toMatch(
            /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
          )
          expect(launch.bootstrapToken).toHaveLength(32)
          expect(launch.bridgeSecret).toHaveLength(32)
          expect(isAbsolute(launch.socketPath)).toBe(true)
          expect(statSync(dirname(launch.socketPath)).mode & 0o777).toBe(0o700)
          expect(statSync(launch.socketPath).mode & 0o777).toBe(0o600)
          const exposed = JSON.stringify({
            args: command.args,
            env: command.env,
          })
          expect(exposed).not.toContain(Buffer.from(launch.bootstrapToken).toString('hex'))
          expect(exposed).not.toContain(Buffer.from(launch.bridgeSecret).toString('hex'))
          const bridge = new DesktopBridgeClient({
            launchId: launch.launchId,
            secret: launch.bridgeSecret,
            socketPath: launch.socketPath,
          })
          try {
            await expect(bridge.call('readWorkspaceTransaction', null)).resolves.toBeNull()
          } finally {
            bridge.close()
          }
          return {
            stdout: `${JSON.stringify(readinessTransform(validReadiness(launch.launchId)))}\n`,
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
    const healthCommand = commands.find(command => command.command === bundledSidecar)
    expect(healthCommand?.args).toEqual(['--health-smoke'])
    expect(healthCommand?.capture).toBe(true)
    expect(Buffer.isBuffer(healthCommand?.fd3Input)).toBe(true)
    expect(healthCommand?.timeoutMs).toBeGreaterThan(0)
    expect(healthLaunches).toHaveLength(1)
    expect(existsSync(dirname(healthLaunches[0]?.socketPath ?? ''))).toBe(false)

    await expect(verifyDesktopBuild(context, runner)).resolves.toBeUndefined()
    expect(healthLaunches).toHaveLength(2)
    expect(healthLaunches[1]?.launchId).not.toBe(healthLaunches[0]?.launchId)
    expect(Buffer.from(healthLaunches[1]?.bootstrapToken ?? []))
      .not.toEqual(Buffer.from(healthLaunches[0]?.bootstrapToken ?? []))
    expect(Buffer.from(healthLaunches[1]?.bridgeSecret ?? []))
      .not.toEqual(Buffer.from(healthLaunches[0]?.bridgeSecret ?? []))

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

    const without = (
      readiness: Record<string, unknown>,
      omitted: string,
    ): Record<string, unknown> => Object.fromEntries(
      Object.entries(readiness).filter(([key]) => key !== omitted),
    )
    const invalidReadinessCases: Array<[
      string,
      (readiness: Record<string, unknown>) => Record<string, unknown>,
    ]> = [
      ['missing type', readiness => without(readiness, 'type')],
      ['extra field', readiness => ({ ...readiness, extra: true })],
      ['wrong version', readiness => ({ ...readiness, version: 2 })],
      ['missing launch id', readiness => without(readiness, 'launchId')],
      ['wrong launch id', readiness => ({
        ...readiness,
        launchId: '00000000-0000-4000-8000-000000000000',
      })],
      ['wrong profile', readiness => ({ ...readiness, profile: 'dsh' })],
      ['wrong host', readiness => ({ ...readiness, host: 'localhost' })],
      ['port zero', readiness => ({ ...readiness, port: 0 })],
      ['port unsafe', readiness => ({
        ...readiness,
        port: Number.MAX_SAFE_INTEGER + 1,
      })],
      ['port fractional', readiness => ({ ...readiness, port: 49152.5 })],
      ['origin mismatch', readiness => ({
        ...readiness,
        origin: 'http://127.0.0.1:49153',
      })],
      ['hash mismatch', readiness => ({
        ...readiness,
        coreManifestSha256: 'b'.repeat(64),
      })],
      ['missing health smoke', readiness => without(readiness, 'healthSmoke')],
      ['extra health smoke field', readiness => ({
        ...readiness,
        healthSmoke: {
          ...(readiness.healthSmoke as Record<string, unknown>),
          extra: true,
        },
      })],
      ['wrong health smoke', readiness => ({
        ...readiness,
        healthSmoke: { method: 'POST', path: '/', status: 200 },
      })],
      ['missing candidate health', readiness => without(readiness, 'candidateHealth')],
      ['extra candidate health field', readiness => ({
        ...readiness,
        candidateHealth: {
          ...(readiness.candidateHealth as Record<string, unknown>),
          extra: true,
        },
      })],
      ['unhealthy Web asset', readiness => ({
        ...readiness,
        candidateHealth: { webAsset: false, bootstrapExchange: true },
      })],
      ['unhealthy bootstrap exchange', readiness => ({
        ...readiness,
        candidateHealth: { webAsset: true, bootstrapExchange: false },
      })],
    ]
    for (const [label, transform] of invalidReadinessCases) {
      readinessTransform = transform
      await expect(verifyDesktopBuild(context, runner), label)
        .rejects.toThrow(/readiness.*contract|port|origin|stderr/iu)
    }
    readinessTransform = readiness => readiness

    let failedSocketDirectory = ''
    const fd3FailureRunner = {
      run: async (command: {
        command: string
        args: string[]
        fd3Input?: Uint8Array
      }) => {
        if (command.command !== bundledSidecar) return await runner.run(command)
        if (command.fd3Input === undefined) throw new Error('test: fd3 input is missing')
        failedSocketDirectory = dirname(
          decodeLaunchSecretsFrame(command.fd3Input).socketPath,
        )
        throw new Error('build-desktop: failed to write fd3 input')
      },
    }
    await expect(verifyDesktopBuild(context, fd3FailureRunner))
      .rejects.toThrow(/fd3.*write|write.*fd3/iu)
    expect(failedSocketDirectory).not.toBe('')
    expect(existsSync(failedSocketDirectory)).toBe(false)

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
