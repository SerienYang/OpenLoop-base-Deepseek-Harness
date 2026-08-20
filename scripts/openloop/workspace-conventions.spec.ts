import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const roots: string[] = []

function fixtureRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'openloop-workspace-'))
  roots.push(root)
  writeJson(join(root, 'tsconfig.host.json'), { files: [], references: [] })
  writeJson(join(root, 'tsconfig.client.json'), { files: [], references: [] })
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

function writeManifest(root: string, name: string, manifest: object): void {
  writePackageManifest(root, 'openloop', name, manifest)
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
})
