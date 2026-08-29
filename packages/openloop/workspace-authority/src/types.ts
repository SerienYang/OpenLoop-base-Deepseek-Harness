/** Stable grant states that may survive a restart. */
export const GRANT_STATUSES = [
  'ready',
  'needs-authorization',
  'missing',
  'permission-denied',
  'identity-mismatch',
] as const

export type GrantStatus = typeof GRANT_STATUSES[number]

export const PERSISTED_GRANT_STATUSES = [
  ...GRANT_STATUSES,
  'revoking',
  'reauthorizing',
] as const

export type PersistedGrantStatus = typeof PERSISTED_GRANT_STATUSES[number]

/** Host-only grant record. Paths and filesystem identity never cross into the browser. */
export interface WorkspaceGrant {
  readonly version: 1
  readonly generation: number
  readonly operationId: string
  readonly workspaceId: string
  readonly canonicalPath: string
  readonly displayPath: string
  readonly volumeId: string
  readonly fileId: string
  readonly status: PersistedGrantStatus
  readonly authorizedAt: number
}

/** Browser-safe projection combined with the DSH registry title. */
export interface WorkspaceGrantView {
  readonly workspaceId: string
  readonly name: string
  readonly displayPath?: string
  readonly state: PersistedGrantStatus
}

export const TRANSACTION_STAGES = {
  add: ['prepared', 'registry-committed', 'grant-committed', 'authorization-failed'],
  revoke: ['revoke-prepared', 'registry-deleted', 'grant-deleted'],
  reauthorize: ['reauthorize-prepared', 'grant-committed'],
} as const

interface WorkspaceTransactionBase {
  readonly operationId: string
  readonly generation: number
  readonly expectedCatalogGeneration: number
  readonly expectedGrantGeneration: number
}

export interface AddWorkspaceTransaction extends WorkspaceTransactionBase {
  readonly kind: 'add'
  readonly workspaceId?: string
  readonly stage: typeof TRANSACTION_STAGES.add[number]
}

export interface RevokeWorkspaceTransaction extends WorkspaceTransactionBase {
  readonly kind: 'revoke'
  readonly workspaceId: string
  readonly stage: typeof TRANSACTION_STAGES.revoke[number]
}

export interface ReauthorizeWorkspaceTransaction extends WorkspaceTransactionBase {
  readonly kind: 'reauthorize'
  readonly workspaceId: string
  readonly stage: typeof TRANSACTION_STAGES.reauthorize[number]
}

export type WorkspaceTransaction =
  | AddWorkspaceTransaction
  | RevokeWorkspaceTransaction
  | ReauthorizeWorkspaceTransaction

export interface TransactionVersion {
  readonly operationId: string
  readonly generation: number
  readonly stage: WorkspaceTransaction['stage']
}

export interface WorkspaceGenerationConflict {
  readonly kind: 'generation-conflict'
  readonly store: 'catalog' | 'grant' | 'transaction'
  readonly expected: number
  readonly actual: number
}

export const RECOVERY_OUTCOMES = [
  'completed',
  'rolled-back',
  'needs-authorization',
  'stale-generation',
] as const

export type WorkspaceRecoveryOutcome = typeof RECOVERY_OUTCOMES[number]
