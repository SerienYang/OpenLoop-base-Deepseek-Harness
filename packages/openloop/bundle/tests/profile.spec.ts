import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { composeEntries } from '@deepseek-ai/dsh-app-boot'
import { entryListSchema } from '@deepseek-ai/cordis-plugin-include'
import type { PatchOptions } from '@deepseek-ai/cordis-plugin-include'
import { WorkspaceTypertGenerator } from '@deepseek-ai/dsh-typert-generator'
import {
  createBrowserApiPolicy,
} from '@openloop/desktop-bridge-host'
import * as yaml from 'js-yaml'
import { describe, expect, it } from 'vitest'
import {
  ensureOpenloopProfile,
  OPENLOOP_PROFILE_BUNDLES,
} from '../src/index.ts'

interface BundleManifest {
  readonly name?: string
  readonly private?: boolean
  readonly openloop?: { readonly face?: string }
  readonly dependencies?: Readonly<Record<string, string>>
  readonly peerDependencies?: Readonly<Record<string, string>>
  readonly devDependencies?: Readonly<Record<string, string>>
  readonly exports?: Readonly<Record<string, unknown>>
  readonly files?: readonly string[]
  readonly dsh?: { readonly bundle?: { readonly patch?: string } }
}

interface ClientPackageManifest {
  readonly name?: string
  readonly dsh?: {
    readonly client?: {
      readonly inject?: readonly string[]
      readonly platform?: string
    }
  }
}

interface RemoteContribution {
  readonly descriptors: readonly {
    readonly namespace: string
    readonly method: string
  }[]
}

const tmp = (): string => mkdtempSync(join(tmpdir(), 'openloop-profile-'))
const repositoryRoot = resolve(import.meta.dirname, '../../../..')
let dynamicCordisEndpointPromise: Promise<readonly string[]> | undefined

function openloopEntries() {
  const require = createRequire(import.meta.url)
  const layers = OPENLOOP_PROFILE_BUNDLES.map((packageName) => {
    const manifestPath = require.resolve(`${packageName}/package.json`)
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as BundleManifest
    const patchPath = join(manifestPath, '..', manifest.dsh!.bundle!.patch!)
    return yaml.load(readFileSync(patchPath, 'utf8'), {
      schema: entryListSchema,
    }) as PatchOptions[]
  })
  return composeEntries(layers)
}

function enabledClientPackages(): ReadonlySet<string> {
  const require = createRequire(import.meta.url)
  const packages = new Set<string>()
  for (const entry of openloopEntries()) {
    if (entry.disabled === true || typeof entry.name !== 'string') continue
    let manifestPath: string
    try {
      manifestPath = require.resolve(`${entry.name}/package.json`)
    } catch {
      continue
    }
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as ClientPackageManifest
    if (manifest.dsh?.client?.platform === 'web' && manifest.name !== undefined) {
      packages.add(manifest.name)
    }
  }
  return packages
}

async function dynamicCordisEndpoints(): Promise<readonly string[]> {
  dynamicCordisEndpointPromise ??= (async () => {
    const artifact = new WorkspaceTypertGenerator(repositoryRoot)
      .generate(['@deepseek-ai/dsh-cordis-host-runner'], ['host'])
      .find(candidate => candidate.package === '@deepseek-ai/dsh-cordis-host-runner')
    if (artifact?.remote === undefined) {
      throw new Error('Dynamic Cordis Host source generated no Remote descriptor')
    }
    const executable = artifact.remote.js.replace(
      "from 'zod'",
      `from ${JSON.stringify(import.meta.resolve('zod'))}`,
    )
    const loaded = await import(`data:text/javascript,${encodeURIComponent(executable)}`) as {
      default: RemoteContribution
    }
    return loaded.default.descriptors
      .map(({ namespace, method }) => `${namespace}/${method}`)
  })()
  return dynamicCordisEndpointPromise
}

