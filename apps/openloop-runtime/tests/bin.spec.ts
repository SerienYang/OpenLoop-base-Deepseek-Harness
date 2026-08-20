import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { linkSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test, vi } from 'vitest'
import {
  ensureEmptyRootConfig,
  readCoreManifest,
  runOpenloopRuntime,
  type RuntimeDependencies,
} from '../src/bin.ts'

const manifest = {
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
} as const

function temporaryDirectory(label: string): string {
  return mkdtempSync(join(tmpdir(), `openloop-runtime-${label}-`))
}

function fakeDependencies(events: string[], output: string[]): RuntimeDependencies {
  const processEvents = new EventEmitter()
  const profileDir = join(temporaryDirectory('fake'), 'profiles/openloop')
  mkdirSync(profileDir, { recursive: true })
  const services = new Map<string, unknown>()
  const loader = {
    create: async ({ name, config }: { name: string; config?: { base?: string; root?: string[] } }) => {
      if (name === '@deepseek-ai/cordis-plugin-timer') {
        events.push('loader-create:timer')
        services.set('timer', {})
      } else if (name === '@deepseek-ai/cordis-plugin-hmr') {
        if (config?.root?.length !== 0 || !config.base?.startsWith('file:')) {
          throw new Error('watch-only HMR requires the real profile base and no module roots')
        }
        events.push('loader-create:hmr')
        services.set('hmr', {})
      }
      return name
    },
  }
  const context = {
    get: (key: string) => key === 'webServer'
      ? { host: '127.0.0.1', port: 43123 }
      : key === 'loader' ? loader : services.get(key),
    provide: (key: string) => { events.push(`provide:${key}`) },
    fiber: {
      dispose: vi.fn(async () => { events.push('dispose') }),
    },
  }
  return {
    process: Object.assign(processEvents, {
      argv: ['runtime', '--health-smoke'],
      env: {},
      exit: vi.fn((code: number) => { events.push(`exit:${code}`) }),
      stdout: { write: (line: string) => { output.push(line); return true } },
      stderr: { write: vi.fn(() => true) },
    }),
    installAnchor: '/runtime/package.json',
    moduleBaseUrl: 'file:///runtime/lib/bin.js',
    coreManifestPath: '/runtime/openloop-core.json',
    loadCoreManifest: () => ({
      bytes: Buffer.from(JSON.stringify(manifest)),
      manifest,
      sha256: 'a'.repeat(64),
    }),
    ensureOpenloopProfile: () => {
      events.push('ensure-profile')
      return profileDir
    },
    healProfilesModuleFallback: () => { events.push('heal') },
    loadProfile: () => ({
      name: 'openloop',
      dir: profileDir,
      layers: [{
        packageName: '@openloop/test-bundle',
        packageDir: '/runtime/test-bundle',
        patchPath: '/runtime/test-bundle/cordis.patch.yml',
        patches: [{ insert: [{ id: 'bundle', name: 'bundle' }] }],
      }],
      patchPath: join(profileDir, 'cordis.patch.yml'),
      patches: [],
    }),
    composeEntries: () => [
      { id: 'web-startup', name: 'web-startup' },
      { id: 'webserver', name: 'webserver' },
      { id: 'web-runtime', name: 'web-runtime' },
    ],
    loadLayeredEnv: () => {
      events.push('load-env')
      return { get: () => undefined, getFrom: () => undefined }
    },
    provideCmdline: (_context, host) => {
      events.push(`cmdline:${host.args.join(' ')}`)
    },
    boot: async (_name, _root, _patches, prepare, bareModuleBaseUrl) => {
      events.push('boot')
      events.push(`boot-base:${String(bareModuleBaseUrl)}`)
      await prepare?.(context as never)
      events.push('settled')
      return context as never
    },
    watchUserPatches: async () => {
      events.push('watch')
      return async () => { events.push('stop-watch') }
    },
    healthRequest: async (origin) => {
      events.push(`health:${origin}`)
      return { status: 200, contentType: 'text/html; charset=utf-8' }
    },
    setTimeout: handler => setTimeout(handler, 0),
    clearTimeout,
  }
}

