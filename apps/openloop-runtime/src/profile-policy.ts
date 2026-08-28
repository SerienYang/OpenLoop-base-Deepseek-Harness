import { isDeepStrictEqual } from 'node:util'
import type { PatchOptions } from '@deepseek-ai/cordis-plugin-include'
import type { EntryOptions } from '@deepseek-ai/cordis-plugin-loader'

export const OPENLOOP_ALLOWED_AGENT_PRESET_IDS = ['standard', 'code'] as const

export const OPENLOOP_AGENT_PRESET_PATCHES: readonly PatchOptions[] = [
  { id: 'tool-bash', disabled: true },
  { id: 'tool-pwsh', disabled: true },
  { id: 'tool-fs-search', disabled: true },
  { id: 'pty', disabled: true },
  { id: 'terminal-bash', disabled: true },
  { id: 'persistent-bash', disabled: true },
  { id: 'terminal', disabled: true },
  { id: 'tool-terminal', disabled: true },
  { id: 'lsp-stdio', disabled: true },
  { id: 'tool-lsp', disabled: true },
  { id: 'mcp-stdio', disabled: true },
  { id: 'subagent-acp', disabled: true },
  { id: 'subagent-codex', disabled: true },
  { id: 'subagent-claude-code', disabled: true },
  { id: 'subagent-dsh-sdk', disabled: true },
  { id: 'tool-subagent-codex', disabled: true },
  { id: 'tool-subagent-claude-code', disabled: true },
  { id: 'tool-presentation', disabled: true },
  { id: 'tool-cordis', disabled: true },
  { id: 'filesystem', isolate: null },
  { id: 'fs-local', disabled: true },
]

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
  'code-runtime',
  'subprocess',
  'sandbox',
  'sandbox-policy',
  'bash-sandbox',
  'pwsh-sandbox',
  'tool-bash',
  'tool-pwsh',
  'approval',
  'permission',
  'fs-observation-policy',
  'fs-sandbox',
  'fs-workspace',
  'sandbox-workspace',
  'tool-fs-search',
  'agent-presets',
  'session-checkpoint-policy',
])

const REQUIRED_WEB_ROWS = ['web-startup', 'webserver', 'web-runtime'] as const
const DISABLED_PROCESS_ROWS = new Map([
  ['code-runtime', '@deepseek-ai/dsh-code-runtime-worker-thread'],
  ['subprocess', '@deepseek-ai/dsh-subprocess-local'],
  ['bash-sandbox', '@deepseek-ai/dsh-bash-sandbox'],
  ['pwsh-sandbox', '@deepseek-ai/dsh-pwsh-sandbox'],
  ['tool-bash', '@deepseek-ai/dsh-tool-bash'],
  ['tool-pwsh', '@deepseek-ai/dsh-tool-pwsh'],
  ['tool-fs-search', '@deepseek-ai/dsh-tool-fs-search'],
])

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

  if (requireRow(effective, 'fs-sandbox').disabled !== true) {
    throw new Error('openloop-runtime: direct host filesystem provider must remain disabled')
  }
  const workspaceFs = requireRow(effective, 'fs-workspace')
  if (workspaceFs.name !== '@openloop/fs-workspace' || workspaceFs.disabled === true) {
    throw new Error('openloop-runtime: Workspace filesystem provider must remain enabled')
  }
  for (const service of ['fileBroker', 'workspaceRegistry', 'sandboxPolicy']) {
    requireInject(workspaceFs, service)
  }
  const workspaceProcess = requireRow(effective, 'sandbox-workspace')
  if (workspaceProcess.name !== '@openloop/sandbox-workspace' || workspaceProcess.disabled === true) {
    throw new Error('openloop-runtime: disabled Workspace process capability must remain mounted with its signed name')
  }
  for (const [id, name] of DISABLED_PROCESS_ROWS) {
    const row = requireRow(effective, id)
    if (row.name !== name || row.disabled !== true) {
      throw new Error(`openloop-runtime: process capability ${JSON.stringify(id)} must remain disabled`)
    }
  }

  const presetConfig = requireRow(effective, 'agent-presets').config as
    | Readonly<Record<string, unknown>>
    | undefined
  if (presetConfig === undefined
    || presetConfig['includeUserRoot'] !== false
    || !isDeepStrictEqual(presetConfig['allowedPresetIds'], OPENLOOP_ALLOWED_AGENT_PRESET_IDS)
    || !isDeepStrictEqual(presetConfig['patches'], OPENLOOP_AGENT_PRESET_PATCHES)) {
    throw new Error('openloop-runtime: agent preset process restrictions must remain locked')
  }
  const roots = presetConfig['roots']
  if (!Array.isArray(roots)
    || roots.length !== 1
    || typeof roots[0] !== 'object'
    || roots[0] === null
    || (roots[0] as Record<string, unknown>)['trust'] !== 'system'
    || typeof (roots[0] as Record<string, unknown>)['path'] !== 'string') {
    throw new Error('openloop-runtime: agent presets must use only the pinned system root')
  }

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
