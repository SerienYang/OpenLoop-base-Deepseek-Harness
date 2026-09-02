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
import { join } from 'node:path'
import { composeEntries } from '@deepseek-ai/dsh-app-boot'
import { entryListSchema } from '@deepseek-ai/cordis-plugin-include'
import type { PatchOptions } from '@deepseek-ai/cordis-plugin-include'
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

const tmp = (): string => mkdtempSync(join(tmpdir(), 'openloop-profile-'))

const OFFICIAL_AGENT_PLAN_MODELS = [
  { id: 'ark-code-latest', name: 'ark-code-latest', contextWindow: 256_000, maxTokens: 32_000, input: ['text', 'image'] },
  { id: 'doubao-seed-2.1-turbo', name: 'doubao-seed-2.1-turbo', contextWindow: 256_000, maxTokens: 65_536, input: ['text', 'image'] },
  { id: 'doubao-seed-evolving', name: 'doubao-seed-evolving', contextWindow: 1_024_000, maxTokens: 65_536, input: ['text', 'image'] },
  { id: 'glm-5.3', name: 'glm-5.3', contextWindow: 1_024_000, maxTokens: 65_536, input: ['text'] },
  { id: 'glm-5.3-flash', name: 'glm-5.3-flash', contextWindow: 1_024_000, maxTokens: 65_536, input: ['text', 'image'] },
  { id: 'glm-latest', name: 'glm-latest', contextWindow: 1_024_000, maxTokens: 65_536, input: ['text'] },
  { id: 'deepseek-v4-flash', name: 'deepseek-v4-flash', contextWindow: 1_024_000, maxTokens: 65_536, input: ['text'] },
  { id: 'deepseek-v4-pro', name: 'deepseek-v4-pro', contextWindow: 1_024_000, maxTokens: 65_536, input: ['text'] },
  { id: 'doubao-seed-2.0-lite', name: 'doubao-seed-2.0-lite', contextWindow: 256_000, maxTokens: 65_536, input: ['text', 'image'] },
  { id: 'doubao-seed-2.0-mini', name: 'doubao-seed-2.0-mini', contextWindow: 256_000, maxTokens: 65_536, input: ['text', 'image'] },
  { id: 'minimax-m3', name: 'minimax-m3', contextWindow: 1_024_000, maxTokens: 65_536, input: ['text', 'image'] },
  { id: 'kimi-k2.7-code', name: 'kimi-k2.7-code', contextWindow: 256_000, maxTokens: 32_000, input: ['text', 'image'] },
  { id: 'kimi-k3', name: 'kimi-k3', contextWindow: 1_024_000, maxTokens: 65_536, input: ['text', 'image'] },
] as const

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

  it('composes the Volcengine Agent Plan provider preset', () => {
    const require = createRequire(import.meta.url)
    const layers = OPENLOOP_PROFILE_BUNDLES.map((packageName) => {
      const manifestPath = require.resolve(`${packageName}/package.json`)
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as BundleManifest
      const patchPath = join(manifestPath, '..', manifest.dsh!.bundle!.patch!)
      return yaml.load(readFileSync(patchPath, 'utf8'), {
        schema: entryListSchema,
      }) as PatchOptions[]
    })

    const llmPiAi = composeEntries(layers).find(entry => entry.id === 'llm-pi-ai')

    expect(llmPiAi?.config).toEqual({
      providers: {
        'volcengine-agent-plan': {
          displayName: '火山方舟 Agent Plan',
          apiKeyEnv: 'VOLCENGINE_ARK_AGENT_PLAN_API_KEY',
          credentialMode: 'bearer',
          api: 'openai-responses',
          baseURL: 'https://ark.cn-beijing.volces.com/api/plan/v3',
          models: OFFICIAL_AGENT_PLAN_MODELS,
        },
      },
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
      inject: ['webServer', 'runtimeBootstrap'],
    })
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
