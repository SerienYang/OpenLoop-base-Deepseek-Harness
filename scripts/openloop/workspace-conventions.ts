import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

export const openLoopFaces = ['host', 'client', 'pure'] as const

export type OpenLoopFace = typeof openLoopFaces[number]

interface OpenLoopManifest {
  name?: string
  private?: boolean
  openloop?: {
    face?: unknown
    cordisPlugin?: unknown
    service?: unknown
  }
  peerDependencies?: Record<string, string>
  devDependencies?: Record<string, string>
}

const cordisPackage = '@deepseek-ai/cordis'

function readManifest(path: string): OpenLoopManifest {
  return JSON.parse(readFileSync(path, 'utf8')) as OpenLoopManifest
}

function isCordisPlugin(manifest: OpenLoopManifest): boolean {
  return manifest.openloop?.cordisPlugin === true
    || typeof manifest.openloop?.service === 'string'
    || manifest.peerDependencies?.[cordisPackage] !== undefined
    || manifest.devDependencies?.[cordisPackage] !== undefined
}

/**
 * Validate the product-owned package namespace without changing DSH's public
 * package policy.
 */
export function collectOpenLoopWorkspaceViolations(root: string): string[] {
  const packagesRoot = join(root, 'packages', 'openloop')
  if (!existsSync(packagesRoot)) return []

  const errors: string[] = []
  const packageDirectories = readdirSync(packagesRoot, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .sort((left, right) => left.name.localeCompare(right.name))

  for (const entry of packageDirectories) {
    const relativeManifestPath = `packages/openloop/${entry.name}/package.json`
    const manifestPath = join(packagesRoot, entry.name, 'package.json')
    if (!existsSync(manifestPath)) continue

    const manifest = readManifest(manifestPath)
    const expectedName = `@openloop/${entry.name}`
    if (manifest.name !== expectedName) {
      errors.push(`${relativeManifestPath}: package name must be ${expectedName}`)
    }
    if (manifest.private !== true) {
      errors.push(`${relativeManifestPath}: OpenLoop packages must set "private": true`)
    }
    if (!openLoopFaces.includes(manifest.openloop?.face as OpenLoopFace)) {
      errors.push(`${relativeManifestPath}: openloop.face must be exactly one of host, client, or pure`)
    }

    if (!isCordisPlugin(manifest)) continue
    const peer = manifest.peerDependencies?.[cordisPackage]
    const dev = manifest.devDependencies?.[cordisPackage]
    if (peer === undefined) {
      errors.push(`${relativeManifestPath}: Cordis plugin must declare ${cordisPackage} as a peerDependency`)
    }
    if (dev === undefined) {
      errors.push(`${relativeManifestPath}: Cordis plugin must also declare ${cordisPackage} as a devDependency`)
    }
    if (peer !== undefined && dev !== undefined && peer !== dev) {
      errors.push(`${relativeManifestPath}: ${cordisPackage} peer (${peer}) and dev (${dev}) ranges must match`)
    }
  }

  return errors
}
