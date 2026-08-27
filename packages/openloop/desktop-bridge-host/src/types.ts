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
  readonly state:
    | 'ready'
    | 'needs-authorization'
    | 'missing'
    | 'permission-denied'
    | 'identity-mismatch'
    | 'revoking'
}

export interface PendingWorkspaceGrant {
  readonly pendingGrantId: string
  readonly path: string
}

export interface WorkspaceFileHandle {
  readonly handleId: string
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