describe('Openloop runtime launcher', () => {
  test('hashes the exact validated core manifest bytes', () => {
    const root = temporaryDirectory('manifest')
    const path = join(root, 'openloop-core.json')
    const bytes = Buffer.from(` ${JSON.stringify(manifest)}\n`)
    writeFileSync(path, bytes)

    expect(readCoreManifest(path)).toEqual({
      bytes,
      manifest,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    })
  })

  test('creates and validates only a regular launcher-owned empty root config', () => {
    const root = temporaryDirectory('root')
    const path = join(root, 'cordis.yml')

    ensureEmptyRootConfig(path)
    expect(readFileSync(path, 'utf8')).toBe('[]\n')

    writeFileSync(path, 'mutated by loader\n')
    expect(() => { ensureEmptyRootConfig(path) }).toThrow(/exact empty root|unexpected content/iu)
    expect(readFileSync(path, 'utf8')).toBe('mutated by loader\n')
  })

  test('refuses to overwrite a symlink root config', () => {
    const root = temporaryDirectory('symlink')
    const target = join(root, 'target')
    const path = join(root, 'cordis.yml')
    writeFileSync(target, 'keep\n')
    symlinkSync(target, path)

    expect(() => { ensureEmptyRootConfig(path) }).toThrow(/symbolic link|regular file/iu)
    expect(readFileSync(target, 'utf8')).toBe('keep\n')
  })

  test('refuses a hardlinked root config without modifying the other link', () => {
    const root = temporaryDirectory('hardlink')
    const target = join(root, 'target')
    const path = join(root, 'cordis.yml')
    writeFileSync(target, 'keep\n')
    linkSync(target, path)

    expect(() => { ensureEmptyRootConfig(path) }).toThrow(/hardlink|link count|single link/iu)
    expect(readFileSync(target, 'utf8')).toBe('keep\n')
    expect(readFileSync(path, 'utf8')).toBe('keep\n')
  })

  test('refuses an intermediate symlink below the trusted parent', () => {
    const root = temporaryDirectory('intermediate-root')
    const outside = temporaryDirectory('intermediate-outside')
    const path = join(root, 'redirect/nested/cordis.yml')
    mkdirSync(join(outside, 'nested'), { recursive: true })
    symlinkSync(outside, join(root, 'redirect'), 'dir')

    expect(() => { ensureEmptyRootConfig(path, root) }).toThrow(/symbolic link|trusted parent|canonical/iu)
    expect(() => readFileSync(join(outside, 'nested/cordis.yml'))).toThrow()
  })

  test('publishes readiness only after settled boot, watcher setup, and HTTP health', async () => {
    const events: string[] = []
    const output: string[] = []
    const dependencies = fakeDependencies(events, output)

    await runOpenloopRuntime({ healthSmoke: true, home: '/home' }, dependencies)

    expect(events).toEqual([
      'ensure-profile',
      'heal',
      'load-env',
      'boot',
      'boot-base:file:///runtime/lib/bin.js',
      'provide:launchEnvironment',
      'cmdline:--host 127.0.0.1 --port 0',
      'settled',
      'loader-create:timer',
      'loader-create:hmr',
      'watch',
      'health:http://127.0.0.1:43123',
      'stop-watch',
      'dispose',
    ])
    expect(output).toHaveLength(1)
    expect(JSON.parse(output[0] as string)).toEqual({
      type: 'openloop.runtime.ready',
      version: 1,
      profile: 'openloop',
      host: '127.0.0.1',
      port: 43123,
      origin: 'http://127.0.0.1:43123',
      coreManifestSha256: 'a'.repeat(64),
      healthSmoke: {
        method: 'GET',
        path: '/',
        status: 200,
      },
    })
  })

  test('runs watcher and fiber teardown only once across repeated release paths', async () => {
    const events: string[] = []
    const output: string[] = []
    const dependencies = fakeDependencies(events, output)
    let failLoudRelease: (() => Promise<void> | void) | undefined
    dependencies.installFailLoud = (_name, _process, release) => {
      failLoudRelease = release
      return () => {}
    }

    await runOpenloopRuntime({ healthSmoke: true, home: '/home' }, dependencies)
    await failLoudRelease?.()

    expect(events.filter(event => event === 'stop-watch')).toHaveLength(1)
    expect(events.filter(event => event === 'dispose')).toHaveLength(1)
  })

  test('fails health smoke after one bounded teardown window when disposal hangs', async () => {
    const events: string[] = []
    const output: string[] = []
    const dependencies = fakeDependencies(events, output)
    let timeoutCount = 0
    dependencies.watchUserPatches = async () => async () => {
      events.push('stop-watch')
      await new Promise<never>(() => {})
    }
    dependencies.setTimeout = (handler) => {
      timeoutCount += 1
      return setTimeout(handler, 0)
    }

    await expect(runOpenloopRuntime({ healthSmoke: true, home: '/home' }, dependencies))
      .rejects.toThrow(/teardown.*5000/iu)

    expect(timeoutCount).toBe(1)
    expect(output).toHaveLength(1)
    expect(events).not.toContain('dispose')
  })

  test('forces a signal exit after the bounded teardown window when disposal hangs', async () => {
    const events: string[] = []
    const output: string[] = []
    const dependencies = fakeDependencies(events, output)
    dependencies.process.argv = ['runtime']
    dependencies.watchUserPatches = async () => async () => {
      events.push('stop-watch')
      await new Promise<never>(() => {})
    }

    const running = runOpenloopRuntime({ healthSmoke: false, home: '/home' }, dependencies)
    await vi.waitFor(() => { expect(output).toHaveLength(1) })
    dependencies.process.emit('SIGTERM')
    await running

    expect(events.slice(-2)).toEqual(['stop-watch', 'exit:0'])
  })

  test('fails before boot when the composed Web rows are incomplete', async () => {
    const events: string[] = []
    const output: string[] = []
    const dependencies = fakeDependencies(events, output)
    dependencies.composeEntries = () => [{ id: 'webserver', name: 'webserver' }]

    await expect(runOpenloopRuntime({ healthSmoke: true, home: '/home' }, dependencies))
      .rejects.toThrow(/web-startup.*web-runtime/isu)
    expect(events).not.toContain('boot')
    expect(output).toEqual([])
  })

  test('rejects non-HTML or non-200 health responses without readiness', async () => {
    const events: string[] = []
    const output: string[] = []
    const dependencies = fakeDependencies(events, output)
    dependencies.healthRequest = async () => ({ status: 503, contentType: 'text/plain' })

    await expect(runOpenloopRuntime({ healthSmoke: true, home: '/home' }, dependencies))
      .rejects.toThrow(/503.*text\/plain/isu)
    expect(output).toEqual([])
    expect(events.slice(-2)).toEqual(['stop-watch', 'dispose'])
  })

  test('stops the watcher before disposal on SIGINT and exits 130', async () => {
    const events: string[] = []
    const output: string[] = []
    const dependencies = fakeDependencies(events, output)
    dependencies.process.argv = ['runtime']

    const running = runOpenloopRuntime({ healthSmoke: false, home: '/home' }, dependencies)
    await vi.waitFor(() => { expect(output).toHaveLength(1) })
    dependencies.process.emit('SIGINT')
    await running

    expect(events.slice(-3)).toEqual(['stop-watch', 'dispose', 'exit:130'])
  })

  test('uses no CLI private modules, app-boot source paths, or secret flags', () => {
    const source = readFileSync(join(import.meta.dirname, '../src/bin.ts'), 'utf8')
    expect(source).not.toMatch(/apps\/cli|@deepseek-ai\/dsh-app-boot\/src/iu)
    expect(source).not.toMatch(/api[-_]?key|credential|secret/iu)
  })

  test('does not touch the real user home during tests', () => {
    const root = temporaryDirectory('home')
    const home = join(root, 'dsh-home')
    mkdirSync(home)
    expect(home).not.toBe(process.env.HOME)
  })
})
