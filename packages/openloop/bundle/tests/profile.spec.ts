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
import { entryListSchema } from '@deepseek-ai/cordis-plugin-include'
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

describe('OpenLoop profile', () => {
  it('uses the exact base, Web, and OpenLoop bundle order', () => {
    expect(OPENLOOP_PROFILE_BUNDLES).toEqual([
      '@deepseek-ai/dsh-base',
      '@deepseek-ai/dsh-web-app',
      '@openloop/bundle',
    ])
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

  it('refuses to initialize through a symlinked profile directory', () => {
    const home = tmp()
    const external = tmp()
    mkdirSync(join(home, 'profiles'), { recursive: true })
    symlinkSync(external, join(home, 'profiles', 'openloop'), 'dir')

    expect(() => ensureOpenloopProfile(home)).toThrow(/symbolic link/i)
    expect(existsSync(join(external, 'package.json'))).toBe(false)
    expect(existsSync(join(external, 'cordis.patch.yml'))).toBe(false)
    expect(existsSync(join(external, 'pnpm-workspace.yaml'))).toBe(false)
  })

  it('refuses to initialize through a symlinked profiles parent directory', () => {
    const home = tmp()
    const external = tmp()
    symlinkSync(external, join(home, 'profiles'), 'dir')

    expect(() => ensureOpenloopProfile(home)).toThrow(/profile parent.*symbolic link/i)
    expect(existsSync(join(external, 'openloop', 'package.json'))).toBe(false)
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

  it('ships an empty private host bundle with the required package surface', () => {
    const require = createRequire(import.meta.url)
    const manifestPath = require.resolve('@openloop/bundle/package.json')
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as BundleManifest
    const patchPath = join(manifestPath, '..', manifest.dsh!.bundle!.patch!)

    expect(readFileSync(patchPath, 'utf8').trim()).toBe('[]')
    expect(manifest).toMatchObject({
      name: '@openloop/bundle',
      private: true,
      openloop: { face: 'host' },
      dependencies: {
        '@deepseek-ai/dsh-app-boot': 'workspace:^',
        '@deepseek-ai/dsh-base': 'workspace:^',
        '@deepseek-ai/dsh-web-app': 'workspace:^',
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
        './cordis.patch.yml': './cordis.patch.yml',
        './package.json': './package.json',
      },
    })
    expect(manifest.files).toEqual([
      'lib/index.js',
      'lib/invariant.js',
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
