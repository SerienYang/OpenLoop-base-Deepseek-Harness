import { readFileSync } from 'node:fs'
import { matchesGlob } from 'node:path'
import type { AppInfo } from '@openloop/desktop-bridge-host/types'
import { describe, expect, it } from 'vitest'

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
})
