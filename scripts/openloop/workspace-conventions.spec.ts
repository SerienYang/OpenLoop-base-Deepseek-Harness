import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

const roots: string[] = []

function fixtureRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'openloop-workspace-'))
  roots.push(root)
  writeFileSync(join(root, 'pnpm-workspace.yaml'), [
    'packages:',
    '  - vendor/*',
    '  - packages/*/*',
    '  - apps/*',
    '',
  ].join('\n'))
  writeJson(join(root, 'tsconfig.base.json'), { compilerOptions: {} })
  writeJson(join(root, 'tsconfig.base.client.json'), {
    extends: './tsconfig.base.json',
    compilerOptions: {},
  })
  writeJson(join(root, 'tsconfig.host.json'), { files: [], references: [] })
  writeJson(join(root, 'tsconfig.client.json'), {
    extends: './tsconfig.base.client.json',
    files: [],
    references: [],
  })
  return root
}

function writeJson(path: string, value: object): void {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`)
}

function writePackageManifest(root: string, group: string, name: string, manifest: object): void {
  const directory = join(root, 'packages', group, name)
  mkdirSync(directory, { recursive: true })
  writeFileSync(join(directory, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`)
}

function writeAppManifest(root: string, name: string, manifest: object): void {
  writeJson(join(root, 'apps', name, 'package.json'), manifest)
}

function writePackageAt(root: string, directory: string, manifest: object): void {
  writeJson(join(root, directory, 'package.json'), manifest)
}

function linkNodeModule(root: string, packageName: string, target: string): void {
  const link = join(root, 'node_modules', ...packageName.split('/'))
  mkdirSync(join(link, '..'), { recursive: true })
  symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir')
}

function writeManifest(root: string, name: string, manifest: object): void {
  writePackageManifest(root, 'openloop', name, manifest)
  writeJson(join(root, 'packages', 'openloop', name, 'tsconfig.json'), {
    compilerOptions: {
      allowJs: true,
      module: 'NodeNext',
      moduleResolution: 'NodeNext',
      target: 'ESNext',
    },
    include: ['src'],
  })
}

function writeSource(root: string, name: string, source: string, file = 'index.ts'): void {
  writeOpenLoopFile(root, name, `src/${file}`, source)
}

function writeOpenLoopFile(root: string, name: string, file: string, source: string): void {
  const path = join(root, 'packages', 'openloop', name, file)
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, source)
}

function privateDshViolationAt(path: string, value: string, line: number): string {
  return `${path}:${String(line)}: `
    + 'Openloop packages may import DSH only through public package exports; '
    + `${JSON.stringify(value)} is private`
}

function privateDshViolation(value: string, line: number, file = 'index.ts'): string {
  return privateDshViolationAt(`packages/openloop/probe/src/${file}`, value, line)
}

function compilerInputViolation(config: string, target: string, detail: string): string {
  return `packages/openloop/probe/${config}: Openloop package compiler input ${target} ${detail}`
}

