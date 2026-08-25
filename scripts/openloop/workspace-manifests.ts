import { globSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import * as yaml from 'js-yaml'

const WORKSPACE_EXCLUDES = [
  '**/node_modules/**',
  '**/fixtures/**',
  '**/.turbo/**',
  '**/dist/**',
  '**/lib/**',
  '**/build/**',
  '**/out/**',
  '**/output/**',
  '**/coverage/**',
  '**/target/**',
] as const

/** Resolve only package-root manifests selected by the root pnpm workspace. */
export function workspacePackageManifestPaths(root: string): string[] {
  const workspacePath = resolve(root, 'pnpm-workspace.yaml')
  let parsed: unknown
  try {
    parsed = yaml.load(readFileSync(workspacePath, 'utf8'))
  } catch (error) {
    throw new Error(
      `browser-api-drift: cannot parse root workspace manifest ${workspacePath}`,
      { cause: error },
    )
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`browser-api-drift: root workspace manifest ${workspacePath} must be an object`)
  }
  const members = (parsed as { packages?: unknown }).packages
  if (!Array.isArray(members)
    || members.length === 0
    || members.some(member => typeof member !== 'string' || member.trim() === '')) {
    throw new Error(
      `browser-api-drift: root workspace manifest ${workspacePath} must declare non-empty package globs`,
    )
  }

  const patterns = members as string[]
  const manifestPattern = (member: string): string =>
    `${member.replace(/\/+$/u, '')}/package.json`
  const include = patterns
    .filter(member => !member.startsWith('!'))
    .map(manifestPattern)
  const exclude = [
    ...patterns
      .filter(member => member.startsWith('!'))
      .map(member => manifestPattern(member.slice(1))),
    ...WORKSPACE_EXCLUDES,
  ]
  if (include.length === 0) {
    throw new Error(
      `browser-api-drift: root workspace manifest ${workspacePath} declares no included packages`,
    )
  }
  return globSync(include, { cwd: root, exclude })
    .sort()
    .map(path => resolve(root, path))
}
