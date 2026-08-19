import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import { load } from 'js-yaml'
import { afterEach, describe, expect, it } from 'vitest'

const roots: string[] = []
const scaffoldModulePath: string = './scaffold-package.mjs'

interface JsonFixture {
  readonly [key: string]: unknown
  readonly references?: ReadonlyArray<{ readonly path?: string }>
  readonly dependencies?: Readonly<Record<string, string>>
  readonly scripts?: Readonly<Record<string, string>>
  readonly exports?: Readonly<Record<string, unknown>>
  readonly dsh?: {
    readonly client?: {
      readonly inject?: readonly string[]
      readonly platform?: string
    }
  }
}

function fixtureRoot(): string {
  const root = mkdtempSync(join(import.meta.dirname, '.scaffold-fixture-'))
  roots.push(root)
  writeJson(join(root, 'tsconfig.base.json'), {
    compilerOptions: {
      composite: true,
      module: 'esnext',
      moduleResolution: 'bundler',
      target: 'es2024',
    },
  })
  writeJson(join(root, 'tsconfig.base.client.json'), {
    extends: './tsconfig.base.json',
    compilerOptions: {},
  })
  writeJson(join(root, 'vendor/cordis/tsconfig.json'), {
    extends: '../../tsconfig.base.json',
    files: [],
  })
  writeJson(join(root, 'tsconfig.host.json'), { files: [], references: [] })
  writeJson(join(root, 'tsconfig.client.json'), { files: [], references: [] })
  return root
}

