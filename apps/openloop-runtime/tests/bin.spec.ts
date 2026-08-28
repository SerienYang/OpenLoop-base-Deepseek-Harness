import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { linkSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { composeEntries } from '@deepseek-ai/dsh-app-boot'
import type { PatchOptions } from '@deepseek-ai/cordis-plugin-include'
import { describe, expect, test, vi } from 'vitest'
import {
  ensureEmptyRootConfig,
  readCoreManifest,
  readLaunchSecretsForRuntime,
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
  const installation = temporaryDirectory('fake-installation')
  const installAnchor = join(installation, 'node_modules/@openloop/runtime/package.json')
  const presetRoot = join(
    installation,
    'node_modules/@deepseek-ai/dsh/config/agent-presets',
  )
  mkdirSync(profileDir, { recursive: true })
  mkdirSync(join(presetRoot, 'standard'), { recursive: true })
  writeFileSync(join(presetRoot, 'standard/agent.cordis.yml'), '[]\n')
  writeFileSync(
    join(installation, 'node_modules/@deepseek-ai/dsh/package.json'),
    '{"name":"@deepseek-ai/dsh"}\n',
  )
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
    provide: (key: string) => {
      events.push(`provide:${key}`)
      return () => {}
    },
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
    installAnchor,
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
      layers: [
        {
          packageName: '@deepseek-ai/dsh-base',
          packageDir: '/runtime/dsh-base',
          patchPath: '/runtime/dsh-base/cordis.patch.yml',
          patches: [{
            insert: [
              { id: 'bundle', name: 'bundle', config: { original: true } },
              { id: 'web-startup', name: 'web-startup' },
              { id: 'webserver', name: 'webserver' },
              { id: 'web-runtime', name: 'web-runtime' },
              {
                id: 'connection',
                name: '@deepseek-ai/dsh-client-connection',
                inject: ['webRuntime', 'browserApiPolicy'],
              },
              {
                id: 'typert-gateway',
                name: '@deepseek-ai/dsh-api-gateway',
                inject: ['browserApiPolicy'],
              },
              {
                id: 'cordis-client-runner',
                name: '@deepseek-ai/dsh-cordis-client-runner',
                disabled: true,
              },
              {
                id: 'ui-cordis',
                name: '@deepseek-ai/dsh-client-ui-cordis',
                disabled: true,
              },
              {
                id: 'fs-sandbox',
                name: '@deepseek-ai/dsh-fs-sandbox',
                disabled: true,
              },
              {
                id: 'subprocess',
                name: '@deepseek-ai/dsh-subprocess-local',
                disabled: true,
              },
              {
                id: 'code-runtime',
                name: '@deepseek-ai/dsh-code-runtime-worker-thread',
                disabled: true,
              },
              {
                id: 'bash-sandbox',
                name: '@deepseek-ai/dsh-bash-sandbox',
                disabled: true,
              },
              {
                id: 'pwsh-sandbox',
                name: '@deepseek-ai/dsh-pwsh-sandbox',
                disabled: true,
              },
              {
                id: 'tool-bash',
                name: '@deepseek-ai/dsh-tool-bash',
                disabled: true,
              },
              {
                id: 'tool-pwsh',
                name: '@deepseek-ai/dsh-tool-pwsh',
                disabled: true,
              },
              {
                id: 'tool-fs-search',
                name: '@deepseek-ai/dsh-tool-fs-search',
                disabled: true,
              },
              {
                id: 'agent-presets',
                name: '@deepseek-ai/dsh-agent-presets',
                config: {
                  default: 'standard',
                  allowedPresetIds: ['standard', 'code'],
                  includeUserRoot: false,
                  patches: [],
                },
              },
            ],
          }],
        },
        {
          packageName: '@deepseek-ai/dsh-web-app',
          packageDir: '/runtime/dsh-web-app',
          patchPath: '/runtime/dsh-web-app/cordis.patch.yml',
          patches: [],
        },
        {
          packageName: '@openloop/bundle',
          packageDir: '/runtime/openloop-bundle',
          patchPath: '/runtime/openloop-bundle/cordis.patch.yml',
          patches: [{
            insert: [
              {
                id: 'desktop-bridge-host',
                name: '@openloop/desktop-bridge-host',
                inject: ['runtimeBootstrap'],
              },
              {
                id: 'openloop-bootstrap',
                name: '@openloop/bundle/bootstrap-host',
                inject: ['webServer', 'runtimeBootstrap'],
              },
              {
                id: 'fs-workspace',
                name: '@openloop/fs-workspace',
                inject: ['fileBroker', 'workspaceRegistry', 'sandboxPolicy'],
              },
              {
                id: 'sandbox-workspace',
                name: '@openloop/sandbox-workspace',
              },
            ],
          }],
        },
      ],
      patchPath: join(profileDir, 'cordis.patch.yml'),
      patches: [],
    }),
    composeEntries,
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
    candidateHealthRequest: async (origin, launchId) => {
      events.push(`candidate-health:${origin}:${launchId}`)
      return {
        webAsset: true,
        bootstrapExchange: true,
      }
    },
    setTimeout: handler => setTimeout(handler, 0),
    clearTimeout,
  }
}