function writeAggregates(
  root: string,
  host: readonly string[],
  client: readonly string[],
): void {
  writeJson(join(root, 'tsconfig.host.json'), {
    files: [],
    references: host.map(path => ({ path: `./packages/openloop/${path}` })),
  })
  writeJson(join(root, 'tsconfig.client.json'), {
    files: [],
    references: client.map(path => ({ path: `./packages/openloop/${path}` })),
  })
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('OpenLoop workspace conventions', () => {
  it('keeps the upstream DSH namespace mandatory under packages/core', async () => {
    const { collectDshWorkspaceNamingViolations } = await import('./workspace-conventions.ts')
    const root = fixtureRoot()
    writePackageManifest(root, 'core', 'agent-loop', {
      name: '@openloop/agent-loop',
    })

    expect(collectDshWorkspaceNamingViolations(root)).toEqual([
      'packages/core/agent-loop/package.json: DSH packages must use the @deepseek-ai/dsh-* namespace',
    ])

    writePackageManifest(root, 'core', 'agent-loop', {
      name: '@deepseek-ai/dsh-agent-loop',
    })
    expect(collectDshWorkspaceNamingViolations(root)).toEqual([])
  })

  it('accepts private @openloop packages with exactly one compiler face', async () => {
    const { collectOpenLoopWorkspaceViolations } = await import('./workspace-conventions.ts')
    const root = fixtureRoot()
    writeManifest(root, 'window-state', {
      name: '@openloop/window-state',
      private: true,
      openloop: { face: 'pure' },
    })
    writeAggregates(root, ['window-state'], [])

    expect(collectOpenLoopWorkspaceViolations(root)).toEqual([])
  })

  it.each([
    ['fs', "import fs from 'fs'\n"],
    ['fs/promises', "export { readFile } from 'fs/promises'\n"],
    ['child_process', "const cp = require('child_process')\n"],
    ['node:fs', "import { readFile } from 'node:fs'\n"],
    ['node:fs/promises', "const fs = await import('node:fs/promises')\n"],
    ['node:child_process', "const cp = require('node:child_process')\n"],
  ])('rejects direct %s imports from the Workspace filesystem provider', async (specifier, source) => {
    const { collectOpenLoopWorkspaceViolations } = await import('./workspace-conventions.ts')
    const root = fixtureRoot()
    writeManifest(root, 'fs-workspace', {
      name: '@openloop/fs-workspace',
      private: true,
      openloop: { face: 'host', cordisPlugin: true },
      peerDependencies: { '@deepseek-ai/cordis': 'workspace:^' },
      devDependencies: { '@deepseek-ai/cordis': 'workspace:^' },
    })
    writeSource(root, 'fs-workspace', source)
    writeAggregates(root, ['fs-workspace'], [])

    expect(collectOpenLoopWorkspaceViolations(root)).toContain(
      'packages/openloop/fs-workspace/src/index.ts:1: '
      + `@openloop/fs-workspace must use the Workspace file broker instead of ${specifier}`,
    )
  })

  it('rejects namespace, privacy, and face violations independently', async () => {
    const { collectOpenLoopWorkspaceViolations } = await import('./workspace-conventions.ts')
    const root = fixtureRoot()
    writeManifest(root, 'desktop-shell', {
      name: '@deepseek-ai/desktop-shell',
      private: false,
      openloop: { faces: ['host', 'client'] },
    })

    expect(collectOpenLoopWorkspaceViolations(root)).toEqual([
      'packages/openloop/desktop-shell/package.json: package name must be @openloop/desktop-shell',
      'packages/openloop/desktop-shell/package.json: OpenLoop packages must set "private": true',
      'packages/openloop/desktop-shell/package.json: openloop.face must be exactly one of host, client, or pure',
    ])
  })

  it('requires Cordis plugins to use matching peer and dev dependency ranges', async () => {
    const { collectOpenLoopWorkspaceViolations } = await import('./workspace-conventions.ts')
    const root = fixtureRoot()
    writeManifest(root, 'desktop-service', {
      name: '@openloop/desktop-service',
      private: true,
      openloop: { face: 'host', cordisPlugin: true },
      peerDependencies: {
        '@deepseek-ai/cordis': 'workspace:^',
      },
      devDependencies: {
        '@deepseek-ai/cordis': 'workspace:*',
      },
    })
    writeAggregates(root, ['desktop-service'], [])

    expect(collectOpenLoopWorkspaceViolations(root)).toEqual([
      'packages/openloop/desktop-service/package.json: @deepseek-ai/cordis peer (workspace:^) and dev (workspace:*) ranges must match',
    ])
  })

  it('requires both Cordis dependency declarations when a plugin declares neither', async () => {
    const { collectOpenLoopWorkspaceViolations } = await import('./workspace-conventions.ts')
    const root = fixtureRoot()
    writeManifest(root, 'lifecycle', {
      name: '@openloop/lifecycle',
      private: true,
      openloop: { face: 'host', cordisPlugin: true },
    })
    writeAggregates(root, ['lifecycle'], [])

    expect(collectOpenLoopWorkspaceViolations(root)).toEqual([
      'packages/openloop/lifecycle/package.json: Cordis plugin must declare @deepseek-ai/cordis as a peerDependency',
      'packages/openloop/lifecycle/package.json: Cordis plugin must also declare @deepseek-ai/cordis as a devDependency',
    ])
  })

  it('rejects a declared Client face referenced only by the Host aggregate', async () => {
    const { collectOpenLoopWorkspaceViolations } = await import('./workspace-conventions.ts')
    const root = fixtureRoot()
    writeManifest(root, 'workbench', {
      name: '@openloop/workbench',
      private: true,
      openloop: { face: 'client' },
    })
    writeAggregates(root, ['workbench'], [])

    expect(collectOpenLoopWorkspaceViolations(root)).toEqual([
      'packages/openloop/workbench/package.json: openloop.face client requires exactly one tsconfig.client.json reference and no tsconfig.host.json reference (found client=0, host=1)',
    ])
  })

  it('rejects a package referenced by both compiler aggregates', async () => {
    const { collectOpenLoopWorkspaceViolations } = await import('./workspace-conventions.ts')
    const root = fixtureRoot()
    writeManifest(root, 'lifecycle', {
      name: '@openloop/lifecycle',
      private: true,
      openloop: { face: 'host' },
    })
    writeAggregates(root, ['lifecycle'], ['lifecycle'])

    expect(collectOpenLoopWorkspaceViolations(root)).toEqual([
      'packages/openloop/lifecycle/package.json: openloop.face host requires exactly one tsconfig.host.json reference and no tsconfig.client.json reference (found host=1, client=1)',
    ])
  })

  it('keeps pure packages exclusively in the Host aggregate', async () => {
    const { collectOpenLoopWorkspaceViolations } = await import('./workspace-conventions.ts')
    const root = fixtureRoot()
    writeManifest(root, 'protocol', {
      name: '@openloop/protocol',
      private: true,
      openloop: { face: 'pure' },
    })
    writeAggregates(root, [], ['protocol'])

    expect(collectOpenLoopWorkspaceViolations(root)).toEqual([
      'packages/openloop/protocol/package.json: openloop.face pure requires exactly one tsconfig.host.json reference and no tsconfig.client.json reference (found host=0, client=1)',
    ])
  })

  it('rejects a pure production config that directly extends the root Client base', async () => {
    const { collectOpenLoopWorkspaceViolations } = await import('./workspace-conventions.ts')
    const root = fixtureRoot()
    writeManifest(root, 'adapters', {
      name: '@openloop/adapters',
      private: true,
      openloop: { face: 'pure' },
    })
    writeJson(join(root, 'packages/openloop/adapters/tsconfig.json'), {
      extends: '../../../tsconfig.base.client.json',
      files: [],
    })
    writeAggregates(root, ['adapters'], [])

    expect(collectOpenLoopWorkspaceViolations(root)).toEqual([
      'packages/openloop/adapters/tsconfig.json: pure production config must not extend Client config tsconfig.base.client.json',
    ])
  })

  it('rejects a pure production config that transitively extends a Client project config', async () => {
    const { collectOpenLoopWorkspaceViolations } = await import('./workspace-conventions.ts')
    const root = fixtureRoot()
    writeManifest(root, 'adapters', {
      name: '@openloop/adapters',
      private: true,
      openloop: { face: 'pure' },
    })
    writeJson(join(root, 'configs/pure-base.json'), {
      extends: '../packages/client/web/tsconfig.json',
      files: [],
    })
    writeJson(join(root, 'packages/client/web/tsconfig.json'), {
      extends: '../../../tsconfig.base.client.json',
      files: [],
    })
    writeJson(join(root, 'packages/openloop/adapters/tsconfig.json'), {
      extends: '../../../configs/pure-base.json',
      files: [],
    })
    writeAggregates(root, ['adapters'], [])
    writeJson(join(root, 'tsconfig.client.json'), {
      files: [],
      references: [{ path: './packages/client/web' }],
    })

    expect(collectOpenLoopWorkspaceViolations(root)).toEqual([
      'packages/openloop/adapters/tsconfig.json: pure production config must not extend Client config packages/client/web/tsconfig.json',
    ])
  })

  it('rejects a scoped package root whose tsconfig field selects the Client base', async () => {
    const { collectOpenLoopWorkspaceViolations } = await import('./workspace-conventions.ts')
    const root = fixtureRoot()
    writeManifest(root, 'adapters', {
      name: '@openloop/adapters',
      private: true,
      openloop: { face: 'pure' },
    })
    const preset = join(root, 'configs/client-preset')
    writeJson(join(preset, 'package.json'), {
      name: '@openloop-config/client',
      tsconfig: './config/client.json',
    })
    writeJson(join(preset, 'config/client.json'), {
      extends: '../../../tsconfig.base.client.json',
      files: [],
    })
    linkNodeModule(root, '@openloop-config/client', preset)
    writeJson(join(root, 'packages/openloop/adapters/tsconfig.json'), {
      extends: '@openloop-config/client',
      files: [],
    })
    writeAggregates(root, ['adapters'], [])

    expect(collectOpenLoopWorkspaceViolations(root)).toEqual([
      'packages/openloop/adapters/tsconfig.json: pure production config must not extend Client config tsconfig.base.client.json',
    ])
  })

  it('rejects a transitive package subpath in an extends array', async () => {
    const { collectOpenLoopWorkspaceViolations } = await import('./workspace-conventions.ts')
    const root = fixtureRoot()
    writeManifest(root, 'adapters', {
      name: '@openloop/adapters',
      private: true,
      openloop: { face: 'pure' },
    })
    const bridgePreset = join(root, 'configs/bridge-preset')
    writeJson(join(bridgePreset, 'package.json'), { name: 'openloop-config-bridge' })
    writeJson(join(bridgePreset, 'tsconfig.json'), {
      extends: ['@openloop-config/client/base', './local.json'],
      files: [],
    })
    writeJson(join(bridgePreset, 'local.json'), {
      extends: '../../tsconfig.base.json',
      files: [],
    })
    const clientPreset = join(root, 'configs/client-preset')
    writeJson(join(clientPreset, 'package.json'), { name: '@openloop-config/client' })
    writeJson(join(clientPreset, 'base.json'), {
      extends: '../../tsconfig.base.client.json',
      files: [],
    })
    linkNodeModule(root, 'openloop-config-bridge', bridgePreset)
    linkNodeModule(bridgePreset, '@openloop-config/client', clientPreset)
    writeJson(join(root, 'packages/openloop/adapters/tsconfig.json'), {
      extends: 'openloop-config-bridge',
      files: [],
    })
    writeAggregates(root, ['adapters'], [])

    expect(collectOpenLoopWorkspaceViolations(root)).toEqual([
      'packages/openloop/adapters/tsconfig.json: pure production config must not extend Client config tsconfig.base.client.json',
    ])
  })

  it('realpaths a package config symlink before checking the Client chain', async () => {
    const { collectOpenLoopWorkspaceViolations } = await import('./workspace-conventions.ts')
    const root = fixtureRoot()
    writeManifest(root, 'adapters', {
      name: '@openloop/adapters',
      private: true,
      openloop: { face: 'pure' },
    })
    const preset = join(root, 'configs/client-preset')
    writeJson(join(preset, 'package.json'), { name: 'openloop-config-client' })
    mkdirSync(preset, { recursive: true })
    symlinkSync(join(root, 'tsconfig.base.client.json'), join(preset, 'tsconfig.json'), 'file')
    linkNodeModule(root, 'openloop-config-client', preset)
    writeJson(join(root, 'packages/openloop/adapters/tsconfig.json'), {
      extends: 'openloop-config-client',
      files: [],
    })
    writeAggregates(root, ['adapters'], [])

    expect(collectOpenLoopWorkspaceViolations(root)).toEqual([
      'packages/openloop/adapters/tsconfig.json: pure production config must not extend Client config tsconfig.base.client.json',
    ])
  })

  it('allows a pure production config to extend a Host package config', async () => {
    const { collectOpenLoopWorkspaceViolations } = await import('./workspace-conventions.ts')
    const root = fixtureRoot()
    writeManifest(root, 'adapters', {
      name: '@openloop/adapters',
      private: true,
      openloop: { face: 'pure' },
    })
    const preset = join(root, 'configs/host-preset')
    writeJson(join(preset, 'package.json'), { name: '@openloop-config/host' })
    writeJson(join(preset, 'tsconfig.json'), {
      extends: '../../tsconfig.base.json',
      files: [],
    })
    linkNodeModule(root, '@openloop-config/host', preset)
    writeJson(join(root, 'packages/openloop/adapters/tsconfig.json'), {
      extends: '@openloop-config/host',
      files: [],
    })
    writeAggregates(root, ['adapters'], [])

    expect(collectOpenLoopWorkspaceViolations(root)).toEqual([])
  })

  it('reports an unresolved package extends as a TypeScript config error', async () => {
    const { collectOpenLoopWorkspaceViolations } = await import('./workspace-conventions.ts')
    const root = fixtureRoot()
    writeManifest(root, 'adapters', {
      name: '@openloop/adapters',
      private: true,
      openloop: { face: 'pure' },
    })
    writeJson(join(root, 'packages/openloop/adapters/tsconfig.json'), {
      extends: '@openloop-config/missing',
      files: [],
    })
    writeAggregates(root, ['adapters'], [])

    expect(() => collectOpenLoopWorkspaceViolations(root))
      .toThrow("File '@openloop-config/missing' not found.")
  })

  it('handles realpath aliases and cycles in a pure production extends chain', async () => {
    const { collectOpenLoopWorkspaceViolations } = await import('./workspace-conventions.ts')
    const root = fixtureRoot()
    writeManifest(root, 'adapters', {
      name: '@openloop/adapters',
      private: true,
      openloop: { face: 'pure' },
    })
    writeJson(join(root, 'configs/pure-a.json'), {
      extends: './pure-b.json',
      files: [],
    })
    writeJson(join(root, 'configs/pure-b.json'), {
      extends: ['./pure-a.json', './client-base-link.json'],
      files: [],
    })
    symlinkSync(
      join(root, 'tsconfig.base.client.json'),
      join(root, 'configs/client-base-link.json'),
      'file',
    )
    writeJson(join(root, 'packages/openloop/adapters/tsconfig.json'), {
      extends: '../../../configs/pure-a.json',
      files: [],
    })
    writeAggregates(root, ['adapters'], [])

    expect(collectOpenLoopWorkspaceViolations(root)).toEqual([
      'packages/openloop/adapters/tsconfig.json: pure production config must not extend Client config tsconfig.base.client.json',
    ])
  })

  it('allows a pure production config to extend the root Host base', async () => {
    const { collectOpenLoopWorkspaceViolations } = await import('./workspace-conventions.ts')
    const root = fixtureRoot()
    writeManifest(root, 'adapters', {
      name: '@openloop/adapters',
      private: true,
      openloop: { face: 'pure' },
    })
    writeJson(join(root, 'packages/openloop/adapters/tsconfig.json'), {
      extends: '../../../tsconfig.base.json',
      files: [],
    })
    writeAggregates(root, ['adapters'], [])

    expect(collectOpenLoopWorkspaceViolations(root)).toEqual([])
  })

  it('rejects Client project references from a pure package production tsconfig', async () => {
    const { collectOpenLoopWorkspaceViolations } = await import('./workspace-conventions.ts')
    const root = fixtureRoot()
    writeManifest(root, 'adapters', {
      name: '@openloop/adapters',
      private: true,
      openloop: { face: 'pure' },
    })
    writeJson(join(root, 'packages/openloop/adapters/tsconfig.json'), {
      files: [],
      references: [
        { path: '../../client/web' },
        { path: '../../host/apiproxy' },
      ],
    })
    writeAggregates(root, ['adapters'], [])
    writeJson(join(root, 'packages/client/web/tsconfig.json'), {
      extends: '../../../tsconfig.base.client.json',
      files: [],
    })
    writeJson(join(root, 'tsconfig.client.json'), {
      files: [],
      references: [{ path: './packages/client/web' }],
    })

    expect(collectOpenLoopWorkspaceViolations(root)).toEqual([
      'packages/openloop/adapters/tsconfig.json: pure production config must not reference Client project packages/client/web',
    ])
  })

  it('rejects a Client project outside packages/client from a pure package', async () => {
    const { collectOpenLoopWorkspaceViolations } = await import('./workspace-conventions.ts')
    const root = fixtureRoot()
    writeManifest(root, 'adapters', {
      name: '@openloop/adapters',
      private: true,
      openloop: { face: 'pure' },
    })
    writeJson(join(root, 'packages/extensions/ui-cordis/tsconfig.json'), {
      extends: '../../../tsconfig.base.client.json',
      files: [],
    })
    writeJson(join(root, 'packages/openloop/adapters/tsconfig.json'), {
      files: [],
      references: [{ path: '../../extensions/ui-cordis' }],
    })
    writeAggregates(root, ['adapters'], [])
    writeJson(join(root, 'tsconfig.client.json'), {
      files: [],
      references: [{ path: './packages/extensions/ui-cordis' }],
    })

    expect(collectOpenLoopWorkspaceViolations(root)).toEqual([
      'packages/openloop/adapters/tsconfig.json: pure production config must not reference Client project packages/extensions/ui-cordis',
    ])
  })

  it('rejects a nested Client project reference reached through a solution config', async () => {
    const { collectOpenLoopWorkspaceViolations } = await import('./workspace-conventions.ts')
    const root = fixtureRoot()
    writeManifest(root, 'adapters', {
      name: '@openloop/adapters',
      private: true,
      openloop: { face: 'pure' },
    })
    writeJson(join(root, 'configs/client-solution.json'), {
      files: [],
      references: [{ path: '../packages/extensions/ui-cordis' }],
    })
    writeJson(join(root, 'packages/extensions/ui-cordis/tsconfig.json'), {
      extends: '../../../tsconfig.base.client.json',
      files: [],
    })
    writeJson(join(root, 'packages/openloop/adapters/tsconfig.json'), {
      files: [],
      references: [{ path: '../../extensions/ui-cordis' }],
    })
    writeAggregates(root, ['adapters'], [])
    writeJson(join(root, 'tsconfig.client.json'), {
      files: [],
      references: [{ path: './configs/client-solution.json' }],
    })

    expect(collectOpenLoopWorkspaceViolations(root)).toEqual([
      'packages/openloop/adapters/tsconfig.json: pure production config must not reference Client project packages/extensions/ui-cordis',
    ])
  })

  it('rejects a transitive Client project reference from a pure production config', async () => {
    const { collectOpenLoopWorkspaceViolations } = await import('./workspace-conventions.ts')
    const root = fixtureRoot()
    writeManifest(root, 'adapters', {
      name: '@openloop/adapters',
      private: true,
      openloop: { face: 'pure' },
    })
    writeJson(join(root, 'configs/pure-solution.json'), {
      files: [],
      references: [{ path: '../packages/client/web' }],
    })
    writeJson(join(root, 'packages/client/web/tsconfig.json'), {
      extends: '../../../tsconfig.base.client.json',
      files: [],
    })
    writeJson(join(root, 'packages/openloop/adapters/tsconfig.json'), {
      files: [],
      references: [{ path: '../../../configs/pure-solution.json' }],
    })
    writeAggregates(root, ['adapters'], [])
    writeJson(join(root, 'tsconfig.client.json'), {
      files: [],
      references: [{ path: './packages/client/web' }],
    })

    expect(collectOpenLoopWorkspaceViolations(root)).toEqual([
      'packages/openloop/adapters/tsconfig.json: pure production config must not reference Client project packages/client/web',
    ])
  })

  it('rejects a Client project reached through multiple solution configs', async () => {
    const { collectOpenLoopWorkspaceViolations } = await import('./workspace-conventions.ts')
    const root = fixtureRoot()
    writeManifest(root, 'adapters', {
      name: '@openloop/adapters',
      private: true,
      openloop: { face: 'pure' },
    })
    writeJson(join(root, 'configs/pure-outer.json'), {
      files: [],
      references: [{ path: './pure-inner.json' }],
    })
    writeJson(join(root, 'configs/pure-inner.json'), {
      files: [],
      references: [{ path: '../packages/client/web' }],
    })
    writeJson(join(root, 'packages/client/web/tsconfig.json'), {
      extends: '../../../tsconfig.base.client.json',
      files: [],
    })
    writeJson(join(root, 'packages/openloop/adapters/tsconfig.json'), {
      files: [],
      references: [{ path: '../../../configs/pure-outer.json' }],
    })
    writeAggregates(root, ['adapters'], [])
    writeJson(join(root, 'tsconfig.client.json'), {
      files: [],
      references: [{ path: './packages/client/web' }],
    })

    expect(collectOpenLoopWorkspaceViolations(root)).toEqual([
      'packages/openloop/adapters/tsconfig.json: pure production config must not reference Client project packages/client/web',
    ])
  })

  it('handles cycles in a pure production project-reference graph', async () => {
    const { collectOpenLoopWorkspaceViolations } = await import('./workspace-conventions.ts')
    const root = fixtureRoot()
    writeManifest(root, 'adapters', {
      name: '@openloop/adapters',
      private: true,
      openloop: { face: 'pure' },
    })
    writeJson(join(root, 'configs/pure-a.json'), {
      files: [],
      references: [{ path: './pure-b.json' }],
    })
    writeJson(join(root, 'configs/pure-b.json'), {
      files: [],
      references: [
        { path: './pure-a.json' },
        { path: '../packages/client/web' },
      ],
    })
    writeJson(join(root, 'packages/client/web/tsconfig.json'), {
      extends: '../../../tsconfig.base.client.json',
      files: [],
    })
    writeJson(join(root, 'packages/openloop/adapters/tsconfig.json'), {
      files: [],
      references: [{ path: '../../../configs/pure-a.json' }],
    })
    writeAggregates(root, ['adapters'], [])
    writeJson(join(root, 'tsconfig.client.json'), {
      files: [],
      references: [{ path: './packages/client/web' }],
    })

    expect(collectOpenLoopWorkspaceViolations(root)).toEqual([
      'packages/openloop/adapters/tsconfig.json: pure production config must not reference Client project packages/client/web',
    ])
  })

  it('does not treat pure package contract and test-only configs as production', async () => {
    const { collectOpenLoopWorkspaceViolations } = await import('./workspace-conventions.ts')
    const root = fixtureRoot()
    writeManifest(root, 'adapters', {
      name: '@openloop/adapters',
      private: true,
      openloop: { face: 'pure' },
    })
    writeJson(join(root, 'packages/openloop/adapters/tsconfig.contracts.json'), {
      extends: '../../client/web/tsconfig.json',
      files: [],
      references: [{ path: '../../client/web' }],
    })
    writeJson(join(root, 'packages/openloop/adapters/tsconfig.test.json'), {
      extends: '../../../tsconfig.base.client.json',
      files: [],
    })
    writeJson(join(root, 'packages/client/web/tsconfig.json'), {
      extends: '../../../tsconfig.base.client.json',
      files: [],
    })
    writeAggregates(root, ['adapters'], [])
    writeJson(join(root, 'tsconfig.client.json'), {
      files: [],
      references: [{ path: './packages/client/web' }],
    })

    expect(collectOpenLoopWorkspaceViolations(root)).toEqual([])
  })

  it('allows a pure package to reference an extension outside the Client graph', async () => {
    const { collectOpenLoopWorkspaceViolations } = await import('./workspace-conventions.ts')
    const root = fixtureRoot()
    writeManifest(root, 'adapters', {
      name: '@openloop/adapters',
      private: true,
      openloop: { face: 'pure' },
    })
    writeJson(join(root, 'packages/extensions/tool-cordis/tsconfig.json'), { files: [] })
    writeJson(join(root, 'packages/openloop/adapters/tsconfig.json'), {
      files: [],
      references: [{ path: '../../extensions/tool-cordis' }],
    })
    writeAggregates(root, ['adapters'], [])

    expect(collectOpenLoopWorkspaceViolations(root)).toEqual([])
  })

  it('allows a pure production config to reach a shared Host project through solution configs', async () => {
    const { collectOpenLoopWorkspaceViolations } = await import('./workspace-conventions.ts')
    const root = fixtureRoot()
    writeManifest(root, 'adapters', {
      name: '@openloop/adapters',
      private: true,
      openloop: { face: 'pure' },
    })
    writeJson(join(root, 'packages/runtime-diagnostics/invariants/tsconfig.json'), {
      extends: '../../../tsconfig.base.json',
      files: [],
    })
    writeJson(join(root, 'packages/extensions/ui-cordis/tsconfig.json'), {
      extends: '../../../tsconfig.base.client.json',
      files: [],
      references: [{ path: '../../runtime-diagnostics/invariants' }],
    })
    writeJson(join(root, 'configs/host-outer.json'), {
      files: [],
      references: [{ path: './host-inner.json' }],
    })
    writeJson(join(root, 'configs/host-inner.json'), {
      files: [],
      references: [{ path: '../packages/runtime-diagnostics/invariants' }],
    })
    writeJson(join(root, 'packages/openloop/adapters/tsconfig.json'), {
      files: [],
      references: [{ path: '../../../configs/host-outer.json' }],
    })
    writeAggregates(root, ['adapters'], [])
    writeJson(join(root, 'tsconfig.client.json'), {
      extends: './tsconfig.base.client.json',
      files: [],
      references: [{ path: './packages/extensions/ui-cordis' }],
    })

    expect(collectOpenLoopWorkspaceViolations(root)).toEqual([])
  })

  it('rejects a pure project reference that resolves through a symlink into Client', async () => {
    const { collectOpenLoopWorkspaceViolations } = await import('./workspace-conventions.ts')
    const root = fixtureRoot()
    writeManifest(root, 'adapters', {
      name: '@openloop/adapters',
      private: true,
      openloop: { face: 'pure' },
    })
    const clientProject = join(root, 'packages', 'client', 'web')
    mkdirSync(clientProject, { recursive: true })
    writeJson(join(clientProject, 'tsconfig.json'), {
      extends: '../../../tsconfig.base.client.json',
      files: [],
    })
    const packageDirectory = join(root, 'packages', 'openloop', 'adapters')
    symlinkSync(
      clientProject,
      join(packageDirectory, 'client-project'),
      process.platform === 'win32' ? 'junction' : 'dir',
    )
    writeJson(join(packageDirectory, 'tsconfig.json'), {
      files: [],
      references: [{ path: './client-project' }],
    })
    writeAggregates(root, ['adapters'], [])
    writeJson(join(root, 'tsconfig.client.json'), {
      files: [],
      references: [{ path: './packages/client/web' }],
    })

    expect(collectOpenLoopWorkspaceViolations(root)).toEqual([
      'packages/openloop/adapters/tsconfig.json: pure production config must not reference Client project packages/client/web',
    ])
  })

  it('allows a pure project reference to a normal nonexistent output path', async () => {
    const { collectOpenLoopWorkspaceViolations } = await import('./workspace-conventions.ts')
    const root = fixtureRoot()
    writeManifest(root, 'adapters', {
      name: '@openloop/adapters',
      private: true,
      openloop: { face: 'pure' },
    })
    writeJson(join(root, 'packages/openloop/adapters/tsconfig.json'), {
      files: [],
      references: [{ path: './generated/types' }],
    })
    writeAggregates(root, ['adapters'], [])

    expect(collectOpenLoopWorkspaceViolations(root)).toEqual([])
  })

  it('allows every Openloop package to use declared public DSH exports', async () => {
    const { collectOpenLoopDshPrivateImportViolations } = await import(
      '../check-workspace-constraints.ts',
    )
    const root = fixtureRoot()
    writePackageManifest(root, 'host', 'gateway', {
      name: '@deepseek-ai/dsh-host-gateway',
      exports: {
        '.': './lib/index.js',
        './client': './lib/client.js',
        './types/*': './lib/types/*.js',
      },
    })
    writeManifest(root, 'adapters', {
      name: '@openloop/adapters',
      private: true,
      openloop: { face: 'pure' },
    })
    writeSource(root, 'adapters', [
      "import type { Root } from '@deepseek-ai/dsh-host-gateway'",
      "export type { Client } from '@deepseek-ai/dsh-host-gateway/client'",
      "export type { Item } from '@deepseek-ai/dsh-host-gateway/types/item'",
      '',
    ].join('\n'))

    expect(collectOpenLoopDshPrivateImportViolations(root)).toEqual([])
  })

  it('resolves tsconfig paths aliases from actual compiler inputs', async () => {
    const { collectOpenLoopDshPrivateImportViolations } = await import(
      '../check-workspace-constraints.ts',
    )
    const root = fixtureRoot()
    writePackageManifest(root, 'host', 'gateway', {
      name: '@deepseek-ai/dsh-host-gateway',
      exports: { '.': './lib/index.js' },
    })
    const privatePath = join(root, 'packages/host/gateway/src/private.ts')
    mkdirSync(join(privatePath, '..'), { recursive: true })
    writeFileSync(privatePath, 'export const privateValue = true\n')
    writeManifest(root, 'probe', {
      name: '@openloop/probe',
      private: true,
      openloop: { face: 'pure' },
    })
    writeJson(join(root, 'packages/openloop/probe/tsconfig.json'), {
      compilerOptions: {
        baseUrl: '.',
        module: 'NodeNext',
        moduleResolution: 'NodeNext',
        paths: {
          '@probe/internal': ['./src/internal.ts'],
          '@probe/private-dsh': ['../../host/gateway/src/private.ts'],
        },
      },
      include: ['src'],
    })
    writeSource(root, 'probe', [
      "import '@probe/private-dsh'",
      "import '@probe/internal'",
      "import '@deepseek-ai/dsh-host-gateway'",
      '',
    ].join('\n'))
    writeSource(root, 'probe', 'export const internal = true\n', 'internal.ts')

    expect(collectOpenLoopDshPrivateImportViolations(root)).toEqual([
      privateDshViolation('@probe/private-dsh', 1),
    ])
  })

  it('rejects a public DSH package name remapped by paths to private source', async () => {
    const { collectOpenLoopDshPrivateImportViolations } = await import(
      '../check-workspace-constraints.ts',
    )
    const root = fixtureRoot()
    writePackageManifest(root, 'host', 'gateway', {
      name: '@deepseek-ai/dsh-host-gateway',
      exports: { '.': './lib/index.js' },
    })
    const privateSource = join(root, 'packages/host/gateway/src/private.ts')
    mkdirSync(join(privateSource, '..'), { recursive: true })
    writeFileSync(privateSource, 'export const privateValue = true\n')
    writeManifest(root, 'probe', {
      name: '@openloop/probe',
      private: true,
      openloop: { face: 'pure' },
    })
    writeJson(join(root, 'packages/openloop/probe/tsconfig.json'), {
      compilerOptions: {
        baseUrl: '.',
        module: 'NodeNext',
        moduleResolution: 'NodeNext',
        paths: {
          '@deepseek-ai/dsh-host-gateway': ['../../host/gateway/src/private.ts'],
        },
      },
      include: ['src'],
    })
    writeSource(root, 'probe', "import '@deepseek-ai/dsh-host-gateway'\n")

    expect(collectOpenLoopDshPrivateImportViolations(root)).toEqual([
      privateDshViolation('@deepseek-ai/dsh-host-gateway', 1),
    ])
  })

  it('lets paths resolution override a safe package imports alias', async () => {
    const { collectOpenLoopDshPrivateImportViolations } = await import(
      '../check-workspace-constraints.ts',
    )
    const root = fixtureRoot()
    writePackageManifest(root, 'host', 'gateway', {
      name: '@deepseek-ai/dsh-host-gateway',
      exports: { '.': './lib/index.js' },
    })
    const privateSource = join(root, 'packages/host/gateway/src/private.ts')
    mkdirSync(join(privateSource, '..'), { recursive: true })
    writeFileSync(privateSource, 'export const privateValue = true\n')
    writeManifest(root, 'probe', {
      name: '@openloop/probe',
      private: true,
      type: 'module',
      imports: {
        '#internal': './src/internal.ts',
      },
      openloop: { face: 'pure' },
    })
    writeJson(join(root, 'packages/openloop/probe/tsconfig.json'), {
      compilerOptions: {
        baseUrl: '.',
        module: 'NodeNext',
        moduleResolution: 'NodeNext',
        paths: {
          '#internal': ['../../host/gateway/src/private.ts'],
        },
      },
      include: ['src'],
    })
    writeSource(root, 'probe', "import '#internal'\n")
    writeSource(root, 'probe', 'export const internal = true\n', 'internal.ts')

    expect(collectOpenLoopDshPrivateImportViolations(root)).toEqual([
      privateDshViolation('#internal', 1),
    ])
  })

  it('allows a public workspace package root mapped to its source entrypoint', async () => {
    const { collectOpenLoopDshPrivateImportViolations } = await import(
      '../check-workspace-constraints.ts',
    )
    const root = fixtureRoot()
    writePackageManifest(root, 'host', 'gateway', {
      name: '@deepseek-ai/dsh-host-gateway',
      exports: { '.': './lib/index.js' },
    })
    const publicSource = join(root, 'packages/host/gateway/src/index.ts')
    mkdirSync(join(publicSource, '..'), { recursive: true })
    writeFileSync(publicSource, 'export const publicValue = true\n')
    writeManifest(root, 'probe', {
      name: '@openloop/probe',
      private: true,
      openloop: { face: 'pure' },
    })
    writeJson(join(root, 'packages/openloop/probe/tsconfig.json'), {
      compilerOptions: {
        baseUrl: '.',
        module: 'NodeNext',
        moduleResolution: 'NodeNext',
        paths: {
          '@deepseek-ai/dsh-host-gateway': ['../../host/gateway/src'],
        },
      },
      include: ['src'],
    })
    writeSource(root, 'probe', "import '@deepseek-ai/dsh-host-gateway'\n")

    expect(collectOpenLoopDshPrivateImportViolations(root)).toEqual([])
  })

  it('allows a package imports alias that resolves to its own package target', async () => {
    const { collectOpenLoopDshPrivateImportViolations } = await import(
      '../check-workspace-constraints.ts',
    )
    const root = fixtureRoot()
    writeManifest(root, 'probe', {
      name: '@openloop/probe',
      private: true,
      type: 'module',
      imports: {
        '#internal': './src/internal.ts',
      },
      openloop: { face: 'pure' },
    })
    writeSource(root, 'probe', "import '#internal'\n")
    writeSource(root, 'probe', 'export const internal = true\n', 'internal.ts')

    expect(collectOpenLoopDshPrivateImportViolations(root)).toEqual([])
  })

  it('uses Node package imports resolution and rejects unused private alias targets', async () => {
    const { collectOpenLoopDshPrivateImportViolations } = await import(
      '../check-workspace-constraints.ts',
    )
    const root = fixtureRoot()
    writePackageManifest(root, 'host', 'gateway', {
      name: '@deepseek-ai/dsh-host-gateway',
      exports: {
        '.': './src/index.ts',
        './src/*': './src/*',
      },
    })
    const dshPackage = join(root, 'packages', 'host', 'gateway')
    mkdirSync(join(dshPackage, 'src'), { recursive: true })
    writeFileSync(join(dshPackage, 'src/index.ts'), 'export const publicValue = true\n')
    writeFileSync(join(dshPackage, 'src/private.ts'), 'export const privateValue = true\n')
    const nodeModulesScope = join(root, 'node_modules', '@deepseek-ai')
    mkdirSync(nodeModulesScope, { recursive: true })
    symlinkSync(
      dshPackage,
      join(nodeModulesScope, 'dsh-host-gateway'),
      process.platform === 'win32' ? 'junction' : 'dir',
    )
    writeManifest(root, 'probe', {
      name: '@openloop/probe',
      private: true,
      type: 'module',
      imports: {
        '#dsh-private': '@deepseek-ai/dsh-host-gateway/src/private.ts',
        '#unused-private': '@deepseek-ai/dsh-host-gateway/src/unused.ts',
        '#dsh-public': '@deepseek-ai/dsh-host-gateway',
        '#internal': './src/internal.ts',
      },
      openloop: { face: 'pure' },
    })
    writeSource(root, 'probe', [
      "import '#dsh-private'",
      "import '#dsh-public'",
      "import '#internal'",
      '',
    ].join('\n'))
    writeSource(root, 'probe', 'export const internal = true\n', 'internal.ts')
    const importer = join(root, 'packages/openloop/probe/src/index.ts')

    expect(realpathSync.native(createRequire(importer).resolve('#dsh-private')))
      .toBe(realpathSync.native(join(dshPackage, 'src/private.ts')))
    expect(collectOpenLoopDshPrivateImportViolations(root)).toEqual([
      privateDshViolationAt(
        'packages/openloop/probe/package.json',
        '@deepseek-ai/dsh-host-gateway/src/private.ts',
        6,
      ),
      privateDshViolationAt(
        'packages/openloop/probe/package.json',
        '@deepseek-ai/dsh-host-gateway/src/unused.ts',
        7,
      ),
      privateDshViolation('#dsh-private', 1),
    ])
  })

  it('scans contract compiler inputs while excluding tests fixtures and generated output', async () => {
    const { collectOpenLoopDshPrivateImportViolations } = await import(
      '../check-workspace-constraints.ts',
    )
    const root = fixtureRoot()
    writePackageManifest(root, 'host', 'gateway', {
      name: '@deepseek-ai/dsh-host-gateway',
      exports: { '.': './lib/index.js' },
    })
    writeManifest(root, 'probe', {
      name: '@openloop/probe',
      private: true,
      openloop: { face: 'pure' },
    })
    writeJson(join(root, 'packages/openloop/probe/tsconfig.contracts.json'), {
      extends: './tsconfig.json',
      include: ['contracts', 'tests', 'fixtures', 'generated', 'lib'],
    })
    const privateImport = "import '@deepseek-ai/dsh-host-gateway/src/private.ts'\n"
    writeOpenLoopFile(root, 'probe', 'contracts/current.ts', privateImport)
    writeOpenLoopFile(root, 'probe', 'tests/private.spec.ts', privateImport)
    writeOpenLoopFile(root, 'probe', 'fixtures/private.ts', privateImport)
    writeOpenLoopFile(root, 'probe', 'generated/private.ts', privateImport)
    writeOpenLoopFile(root, 'probe', 'lib/private.ts', privateImport)

    expect(collectOpenLoopDshPrivateImportViolations(root)).toEqual([
      privateDshViolationAt(
        'packages/openloop/probe/contracts/current.ts',
        '@deepseek-ai/dsh-host-gateway/src/private.ts',
        1,
      ),
    ])
  })

  it('scans production compiler inputs under source subdirectories and with test-like names', async () => {
    const { collectOpenLoopDshPrivateImportViolations } = await import(
      '../check-workspace-constraints.ts',
    )
    const root = fixtureRoot()
    writePackageManifest(root, 'host', 'gateway', {
      name: '@deepseek-ai/dsh-host-gateway',
      exports: { '.': './lib/index.js' },
    })
    writeManifest(root, 'probe', {
      name: '@openloop/probe',
      private: true,
      openloop: { face: 'pure' },
    })
    const privateImport = "import '@deepseek-ai/dsh-host-gateway/src/private.ts'\n"
    writeOpenLoopFile(root, 'probe', 'src/generated/private.ts', privateImport)
    writeOpenLoopFile(root, 'probe', 'src/generated/private.d.ts', privateImport)
    writeOpenLoopFile(root, 'probe', 'src/private.test.ts', privateImport)
    writeJson(join(root, 'packages/openloop/probe/tsconfig.json'), {
      compilerOptions: { module: 'NodeNext', moduleResolution: 'NodeNext' },
      files: [
        'src/generated/private.ts',
        'src/generated/private.d.ts',
        'src/private.test.ts',
      ],
    })

    expect(collectOpenLoopDshPrivateImportViolations(root)).toEqual([
      privateDshViolation(
        '@deepseek-ai/dsh-host-gateway/src/private.ts',
        1,
        'generated/private.d.ts',
      ),
      privateDshViolation(
        '@deepseek-ai/dsh-host-gateway/src/private.ts',
        1,
        'generated/private.ts',
      ),
      privateDshViolation(
        '@deepseek-ai/dsh-host-gateway/src/private.ts',
        1,
        'private.test.ts',
      ),
    ])
  })

  it('rejects a DSH source file directly included by an Openloop tsconfig', async () => {
    const { collectOpenLoopDshPrivateImportViolations } = await import(
      '../check-workspace-constraints.ts',
    )
    const root = fixtureRoot()
    writePackageManifest(root, 'host', 'gateway', {
      name: '@deepseek-ai/dsh-host-gateway',
      exports: { '.': './lib/index.js' },
    })
    writeOpenLoopFile(root, 'probe', 'src/index.ts', 'export {}\n')
    writeManifest(root, 'probe', {
      name: '@openloop/probe',
      private: true,
      openloop: { face: 'pure' },
    })
    const privateSource = join(root, 'packages/host/gateway/src/private.ts')
    mkdirSync(join(privateSource, '..'), { recursive: true })
    writeFileSync(privateSource, 'export const privateValue = true\n')
    writeJson(join(root, 'packages/openloop/probe/tsconfig.json'), {
      compilerOptions: { module: 'NodeNext', moduleResolution: 'NodeNext' },
      files: ['../../host/gateway/src/private.ts'],
    })

    expect(collectOpenLoopDshPrivateImportViolations(root)).toEqual([
      compilerInputViolation(
        'tsconfig.json',
        'packages/host/gateway/src/private.ts',
        'must not include private DSH source',
      ),
    ])
  })

  it('rejects a compiler input symlink that resolves into DSH source', async () => {
    const { collectOpenLoopDshPrivateImportViolations } = await import(
      '../check-workspace-constraints.ts',
    )
    const root = fixtureRoot()
    writePackageManifest(root, 'host', 'gateway', {
      name: '@deepseek-ai/dsh-host-gateway',
      exports: { '.': './lib/index.js' },
    })
    writeManifest(root, 'probe', {
      name: '@openloop/probe',
      private: true,
      openloop: { face: 'pure' },
    })
    const privateSource = join(root, 'packages/host/gateway/src/private.ts')
    mkdirSync(join(privateSource, '..'), { recursive: true })
    writeFileSync(privateSource, 'export const privateValue = true\n')
    symlinkSync(privateSource, join(root, 'packages/openloop/probe/dsh-private.ts'), 'file')
    writeJson(join(root, 'packages/openloop/probe/tsconfig.json'), {
      compilerOptions: { module: 'NodeNext', moduleResolution: 'NodeNext' },
      files: ['dsh-private.ts'],
    })

    expect(collectOpenLoopDshPrivateImportViolations(root)).toEqual([
      compilerInputViolation(
        'tsconfig.json',
        'packages/host/gateway/src/private.ts',
        'must not include private DSH source',
      ),
    ])
  })

  it('rejects a DSH generated declaration directly included by an Openloop tsconfig', async () => {
    const { collectOpenLoopDshPrivateImportViolations } = await import(
      '../check-workspace-constraints.ts',
    )
    const root = fixtureRoot()
    writePackageManifest(root, 'host', 'gateway', {
      name: '@deepseek-ai/dsh-host-gateway',
      exports: { '.': './lib/index.js' },
    })
    writeManifest(root, 'probe', {
      name: '@openloop/probe',
      private: true,
      openloop: { face: 'pure' },
    })
    const privateDeclaration = join(root, 'packages/host/gateway/lib/private.d.ts')
    mkdirSync(join(privateDeclaration, '..'), { recursive: true })
    writeFileSync(privateDeclaration, 'export declare const privateValue: true\n')
    writeJson(join(root, 'packages/openloop/probe/tsconfig.json'), {
      compilerOptions: { module: 'NodeNext', moduleResolution: 'NodeNext' },
      files: ['../../host/gateway/lib/private.d.ts'],
    })

    expect(collectOpenLoopDshPrivateImportViolations(root)).toEqual([
      compilerInputViolation(
        'tsconfig.json',
        'packages/host/gateway/lib/private.d.ts',
        'must not include private DSH source',
      ),
    ])
  })

  it('rejects a generated declaration symlink that resolves into a DSH package lib', async () => {
    const { collectOpenLoopDshPrivateImportViolations } = await import(
      '../check-workspace-constraints.ts',
    )
    const root = fixtureRoot()
    writePackageManifest(root, 'host', 'gateway', {
      name: '@deepseek-ai/dsh-host-gateway',
      exports: { '.': './lib/index.js' },
    })
    writeManifest(root, 'probe', {
      name: '@openloop/probe',
      private: true,
      openloop: { face: 'pure' },
    })
    const privateDeclaration = join(root, 'packages/host/gateway/lib/private.d.ts')
    mkdirSync(join(privateDeclaration, '..'), { recursive: true })
    writeFileSync(privateDeclaration, 'export declare const privateValue: true\n')
    const generatedLink = join(root, 'packages/openloop/probe/generated/dsh-private.d.ts')
    mkdirSync(join(generatedLink, '..'), { recursive: true })
    symlinkSync(privateDeclaration, generatedLink, 'file')
    writeJson(join(root, 'packages/openloop/probe/tsconfig.json'), {
      compilerOptions: { module: 'NodeNext', moduleResolution: 'NodeNext' },
      include: ['generated/dsh-private.d.ts'],
    })

    expect(collectOpenLoopDshPrivateImportViolations(root)).toEqual([
      compilerInputViolation(
        'tsconfig.json',
        'packages/host/gateway/lib/private.d.ts',
        'must not include private DSH source',
      ),
    ])
  })

  it('continues to exclude an ordinary package-local generated declaration', async () => {
    const { collectOpenLoopDshPrivateImportViolations } = await import(
      '../check-workspace-constraints.ts',
    )
    const root = fixtureRoot()
    writePackageManifest(root, 'host', 'gateway', {
      name: '@deepseek-ai/dsh-host-gateway',
      exports: { '.': './lib/index.js' },
    })
    writeManifest(root, 'probe', {
      name: '@openloop/probe',
      private: true,
      openloop: { face: 'pure' },
    })
    writeOpenLoopFile(
      root,
      'probe',
      'generated/index.d.ts',
      "import '@deepseek-ai/dsh-host-gateway/src/private.ts'\n",
    )
    writeJson(join(root, 'packages/openloop/probe/tsconfig.json'), {
      compilerOptions: { module: 'NodeNext', moduleResolution: 'NodeNext' },
      files: ['generated/index.d.ts'],
    })

    expect(collectOpenLoopDshPrivateImportViolations(root)).toEqual([])
  })

  it('scans and rejects a repo source directly included from outside its Openloop package', async () => {
    const { collectOpenLoopDshPrivateImportViolations } = await import(
      '../check-workspace-constraints.ts',
    )
    const root = fixtureRoot()
    writePackageManifest(root, 'host', 'gateway', {
      name: '@deepseek-ai/dsh-host-gateway',
      exports: { '.': './lib/index.js' },
    })
    writePackageManifest(root, 'shared', 'bridge', {
      name: '@workspace/bridge',
      private: true,
    })
    const bridgeSource = join(root, 'packages/shared/bridge/src/index.ts')
    mkdirSync(join(bridgeSource, '..'), { recursive: true })
    writeFileSync(
      bridgeSource,
      "import '@deepseek-ai/dsh-host-gateway/src/private.ts'\n",
    )
    writeManifest(root, 'probe', {
      name: '@openloop/probe',
      private: true,
      openloop: { face: 'pure' },
    })
    writeJson(join(root, 'packages/openloop/probe/tsconfig.json'), {
      compilerOptions: { module: 'NodeNext', moduleResolution: 'NodeNext' },
      files: ['../../shared/bridge/src/index.ts'],
    })

    expect(collectOpenLoopDshPrivateImportViolations(root)).toEqual([
      compilerInputViolation(
        'tsconfig.json',
        'packages/shared/bridge/src/index.ts',
        'must stay within packages/openloop/probe',
      ),
      privateDshViolationAt(
        'packages/shared/bridge/src/index.ts',
        '@deepseek-ai/dsh-host-gateway/src/private.ts',
        1,
      ),
    ])
  })

  it('does not scan a DSH project reached only through a project reference', async () => {
    const { collectOpenLoopDshPrivateImportViolations } = await import(
      '../check-workspace-constraints.ts',
    )
    const root = fixtureRoot()
    writePackageManifest(root, 'host', 'gateway', {
      name: '@deepseek-ai/dsh-host-gateway',
      exports: { '.': './lib/index.js' },
    })
    const privateSource = join(root, 'packages/host/gateway/src/private.ts')
    mkdirSync(join(privateSource, '..'), { recursive: true })
    writeFileSync(privateSource, 'export const privateValue = true\n')
    writeJson(join(root, 'packages/host/gateway/tsconfig.json'), {
      compilerOptions: {
        composite: true,
        module: 'NodeNext',
        moduleResolution: 'NodeNext',
      },
      include: ['src'],
    })
    writeManifest(root, 'probe', {
      name: '@openloop/probe',
      private: true,
      openloop: { face: 'pure' },
    })
    writeJson(join(root, 'packages/openloop/probe/tsconfig.json'), {
      compilerOptions: { module: 'NodeNext', moduleResolution: 'NodeNext' },
      files: [],
      references: [{ path: '../../host/gateway' }],
    })

    expect(collectOpenLoopDshPrivateImportViolations(root)).toEqual([])
  })

  it('excludes node_modules, TypeScript libs, and generated declarations from compiler inputs', async () => {
    const { collectOpenLoopDshPrivateImportViolations } = await import(
      '../check-workspace-constraints.ts',
    )
    const root = fixtureRoot()
    writePackageManifest(root, 'host', 'gateway', {
      name: '@deepseek-ai/dsh-host-gateway',
      exports: { '.': './lib/index.js' },
    })
    writePackageManifest(root, 'shared', 'bridge', {
      name: '@workspace/bridge',
      private: true,
    })
    const privateImport = "import '@deepseek-ai/dsh-host-gateway/src/private.ts'\n"
    const dependencySource = join(root, 'node_modules/dependency/index.ts')
    mkdirSync(join(dependencySource, '..'), { recursive: true })
    writeFileSync(dependencySource, privateImport)
    const generatedDeclaration = join(root, 'packages/shared/bridge/generated/index.d.ts')
    mkdirSync(join(generatedDeclaration, '..'), { recursive: true })
    writeFileSync(generatedDeclaration, privateImport)
    writeManifest(root, 'probe', {
      name: '@openloop/probe',
      private: true,
      openloop: { face: 'pure' },
    })
    writeJson(join(root, 'packages/openloop/probe/tsconfig.json'), {
      compilerOptions: { module: 'NodeNext', moduleResolution: 'NodeNext' },
      files: [
        '../../../node_modules/dependency/index.ts',
        '../../shared/bridge/generated/index.d.ts',
        createRequire(import.meta.url).resolve('typescript/lib/lib.es5.d.ts'),
      ],
    })

    expect(collectOpenLoopDshPrivateImportViolations(root)).toEqual([])
  })

  it('follows Node root export forms and fails closed for invalid mixed maps', async () => {
    const { collectOpenLoopDshPrivateImportViolations } = await import(
      '../check-workspace-constraints.ts',
    )
    const root = fixtureRoot()
    const manifests = [
      ['root-string', './lib/index.js'],
      ['root-array', [null, './lib/index.js']],
      ['root-conditions', { import: './lib/index.js', default: null }],
      ['root-null', null],
      ['subpath-map', { '.': './lib/index.js', './feature': './lib/feature.js' }],
      ['condition-wildcard', { '*': './lib/index.js', default: null }],
      ['mixed-map', { '.': './lib/index.js', default: './lib/fallback.js' }],
    ] as const
    for (const [name, exports] of manifests) {
      writePackageManifest(root, 'host', name, {
        name: `@deepseek-ai/dsh-${name}`,
        exports,
      })
    }
    writeManifest(root, 'probe', {
      name: '@openloop/probe',
      private: true,
      openloop: { face: 'pure' },
    })
    const specifiers = [
      '@deepseek-ai/dsh-root-string',
      '@deepseek-ai/dsh-root-string/private',
      '@deepseek-ai/dsh-root-array',
      '@deepseek-ai/dsh-root-array/private',
      '@deepseek-ai/dsh-root-conditions',
      '@deepseek-ai/dsh-root-conditions/private',
      '@deepseek-ai/dsh-root-null',
      '@deepseek-ai/dsh-subpath-map',
      '@deepseek-ai/dsh-subpath-map/feature',
      '@deepseek-ai/dsh-subpath-map/private',
      '@deepseek-ai/dsh-condition-wildcard',
      '@deepseek-ai/dsh-condition-wildcard/private',
      '@deepseek-ai/dsh-mixed-map',
      '@deepseek-ai/dsh-mixed-map/feature',
    ]
    writeSource(
      root,
      'probe',
      `${specifiers.map(value => `void import(${JSON.stringify(value)})`).join('\n')}\n`,
    )

    expect(() => collectOpenLoopDshPrivateImportViolations(root)).not.toThrow()
    expect(collectOpenLoopDshPrivateImportViolations(root)).toEqual(
      [1, 3, 5, 6, 9, 11, 12, 13]
        .map(index => privateDshViolation(specifiers[index]!, index + 1)),
    )
  })

  it('rejects real src and lib wildcard exports without rejecting a source subpath', async () => {
    const { collectOpenLoopDshPrivateImportViolations } = await import(
      '../check-workspace-constraints.ts',
    )
    const root = fixtureRoot()
    writePackageManifest(root, 'client', 'web', {
      name: '@deepseek-ai/dsh-client-web',
      exports: {
        '.': {
          types: './lib/types/index.d.ts',
          default: './lib/index.js',
        },
        './src/*': './src/*',
        './lib/*': './lib/*',
        './source/*': './lib/source/*.js',
      },
    })
    writeManifest(root, 'probe', {
      name: '@openloop/probe',
      private: true,
      openloop: { face: 'pure' },
    })
    const specifiers = [
      '@deepseek-ai/dsh-client-web/src/app-shell.ts',
      '@deepseek-ai/dsh-client-web/lib/index.js',
      '@deepseek-ai/dsh-client-web/source/public',
    ]
    writeSource(
      root,
      'probe',
      `${specifiers.map(value => `void import(${JSON.stringify(value)})`).join('\n')}\n`,
    )

    expect(collectOpenLoopDshPrivateImportViolations(root)).toEqual([
      privateDshViolation(specifiers[0]!, 1),
      privateDshViolation(specifiers[1]!, 2),
    ])
  })

  it('normalizes package subpath separators, dot segments, and percent escapes before exports', async () => {
    const { collectOpenLoopDshPrivateImportViolations } = await import(
      '../check-workspace-constraints.ts',
    )
    const root = fixtureRoot()
    writePackageManifest(root, 'client', 'web', {
      name: '@deepseek-ai/dsh-client-web',
      exports: {
        '.': './lib/index.js',
        './*': './lib/*.js',
      },
    })
    writeManifest(root, 'probe', {
      name: '@openloop/probe',
      private: true,
      openloop: { face: 'pure' },
    })
    const specifiers = [
      '@deepseek-ai/dsh-client-web/source/public',
      '@deepseek-ai/dsh-client-web/./src/private',
      '@deepseek-ai/dsh-client-web/source/../lib/private',
      '@deepseek-ai/dsh-client-web/%73rc/private',
      '@deepseek-ai/dsh-client-web/lib%2Fprivate',
      String.raw`@deepseek-ai/dsh-client-web/src\private`,
    ]
    writeSource(
      root,
      'probe',
      `${specifiers.map(value => `void import(${JSON.stringify(value)})`).join('\n')}\n`,
    )

    expect(collectOpenLoopDshPrivateImportViolations(root)).toEqual(
      specifiers.slice(1).map((value, index) => privateDshViolation(value, index + 2)),
    )
  })

  it('applies one private-path assertion to package, relative, absolute, and file URL forms', async () => {
    const { collectOpenLoopDshPrivateImportViolations } = await import(
      '../check-workspace-constraints.ts',
    )
    const root = fixtureRoot()
    writePackageManifest(root, 'client', 'web', {
      name: '@deepseek-ai/dsh-client-web',
      exports: {
        '.': './lib/index.js',
        './src/*': './src/*',
      },
    })
    const packageDirectory = join(root, 'packages', 'client', 'web')
    const privatePath = join(packageDirectory, 'src', 'private.ts')
    mkdirSync(join(privatePath, '..'), { recursive: true })
    writeFileSync(privatePath, 'export const privateValue = true\n')
    writeManifest(root, 'probe', {
      name: '@openloop/probe',
      private: true,
      openloop: { face: 'pure' },
    })
    const specifiers = [
      '@deepseek-ai/dsh-client-web/src/private.ts',
      '../../../client/web/lib/../src/private.ts',
      `${join(packageDirectory, 'lib')}/../src/private.ts`,
      pathToFileURL(privatePath).href.replace('private.ts', '%70rivate.ts'),
    ]
    writeSource(
      root,
      'probe',
      `${specifiers.map(value => `void import(${JSON.stringify(value)})`).join('\n')}\n`,
    )

    expect(collectOpenLoopDshPrivateImportViolations(root)).toEqual(
      specifiers.map((value, index) => privateDshViolation(value, index + 1)),
    )
  })

  it('discovers app DSH packages and distinguishes their public and private entrypoints', async () => {
    const { collectOpenLoopDshPrivateImportViolations } = await import(
      '../check-workspace-constraints.ts',
    )
    const root = fixtureRoot()
    writeAppManifest(root, 'cli', {
      name: '@deepseek-ai/dsh',
      main: 'lib/bin.js',
    })
    writeAppManifest(root, 'web', {
      name: '@deepseek-ai/dsh-web-frontend',
      exports: {
        './dist/*': './dist/*',
        './package.json': './package.json',
      },
    })
    writeAppManifest(root, 'openloop-runtime', {
      name: '@openloop/runtime',
      private: true,
    })
    writePackageAt(root, 'vendor/cordis', {
      name: '@deepseek-ai/cordis',
      exports: { '.': './lib/index.js' },
    })
    writeManifest(root, 'probe', {
      name: '@openloop/probe',
      private: true,
      openloop: { face: 'pure' },
    })
    writeSource(root, 'probe', [
      "import '@deepseek-ai/dsh'",
      "import '@deepseek-ai/dsh/private'",
      "import '@deepseek-ai/dsh-web-frontend/dist/app.js'",
      "import '@deepseek-ai/dsh-web-frontend/src/main.tsx'",
      "import '../../../../apps/cli/src/bin.ts'",
      "import '../../../../apps/web/src/main.tsx'",
      "import '@openloop/runtime/src/private'",
      "import '@deepseek-ai/cordis'",
      "import '@deepseek-ai/cordis/src/private'",
      "import '../../../../vendor/cordis/src/private.ts'",
      '',
    ].join('\n'))

    expect(collectOpenLoopDshPrivateImportViolations(root)).toEqual([
      'packages/openloop/probe/src/index.ts:2: Openloop packages may import DSH only through public package exports; "@deepseek-ai/dsh/private" is private',
      'packages/openloop/probe/src/index.ts:4: Openloop packages may import DSH only through public package exports; "@deepseek-ai/dsh-web-frontend/src/main.tsx" is private',
      'packages/openloop/probe/src/index.ts:5: Openloop packages may import DSH only through public package exports; "../../../../apps/cli/src/bin.ts" is private',
      'packages/openloop/probe/src/index.ts:6: Openloop packages may import DSH only through public package exports; "../../../../apps/web/src/main.tsx" is private',
      'packages/openloop/probe/src/index.ts:9: Openloop packages may import DSH only through public package exports; "@deepseek-ai/cordis/src/private" is private',
      'packages/openloop/probe/src/index.ts:10: Openloop packages may import DSH only through public package exports; "../../../../vendor/cordis/src/private.ts" is private',
    ])
  })

  it('derives DSH packages from workspace globs while excluding generated and fixture trees', async () => {
    const { collectOpenLoopDshPrivateImportViolations } = await import(
      '../check-workspace-constraints.ts',
    )
    const root = fixtureRoot()
    writeFileSync(join(root, 'pnpm-workspace.yaml'), [
      'packages:',
      '  - packages/*/*',
      '  - products/*',
      '',
    ].join('\n'))
    writePackageAt(root, 'products/desktop', {
      name: '@deepseek-ai/dsh-desktop',
      exports: { '.': './lib/index.js' },
    })
    for (const directory of ['products/node_modules', 'products/fixtures', 'products/build']) {
      writePackageAt(root, directory, {
        name: `@deepseek-ai/dsh-${directory.slice('products/'.length)}`,
        exports: { '.': './lib/index.js' },
      })
    }
    writeManifest(root, 'probe', {
      name: '@openloop/probe',
      private: true,
      openloop: { face: 'pure' },
    })
    writeSource(root, 'probe', [
      "import '@deepseek-ai/dsh-desktop/private'",
      "import 'products/desktop/src/private.ts'",
      "import '@deepseek-ai/dsh-node_modules/private'",
      "import '@deepseek-ai/dsh-fixtures/private'",
      "import '@deepseek-ai/dsh-build/private'",
      '',
    ].join('\n'))

    expect(collectOpenLoopDshPrivateImportViolations(root)).toEqual([
      'packages/openloop/probe/src/index.ts:1: Openloop packages may import DSH only through public package exports; "@deepseek-ai/dsh-desktop/private" is private',
      'packages/openloop/probe/src/index.ts:2: Openloop packages may import DSH only through public package exports; "products/desktop/src/private.ts" is private',
    ])
  })

  it('rejects private DSH paths across Openloop business packages', async () => {
    const { collectOpenLoopDshPrivateImportViolations } = await import(
      '../check-workspace-constraints.ts',
    )
    const root = fixtureRoot()
    writePackageManifest(root, 'client', 'web', {
      name: '@deepseek-ai/dsh-client-web',
      exports: {
        '.': './lib/index.js',
      },
    })
    writePackageManifest(root, 'settings', 'settings', {
      name: '@deepseek-ai/dsh-settings',
      exports: {
        '.': './lib/index.js',
        './types': './lib/types/types.js',
      },
    })
    writePackageManifest(root, 'host', 'gateway', {
      name: '@deepseek-ai/dsh-host-gateway',
      exports: {
        '.': './lib/index.js',
      },
    })
    for (const name of ['bridge', 'legacy', 'shell', 'onboarding']) {
      writeManifest(root, name, {
        name: `@openloop/${name}`,
        private: true,
        openloop: { face: 'pure' },
      })
    }
    writeSource(
      root,
      'shell',
      "import { apply } from '@deepseek-ai/dsh-client-web/src/app-shell.ts'\nvoid apply\n",
    )
    writeSource(
      root,
      'onboarding',
      "export { loadSettings } from '@deepseek-ai/dsh-settings/internal/storage'\n",
    )
    writeSource(
      root,
      'bridge',
      "import type { AppShellService } from '../../../client/web/src/app-shell.ts'\nexport {}\n",
    )
    writeSource(
      root,
      'bridge',
      "import gateway = require('../../../host/gateway')\nexport = gateway\n",
      'legacy.cts',
    )
    writeSource(
      root,
      'legacy',
      "import api = require('@deepseek-ai/dsh-host-gateway/src/api')\nexport = api\n",
      'index.cts',
    )

    expect(collectOpenLoopDshPrivateImportViolations(root)).toEqual([
      'packages/openloop/bridge/src/index.ts:1: Openloop packages may import DSH only through public package exports; "../../../client/web/src/app-shell.ts" is private',
      'packages/openloop/bridge/src/legacy.cts:1: Openloop packages may import DSH only through public package exports; "../../../host/gateway" is private',
      'packages/openloop/legacy/src/index.cts:1: Openloop packages may import DSH only through public package exports; "@deepseek-ai/dsh-host-gateway/src/api" is private',
      'packages/openloop/onboarding/src/index.ts:1: Openloop packages may import DSH only through public package exports; "@deepseek-ai/dsh-settings/internal/storage" is private',
      'packages/openloop/shell/src/index.ts:1: Openloop packages may import DSH only through public package exports; "@deepseek-ai/dsh-client-web/src/app-shell.ts" is private',
    ])
  })

  it('rejects private DSH paths through require, dynamic import, and absolute repo paths', async () => {
    const { collectOpenLoopDshPrivateImportViolations } = await import(
      '../check-workspace-constraints.ts',
    )
    const root = fixtureRoot()
    writePackageManifest(root, 'client', 'web', {
      name: '@deepseek-ai/dsh-client-web',
      exports: {
        '.': './lib/index.js',
      },
    })
    writeManifest(root, 'probe', {
      name: '@openloop/probe',
      private: true,
      openloop: { face: 'pure' },
    })
    const absolutePrivatePath = join(root, 'packages', 'client', 'web', 'src', 'app-shell.ts')
    writeSource(root, 'probe', [
      "require('../../../client/web/src/app-shell.ts')",
      "void import('@deepseek-ai/dsh-client-web/src/app-shell.ts')",
      "void import('../../../client/web/src/app-shell.ts', { with: { type: 'json' } })",
      `void import(${JSON.stringify(absolutePrivatePath)})`,
      "void import('/opt/external/runtime.js')",
      '',
    ].join('\n'))

    expect(collectOpenLoopDshPrivateImportViolations(root)).toEqual([
      'packages/openloop/probe/src/index.ts:1: Openloop packages may import DSH only through public package exports; "../../../client/web/src/app-shell.ts" is private',
      'packages/openloop/probe/src/index.ts:2: Openloop packages may import DSH only through public package exports; "@deepseek-ai/dsh-client-web/src/app-shell.ts" is private',
      'packages/openloop/probe/src/index.ts:3: Openloop packages may import DSH only through public package exports; "../../../client/web/src/app-shell.ts" is private',
      `packages/openloop/probe/src/index.ts:4: Openloop packages may import DSH only through public package exports; ${JSON.stringify(absolutePrivatePath)} is private`,
    ])
  })

  it('rejects static private DSH targets independently of loader call syntax', async () => {
    const { collectOpenLoopDshPrivateImportViolations } = await import(
      '../check-workspace-constraints.ts',
    )
    const root = fixtureRoot()
    writePackageManifest(root, 'host', 'gateway', {
      name: '@deepseek-ai/dsh-host-gateway',
      exports: {
        '.': './lib/index.js',
      },
    })
    writeManifest(root, 'probe', {
      name: '@openloop/probe',
      private: true,
      openloop: { face: 'pure' },
    })
    writeSource(root, 'probe', [
      "(require)('@deepseek-ai/dsh-host-gateway/src/parenthesized')",
      "const ModuleApi = await import('node:module')",
      "ModuleApi.createRequire(import.meta.url)('@deepseek-ai/dsh-host-gateway/src/dynamic-module')",
      "import { createRequire } from 'node:module'",
      'let assignedRequire',
      'assignedRequire = createRequire(import.meta.url)',
      "assignedRequire('@deepseek-ai/dsh-host-gateway/src/assigned')",
      "const { ['createRequire']: computedCreateRequire } = ModuleApi",
      'computedCreateRequire(import.meta.url)(`@deepseek-ai/dsh-host-gateway/src/computed`)',
      "module.require.call(module, '@deepseek-ai/dsh-host-gateway/src/call')",
      '',
    ].join('\n'))

    expect(collectOpenLoopDshPrivateImportViolations(root)).toEqual([
      'packages/openloop/probe/src/index.ts:1: Openloop packages may import DSH only through public package exports; "@deepseek-ai/dsh-host-gateway/src/parenthesized" is private',
      'packages/openloop/probe/src/index.ts:3: Openloop packages may import DSH only through public package exports; "@deepseek-ai/dsh-host-gateway/src/dynamic-module" is private',
      'packages/openloop/probe/src/index.ts:7: Openloop packages may import DSH only through public package exports; "@deepseek-ai/dsh-host-gateway/src/assigned" is private',
      'packages/openloop/probe/src/index.ts:9: Openloop packages may import DSH only through public package exports; "@deepseek-ai/dsh-host-gateway/src/computed" is private',
      'packages/openloop/probe/src/index.ts:10: Openloop packages may import DSH only through public package exports; "@deepseek-ai/dsh-host-gateway/src/call" is private',
    ])
  })

  it('rejects repo-relative private paths but allows non-specifier business text', async () => {
    const { collectOpenLoopDshPrivateImportViolations } = await import(
      '../check-workspace-constraints.ts',
    )
    const root = fixtureRoot()
    writePackageManifest(root, 'host', 'gateway', {
      name: '@deepseek-ai/dsh-host-gateway',
      exports: {
        '.': './lib/index.js',
      },
    })
    writeManifest(root, 'probe', {
      name: '@openloop/probe',
      private: true,
      openloop: { face: 'pure' },
    })
    writeSource(root, 'probe', [
      'const privatePath = `packages/host/gateway/src/private.ts`',
      "const copy = 'Openloop integrates with @deepseek-ai packages through stable adapters.'",
      "const migrationNote = 'Do not import @deepseek-ai/dsh-host-gateway/src/private directly.'",
      "const externalPath = '/opt/external/runtime.js'",
      'void privatePath',
      'void copy',
      'void migrationNote',
      'void externalPath',
      '',
    ].join('\n'))

    expect(collectOpenLoopDshPrivateImportViolations(root)).toEqual([
      'packages/openloop/probe/src/index.ts:1: Openloop packages may import DSH only through public package exports; "packages/host/gateway/src/private.ts" is private',
    ])
  })

  it('normalizes file URL imports and fails closed for malformed file URLs', async () => {
    const { collectOpenLoopDshPrivateImportViolations } = await import(
      '../check-workspace-constraints.ts',
    )
    const root = fixtureRoot()
    writePackageManifest(root, 'client', 'web', {
      name: '@deepseek-ai/dsh-client-web',
      exports: {
        '.': './lib/index.js',
      },
    })
    writeManifest(root, 'probe', {
      name: '@openloop/probe',
      private: true,
      openloop: { face: 'pure' },
    })
    const privatePath = join(root, 'packages', 'client', 'web', 'src', 'private.ts')
    mkdirSync(join(privatePath, '..'), { recursive: true })
    writeFileSync(privatePath, 'export const privateValue = true\n')
    const privateUrl = pathToFileURL(privatePath).href
    const upperPrivateUrl = privateUrl.replace('file:', 'FILE:')
    writeSource(root, 'probe', [
      `void import(${JSON.stringify(privateUrl)})`,
      `void import(${JSON.stringify(upperPrivateUrl)})`,
      "void import('File:///opt/external/runtime.js')",
      "void import('file:///opt/external/runtime.js')",
      "void import('file:///C:/external/runtime.js')",
      "void import('file://%zz')",
      "void import('FILE://%zz')",
      '',
    ].join('\n'))

    expect(collectOpenLoopDshPrivateImportViolations(root)).toEqual([
      `packages/openloop/probe/src/index.ts:1: Openloop packages may import DSH only through public package exports; ${JSON.stringify(privateUrl)} is private`,
      `packages/openloop/probe/src/index.ts:2: Openloop packages may import DSH only through public package exports; ${JSON.stringify(upperPrivateUrl)} is private`,
      'packages/openloop/probe/src/index.ts:6: Openloop packages may import DSH only through public package exports; "file://%zz" is private',
      'packages/openloop/probe/src/index.ts:7: Openloop packages may import DSH only through public package exports; "FILE://%zz" is private',
    ])
  })

  it('rejects static private DSH targets in import types, JSDoc imports, and require.resolve', async () => {
    const { collectOpenLoopDshPrivateImportViolations } = await import(
      '../check-workspace-constraints.ts',
    )
    const root = fixtureRoot()
    writePackageManifest(root, 'host', 'gateway', {
      name: '@deepseek-ai/dsh-host-gateway',
      exports: {
        '.': './lib/index.js',
      },
    })
    writeManifest(root, 'probe', {
      name: '@openloop/probe',
      private: true,
      openloop: { face: 'pure' },
    })
    writeSource(root, 'probe', [
      "type PrivateApi = import('@deepseek-ai/dsh-host-gateway/src/private').PrivateApi",
      "const privatePath = require.resolve('@deepseek-ai/dsh-host-gateway/src/resolve')",
      "const privatePathWithOptions = require.resolve('@deepseek-ai/dsh-host-gateway/src/resolve-options', { paths: [] })",
      "const dynamicTarget = '@deepseek-ai/dsh-host-gateway/src/dynamic'",
      'require.resolve(dynamicTarget)',
      'void privatePath',
      'void privatePathWithOptions',
      '',
    ].join('\n'))
    writeSource(root, 'probe', [
      "/** @typedef {import('@deepseek-ai/dsh-host-gateway/src/jsdoc').PrivateApi} PrivateApi */",
      "const dynamicTarget = '@deepseek-ai/dsh-host-gateway/src/dynamic-jsdoc'",
      '/** @typedef {import(dynamicTarget).PrivateApi} DynamicPrivateApi */',
      'void dynamicTarget',
      '',
    ].join('\n'), 'jsdoc.js')

    expect(collectOpenLoopDshPrivateImportViolations(root)).toEqual([
      'packages/openloop/probe/src/index.ts:1: Openloop packages may import DSH only through public package exports; "@deepseek-ai/dsh-host-gateway/src/private" is private',
      'packages/openloop/probe/src/index.ts:2: Openloop packages may import DSH only through public package exports; "@deepseek-ai/dsh-host-gateway/src/resolve" is private',
      'packages/openloop/probe/src/index.ts:3: Openloop packages may import DSH only through public package exports; "@deepseek-ai/dsh-host-gateway/src/resolve-options" is private',
      'packages/openloop/probe/src/index.ts:4: Openloop packages may import DSH only through public package exports; "@deepseek-ai/dsh-host-gateway/src/dynamic" is private',
      'packages/openloop/probe/src/jsdoc.js:1: Openloop packages may import DSH only through public package exports; "@deepseek-ai/dsh-host-gateway/src/jsdoc" is private',
      'packages/openloop/probe/src/jsdoc.js:2: Openloop packages may import DSH only through public package exports; "@deepseek-ai/dsh-host-gateway/src/dynamic-jsdoc" is private',
    ])
  })

  it('rejects private literals independently of shadowed require bindings', async () => {
    const { collectOpenLoopDshPrivateImportViolations } = await import(
      '../check-workspace-constraints.ts',
    )
    const root = fixtureRoot()
    writePackageManifest(root, 'host', 'gateway', {
      name: '@deepseek-ai/dsh-host-gateway',
      exports: {
        '.': './lib/index.js',
      },
    })
    writeManifest(root, 'probe', {
      name: '@openloop/probe',
      private: true,
      openloop: { face: 'pure' },
    })
    writeSource(root, 'probe', [
      "require('@deepseek-ai/dsh-host-gateway/src/global')",
      "require.resolve('@deepseek-ai/dsh-host-gateway/src/global-resolve')",
      '',
    ].join('\n'), 'global.cts')
    writeSource(root, 'probe', [
      'function require(value: string): string { return value }',
      "require('@deepseek-ai/dsh-host-gateway/src/local-function')",
      'function load(require: { (value: string): string; resolve(value: string): string }) {',
      "  require('@deepseek-ai/dsh-host-gateway/src/local-parameter')",
      "  require.resolve('@deepseek-ai/dsh-host-gateway/src/local-parameter-resolve')",
      '}',
      'void load',
      '',
    ].join('\n'), 'shadowed.ts')

    expect(collectOpenLoopDshPrivateImportViolations(root)).toEqual([
      'packages/openloop/probe/src/global.cts:1: Openloop packages may import DSH only through public package exports; "@deepseek-ai/dsh-host-gateway/src/global" is private',
      'packages/openloop/probe/src/global.cts:2: Openloop packages may import DSH only through public package exports; "@deepseek-ai/dsh-host-gateway/src/global-resolve" is private',
      'packages/openloop/probe/src/shadowed.ts:2: Openloop packages may import DSH only through public package exports; "@deepseek-ai/dsh-host-gateway/src/local-function" is private',
      'packages/openloop/probe/src/shadowed.ts:4: Openloop packages may import DSH only through public package exports; "@deepseek-ai/dsh-host-gateway/src/local-parameter" is private',
      'packages/openloop/probe/src/shadowed.ts:5: Openloop packages may import DSH only through public package exports; "@deepseek-ai/dsh-host-gateway/src/local-parameter-resolve" is private',
    ])
  })

  it('rejects private literals without tracking createRequire or module.require data flow', async () => {
    const { collectOpenLoopDshPrivateImportViolations } = await import(
      '../check-workspace-constraints.ts',
    )
    const root = fixtureRoot()
    writePackageManifest(root, 'host', 'gateway', {
      name: '@deepseek-ai/dsh-host-gateway',
      exports: {
        '.': './lib/index.js',
      },
    })
    writeManifest(root, 'probe', {
      name: '@openloop/probe',
      private: true,
      openloop: { face: 'pure' },
    })
    writeSource(root, 'probe', [
      "import ModuleDefault from 'node:module'",
      "import { createRequire } from 'node:module'",
      "import { createRequire as makeRequire } from 'module'",
      "import * as ModuleApi from 'node:module'",
      "const { createRequire: commonJsCreateRequire } = require('node:module')",
      'const defaultRequire = ModuleDefault.createRequire(import.meta.url)',
      "const defaultElementRequire = ModuleDefault['createRequire'](import.meta.url)",
      'const localRequire = createRequire(import.meta.url)',
      'const aliasedRequire = makeRequire(import.meta.url)',
      'const namespaceRequire = ModuleApi.createRequire(import.meta.url)',
      "const namespaceElementRequire = ModuleApi['createRequire'](import.meta.url)",
      'const commonJsRequire = commonJsCreateRequire(import.meta.url)',
      "defaultRequire('@deepseek-ai/dsh-host-gateway/src/default')",
      "defaultElementRequire('@deepseek-ai/dsh-host-gateway/src/default-element')",
      "localRequire('@deepseek-ai/dsh-host-gateway/src/local')",
      "aliasedRequire.resolve('@deepseek-ai/dsh-host-gateway/src/aliased')",
      "namespaceRequire('@deepseek-ai/dsh-host-gateway/src/namespace')",
      "namespaceElementRequire('@deepseek-ai/dsh-host-gateway/src/namespace-element')",
      "commonJsRequire('@deepseek-ai/dsh-host-gateway/src/commonjs-destructured')",
      "module.require('@deepseek-ai/dsh-host-gateway/src/commonjs-property')",
      "module['require']('@deepseek-ai/dsh-host-gateway/src/commonjs-element')",
      'const ordinary = { require: (value: string) => value }',
      "ordinary.require('@deepseek-ai/dsh-host-gateway/src/ordinary-object')",
      'function load(',
      '  module: { require(value: string): string },',
      '  ModuleDefault: { createRequire(url: string): (value: string) => string },',
      ') {',
      "  module.require('@deepseek-ai/dsh-host-gateway/src/shadowed-module')",
      "  module['require']('@deepseek-ai/dsh-host-gateway/src/shadowed-module-element')",
      '  const shadowedRequire = ModuleDefault.createRequire(import.meta.url)',
      "  shadowedRequire('@deepseek-ai/dsh-host-gateway/src/shadowed-default')",
      '}',
      'void load',
      '',
    ].join('\n'), 'imports.cts')
    writeSource(root, 'probe', [
      'function createRequire(_url: string) {',
      '  return (value: string): string => value',
      '}',
      'const localRequire = createRequire(import.meta.url)',
      "localRequire('@deepseek-ai/dsh-host-gateway/src/shadowed-create-require')",
      'const ModuleApi = { createRequire }',
      'const namespaceRequire = ModuleApi.createRequire(import.meta.url)',
      "namespaceRequire('@deepseek-ai/dsh-host-gateway/src/shadowed-namespace')",
      'const userModule = { createRequire }',
      'const { createRequire: userCreateRequire } = userModule',
      'const userRequire = userCreateRequire(import.meta.url)',
      "userRequire('@deepseek-ai/dsh-host-gateway/src/user-create-require')",
      '',
    ].join('\n'), 'shadowed-create-require.ts')

    expect(collectOpenLoopDshPrivateImportViolations(root)).toEqual([
      'packages/openloop/probe/src/imports.cts:13: Openloop packages may import DSH only through public package exports; "@deepseek-ai/dsh-host-gateway/src/default" is private',
      'packages/openloop/probe/src/imports.cts:14: Openloop packages may import DSH only through public package exports; "@deepseek-ai/dsh-host-gateway/src/default-element" is private',
      'packages/openloop/probe/src/imports.cts:15: Openloop packages may import DSH only through public package exports; "@deepseek-ai/dsh-host-gateway/src/local" is private',
      'packages/openloop/probe/src/imports.cts:16: Openloop packages may import DSH only through public package exports; "@deepseek-ai/dsh-host-gateway/src/aliased" is private',
      'packages/openloop/probe/src/imports.cts:17: Openloop packages may import DSH only through public package exports; "@deepseek-ai/dsh-host-gateway/src/namespace" is private',
      'packages/openloop/probe/src/imports.cts:18: Openloop packages may import DSH only through public package exports; "@deepseek-ai/dsh-host-gateway/src/namespace-element" is private',
      'packages/openloop/probe/src/imports.cts:19: Openloop packages may import DSH only through public package exports; "@deepseek-ai/dsh-host-gateway/src/commonjs-destructured" is private',
      'packages/openloop/probe/src/imports.cts:20: Openloop packages may import DSH only through public package exports; "@deepseek-ai/dsh-host-gateway/src/commonjs-property" is private',
      'packages/openloop/probe/src/imports.cts:21: Openloop packages may import DSH only through public package exports; "@deepseek-ai/dsh-host-gateway/src/commonjs-element" is private',
      'packages/openloop/probe/src/imports.cts:23: Openloop packages may import DSH only through public package exports; "@deepseek-ai/dsh-host-gateway/src/ordinary-object" is private',
      'packages/openloop/probe/src/imports.cts:28: Openloop packages may import DSH only through public package exports; "@deepseek-ai/dsh-host-gateway/src/shadowed-module" is private',
      'packages/openloop/probe/src/imports.cts:29: Openloop packages may import DSH only through public package exports; "@deepseek-ai/dsh-host-gateway/src/shadowed-module-element" is private',
      'packages/openloop/probe/src/imports.cts:31: Openloop packages may import DSH only through public package exports; "@deepseek-ai/dsh-host-gateway/src/shadowed-default" is private',
      'packages/openloop/probe/src/shadowed-create-require.ts:5: Openloop packages may import DSH only through public package exports; "@deepseek-ai/dsh-host-gateway/src/shadowed-create-require" is private',
      'packages/openloop/probe/src/shadowed-create-require.ts:8: Openloop packages may import DSH only through public package exports; "@deepseek-ai/dsh-host-gateway/src/shadowed-namespace" is private',
      'packages/openloop/probe/src/shadowed-create-require.ts:12: Openloop packages may import DSH only through public package exports; "@deepseek-ai/dsh-host-gateway/src/user-create-require" is private',
    ])
  })

  it('lets a specific null export block a broader wildcard without regressing target forms', async () => {
    const { collectOpenLoopDshPrivateImportViolations } = await import(
      '../check-workspace-constraints.ts',
    )
    const root = fixtureRoot()
    writePackageManifest(root, 'host', 'gateway', {
      name: '@deepseek-ai/dsh-host-gateway',
      exports: {
        '.': './lib/index.js',
        './features/*': './lib/features/*.js',
        './features/private': null,
        './conditional': {
          node: './lib/conditional.js',
          default: null,
        },
        './array': [null, './lib/array.js'],
      },
    })
    writeManifest(root, 'probe', {
      name: '@openloop/probe',
      private: true,
      openloop: { face: 'pure' },
    })
    writeSource(root, 'probe', [
      "import '@deepseek-ai/dsh-host-gateway/features/public'",
      "import '@deepseek-ai/dsh-host-gateway/features/private'",
      "import '@deepseek-ai/dsh-host-gateway/conditional'",
      "import '@deepseek-ai/dsh-host-gateway/array'",
      '',
    ].join('\n'))

    expect(collectOpenLoopDshPrivateImportViolations(root)).toEqual([
      'packages/openloop/probe/src/index.ts:2: Openloop packages may import DSH only through public package exports; "@deepseek-ai/dsh-host-gateway/features/private" is private',
    ])
  })

  it('rejects an Openloop-relative import that resolves through a symlink into DSH source', async () => {
    const { collectOpenLoopDshPrivateImportViolations } = await import(
      '../check-workspace-constraints.ts',
    )
    const root = fixtureRoot()
    writePackageManifest(root, 'client', 'web', {
      name: '@deepseek-ai/dsh-client-web',
      exports: {
        '.': './lib/index.js',
      },
    })
    const dshSource = join(root, 'packages', 'client', 'web', 'src')
    mkdirSync(dshSource, { recursive: true })
    writeFileSync(join(dshSource, 'private.ts'), 'export const privateValue = true\n')
    writeManifest(root, 'probe', {
      name: '@openloop/probe',
      private: true,
      openloop: { face: 'pure' },
    })
    const probeSource = join(root, 'packages', 'openloop', 'probe', 'src')
    mkdirSync(probeSource, { recursive: true })
    symlinkSync(
      dshSource,
      join(probeSource, 'dsh-source'),
      process.platform === 'win32' ? 'junction' : 'dir',
    )
    writeSource(root, 'probe', "import './dsh-source/private.ts'\n")

    expect(collectOpenLoopDshPrivateImportViolations(root)).toEqual([
      'packages/openloop/probe/tsconfig.json: Openloop package compiler input packages/client/web/src/private.ts must not include private DSH source',
      'packages/openloop/probe/src/index.ts:1: Openloop packages may import DSH only through public package exports; "./dsh-source/private.ts" is private',
    ])
  })
})