describe('OpenLoop profile', () => {
  it('uses the exact base, Web, and OpenLoop bundle order', () => {
    expect(OPENLOOP_PROFILE_BUNDLES).toEqual([
      '@deepseek-ai/dsh-base',
      '@deepseek-ai/dsh-web-app',
      '@openloop/bundle',
    ])
  })

  it('composes a quiet Web runtime without dropping its surface or trust config', () => {
    const require = createRequire(import.meta.url)
    const layers = OPENLOOP_PROFILE_BUNDLES.map((packageName) => {
      const manifestPath = require.resolve(`${packageName}/package.json`)
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as BundleManifest
      const patchPath = join(manifestPath, '..', manifest.dsh!.bundle!.patch!)
      return yaml.load(readFileSync(patchPath, 'utf8'), {
        schema: entryListSchema,
      }) as PatchOptions[]
    })

    const webRuntime = composeEntries(layers).find(entry => entry.id === 'web-runtime')

    expect(webRuntime?.config).toEqual({
      printUrl: false,
      surfaceContext: true,
      trustedHosts: { __jsExpr: 'ctx.webStartup.trustedHosts' },
    })
  })

  it('inserts the Host bootstrap entry into the composed runtime profile', () => {
    const require = createRequire(import.meta.url)
    const manifestPath = require.resolve('@openloop/bundle/package.json')
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as BundleManifest
    const patchPath = join(manifestPath, '..', manifest.dsh!.bundle!.patch!)
    const patch = yaml.load(readFileSync(patchPath, 'utf8'), {
      schema: entryListSchema,
    }) as PatchOptions[]

    expect(composeEntries([patch]).find(entry => entry.id === 'openloop-bootstrap')).toEqual({
      id: 'openloop-bootstrap',
      name: '@openloop/bundle/bootstrap-host',
      inject: ['credentials', 'desktopBridge', 'webServer', 'runtimeBootstrap'],
    })
  })

  it('mounts one policy owner and makes both browser API dispatchers require it', () => {
    const entries = openloopEntries()
    expect(entries.find(entry => entry.id === 'desktop-bridge-host')).toEqual({
      id: 'desktop-bridge-host',
      name: '@openloop/desktop-bridge-host',
      inject: ['runtimeBootstrap'],
    })
    expect(entries.find(entry => entry.id === 'connection')?.inject)
      .toEqual(['webRuntime', 'browserApiPolicy'])
    expect(entries.find(entry => entry.id === 'typert-gateway')?.inject)
      .toEqual(['browserApiPolicy'])
    expect(entries.find(entry => entry.id === 'file-broker')).toEqual({
      id: 'file-broker',
      name: '@openloop/file-broker',
      inject: ['desktopBridge'],
    })
    expect(entries.find(entry => entry.id === 'session-log-download')).toMatchObject({
      id: 'session-log-download',
      name: '@deepseek-ai/dsh-session-log-export',
      disabled: true,
    })
  })

  it('selects the path-free Workspace adapter before the shared client runtime starts', () => {
    const require = createRequire(import.meta.url)
    const entries = openloopEntries()

    expect(entries.find(entry => entry.id === 'desktop-bridge-client')).toEqual({
      id: 'desktop-bridge-client',
      name: '@openloop/desktop-bridge-client',
    })
    expect(entries.find(entry => entry.id === 'client-runtime')).toEqual({
      id: 'client-runtime',
      name: '@deepseek-ai/dsh-client-runtime',
    })
    const clientManifest = JSON.parse(readFileSync(
      require.resolve('@openloop/desktop-bridge-client/package.json'),
      'utf8',
    )) as ClientPackageManifest
    expect(clientManifest.dsh?.client?.inject)
      .toEqual(['@deepseek-ai/dsh-api-gateway'])
  })

  it('replaces only the Openloop filesystem provider and removes process-backed search', () => {
    const entries = openloopEntries()

    expect(entries.find(entry => entry.id === 'fs-sandbox')).toMatchObject({
      id: 'fs-sandbox',
      name: '@deepseek-ai/dsh-fs-sandbox',
      disabled: true,
    })
    expect(entries.find(entry => entry.id === 'fs-workspace')).toEqual({
      id: 'fs-workspace',
      name: '@openloop/fs-workspace',
      inject: ['fileBroker', 'workspaceRegistry', 'sandboxPolicy'],
    })
    expect(entries.find(entry => entry.id === 'tool-fs-search')).toMatchObject({
      id: 'tool-fs-search',
      name: '@deepseek-ai/dsh-tool-fs-search',
      disabled: true,
    })
    expect(entries.find(entry => entry.id === 'agent-presets')?.config).toMatchObject({
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
        { id: 'workflow-worker-thread', disabled: true },
        { id: 'tool-workflow', disabled: true },
        { id: 'tool-ralph', disabled: true },
        { id: 'tool-cordis', disabled: true },
        { id: 'filesystem', isolate: null },
        { id: 'fs-local', disabled: true },
      ],
    })
  })

  it('makes every signed Host process capability unreachable', () => {
    const entries = openloopEntries()
    const disabled = [
      ['code-runtime', '@deepseek-ai/dsh-code-runtime-worker-thread'],
      ['subprocess', '@deepseek-ai/dsh-subprocess-local'],
      ['bash-sandbox', '@deepseek-ai/dsh-bash-sandbox'],
      ['pwsh-sandbox', '@deepseek-ai/dsh-pwsh-sandbox'],
      ['tool-bash', '@deepseek-ai/dsh-tool-bash'],
      ['tool-pwsh', '@deepseek-ai/dsh-tool-pwsh'],
      ['tool-fs-search', '@deepseek-ai/dsh-tool-fs-search'],
      ['workflow-worker-thread', '@deepseek-ai/dsh-workflow-worker-thread'],
      ['tool-workflow', '@deepseek-ai/dsh-tool-workflow'],
      ['tool-ralph', '@deepseek-ai/dsh-tool-ralph'],
    ] as const

    for (const [id, name] of disabled) {
      expect(entries.find(entry => entry.id === id)).toMatchObject({
        id,
        name,
        disabled: true,
      })
    }
    expect(entries.find(entry => entry.id === 'sandbox-workspace')).toEqual({
      id: 'sandbox-workspace',
      name: '@openloop/sandbox-workspace',
    })
    for (const id of [
      'terminal',
      'tool-terminal',
      'lsp-stdio',
      'tool-lsp',
      'mcp-stdio',
      'subagent-acp',
      'subagent-codex',
      'subagent-claude-code',
      'subagent-dsh-sdk',
    ]) {
      expect(entries.find(entry => entry.id === id)).toBeUndefined()
    }
  })

  it('replaces only the Openloop credential provider and wires built-in consumers to its registry', () => {
    const entries = openloopEntries()

    expect(entries.find(entry => entry.id === 'credentials')).toMatchObject({
      id: 'credentials',
      name: '@deepseek-ai/dsh-credentials-local',
      disabled: true,
    })
    expect(entries.find(entry => entry.id === 'credentials-keychain')).toEqual({
      id: 'credentials-keychain',
      name: '@openloop/credentials-keychain',
      inject: ['desktopBridge'],
    })
    expect(entries.find(entry => entry.id === 'llm-deepseek')?.inject)
      .toContain('credentialConsumers')
    expect(entries.find(entry => entry.id === 'llm-pi-ai')?.inject)
      .toContain('credentialConsumers')
    expect(entries.find(entry => entry.id === 'web-search-deepseek')?.inject)
      .toContain('credentialConsumers')
  })

  it('disables legacy Client rows whose calls are intentionally absent from the first policy', () => {
    const entries = openloopEntries()
    const disabled = [
      ['cordis-client-runner', '@deepseek-ai/dsh-cordis-client-runner'],
      ['ui-cordis', '@deepseek-ai/dsh-client-ui-cordis'],
      ['ui-workspace', '@deepseek-ai/dsh-client-ui-workspace'],
      ['ui-settings', '@deepseek-ai/dsh-client-ui-settings'],
      ['ui-settings-general', '@deepseek-ai/dsh-client-ui-settings-general'],
      ['ui-settings-models', '@deepseek-ai/dsh-client-ui-settings-models'],
      ['ui-settings-plugin-inventory', '@deepseek-ai/dsh-client-ui-settings-plugin-inventory'],
      ['ui-settings-plugins', '@deepseek-ai/dsh-client-ui-settings-plugins'],
      ['ui-permission', '@deepseek-ai/dsh-client-ui-permission-presets'],
      ['ui-agent-preset', '@deepseek-ai/dsh-client-ui-agent-preset'],
    ] as const

    for (const [id, name] of disabled) {
      expect(entries.find(entry => entry.id === id)).toMatchObject({
        id,
        name,
        disabled: true,
      })
    }
    for (const [, name] of disabled) {
      expect(enabledClientPackages()).not.toContain(name)
    }
  })

  it('enables the Openloop Workspace client while legacy Workspace and Settings rows stay disabled', () => {
    const entries = openloopEntries()

    expect(entries.find(entry => entry.id === 'openloop-settings-scope')).toBeUndefined()
    expect(entries.find(entry => entry.id === 'openloop-settings-foundation')).toEqual({
      id: 'openloop-settings-foundation',
      name: '@openloop/settings-foundation',
    })
    expect(entries.find(entry => entry.id === 'openloop-workspace-client')).toEqual({
      id: 'openloop-workspace-client',
      name: '@openloop/workspace-client',
    })
    expect(enabledClientPackages()).not.toContain('@deepseek-ai/dsh-client-ui-settings')
    expect(enabledClientPackages()).toContain('@openloop/settings-foundation')
    expect(enabledClientPackages()).toContain('@openloop/workspace-client')
    for (const id of [
      'ui-workspace',
      'ui-settings',
      'ui-settings-general',
      'ui-settings-models',
      'ui-settings-plugin-inventory',
      'ui-settings-plugins',
    ]) {
      expect(entries.find(entry => entry.id === id)?.disabled).toBe(true)
    }
  })

  it('replaces the DSH root owner with exactly one Openloop shell in this profile', () => {
    const entries = openloopEntries()
    expect(entries.find(entry => entry.id === 'ui-layout')).toMatchObject({
      id: 'ui-layout',
      name: '@deepseek-ai/dsh-client-ui-layout',
      disabled: true,
    })
    expect(entries.filter(entry => entry.name === '@openloop/shell')).toEqual([{
      id: 'shell',
      name: '@openloop/shell',
    }])
    expect(enabledClientPackages()).not.toContain('@deepseek-ai/dsh-client-ui-layout')
    expect(enabledClientPackages()).toContain('@openloop/shell')
  })

  it('denies every Dynamic Cordis browser endpoint while its Client plugins are disabled', async () => {
    const policy = createBrowserApiPolicy(JSON.parse(
      readFileSync(
        new URL('../../desktop-bridge-host/openloop-browser-api.json', import.meta.url),
        'utf8',
      ),
    ) as unknown)
    const endpoints = await dynamicCordisEndpoints()

    expect(endpoints.length).toBeGreaterThan(0)
    for (const endpoint of endpoints) {
      expect([endpoint, policy.allows(endpoint, {})]).toEqual([endpoint, false])
    }
  }, 60_000)

  it('keeps every Dynamic Cordis lifecycle call allowed or all of its Client callers disabled', async () => {
    const policy = createBrowserApiPolicy(JSON.parse(
      readFileSync(
        new URL('../../desktop-bridge-host/openloop-browser-api.json', import.meta.url),
        'utf8',
      ),
    ) as unknown)
    const active = enabledClientPackages()
    const owners = [
      '@deepseek-ai/dsh-cordis-client-runner',
      '@deepseek-ai/dsh-client-ui-cordis',
    ]

    for (const endpoint of await dynamicCordisEndpoints()) {
      const allowed = policy.allows(endpoint, {})
      const allOwnersDisabled = owners.every(owner => !active.has(owner))
      expect(allowed || allOwnersDisabled, endpoint).toBe(true)
    }
  })

  it('leaves the default DSH Web bundle without an OpenLoop browser policy', () => {
    const require = createRequire(import.meta.url)
    const layers = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'].map((packageName) => {
      const manifestPath = require.resolve(`${packageName}/package.json`)
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as BundleManifest
      const patchPath = join(manifestPath, '..', manifest.dsh!.bundle!.patch!)
      return yaml.load(readFileSync(patchPath, 'utf8'), {
        schema: entryListSchema,
      }) as PatchOptions[]
    })

    const entries = composeEntries(layers)
    expect(entries.find(entry => entry.id === 'desktop-bridge-host')).toBeUndefined()
    expect(entries.find(entry => entry.id === 'connection')?.inject).toEqual(['webRuntime'])
    expect(entries.find(entry => entry.id === 'typert-gateway')?.inject).toBeUndefined()
    expect(entries.find(entry => entry.id === 'session-log-download')?.disabled).not.toBe(true)
    expect(entries.find(entry => entry.id === 'credentials')?.name)
      .toBe('@deepseek-ai/dsh-credentials-local')
    const defaultFs = entries.find(entry => entry.id === 'fs-sandbox')
    expect(defaultFs?.name).toBe('@deepseek-ai/dsh-fs-sandbox')
    expect(defaultFs).not.toHaveProperty('disabled')
    expect(entries.find(entry => entry.id === 'fs-workspace')).toBeUndefined()
    const defaultSearch = entries.find(entry => entry.id === 'tool-fs-search')
    expect(defaultSearch?.name).toBe('@deepseek-ai/dsh-tool-fs-search')
    expect(defaultSearch?.disabled).toBe(true)
    expect(entries.find(entry => entry.id === 'code-runtime')).toMatchObject({
      id: 'code-runtime',
      name: '@deepseek-ai/dsh-code-runtime-worker-thread',
    })
    expect(entries.find(entry => entry.id === 'code-runtime')?.disabled).not.toBe(true)
    expect(entries.find(entry => entry.id === 'subprocess')).toMatchObject({
      id: 'subprocess',
      name: '@deepseek-ai/dsh-subprocess-local',
    })
    expect(entries.find(entry => entry.id === 'subprocess')?.disabled).not.toBe(true)
    expect(entries.find(entry => entry.id === 'bash-sandbox')).toMatchObject({
      id: 'bash-sandbox',
      name: '@deepseek-ai/dsh-bash-sandbox',
    })
    expect(entries.find(entry => entry.id === 'bash-sandbox')?.disabled).not.toBe(true)
    expect(entries.find(entry => entry.id === 'sandbox-workspace')).toBeUndefined()
  })

  it('initializes the OpenLoop profile once with the official bundle order', () => {
    const home = tmp()

    const dir = ensureOpenloopProfile(home)

    expect(dir).toBe(join(home, 'profiles', 'openloop'))
    expect(JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))).toEqual({
      name: 'dsh-profile-openloop',
      private: true,
      dependencies: {},
      dsh: {
        profile: {
          bundles: [...OPENLOOP_PROFILE_BUNDLES],
        },
      },
    })
    expect(existsSync(join(dir, 'cordis.patch.yml'))).toBe(true)
    expect(existsSync(join(dir, 'pnpm-workspace.yaml'))).toBe(true)
  })

  it('keeps every existing user profile byte unchanged', () => {
    const home = tmp()
    const dir = join(home, 'profiles', 'openloop')
    mkdirSync(dir, { recursive: true })
    const manifest = '{\n  "name": "custom-openloop-profile",\n  "custom": true\n}\n'
    const patch = '- id: user-owned\n  disabled: true\n'
    const workspace = 'packages: []\n# user-owned\n'
    writeFileSync(join(dir, 'package.json'), manifest)
    writeFileSync(join(dir, 'cordis.patch.yml'), patch)
    writeFileSync(join(dir, 'pnpm-workspace.yaml'), workspace)

    expect(ensureOpenloopProfile(home)).toBe(dir)
    expect(readFileSync(join(dir, 'package.json'), 'utf8')).toBe(manifest)
    expect(readFileSync(join(dir, 'cordis.patch.yml'), 'utf8')).toBe(patch)
    expect(readFileSync(join(dir, 'pnpm-workspace.yaml'), 'utf8')).toBe(workspace)
  })

  it('does not fill missing profile files when a user manifest already exists', () => {
    const home = tmp()
    const dir = join(home, 'profiles', 'openloop')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'package.json'), '{"name":"manifest-only"}\n')

    ensureOpenloopProfile(home)

    expect(existsSync(join(dir, 'cordis.patch.yml'))).toBe(false)
    expect(existsSync(join(dir, 'pnpm-workspace.yaml'))).toBe(false)
  })

  it.runIf(process.platform !== 'win32')('rejects a dangling profile manifest symlink', () => {
    const home = tmp()
    const dir = join(home, 'profiles', 'openloop')
    const missingTarget = join(dir, 'missing-package.json')
    mkdirSync(dir, { recursive: true })
    symlinkSync(missingTarget, join(dir, 'package.json'))

    expect(() => ensureOpenloopProfile(home))
      .toThrow(/package\.json.*regular file/i)
    expect(existsSync(missingTarget)).toBe(false)
    expect(existsSync(join(dir, 'cordis.patch.yml'))).toBe(false)
    expect(existsSync(join(dir, 'pnpm-workspace.yaml'))).toBe(false)
  })

  it.runIf(process.platform !== 'win32')('rejects a profile manifest symlink to an external file', () => {
    const home = tmp()
    const external = tmp()
    const dir = join(home, 'profiles', 'openloop')
    const externalManifest = join(external, 'package.json')
    mkdirSync(dir, { recursive: true })
    writeFileSync(externalManifest, '{"name":"external"}\n')
    symlinkSync(externalManifest, join(dir, 'package.json'))

    expect(() => ensureOpenloopProfile(home))
      .toThrow(/package\.json.*regular file/i)
    expect(readFileSync(externalManifest, 'utf8')).toBe('{"name":"external"}\n')
    expect(existsSync(join(dir, 'cordis.patch.yml'))).toBe(false)
    expect(existsSync(join(dir, 'pnpm-workspace.yaml'))).toBe(false)
  })

  it('rejects a directory at the profile manifest path', () => {
    const home = tmp()
    const dir = join(home, 'profiles', 'openloop')
    mkdirSync(join(dir, 'package.json'), { recursive: true })

    expect(() => ensureOpenloopProfile(home))
      .toThrow(/package\.json.*regular file/i)
    expect(existsSync(join(dir, 'cordis.patch.yml'))).toBe(false)
    expect(existsSync(join(dir, 'pnpm-workspace.yaml'))).toBe(false)
  })

  it('rejects an existing scalar patch without committing profile fragments', () => {
    const home = tmp()
    const dir = join(home, 'profiles', 'openloop')
    const patch = 'partial\n'
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'cordis.patch.yml'), patch)

    expect(() => ensureOpenloopProfile(home))
      .toThrow(/cordis\.patch\.yml.*YAML array/i)
    expect(readFileSync(join(dir, 'cordis.patch.yml'), 'utf8')).toBe(patch)
    expect(existsSync(join(dir, 'pnpm-workspace.yaml'))).toBe(false)
    expect(existsSync(join(dir, 'package.json'))).toBe(false)
  })

  it('rejects an incomplete existing workspace without committing profile fragments', () => {
    const home = tmp()
    const dir = join(home, 'profiles', 'openloop')
    const workspace = 'packages:\n  - .\n'
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'pnpm-workspace.yaml'), workspace)

    expect(() => ensureOpenloopProfile(home))
      .toThrow(/pnpm-workspace\.yaml.*nodeLinker.*hoisted/i)
    expect(readFileSync(join(dir, 'pnpm-workspace.yaml'), 'utf8')).toBe(workspace)
    expect(existsSync(join(dir, 'cordis.patch.yml'))).toBe(false)
    expect(existsSync(join(dir, 'package.json'))).toBe(false)
  })

  it.each([
    ['number', "packages: ['.', 42]\nnodeLinker: hoisted\nautoInstallPeers: false\n"],
    ['empty string', "packages: ['.', '']\nnodeLinker: hoisted\nautoInstallPeers: false\n"],
    ['object', "packages: ['.', {}]\nnodeLinker: hoisted\nautoInstallPeers: false\n"],
  ])('rejects a workspace with a %s package member without committing profile fragments', (_member, workspace) => {
    const home = tmp()
    const dir = join(home, 'profiles', 'openloop')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'pnpm-workspace.yaml'), workspace)

    let failure: unknown
    try {
      ensureOpenloopProfile(home)
    } catch (error) {
      failure = error
    }
    expect(readFileSync(join(dir, 'pnpm-workspace.yaml'), 'utf8')).toBe(workspace)
    expect(existsSync(join(dir, 'cordis.patch.yml'))).toBe(false)
    expect(existsSync(join(dir, 'package.json'))).toBe(false)
    expect((failure as Error).message)
      .toMatch(/pnpm-workspace\.yaml.*packages.*non-empty strings/i)
  })

  it('preserves a valid existing custom patch array while creating the profile manifest', () => {
    const home = tmp()
    const dir = join(home, 'profiles', 'openloop')
    const patch = '- id: user-owned\n  disabled: true\n'
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'cordis.patch.yml'), patch)

    expect(ensureOpenloopProfile(home)).toBe(dir)

    expect(readFileSync(join(dir, 'cordis.patch.yml'), 'utf8')).toBe(patch)
    expect(existsSync(join(dir, 'pnpm-workspace.yaml'))).toBe(true)
    expect(existsSync(join(dir, 'package.json'))).toBe(true)
  })

  it.runIf(process.platform !== 'win32')('refuses an existing manifest through a symlinked profile directory', () => {
    const home = tmp()
    const external = tmp()
    mkdirSync(join(home, 'profiles'), { recursive: true })
    writeFileSync(join(external, 'package.json'), '{"name":"external"}\n')
    symlinkSync(external, join(home, 'profiles', 'openloop'), 'dir')

    expect(() => ensureOpenloopProfile(home)).toThrow(/symbolic link/i)
    expect(readFileSync(join(external, 'package.json'), 'utf8')).toBe('{"name":"external"}\n')
    expect(existsSync(join(external, 'cordis.patch.yml'))).toBe(false)
    expect(existsSync(join(external, 'pnpm-workspace.yaml'))).toBe(false)
  })

  it.runIf(process.platform !== 'win32')('refuses an existing manifest through a symlinked profiles parent directory', () => {
    const home = tmp()
    const external = tmp()
    mkdirSync(join(external, 'openloop'))
    writeFileSync(join(external, 'openloop', 'package.json'), '{"name":"external"}\n')
    symlinkSync(external, join(home, 'profiles'), 'dir')

    expect(() => ensureOpenloopProfile(home)).toThrow(/profile parent.*symbolic link/i)
    expect(readFileSync(join(external, 'openloop', 'package.json'), 'utf8')).toBe('{"name":"external"}\n')
    expect(existsSync(join(external, '.openloop.init.lock'))).toBe(false)
  })

  it('resolves every bundle manifest and parses every declared patch as a YAML list', () => {
    const require = createRequire(import.meta.url)

    for (const packageName of OPENLOOP_PROFILE_BUNDLES) {
      const manifestPath = require.resolve(`${packageName}/package.json`)
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as BundleManifest
      const patch = manifest.dsh?.bundle?.patch
      expect(manifest.name).toBe(packageName)
      expect(patch, packageName).toBe('./cordis.patch.yml')
      expect(yaml.load(readFileSync(join(manifestPath, '..', patch!), 'utf8'), {
        schema: entryListSchema,
      }), packageName).toSatisfy(Array.isArray)
    }
  })

  it('ships a private host bundle with the required package surface', () => {
    const require = createRequire(import.meta.url)
    const manifestPath = require.resolve('@openloop/bundle/package.json')
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as BundleManifest

    expect(manifest).toMatchObject({
      name: '@openloop/bundle',
      private: true,
      openloop: { face: 'host' },
      dependencies: {
        '@deepseek-ai/dsh-app-boot': 'workspace:^',
        '@deepseek-ai/dsh-base': 'workspace:^',
        '@deepseek-ai/dsh-web-app': 'workspace:^',
        '@openloop/runtime-bootstrap': 'workspace:^',
        '@openloop/sandbox-workspace': 'workspace:^',
        '@openloop/settings-foundation': 'workspace:*',
      },
      dsh: { bundle: { patch: './cordis.patch.yml' } },
      exports: {
        '.': {
          types: './lib/types/index.d.ts',
          default: './lib/index.js',
        },
        './invariant': {
          types: './lib/types/invariant.d.ts',
          default: './lib/invariant.js',
        },
        './bootstrap-host': {
          types: './lib/types/bootstrap-host.d.ts',
          default: './lib/bootstrap-host.js',
        },
        './cordis.patch.yml': './cordis.patch.yml',
        './package.json': './package.json',
      },
    })
    expect(manifest.files).toEqual([
      'lib/index.js',
      'lib/invariant.js',
      'lib/bootstrap-host.js',
      'cordis.patch.yml',
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
