import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import ts from 'typescript'

const openLoopFaces = ['host', 'client', 'pure'] as const

type OpenLoopFace = typeof openLoopFaces[number]

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

interface AggregateConfig {
  references?: ReadonlyArray<{ path?: unknown }>
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

function aggregateReferences(root: string, face: 'host' | 'client'): readonly string[] {
  const path = join(root, `tsconfig.${face}.json`)
  if (!existsSync(path)) return []
  const parsed = ts.readConfigFile(path, file => ts.sys.readFile(file))
  if (parsed.error !== undefined) {
    const message = ts.flattenDiagnosticMessageText(parsed.error.messageText, '\n')
    throw new Error(`tsconfig.${face}.json: ${message}`)
  }
  const config = parsed.config as AggregateConfig
  return (config.references ?? [])
    .map(reference => reference.path)
    .filter((reference): reference is string => typeof reference === 'string')
}

/**
 * Preserve the upstream package namespace for every DSH package group. The
 * product-owned packages/openloop group is the only exception.
 */
export function collectDshWorkspaceNamingViolations(root: string): string[] {
  const packagesRoot = join(root, 'packages')
  if (!existsSync(packagesRoot)) return []

  const errors: string[] = []
  const groups = readdirSync(packagesRoot, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && entry.name !== 'openloop')
    .sort((left, right) => left.name.localeCompare(right.name))

  for (const group of groups) {
    const groupRoot = join(packagesRoot, group.name)
    const packages = readdirSync(groupRoot, { withFileTypes: true })
      .filter(entry => entry.isDirectory())
      .sort((left, right) => left.name.localeCompare(right.name))
    for (const entry of packages) {
      const manifestPath = join(groupRoot, entry.name, 'package.json')
      if (!existsSync(manifestPath)) continue
      const manifest = readManifest(manifestPath)
      if (manifest.name?.startsWith('@deepseek-ai/dsh-') === true) continue
      errors.push(
        `packages/${group.name}/${entry.name}/package.json: DSH packages must use the @deepseek-ai/dsh-* namespace`,
      )
    }
  }

  return errors
}

/**
 * Validate the product-owned package namespace without changing DSH's public
 * package policy.
 */
export function collectOpenLoopWorkspaceViolations(root: string): string[] {
  const packagesRoot = join(root, 'packages', 'openloop')
  if (!existsSync(packagesRoot)) return []

  const errors: string[] = []
  const aggregates = {
    host: aggregateReferences(root, 'host'),
    client: aggregateReferences(root, 'client'),
  }
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
    const face = manifest.openloop?.face
    if (!openLoopFaces.includes(face as OpenLoopFace)) {
      errors.push(`${relativeManifestPath}: openloop.face must be exactly one of host, client, or pure`)
    } else {
      const expectedFace = face === 'client' ? 'client' : 'host'
      const otherFace = expectedFace === 'client' ? 'host' : 'client'
      const reference = `./packages/openloop/${entry.name}`
      const expectedCount = aggregates[expectedFace].filter(path => path === reference).length
      const otherCount = aggregates[otherFace].filter(path => path === reference).length
      if (expectedCount !== 1 || otherCount !== 0) {
        errors.push(
          `${relativeManifestPath}: openloop.face ${String(face)} requires exactly one tsconfig.${expectedFace}.json reference and no tsconfig.${otherFace}.json reference (found ${expectedFace}=${expectedCount}, ${otherFace}=${otherCount})`,
        )
      }
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