const MALICIOUS_USER_PATCHES: ReadonlyArray<readonly [string, PatchOptions[]]> = [
  ['disable the policy owner', [{ id: 'desktop-bridge-host', disabled: true }]],
  ['remove the Connection policy injection', [{ id: 'connection', inject: [] }]],
  ['rename a signed row', [{ id: 'web-runtime', name: '@attacker/replacement' }]],
  ['insert a third-party Client row', [{
    insert: [{ id: 'third-party-client', name: '@attacker/client' }],
  }]],
  ['re-enable the dynamic Client runner', [{ id: 'cordis-client-runner', disabled: false }]],
  ['re-enable the code runtime', [{ id: 'code-runtime', disabled: false }]],
  ['re-enable the subprocess provider', [{ id: 'subprocess', disabled: false }]],
  ['replace the locked preset policy', [{
    id: 'agent-presets',
    config: {
      default: 'cordis',
      includeUserRoot: true,
      patches: [],
      roots: [{ path: '/tmp/attacker-presets', trust: 'user' }],
    },
  }]],
  ['target an unknown row', [{ id: 'not-in-signed-profile', config: { enabled: true } }]],
  ['change config on a protected row', [{ id: 'connection', config: { trustedHosts: ['attacker'] } }]],
]

describe('Openloop runtime launcher', () => {
  test('requires inherited launch secrets for supervised health smoke', () => {
    const secrets = {
      launchId: '8f5d7e17-9b2b-4b2c-9c2a-1f3e6b2a4d90',
      bootstrapToken: Uint8Array.from([1, 2, 3]),
      bridgeSecret: Uint8Array.from([4, 5, 6]),
      socketPath: '/tmp/openloop-runtime.sock',
    }
    const read = vi.fn(() => secrets)

    expect(readLaunchSecretsForRuntime({ healthSmoke: true }, read)).toBe(secrets)
    expect(read).toHaveBeenCalledOnce()
  })

  test('reads inherited launch secrets for a supervised runtime', () => {
    const secrets = {
      launchId: '8f5d7e17-9b2b-4b2c-9c2a-1f3e6b2a4d90',
      bootstrapToken: Uint8Array.from([1, 2, 3]),
      bridgeSecret: Uint8Array.from([4, 5, 6]),
      socketPath: '/tmp/openloop-runtime.sock',
    }
    const read = vi.fn(() => secrets)

    expect(readLaunchSecretsForRuntime({ healthSmoke: false }, read)).toBe(secrets)
    expect(read).toHaveBeenCalledOnce()
  })

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

    await runOpenloopRuntime({ healthSmoke: true, home: '/home' }, dependencies, {
      launchId: '8f5d7e17-9b2b-4b2c-9c2a-1f3e6b2a4d90',
      bootstrapToken: Uint8Array.from([1, 2, 3]),
      bridgeSecret: Uint8Array.from([4, 5, 6]),
      socketPath: '/tmp/openloop-runtime.sock',
    })

    expect(events).toEqual([
      'ensure-profile',
      'heal',
      'load-env',
      'boot',
      'boot-base:file:///runtime/lib/bin.js',
      'provide:runtimeBootstrap',
      'provide:launchEnvironment',
      'cmdline:--host 127.0.0.1 --port 0',
      'settled',
      'loader-create:timer',
      'loader-create:hmr',
      'watch',
      'health:http://127.0.0.1:43123',
      'candidate-health:http://127.0.0.1:43123:8f5d7e17-9b2b-4b2c-9c2a-1f3e6b2a4d90',
      'stop-watch',
      'dispose',
    ])
    expect(output).toHaveLength(1)
    expect(JSON.parse(output[0] as string)).toEqual({
      type: 'openloop.runtime.ready',
      version: 1,
      launchId: '8f5d7e17-9b2b-4b2c-9c2a-1f3e6b2a4d90',
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
      candidateHealth: {
        webAsset: true,
        bootstrapExchange: true,
      },
    })
  })

  test('pins the shipped agent preset root for boot and live profile recomposition', async () => {
    const events: string[] = []
    const output: string[] = []
    const dependencies = fakeDependencies(events, output)
    const installation = temporaryDirectory('preset-installation')
    const installAnchor = join(installation, 'node_modules/@openloop/runtime/package.json')
    const presetRoot = join(
      installation,
      'node_modules/@deepseek-ai/dsh/config/agent-presets',
    )
    mkdirSync(join(presetRoot, 'standard'), { recursive: true })
    writeFileSync(join(presetRoot, 'standard/agent.cordis.yml'), '[]\n')
    writeFileSync(
      join(installation, 'node_modules/@deepseek-ai/dsh/package.json'),
      '{"name":"@deepseek-ai/dsh"}\n',
    )
    dependencies.installAnchor = installAnchor

    let bootPatches: unknown[] = []
    const boot = dependencies.boot.bind(dependencies)
    dependencies.boot = async (binName, rootConfig, patches, prepare, bareModuleBaseUrl) => {
      bootPatches = patches ?? []
      return await boot(binName, rootConfig, patches, prepare, bareModuleBaseUrl)
    }
    let livePatches: unknown[] = []
    dependencies.watchUserPatches = async (_ctx, options) => {
      livePatches = options.compose?.([
        { id: 'bundle', config: { hmr: true } },
      ]) ?? []
      return async () => {}
    }

    await runOpenloopRuntime({ healthSmoke: true, home: '/home' }, dependencies, {
      launchId: '8f5d7e17-9b2b-4b2c-9c2a-1f3e6b2a4d90',
      bootstrapToken: Uint8Array.from([1, 2, 3]),
      bridgeSecret: Uint8Array.from([4, 5, 6]),
      socketPath: '/tmp/openloop-runtime.sock',
    })

    expect(bootPatches.at(-1)).toEqual({
      id: 'agent-presets',
      config: {
        default: 'standard',
        allowedPresetIds: ['standard', 'code'],
        includeUserRoot: false,
        patches: [
          { id: 'tool-bash', disabled: true },
          { id: 'tool-pwsh', disabled: true },
          { id: 'tool-fs-search', disabled: true },
          { id: 'pty', disabled: true },
          { id: 'terminal-bash', disabled: true },
          { id: 'persistent-bash', disabled: true },
          { id: 'terminal', disabled: true },
          { id: 'tool-terminal', disabled: true },
          { id: 'lsp-stdio', disabled: true },
          { id: 'tool-lsp', disabled: true },
          { id: 'mcp-stdio', disabled: true },
          { id: 'subagent-acp', disabled: true },
          { id: 'subagent-codex', disabled: true },
          { id: 'subagent-claude-code', disabled: true },
          { id: 'subagent-dsh-sdk', disabled: true },
          { id: 'tool-subagent-codex', disabled: true },
          { id: 'tool-subagent-claude-code', disabled: true },
          { id: 'tool-presentation', disabled: true },
          { id: 'tool-cordis', disabled: true },
          { id: 'filesystem', isolate: null },
          { id: 'fs-local', disabled: true },
        ],
        roots: [{ path: presetRoot, trust: 'system' }],
      },
    })
    expect(livePatches.at(-1)).toEqual({
      id: 'agent-presets',
      config: {
        default: 'standard',
        allowedPresetIds: ['standard', 'code'],
        includeUserRoot: false,
        patches: [
          { id: 'tool-bash', disabled: true },
          { id: 'tool-pwsh', disabled: true },
          { id: 'tool-fs-search', disabled: true },
          { id: 'pty', disabled: true },
          { id: 'terminal-bash', disabled: true },
          { id: 'persistent-bash', disabled: true },
          { id: 'terminal', disabled: true },
          { id: 'tool-terminal', disabled: true },
          { id: 'lsp-stdio', disabled: true },
          { id: 'tool-lsp', disabled: true },
          { id: 'mcp-stdio', disabled: true },
          { id: 'subagent-acp', disabled: true },
          { id: 'subagent-codex', disabled: true },
          { id: 'subagent-claude-code', disabled: true },
          { id: 'subagent-dsh-sdk', disabled: true },
          { id: 'tool-subagent-codex', disabled: true },
          { id: 'tool-subagent-claude-code', disabled: true },
          { id: 'tool-presentation', disabled: true },
          { id: 'tool-cordis', disabled: true },
          { id: 'filesystem', isolate: null },
          { id: 'fs-local', disabled: true },
        ],
        roots: [{ path: presetRoot, trust: 'system' }],
      },
    })
  })

  test.each(MALICIOUS_USER_PATCHES)(
    'rejects an initial user patch that attempts to %s',
    async (_label, userPatches) => {
      const events: string[] = []
      const output: string[] = []
      const dependencies = fakeDependencies(events, output)
      const loadProfile = dependencies.loadProfile.bind(dependencies)
      dependencies.loadProfile = (...args) => ({
        ...loadProfile(...args),
        patches: structuredClone(userPatches),
      })

      await expect(runOpenloopRuntime({ healthSmoke: true, home: '/home' }, dependencies))
        .rejects.toThrow(/user patch|protected|signed|topology|unknown/iu)
      expect(events).not.toContain('boot')
      expect(output).toEqual([])
    },
  )

  test('rejects user-selected bundle layers instead of trusting them as the signed baseline', async () => {
    const events: string[] = []
    const output: string[] = []
    const dependencies = fakeDependencies(events, output)
    const loadProfile = dependencies.loadProfile.bind(dependencies)
    dependencies.loadProfile = (...args) => {
      const profile = loadProfile(...args)
      return {
        ...profile,
        layers: [{
          packageName: '@attacker/bundle',
          packageDir: '/profile/node_modules/@attacker/bundle',
          patchPath: '/profile/node_modules/@attacker/bundle/cordis.patch.yml',
          patches: profile.layers.flatMap(layer => layer.patches),
        }],
      }
    }

    await expect(runOpenloopRuntime({ healthSmoke: true, home: '/home' }, dependencies))
      .rejects.toThrow(/signed bundle|bundle layers/iu)
    expect(events).not.toContain('boot')
  })

  test.each(MALICIOUS_USER_PATCHES)(
    'fails the runtime closed when an HMR user patch attempts to %s',
    async (_label, userPatches) => {
      const events: string[] = []
      const output: string[] = []
      const dependencies = fakeDependencies(events, output)
      dependencies.process.argv = ['runtime']
      let compose: ((patches: PatchOptions[]) => PatchOptions[]) | undefined
      dependencies.watchUserPatches = async (_ctx, options) => {
        compose = options.compose
        return async () => { events.push('stop-watch') }
      }

      const running = runOpenloopRuntime({ healthSmoke: false, home: '/home' }, dependencies)
      await vi.waitFor(() => {
        expect(output).toHaveLength(1)
        expect(compose).toBeTypeOf('function')
      })
      let failure: unknown
      try {
        compose?.(structuredClone(userPatches))
      } catch (error) {
        failure = error
      }
      if (failure === undefined) dependencies.process.emit('SIGTERM')
      await running

      expect(failure).toBeInstanceOf(Error)
      expect((failure as Error).message).toMatch(/user patch|protected|signed|topology|unknown/iu)
      expect(events).toContain('stop-watch')
      expect(events).toContain('dispose')
      expect(events).toContain('exit:1')
    },
  )

  test('allows initial and HMR config patches for an existing non-protected signed row', async () => {
    const events: string[] = []
    const output: string[] = []
    const dependencies = fakeDependencies(events, output)
    const loadProfile = dependencies.loadProfile.bind(dependencies)
    dependencies.loadProfile = (...args) => ({
      ...loadProfile(...args),
      patches: [{ id: 'bundle', config: { initial: true } }],
    })
    let hmrRows: ReturnType<typeof composeEntries> = []
    dependencies.watchUserPatches = async (_ctx, options) => {
      hmrRows = composeEntries([options.compose?.([
        { id: 'bundle', config: { hmr: true } },
      ]) ?? []])
      return async () => {}
    }
    let bootRows: ReturnType<typeof composeEntries> = []
    const boot = dependencies.boot.bind(dependencies)
    dependencies.boot = async (binName, rootConfig, patches, prepare, bareModuleBaseUrl) => {
      bootRows = composeEntries([patches ?? []])
      return await boot(binName, rootConfig, patches, prepare, bareModuleBaseUrl)
    }

    await runOpenloopRuntime({ healthSmoke: true, home: '/home' }, dependencies, {
      launchId: '8f5d7e17-9b2b-4b2c-9c2a-1f3e6b2a4d90',
      bootstrapToken: Uint8Array.from([1, 2, 3]),
      bridgeSecret: Uint8Array.from([4, 5, 6]),
      socketPath: '/tmp/openloop-runtime.sock',
    })

    expect(bootRows.find(row => row.id === 'bundle')?.config).toEqual({ initial: true })
    expect(hmrRows.find(row => row.id === 'bundle')?.config).toEqual({ hmr: true })
  })

  test('includes the Host bootstrap patch in supervised health smoke', async () => {
    const events: string[] = []
    const output: string[] = []
    const dependencies = fakeDependencies(events, output)
    let bootPatches: PatchOptions[] = []
    const boot = dependencies.boot.bind(dependencies)
    dependencies.boot = async (binName, rootConfig, patches, prepare, bareModuleBaseUrl) => {
      bootPatches = patches ?? []
      return await boot(binName, rootConfig, patches, prepare, bareModuleBaseUrl)
    }

    await runOpenloopRuntime({ healthSmoke: true, home: '/home' }, dependencies, {
      launchId: '8f5d7e17-9b2b-4b2c-9c2a-1f3e6b2a4d90',
      bootstrapToken: Uint8Array.from([1, 2, 3]),
      bridgeSecret: Uint8Array.from([4, 5, 6]),
      socketPath: '/tmp/openloop-runtime.sock',
    })

    expect(bootPatches.some(patch =>
      patch.insert?.some(entry => entry.id === 'openloop-bootstrap') === true,
    )).toBe(true)
  })

  test('zeroizes parsed launch secret bytes after Host bootstrap installation', async () => {
    const events: string[] = []
    const output: string[] = []
    const dependencies = fakeDependencies(events, output)
    const secrets = {
      launchId: '8f5d7e17-9b2b-4b2c-9c2a-1f3e6b2a4d90',
      bootstrapToken: Uint8Array.from([1, 2, 3]),
      bridgeSecret: Uint8Array.from([4, 5, 6]),
      socketPath: '/tmp/openloop-runtime.sock',
    }

    await runOpenloopRuntime({ healthSmoke: true, home: '/home' }, dependencies, secrets)

    expect(secrets.bootstrapToken).toEqual(Uint8Array.from([0, 0, 0]))
    expect(secrets.bridgeSecret).toEqual(Uint8Array.from([0, 0, 0]))
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
      .rejects.toThrow(/missing required row.*web-startup/isu)
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
    const argumentSurface = source
      .split('\n')
      .filter(line => /argv|parseRuntimeArgs|health-smoke/iu.test(line))
      .join('\n')
    expect(argumentSurface).not.toMatch(/api[-_]?key|credential|secret/iu)
  })

  test('does not touch the real user home during tests', () => {
    const root = temporaryDirectory('home')
    const home = join(root, 'dsh-home')
    mkdirSync(home)
    expect(home).not.toBe(process.env.HOME)
  })
})
