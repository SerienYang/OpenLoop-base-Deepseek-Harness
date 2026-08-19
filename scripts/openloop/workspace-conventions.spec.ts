import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const roots: string[] = []

function fixtureRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'openloop-workspace-'))
  roots.push(root)
  return root
}

function writeManifest(root: string, name: string, manifest: object): void {
  const directory = join(root, 'packages', 'openloop', name)
  mkdirSync(directory, { recursive: true })
  writeFileSync(join(directory, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`)
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('OpenLoop workspace conventions', () => {
  it('accepts private @openloop packages with exactly one compiler face', async () => {
    const { collectOpenLoopWorkspaceViolations } = await import('./workspace-conventions.ts')
    const root = fixtureRoot()
    writeManifest(root, 'window-state', {
      name: '@openloop/window-state',
      private: true,
      openloop: { face: 'pure' },
    })

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

    expect(collectOpenLoopWorkspaceViolations(root)).toEqual([
      'packages/openloop/lifecycle/package.json: Cordis plugin must declare @deepseek-ai/cordis as a peerDependency',
      'packages/openloop/lifecycle/package.json: Cordis plugin must also declare @deepseek-ai/cordis as a devDependency',
    ])
  })
})
