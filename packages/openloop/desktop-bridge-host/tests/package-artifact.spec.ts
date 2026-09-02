import { readFileSync } from 'node:fs'
import { matchesGlob } from 'node:path'
import type { AppInfo, WorkspaceGrantView } from '@openloop/desktop-bridge-host/types'
import { describe, expect, expectTypeOf, it } from 'vitest'

interface PackageManifest {
  readonly exports: Readonly<Record<string, Readonly<Record<string, string>>>>
  readonly files: readonly string[]
}

const manifest = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
) as PackageManifest

function isIncludedInPackage(target: string): boolean {
  const path = target.replace(/^\.\//u, '')
  return manifest.files.some(pattern => matchesGlob(path, pattern))
}

describe('desktop bridge Host package artifact', () => {
  it('ships every relative JavaScript chunk imported by its runtime entries', () => {
    for (const entry of ['lib/index.js', 'lib/typert.host.js', 'lib/typert.remote-client.js']) {
      const source = readFileSync(new URL(`../${entry}`, import.meta.url), 'utf8')
      const imports = [...source.matchAll(/from\s+["'](\.\/[^"']+\.js)["']/gu)]
        .map(match => `lib/${match[1]?.slice(2)}`)
      for (const imported of imports) {
        expect(isIncludedInPackage(imported), `${entry} imports omitted package file ${imported}`)
          .toBe(true)
      }
    }
  })

  it('publishes the types-only subpath without advertising a runtime module', () => {
    const typesExport = manifest.exports['./types']
    const appInfo = {
      appVersion: '1.0.0',
      channel: 'stable',
    } satisfies AppInfo

    expect(appInfo.channel).toBe('stable')
    expect(typesExport).toEqual({
      types: './lib/types/types.d.ts',
    })
    expect(isIncludedInPackage(typesExport?.types ?? '')).toBe(true)
  })

  it('publishes only the browser-safe Workspace grant projection', () => {
    expectTypeOf<keyof WorkspaceGrantView>().toEqualTypeOf<
      'workspaceId' | 'name' | 'displayPath' | 'state' | 'sessionIds'
    >()
    expectTypeOf<WorkspaceGrantView>().not.toHaveProperty('canonicalPath')
    expectTypeOf<WorkspaceGrantView>().not.toHaveProperty('identity')
    expectTypeOf<WorkspaceGrantView>().not.toHaveProperty('fd')
    expectTypeOf<WorkspaceGrantView>().not.toHaveProperty('pendingGrantId')
  })
})
