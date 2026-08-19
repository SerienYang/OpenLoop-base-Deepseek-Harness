import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { load } from 'js-yaml'
import { afterEach, describe, expect, it } from 'vitest'

const roots: string[] = []
const scaffoldModulePath: string = './scaffold-package.mjs'

interface JsonFixture {
  readonly [key: string]: unknown
  readonly references?: ReadonlyArray<{ readonly path?: string }>
  readonly dependencies?: Readonly<Record<string, string>>
}

function fixtureRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'openloop-scaffold-'))
  roots.push(root)
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

    expect(readJson(join(root, 'packages/openloop/window-client/package.json'))).toMatchObject({
      openloop: { face: 'client', cordisPlugin: true },
      peerDependencies: { '@deepseek-ai/cordis': 'workspace:^' },
      devDependencies: { '@deepseek-ai/cordis': 'workspace:^' },
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
