import { isDeepStrictEqual } from 'node:util'
import type { PatchOptions } from '@deepseek-ai/cordis-plugin-include'
import type { EntryOptions } from '@deepseek-ai/cordis-plugin-loader'

const PROTECTED_ROW_IDS = new Set([
  'desktop-bridge-host',
  'connection',
  'typert-gateway',
  'web-startup',
  'webserver',
  'web-runtime',
  'modules',
  'api-remotes',
  'api-gateway',
  'client-hmr',
  'cordis-client-runner',
  'ui-cordis',
  'openloop-bootstrap',
  'credentials',
  'settings',
  'sandbox',
  'sandbox-policy',
  'bash-sandbox',
  'pwsh-sandbox',
  'approval',
  'permission',
  'fs-observation-policy',
  'session-checkpoint-policy',
])

const REQUIRED_WEB_ROWS = ['web-startup', 'webserver', 'web-runtime'] as const

function rowMap(rows: readonly EntryOptions[], label: string): Map<string, EntryOptions> {
  const result = new Map<string, EntryOptions>()
  for (const row of rows) {
    if (typeof row.id !== 'string' || row.id === '') {
      throw new Error(`openloop-runtime: ${label} contains a row without an id`)
    }
    if (result.has(row.id)) {
      throw new Error(`openloop-runtime: ${label} repeats signed row ${JSON.stringify(row.id)}`)
    }
    result.set(row.id, row)
  }
  return result
}

function topologyOf(row: EntryOptions): Readonly<Record<string, unknown>> {
  const topology: Record<string, unknown> = {}
  const source = row as unknown as Readonly<Record<string, unknown>>
  for (const key of Reflect.ownKeys(row)) {
    if (typeof key !== 'string' || key === 'config') continue
    topology[key] = source[key]
  }
  if (row.group === true && Array.isArray(row.config)) {
    topology.config = (row.config as EntryOptions[]).map(child => topologyOf(child))
  }
  return topology
}

function requireRow(rows: ReadonlyMap<string, EntryOptions>, id: string): EntryOptions {
  const row = rows.get(id)
  if (row === undefined) {
    throw new Error(`openloop-runtime: signed Openloop profile is missing required row ${JSON.stringify(id)}`)
  }
  return row
}

function requireInject(row: EntryOptions, service: string): void {
  if (!Array.isArray(row.inject) || !row.inject.includes(service)) {
    throw new Error(
      `openloop-runtime: signed row ${JSON.stringify(row.id)} must inject ${JSON.stringify(service)}`,
    )
  }
}

/**
 * Validate only the user-owned patch layer. Signed bundle patches must never
 * pass through this boundary or they would be mistaken for untrusted input.
 */
export function validateOpenloopUserPatches(
  userPatches: readonly PatchOptions[],
  signedRows: readonly EntryOptions[],
): PatchOptions[] {
  const signed = rowMap(signedRows, 'signed profile')
  return userPatches.map((patch, index) => {
    const candidate: unknown = patch
    if (typeof candidate !== 'object' || candidate === null || Array.isArray(candidate)) {
      throw new Error(`openloop-runtime: user patch ${String(index + 1)} must be a mapping`)
    }
    const checked = candidate as PatchOptions
    const keys = Reflect.ownKeys(checked)
    const invalid = keys.find(key => key !== 'id' && key !== 'config')
    if (invalid !== undefined) {
      throw new Error(
        `openloop-runtime: user patch ${String(index + 1)} may modify only config; `
        + `topology field ${JSON.stringify(String(invalid))} is forbidden`,
      )
    }
    if (typeof checked.id !== 'string' || checked.id === '') {
      throw new Error(`openloop-runtime: user patch ${String(index + 1)} must target one signed row id`)
    }
    const baseline = signed.get(checked.id)
    if (baseline === undefined) {
      throw new Error(`openloop-runtime: user patch targets unknown signed row ${JSON.stringify(checked.id)}`)
    }
    if (PROTECTED_ROW_IDS.has(checked.id)) {
      throw new Error(`openloop-runtime: user patch cannot touch protected row ${JSON.stringify(checked.id)}`)
    }
    if (baseline.group === true || Array.isArray(baseline.config)) {
      throw new Error(`openloop-runtime: user patch cannot replace group topology through ${JSON.stringify(checked.id)} config`)
    }
    if (!Object.hasOwn(checked, 'config')) {
      throw new Error(`openloop-runtime: user patch for ${JSON.stringify(checked.id)} must contain config`)
    }
    return structuredClone(checked)
  })
}

/**
 * Recheck the complete effective profile after composition. The signed rows
 * are the only topology authority; user-owned data is never used as baseline.
 */
export function assertOpenloopProfileSecurity(
  signedRows: readonly EntryOptions[],
  effectiveRows: readonly EntryOptions[],
  includeHostBootstrap: boolean,
): void {
  const signed = rowMap(signedRows, 'signed profile')
  const effective = rowMap(effectiveRows, 'effective profile')

  for (const id of REQUIRED_WEB_ROWS) requireRow(effective, id)

  if (signed.size !== effective.size) {
    throw new Error('openloop-runtime: effective profile changed the signed row roster')
  }
  for (const [id, signedRow] of signed) {
    const effectiveRow = effective.get(id)
    if (effectiveRow === undefined || !isDeepStrictEqual(topologyOf(effectiveRow), topologyOf(signedRow))) {
      throw new Error(`openloop-runtime: effective profile changed signed topology for row ${JSON.stringify(id)}`)
    }
  }

  const policyOwner = requireRow(effective, 'desktop-bridge-host')
  if (policyOwner.name !== '@openloop/desktop-bridge-host' || policyOwner.disabled === true) {
    throw new Error('openloop-runtime: browser policy owner must be enabled with its signed name')
  }
  requireInject(policyOwner, 'runtimeBootstrap')
  requireInject(requireRow(effective, 'connection'), 'browserApiPolicy')
  requireInject(requireRow(effective, 'typert-gateway'), 'browserApiPolicy')

  for (const id of ['cordis-client-runner', 'ui-cordis']) {
    if (requireRow(effective, id).disabled !== true) {
      throw new Error(`openloop-runtime: dynamic Client row ${JSON.stringify(id)} must remain disabled`)
    }
  }

  const bootstrap = effective.get('openloop-bootstrap')
  if (includeHostBootstrap) {
    if (bootstrap?.name !== '@openloop/bundle/bootstrap-host' || bootstrap.disabled === true) {
      throw new Error('openloop-runtime: Host bootstrap must be enabled with its signed name')
    }
  } else if (bootstrap !== undefined) {
    throw new Error('openloop-runtime: health smoke must not mount the Host bootstrap')
  }
}
