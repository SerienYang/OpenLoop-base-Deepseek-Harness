import type { SessionId } from '@deepseek-ai/dsh-session'

/** Browser-safe result contracts for the Openloop desktop Remote facade. */

export interface AppInfo {
  readonly appVersion: string
  readonly channel: 'test' | 'stable'
}

export type UpdateState =
  | 'idle'
  | 'checking'
  | 'up-to-date'
  | 'available'
  | 'failed'
  | 'downloading'
  | 'verifying'
  | 'ready-to-install'
  | 'installing'
  | 'restarting'
  | 'committed'
  | 'rolled-back'

export interface UpdateStatus {
  readonly state: UpdateState
  readonly updateId?: string
  readonly version?: string
  readonly message?: string
  readonly progress?: number
  readonly lastCheckedAt?: number
}

export interface CredentialStatus {
  readonly configured: boolean
  readonly writable: boolean
  readonly source?: 'keychain' | 'legacy-file' | 'environment'
}

export interface CredentialMigrationStatus {
  readonly state: 'not-required' | 'pending' | 'incomplete' | 'completed'
  readonly readOnly: boolean
  readonly retryRequired: boolean
}

export interface CandidateCredentialHealthPlan {
  readonly migrationTransactionId: string | null
  readonly references: readonly string[]
}

export interface CandidateCredentialHealthProof {
  readonly migrationTransactionId: string | null
  readonly ready: boolean
  readonly checkedCount: number
}

export interface MainWebviewHealthAcknowledgement {
  readonly launchId: string
  readonly coreManifestSha256: string
  readonly openloopDataVersion: number
  readonly dshDataVersion: number
  readonly credentialHealth?: CandidateCredentialHealthProof
}

export interface WorkspaceGrantView {
  readonly workspaceId: string
  readonly name: string
  readonly displayPath?: string
  readonly sessionIds: readonly SessionId[]
  readonly state:
    | 'ready'
    | 'needs-authorization'
    | 'missing'
    | 'permission-denied'
    | 'identity-mismatch'
    | 'revoking'
    | 'reauthorizing'
}

export interface PendingWorkspaceGrant {
  readonly outcome: 'pending'
  readonly pendingGrantId: string
  readonly path: string
}

export interface CancelledWorkspaceGrant {
  readonly outcome: 'cancelled'
}

export type WorkspaceAuthorizationSelection =
  | PendingWorkspaceGrant
  | CancelledWorkspaceGrant

export interface CommittedWorkspaceGrant {
  readonly workspaceId: string
  readonly displayPath?: string
  readonly state: WorkspaceGrantView['state']
}

export interface WorkspaceGrantInspection {
  readonly exists: boolean
  readonly generation?: number
  readonly operationId?: string
  readonly identityValid: boolean
  readonly displayPath?: string
  readonly status?: WorkspaceGrantView['state'] | 'reauthorizing'
  readonly effectiveStatus?: WorkspaceGrantView['state']
}

export type WorkspaceTransactionKind = 'add' | 'revoke' | 'reauthorize'

export type WorkspaceTransactionStage =
  | 'prepared'
  | 'registry-committed'
  | 'grant-committed'
  | 'revoke-prepared'
  | 'registry-deleted'
  | 'grant-deleted'
  | 'reauthorize-prepared'
  | 'authorization-failed'

export interface WorkspaceTransactionInput {
  readonly operationId?: string
  readonly kind: WorkspaceTransactionKind
  readonly workspaceId?: string
  readonly expectedCatalogGeneration: number
  readonly expectedGrantGeneration: number
  readonly stage: WorkspaceTransactionStage
}

export interface WorkspaceTransactionVersion {
  readonly operationId: string
  readonly generation: number
  readonly stage: WorkspaceTransactionStage
}

interface WorkspaceTransactionBase {
  readonly version: 1
  readonly operationId: string
  readonly generation: number
  readonly expectedCatalogGeneration: number
  readonly expectedGrantGeneration: number
}

export type WorkspaceTransaction =
  | (WorkspaceTransactionBase & {
    readonly kind: 'add'
    readonly workspaceId?: string
    readonly stage:
      | 'prepared'
      | 'registry-committed'
      | 'grant-committed'
      | 'authorization-failed'
  })
  | (WorkspaceTransactionBase & {
    readonly kind: 'revoke'
    readonly workspaceId: string
    readonly stage: 'revoke-prepared' | 'registry-deleted' | 'grant-deleted'
  })
  | (WorkspaceTransactionBase & {
    readonly kind: 'reauthorize'
    readonly workspaceId: string
    readonly stage: 'reauthorize-prepared' | 'grant-committed'
  })

export interface WorkspaceFileHandle {
  readonly handleId: string
  readonly kind: 'regular' | 'directory'
  readonly version?: string
}

export interface WorkspaceFileStat {
  readonly kind: WorkspaceFileHandle['kind']
  readonly size: number
  readonly version?: string
}

export interface WorkspaceDirectoryEntry {
  readonly name: string
  readonly kind: WorkspaceFileHandle['kind'] | 'symlink' | 'other'
  readonly size: number
  readonly version: string
}

export interface WorkspaceDirectoryChunk {
  readonly entries: readonly WorkspaceDirectoryEntry[]
  readonly nextOffset: number
  readonly eof: boolean
}

export interface WorkspaceFileReadChunk {
  readonly bytes: string
  readonly nextOffset: number
  readonly eof: boolean
}

export interface WorkspaceFileVersion {
  readonly version: string
}

export interface WorkspaceProcessHandle {
  readonly handleId: string
}

export interface ApprovedCommand {
  readonly program: string
  readonly args: readonly string[]
}

/** Mutable bytes so a Host consumer can clear the one-request credential copy. */
export type SecretBytes = number[]

export interface ResolvedSecretBytes {
  readonly bytes: SecretBytes
  readonly source: 'keychain' | 'legacy-file'
}