function writeJson(path: string, value: object): void {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`)
}

function readJson(path: string): JsonFixture {
  return JSON.parse(readFileSync(path, 'utf8')) as JsonFixture
}

async function loadCordisPlugin(path: string): Promise<{
  readonly ctx: Context
  readonly plugin: Record<string, unknown>
}> {
  const plugin = await import(pathToFileURL(path).href) as Record<string, unknown>
  const ctx = new Context()
  const entry = (plugin.default ?? plugin) as Parameters<Context['plugin']>[0]
  const fiber = ctx.plugin(entry)
  await fiber
  return { ctx, plugin }
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('OpenLoop package scaffolder', () => {
  it('parses the complete CLI interface', async () => {
    const { parseScaffoldArguments } = await import(scaffoldModulePath)

    expect(parseScaffoldArguments([
      '--name', 'workbench',
      '--face', 'client',
      '--client-bundle',
      '--bundle-row', 'desktop',
      '--service', 'workbench',
    ])).toEqual({
      name: 'workbench',
      face: 'client',
      clientBundle: true,
      bundleRow: 'desktop',
      service: 'workbench',
    })
  })

  it('accepts the leading separator forwarded by the root pnpm command', async () => {
    const { parseScaffoldArguments } = await import(scaffoldModulePath)

    expect(parseScaffoldArguments([
      '--',
      '--name', 'workbench',
      '--face', 'client',
    ])).toEqual({
      name: 'workbench',
      face: 'client',
      clientBundle: false,
    })
  })

  it('creates a package in an absent directory with one host aggregate reference', async () => {
    const { scaffoldPackage } = await import(scaffoldModulePath)
    const root = fixtureRoot()

    scaffoldPackage({ root, name: 'window-state', face: 'host' })

    const directory = join(root, 'packages/openloop/window-state')
    expect(readJson(join(directory, 'package.json'))).toMatchObject({
      name: '@openloop/window-state',
      private: true,
      type: 'module',
      openloop: { face: 'host' },
    })
    expect(readFileSync(join(directory, 'src/index.ts'), 'utf8')).toContain('@openloop/window-state')
    expect(existsSync(join(directory, 'README.md'))).toBe(true)
    expect(readJson(join(directory, 'tsconfig.json'))).toMatchObject({
      extends: '../../../tsconfig.base.json',
      compilerOptions: { rootDir: 'src', outDir: 'lib/types' },
      include: ['src'],
    })
    expect(readJson(join(root, 'tsconfig.host.json')).references).toEqual([
      { path: './packages/openloop/window-state' },
    ])
    expect(readJson(join(root, 'tsconfig.client.json')).references).toEqual([])
  })

  it('treats a client bundle as a Cordis plugin without requiring a service', async () => {
    const { scaffoldPackage } = await import(scaffoldModulePath)
    const root = fixtureRoot()

    scaffoldPackage({
      root,
      name: 'window-client',
      face: 'client',
      clientBundle: true,
    })

    const directory = join(root, 'packages/openloop/window-client')
    expect(readJson(join(directory, 'package.json'))).toMatchObject({
      openloop: { face: 'client', cordisPlugin: true },
      exports: {
        '.': {
          types: './lib/types/index.d.ts',
          default: './lib/index.js',
        },
        './client': {
          types: './lib/types/client/index.d.ts',
          default: './lib/client.js',
        },
      },
      dsh: {
        client: {
          inject: [],
          platform: 'web',
        },
      },
      scripts: {
        bundle: 'tsdown',
        watch: 'tsdown --watch',
      },
      peerDependencies: { '@deepseek-ai/cordis': 'workspace:^' },
      devDependencies: { '@deepseek-ai/cordis': 'workspace:^' },
    })
    expect(readFileSync(join(directory, 'tsdown.config.ts'), 'utf8')).toContain(
      "clientBundle('@openloop/window-client', ['lib/types/index.js'])",
    )
    await expect(loadCordisPlugin(join(directory, 'src/client/index.ts'))).resolves.toMatchObject({
      plugin: {
        apply: expect.any(Function),
      },
    })
  })

  it('preserves a tests-only directory and generates optional client and bundle wiring', async () => {
    const { scaffoldPackage } = await import(scaffoldModulePath)
    const root = fixtureRoot()
    const directory = join(root, 'packages/openloop/workbench')
    mkdirSync(join(directory, 'tests'), { recursive: true })
    writeFileSync(join(directory, 'tests/contract.spec.ts'), 'export {}\n')

    const bundleDirectory = join(root, 'packages/openloop/desktop')
    writeJson(join(bundleDirectory, 'package.json'), {
      name: '@openloop/desktop',
      private: true,
      dependencies: {},
    })
    writeFileSync(join(bundleDirectory, 'cordis.patch.yml'), '[]\n')

    scaffoldPackage({
      root,
      name: 'workbench',
      face: 'client',
      clientBundle: true,
      bundleRow: 'desktop',
      service: 'workbench',
    })

    expect(readFileSync(join(directory, 'tests/contract.spec.ts'), 'utf8')).toBe('export {}\n')
    expect(readJson(join(directory, 'package.json'))).toMatchObject({
      name: '@openloop/workbench',
      openloop: { face: 'client', cordisPlugin: true, service: 'workbench' },
      peerDependencies: { '@deepseek-ai/cordis': 'workspace:^' },
      devDependencies: { '@deepseek-ai/cordis': 'workspace:^' },
    })
    expect(readFileSync(join(directory, 'tsdown.config.ts'), 'utf8')).toContain(
      "clientBundle('@openloop/workbench'",
    )
    expect(readJson(join(root, 'tsconfig.client.json')).references).toEqual([
      { path: './packages/openloop/workbench' },
    ])
    expect(readJson(join(root, 'tsconfig.host.json')).references).toEqual([])
    expect(readJson(join(bundleDirectory, 'package.json')).dependencies).toEqual({
      '@openloop/workbench': 'workspace:*',
    })
    expect(load(readFileSync(join(bundleDirectory, 'cordis.patch.yml'), 'utf8'))).toEqual([
      { insert: [{ id: 'workbench', name: '@openloop/workbench' }] },
    ])
    const loaded = await loadCordisPlugin(join(directory, 'src/index.ts'))
    expect(loaded.plugin.default).toBeTypeOf('function')
    expect((loaded.ctx as unknown as Record<string, unknown>).workbench).toBeInstanceOf(
      loaded.plugin.default,
    )
  })

  it('generates a loadable namespace plugin for a bundle row without a service', async () => {
    const { scaffoldPackage } = await import(scaffoldModulePath)
    const root = fixtureRoot()
    const bundleDirectory = join(root, 'packages/openloop/desktop')
    writeJson(join(bundleDirectory, 'package.json'), {
      name: '@openloop/desktop',
      private: true,
      dependencies: {},
    })
    writeFileSync(join(bundleDirectory, 'cordis.patch.yml'), '[]\n')

    scaffoldPackage({
      root,
      name: 'window-state',
      face: 'host',
      bundleRow: 'desktop',
    })

    const loaded = await loadCordisPlugin(
      join(root, 'packages/openloop/window-state/src/index.ts'),
    )
    expect(loaded.plugin).toMatchObject({
      name: 'window-state',
      apply: expect.any(Function),
    })
    expect(load(readFileSync(join(bundleDirectory, 'cordis.patch.yml'), 'utf8'))).toEqual([
      { insert: [{ id: 'window-state', name: '@openloop/window-state' }] },
    ])
  })

  it.each([
    'package.json',
    'src',
    'README.md',
    'tsconfig.json',
  ])('refuses to overwrite owned path %s', async (ownedPath) => {
    const { scaffoldPackage } = await import(scaffoldModulePath)
    const root = fixtureRoot()
    const directory = join(root, 'packages/openloop/existing')
    const path = join(directory, ownedPath)
    if (ownedPath === 'src') mkdirSync(path, { recursive: true })
    else {
      mkdirSync(directory, { recursive: true })
      writeFileSync(path, 'owned\n')
    }

    expect(() => scaffoldPackage({ root, name: 'existing', face: 'pure' }))
      .toThrow(`refusing to overwrite packages/openloop/existing/${ownedPath}`)
  })

  it('refuses duplicate bundle rows before creating package files', async () => {
    const { scaffoldPackage } = await import(scaffoldModulePath)
    const root = fixtureRoot()
    const bundleDirectory = join(root, 'packages/openloop/desktop')
    writeJson(join(bundleDirectory, 'package.json'), {
      name: '@openloop/desktop',
      private: true,
      dependencies: { '@openloop/panel': 'workspace:*' },
    })
    writeFileSync(
      join(bundleDirectory, 'cordis.patch.yml'),
      '- insert:\n    - id: panel\n      name: "@openloop/panel"\n',
    )

    expect(() => scaffoldPackage({
      root,
      name: 'panel',
      face: 'client',
      bundleRow: 'desktop',
    })).toThrow('bundle desktop already contains row panel')
    expect(existsSync(join(root, 'packages/openloop/panel/package.json'))).toBe(false)
  })
})
