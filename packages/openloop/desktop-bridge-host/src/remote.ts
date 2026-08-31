import { symbols, type Context } from '@deepseek-ai/cordis'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type {} from 'zod'
import type { BridgeRequest } from './protocol.ts'
import type { DesktopBridgeClient } from './client.ts'
import type {
  AppInfo,
  ApprovedCommand,
  CandidateCredentialHealthPlan,
  CommittedWorkspaceGrant,
  CredentialMigrationStatus,
  CredentialStatus,
  MainWebviewHealthAcknowledgement,
  ResolvedSecretBytes,
  UpdateStatus,
  WorkspaceAuthorizationSelection,
  WorkspaceDirectoryChunk,
  WorkspaceFileHandle,
  WorkspaceFileReadChunk,
  WorkspaceFileStat,
  WorkspaceFileVersion,
  WorkspaceGrantInspection,
  WorkspaceGrantView,
  WorkspaceProcessHandle,
  WorkspaceTransaction,
  WorkspaceTransactionInput,
  WorkspaceTransactionStage,
  WorkspaceTransactionVersion,
} from './types.ts'

export type * from './types.ts'

export const BROWSER_SAFE_METHODS = [
  'getAppInfo',
  'getUpdateStatus',
  'checkForUpdate',
  'installUpdateAndRestart',
  'describeCredential',
  'openCredentialReplacement',
  'unsetCredential',
  'getCredentialMigrationStatus',
  'listWorkspaceGrants',
  'authorizeWorkspace',
  'reauthorizeWorkspace',
  'renameWorkspace',
  'revokeWorkspace',
  'revealWorkspace',
] as const

export const HOST_ONLY_METHODS = [
  'resolveCredential',
  'getCandidateCredentialHealthPlan',
  'acknowledgeMainWebviewHealth',
  'beginWorkspaceAuthorization',
  'commitWorkspaceAuthorization',
  'abortWorkspaceAuthorization',
  'getWorkspaceGrantGeneration',
  'inspectWorkspaceGrant',
  'markWorkspaceGrantNeedsAuthorization',
  'restoreWorkspaceGrantReady',
  'confirmWorkspaceRevoke',
  'markWorkspaceGrantRevoking',
  'markWorkspaceGrantReauthorizing',
  'deleteWorkspaceGrant',
  'readWorkspaceTransaction',
  'prepareWorkspaceTransaction',
  'advanceWorkspaceTransaction',
  'abortWorkspaceTransaction',
  'completeWorkspaceTransaction',
  'openWorkspaceFile',
  'openWorkspaceRoot',
  'statWorkspaceFile',
  'listWorkspaceFiles',
  'readWorkspaceFile',
  'createWorkspaceFile',
  'beginWorkspaceAtomicWrite',
  'writeWorkspaceFileChunk',
  'commitWorkspaceAtomicWrite',
  'closeWorkspaceFile',
  'spawnWorkspaceProcess',
] as const

type BrowserSafeBridgeMethod = typeof BROWSER_SAFE_METHODS[number]
type HostOnlyBridgeMethod = typeof HOST_ONLY_METHODS[number]
type BridgeHandler = (payload: unknown, signal: AbortSignal) => unknown
const remoteBridgeClients = new WeakMap<object, DesktopBridgeClient>()
const remoteContexts = new WeakMap<object, Context>()

interface CredentialBrowserOperations {
  describeCredential(reference: string, signal?: AbortSignal): Promise<CredentialStatus>
  openCredentialReplacement(
    reference: string,
    signal?: AbortSignal,
  ): Promise<'saved' | 'cancelled'>
  deleteCredential(reference: string, signal?: AbortSignal): Promise<'deleted' | 'cancelled'>
}

interface WorkspaceBrowserOperations {
  list(signal: AbortSignal): Promise<WorkspaceGrantView[]>
  add(signal: AbortSignal): Promise<WorkspaceGrantView | 'cancelled'>
  reauthorize(
    workspaceId: string,
    signal: AbortSignal,
  ): Promise<WorkspaceGrantView | 'cancelled'>
  rename(workspaceId: string, name: string, signal: AbortSignal): Promise<WorkspaceGrantView>
  revoke(workspaceId: string, signal: AbortSignal): Promise<'revoked' | 'cancelled'>
}

function remoteBridgeClient(service: object): DesktopBridgeClient {
  const original = Reflect.get(service, symbols.original) as unknown
  const owner = typeof original === 'object' && original !== null ? original : service
  const client = remoteBridgeClients.get(owner)
  if (client === undefined) throw new Error('desktop bridge Remote client is unavailable')
  return client
}

function credentialOperations(service: object): CredentialBrowserOperations {
  const original = Reflect.get(service, symbols.original) as unknown
  const owner = typeof original === 'object' && original !== null ? original : service
  const operations = remoteContexts.get(owner)?.get('openloopCredentialOperations') as
    | CredentialBrowserOperations
    | undefined
  if (operations === undefined) {
    throw new Error('Openloop credential operations are unavailable')
  }
  return operations
}

function workspaceOperations(service: object): WorkspaceBrowserOperations {
  const original = Reflect.get(service, symbols.original) as unknown
  const owner = typeof original === 'object' && original !== null ? original : service
  const operations = remoteContexts.get(owner)?.get('workspaceAuthority') as
    | WorkspaceBrowserOperations
    | undefined
  if (operations === undefined) {
    throw new Error('Openloop Workspace authority is unavailable')
  }
  return operations
}

export interface BridgeDispatchTables {
  readonly browserSafe: Partial<Record<BrowserSafeBridgeMethod, BridgeHandler>>
  readonly hostOnly: Partial<Record<HostOnlyBridgeMethod, BridgeHandler>>
}

/** Dispatch against two explicit capability tables; unknown names never reach a handler. */
export function dispatchBridgeRequest(
  request: BridgeRequest,
  tables: BridgeDispatchTables,
  signal: AbortSignal,
): Promise<unknown> {
  const browserHandler = Object.hasOwn(tables.browserSafe, request.method)
    ? tables.browserSafe[request.method as BrowserSafeBridgeMethod]
    : undefined
  const hostHandler = Object.hasOwn(tables.hostOnly, request.method)
    ? tables.hostOnly[request.method as HostOnlyBridgeMethod]
    : undefined
  const handler = browserHandler ?? hostHandler
  if (handler === undefined) {
    return Promise.reject(new Error(
      `desktop bridge unknown method ${JSON.stringify(request.method)}`,
    ))
  }
  try {
    return Promise.resolve(handler(request.payload, signal))
  } catch (error) {
    return Promise.reject(error instanceof Error ? error : new Error('desktop bridge handler failed'))
  }
}

/** Browser-visible Remote facade. It contains no Host-only methods or secrets. */
export class OpenloopDesktopRemoteService extends TypertRemoteService {
  constructor(ctx: Context, client: DesktopBridgeClient) {
    super(ctx, 'openloopDesktop')
    remoteBridgeClients.set(this, client)
    remoteContexts.set(this, ctx)
  }

  @Remote
  getAppInfo(signal: AbortSignal): Promise<AppInfo> {
    return remoteBridgeClient(this).call<AppInfo>('getAppInfo', null, signal)
  }

  @Remote
  getUpdateStatus(signal: AbortSignal): Promise<UpdateStatus> {
    signal.throwIfAborted()
    return remoteBridgeClient(this).call<UpdateStatus>('getUpdateStatus', null, signal)
  }

  @Remote
  checkForUpdate(signal: AbortSignal): Promise<UpdateStatus> {
    signal.throwIfAborted()
    return remoteBridgeClient(this).call<UpdateStatus>('checkForUpdate', null, signal)
  }

  @Remote
  installUpdateAndRestart(
    updateId: string,
    signal: AbortSignal,
  ): Promise<'restarting' | 'cancelled'> {
    signal.throwIfAborted()
    return remoteBridgeClient(this).call('installUpdateAndRestart', { updateId }, signal)
  }

  @Remote
  describeCredential(ref: string, signal: AbortSignal): Promise<CredentialStatus> {
    return credentialOperations(this).describeCredential(ref, signal)
  }

  @Remote
  openCredentialReplacement(
    ref: string,
    signal: AbortSignal,
  ): Promise<'saved' | 'cancelled'> {
    return credentialOperations(this).openCredentialReplacement(ref, signal)
  }

  @Remote
  unsetCredential(ref: string, signal: AbortSignal): Promise<'deleted' | 'cancelled'> {
    return credentialOperations(this).deleteCredential(ref, signal)
  }

  @Remote
  getCredentialMigrationStatus(signal: AbortSignal): Promise<CredentialMigrationStatus> {
    return remoteBridgeClient(this).call<CredentialMigrationStatus>(
      'getCredentialMigrationStatus',
      null,
      signal,
    )
  }

  @Remote
  listWorkspaceGrants(signal: AbortSignal): Promise<WorkspaceGrantView[]> {
    signal.throwIfAborted()
    return workspaceOperations(this).list(signal)
  }

  @Remote
  authorizeWorkspace(signal: AbortSignal): Promise<WorkspaceGrantView | 'cancelled'> {
    signal.throwIfAborted()
    return workspaceOperations(this).add(signal)
  }

  @Remote
  reauthorizeWorkspace(
    workspaceId: string,
    signal: AbortSignal,
  ): Promise<WorkspaceGrantView | 'cancelled'> {
    signal.throwIfAborted()
    return workspaceOperations(this).reauthorize(workspaceId, signal)
  }

  @Remote
  renameWorkspace(
    workspaceId: string,
    name: string,
    signal: AbortSignal,
  ): Promise<WorkspaceGrantView> {
    signal.throwIfAborted()
    return workspaceOperations(this).rename(workspaceId, name, signal)
  }

  @Remote
  revokeWorkspace(workspaceId: string, signal: AbortSignal): Promise<'revoked' | 'cancelled'> {
    signal.throwIfAborted()
    return workspaceOperations(this).revoke(workspaceId, signal)
  }

  @Remote
  async revealWorkspace(workspaceId: string, signal: AbortSignal): Promise<void> {
    await remoteBridgeClient(this).call<null>('revealWorkspace', { workspaceId }, signal)
  }
}

/** Host-only named facade; this class is never decorated or mounted as a Remote. */
export class OpenloopDesktopHostClient {
  readonly #client: DesktopBridgeClient

  constructor(client: DesktopBridgeClient) {
    this.#client = client
  }

  /**
   * Resolve a credential for one trusted Host request. This method is never
   * exposed through the browser Remote facade, and callers must clear the
   * returned mutable bytes after use.
   * @param ref - Registered credential reference.
   * @param signal - Optional request cancellation signal.
   * @returns Short-lived credential bytes, or `undefined` when absent.
   */
  async resolveCredential(
    ref: string,
    signal?: AbortSignal,
  ): Promise<ResolvedSecretBytes | undefined> {
    const result = await this.#client.call<ResolvedSecretBytes | null>(
      'resolveCredential',
      { ref },
      signal,
    )
    return result ?? undefined
  }

  /**
   * Acknowledge the verified main-webview credential health result to native.
   * @param acknowledgement - Host-produced health acknowledgement.
   * @param signal - Optional request cancellation signal.
   * @returns Resolution after native persistence.
   */
  async acknowledgeMainWebviewHealth(
    acknowledgement: MainWebviewHealthAcknowledgement,
    signal?: AbortSignal,
  ): Promise<void> {
    await this.#client.call<null>(
      'acknowledgeMainWebviewHealth',
      acknowledgement,
      signal,
    )
  }

  /**
   * Read the value-free credential checks required before candidate startup.
   * @param signal - Optional request cancellation signal.
   * @returns The native candidate-health plan without credential values.
   */
  getCandidateCredentialHealthPlan(
    signal?: AbortSignal,
  ): Promise<CandidateCredentialHealthPlan> {
    return this.#client.call<CandidateCredentialHealthPlan>(
      'getCandidateCredentialHealthPlan',
      null,
      signal,
    )
  }

  /**
   * Read value-free native Keychain status for one reference.
   * @param ref - Credential reference.
   * @param signal - Optional request cancellation signal.
   * @returns Native Keychain status.
   */
  describeCredential(ref: string, signal?: AbortSignal): Promise<CredentialStatus> {
    return this.#client.call<CredentialStatus>('describeCredential', { ref }, signal)
  }

  /**
   * Request the native credential replacement flow.
   * @param ref - Credential reference.
   * @param signal - Optional request cancellation signal.
   * @returns Native replacement outcome.
   */
  openCredentialReplacement(
    ref: string,
    signal?: AbortSignal,
  ): Promise<'saved' | 'cancelled'> {
    return this.#client.call('openCredentialReplacement', { ref }, signal)
  }

  /**
   * Forward a Host-derived deletion plan to native confirmation.
   * @param plan - Registry-derived reference and consumer labels.
   * @param signal - Optional request cancellation signal.
   * @returns Native confirmation outcome.
   */
  deleteCredentialWithConfirmation(
    plan: {
      readonly reference: string
      readonly consumers: readonly {
        readonly ownerId: string
        readonly kind: 'model-route' | 'plugin'
        readonly display: {
          readonly key: string
          readonly values: Readonly<Record<string, string>>
        }
      }[]
    },
    signal?: AbortSignal,
  ): Promise<'deleted' | 'cancelled'> {
    return this.#client.call('unsetCredential', plan, signal)
  }

  /**
   * Open the native directory picker and create a launch-local pending grant.
   * @param signal - Optional request cancellation signal.
   * @returns A cancelled selection or pending grant metadata.
   */
  beginWorkspaceAuthorization(signal?: AbortSignal): Promise<WorkspaceAuthorizationSelection> {
    return this.#client.call<WorkspaceAuthorizationSelection>(
      'beginWorkspaceAuthorization',
      null,
      signal,
    )
  }

  /**
   * Bind a pending native selection to a Host workspace after generation and
   * canonical-path checks.
   * @param pendingGrantId - Launch-local pending grant identifier.
   * @param workspaceId - Host-owned workspace identifier.
   * @param expectedGrantGeneration - Native grant generation previously observed.
   * @param operationId - Idempotency identifier for the authority transaction.
   * @param expectedCanonicalPath - Canonical path the Host expects to bind.
   * @param signal - Optional request cancellation signal.
   * @returns The committed workspace grant metadata.
   */
  commitWorkspaceAuthorization(
    pendingGrantId: string,
    workspaceId: string,
    expectedGrantGeneration: number,
    operationId: string,
    expectedCanonicalPath?: string,
    signal?: AbortSignal,
  ): Promise<CommittedWorkspaceGrant> {
    return this.#client.call<CommittedWorkspaceGrant>(
      'commitWorkspaceAuthorization',
      {
        pendingGrantId,
        workspaceId,
        expectedGrantGeneration,
        operationId,
        ...(expectedCanonicalPath === undefined ? {} : { expectedCanonicalPath }),
      },
      signal,
    )
  }

  /**
   * Discard a launch-local pending directory grant.
   * @param pendingGrantId - Pending grant identifier returned by native.
   * @param signal - Optional request cancellation signal.
   * @returns Resolution after the pending capability is discarded.
   */
  abortWorkspaceAuthorization(pendingGrantId: string, signal?: AbortSignal): Promise<void> {
    return this.#client.call<void>('abortWorkspaceAuthorization', { pendingGrantId }, signal)
  }

  /**
   * Read the native generation used for compare-and-swap grant mutations.
   * @param signal - Optional request cancellation signal.
   * @returns The current native grant generation.
   */
  getWorkspaceGrantGeneration(signal?: AbortSignal): Promise<number> {
    return this.#client.call<number>('getWorkspaceGrantGeneration', null, signal)
  }

  /**
   * Inspect value-free grant state and identity validity for one workspace.
   * @param workspaceId - Host-owned workspace identifier.
   * @param signal - Optional request cancellation signal.
   * @returns Grant status without exposing the underlying capability.
   */
  inspectWorkspaceGrant(
    workspaceId: string,
    signal?: AbortSignal,
  ): Promise<WorkspaceGrantInspection> {
    return this.#client.call('inspectWorkspaceGrant', { workspaceId }, signal)
  }

  /**
   * Mark a grant unusable after validating its expected generation.
   * @param workspaceId - Host-owned workspace identifier.
   * @param expectedGrantGeneration - Native generation previously observed.
   * @param operationId - Optional authority transaction identifier.
   * @param signal - Optional request cancellation signal.
   * @returns The committed native grant generation.
   */
  markWorkspaceGrantNeedsAuthorization(
    workspaceId: string,
    expectedGrantGeneration: number,
    operationId?: string,
    signal?: AbortSignal,
  ): Promise<number> {
    return this.#client.call(
      'markWorkspaceGrantNeedsAuthorization',
      {
        expectedGrantGeneration,
        workspaceId,
        ...(operationId === undefined ? {} : { operationId }),
      },
      signal,
    )
  }

  /**
   * Restore a transaction-owned grant to ready after generation validation.
   * @param workspaceId - Host-owned workspace identifier.
   * @param expectedGrantGeneration - Native generation previously observed.
   * @param operationId - Authority transaction that owns the transition.
   * @param signal - Optional request cancellation signal.
   * @returns The committed native grant generation.
   */
  restoreWorkspaceGrantReady(
    workspaceId: string,
    expectedGrantGeneration: number,
    operationId: string,
    signal?: AbortSignal,
  ): Promise<number> {
    return this.#client.call(
      'restoreWorkspaceGrantReady',
      { expectedGrantGeneration, operationId, workspaceId },
      signal,
    )
  }

  /**
   * Ask native trusted UI to confirm revoking a workspace grant.
   * @param workspaceId - Host-owned workspace identifier.
   * @param title - Display-only workspace title shown for confirmation.
   * @param signal - Optional request cancellation signal.
   * @returns The user's confirmation outcome.
   */
  confirmWorkspaceRevoke(
    workspaceId: string,
    title: string,
    signal?: AbortSignal,
  ): Promise<'confirmed' | 'cancelled'> {
    return this.#client.call('confirmWorkspaceRevoke', { title, workspaceId }, signal)
  }

  /**
   * Reserve a grant for revoke using transaction and generation ownership.
   * @param workspaceId - Host-owned workspace identifier.
   * @param expectedGrantGeneration - Native generation previously observed.
   * @param operationId - Authority transaction that owns the transition.
   * @param signal - Optional request cancellation signal.
   * @returns The committed native grant generation.
   */
  markWorkspaceGrantRevoking(
    workspaceId: string,
    expectedGrantGeneration: number,
    operationId: string,
    signal?: AbortSignal,
  ): Promise<number> {
    return this.#client.call<number>(
      'markWorkspaceGrantRevoking',
      { expectedGrantGeneration, operationId, workspaceId },
      signal,
    )
  }

  /**
   * Reserve a grant for reauthorization using transaction and generation ownership.
   * @param workspaceId - Host-owned workspace identifier.
   * @param expectedGrantGeneration - Native generation previously observed.
   * @param operationId - Authority transaction that owns the transition.
   * @param signal - Optional request cancellation signal.
   * @returns The committed native grant generation.
   */
  markWorkspaceGrantReauthorizing(
    workspaceId: string,
    expectedGrantGeneration: number,
    operationId: string,
    signal?: AbortSignal,
  ): Promise<number> {
    return this.#client.call<number>(
      'markWorkspaceGrantReauthorizing',
      { expectedGrantGeneration, operationId, workspaceId },
      signal,
    )
  }

  /**
   * Delete a native grant after generation and optional transaction checks.
   * @param workspaceId - Host-owned workspace identifier.
   * @param expectedGrantGeneration - Native generation previously observed.
   * @param operationId - Optional authority transaction identifier.
   * @param signal - Optional request cancellation signal.
   * @returns The committed native grant generation.
   */
  deleteWorkspaceGrant(
    workspaceId: string,
    expectedGrantGeneration: number,
    operationId?: string,
    signal?: AbortSignal,
  ): Promise<number> {
    return this.#client.call<number>(
      'deleteWorkspaceGrant',
      {
        expectedGrantGeneration,
        workspaceId,
        ...(operationId === undefined ? {} : { operationId }),
      },
      signal,
    )
  }

  /**
   * Persist the initial authority transaction before cross-store mutation.
   * @param input - Transaction intent and expected durable generations.
   * @param signal - Optional request cancellation signal.
   * @returns The prepared transaction version.
   */
  prepareWorkspaceTransaction(
    input: WorkspaceTransactionInput,
    signal?: AbortSignal,
  ): Promise<WorkspaceTransactionVersion> {
    return this.#client.call('prepareWorkspaceTransaction', input, signal)
  }

  /**
   * Read the durable authority recovery journal.
   * @param signal - Optional request cancellation signal.
   * @returns The pending transaction, or `null` when no recovery is required.
   */
  readWorkspaceTransaction(signal?: AbortSignal): Promise<WorkspaceTransaction | null> {
    return this.#client.call('readWorkspaceTransaction', null, signal)
  }

  /**
   * Advance the recovery journal through a compare-and-swap stage transition.
   * @param operationId - Transaction identifier.
   * @param expectedGeneration - Journal generation previously observed.
   * @param expectedStage - Journal stage previously observed.
   * @param nextStage - Next legal recovery stage.
   * @param workspaceId - Workspace id learned during the transaction, when applicable.
   * @param signal - Optional request cancellation signal.
   * @returns The updated transaction version.
   */
  advanceWorkspaceTransaction(
    operationId: string,
    expectedGeneration: number,
    expectedStage: WorkspaceTransactionStage,
    nextStage: WorkspaceTransactionStage,
    workspaceId?: string,
    signal?: AbortSignal,
  ): Promise<WorkspaceTransactionVersion> {
    return this.#client.call(
      'advanceWorkspaceTransaction',
      {
        expectedGeneration,
        expectedStage,
        nextStage,
        operationId,
        ...(workspaceId === undefined ? {} : { workspaceId }),
      },
      signal,
    )
  }

  /**
   * Remove a recoverable transaction only from its expected version and stage.
   * @param operationId - Transaction identifier.
   * @param expectedGeneration - Journal generation previously observed.
   * @param expectedStage - Journal stage previously observed.
   * @param signal - Optional request cancellation signal.
   * @returns Resolution after the journal is removed.
   */
  async abortWorkspaceTransaction(
    operationId: string,
    expectedGeneration: number,
    expectedStage: WorkspaceTransactionStage,
    signal?: AbortSignal,
  ): Promise<void> {
    await this.#client.call<null>(
      'abortWorkspaceTransaction',
      { expectedGeneration, expectedStage, operationId },
      signal,
    )
  }

  /**
   * Complete and remove a transaction after its final expected stage.
   * @param operationId - Transaction identifier.
   * @param expectedGeneration - Journal generation previously observed.
   * @param expectedStage - Final journal stage previously observed.
   * @param signal - Optional request cancellation signal.
   * @returns Resolution after completion is persisted.
   */
  async completeWorkspaceTransaction(
    operationId: string,
    expectedGeneration: number,
    expectedStage: WorkspaceTransactionStage,
    signal?: AbortSignal,
  ): Promise<void> {
    await this.#client.call<null>(
      'completeWorkspaceTransaction',
      { expectedGeneration, expectedStage, operationId },
      signal,
    )
  }

  /**
   * Open a file or directory beneath an authorized workspace root.
   * Native resolves the relative path without following it outside that root.
   * @param workspaceId - Authorized workspace identifier.
   * @param relativePath - Workspace-relative path.
   * @param mode - Requested read or directory-list capability.
   * @param signal - Optional request cancellation signal.
   * @returns An opaque native file handle.
   */
  openWorkspaceFile(
    workspaceId: string,
    relativePath: string,
    mode: 'read' | 'list',
    signal?: AbortSignal,
  ): Promise<WorkspaceFileHandle> {
    return this.#client.call<WorkspaceFileHandle>(
      'openWorkspaceFile',
      { mode, relativePath, workspaceId },
      signal,
    )
  }

  /**
   * Open the authorized root directory for a workspace.
   * @param workspaceId - Authorized workspace identifier.
   * @param signal - Optional request cancellation signal.
   * @returns An opaque native directory handle.
   */
  openWorkspaceRoot(
    workspaceId: string,
    signal?: AbortSignal,
  ): Promise<WorkspaceFileHandle> {
    return this.#client.call<WorkspaceFileHandle>(
      'openWorkspaceRoot',
      { workspaceId },
      signal,
    )
  }

  /**
   * Read metadata through an already authorized native handle.
   * @param handleId - Opaque native file handle.
   * @param signal - Optional request cancellation signal.
   * @returns File metadata without an unrestricted filesystem path.
   */
  statWorkspaceFile(
    handleId: string,
    signal?: AbortSignal,
  ): Promise<WorkspaceFileStat> {
    return this.#client.call<WorkspaceFileStat>('statWorkspaceFile', { handleId }, signal)
  }

  /**
   * Read one bounded page from an authorized directory handle.
   * @param handleId - Opaque native directory handle.
   * @param offset - Zero-based entry offset.
   * @param maxEntries - Maximum entries to return.
   * @param signal - Optional request cancellation signal.
   * @returns Directory entries and continuation metadata.
   */
  listWorkspaceFiles(
    handleId: string,
    offset: number,
    maxEntries: number,
    signal?: AbortSignal,
  ): Promise<WorkspaceDirectoryChunk> {
    return this.#client.call<WorkspaceDirectoryChunk>(
      'listWorkspaceFiles',
      { handleId, maxEntries, offset },
      signal,
    )
  }

  /**
   * Read one bounded chunk from an authorized file handle.
   * @param handleId - Opaque native file handle.
   * @param offset - Zero-based byte offset.
   * @param maxBytes - Maximum bytes to return.
   * @param signal - Optional request cancellation signal.
   * @returns Encoded bytes and continuation metadata.
   */
  readWorkspaceFile(
    handleId: string,
    offset: number,
    maxBytes: number,
    signal?: AbortSignal,
  ): Promise<WorkspaceFileReadChunk> {
    return this.#client.call<WorkspaceFileReadChunk>(
      'readWorkspaceFile',
      { handleId, maxBytes, offset },
      signal,
    )
  }

  /**
   * Create a file beneath an authorized workspace root.
   * @param workspaceId - Authorized workspace identifier.
   * @param relativePath - Workspace-relative path validated by native.
   * @param signal - Optional request cancellation signal.
   * @returns An opaque handle for the created file.
   */
  createWorkspaceFile(
    workspaceId: string,
    relativePath: string,
    signal?: AbortSignal,
  ): Promise<WorkspaceFileHandle> {
    return this.#client.call<WorkspaceFileHandle>(
      'createWorkspaceFile',
      { relativePath, workspaceId },
      signal,
    )
  }

  /**
   * Begin a native atomic replacement beneath an authorized workspace root.
   * @param workspaceId - Authorized workspace identifier.
   * @param relativePath - Workspace-relative destination path.
   * @param createIfAbsent - Whether a missing destination may be created.
   * @param expectedVersion - Optional version required to prevent stale writes.
   * @param signal - Optional request cancellation signal.
   * @returns An opaque write handle for staging chunks.
   */
  beginWorkspaceAtomicWrite(
    workspaceId: string,
    relativePath: string,
    createIfAbsent: boolean,
    expectedVersion?: string,
    signal?: AbortSignal,
  ): Promise<WorkspaceFileHandle> {
    return this.#client.call<WorkspaceFileHandle>(
      'beginWorkspaceAtomicWrite',
      {
        createIfAbsent,
        relativePath,
        workspaceId,
        ...(expectedVersion === undefined ? {} : { expectedVersion }),
      },
      signal,
    )
  }

  /**
   * Append one encoded chunk to an authorized atomic-write handle.
   * @param handleId - Opaque native write handle.
   * @param bytes - Encoded chunk accepted by the bounded bridge protocol.
   * @param signal - Optional request cancellation signal.
   * @returns Resolution after native staging.
   */
  writeWorkspaceFileChunk(
    handleId: string,
    bytes: string,
    signal?: AbortSignal,
  ): Promise<void> {
    return this.#client.call<void>(
      'writeWorkspaceFileChunk',
      { bytes, handleId },
      signal,
    )
  }

  /**
   * Atomically publish all staged chunks for a write handle.
   * @param handleId - Opaque native write handle.
   * @param signal - Optional request cancellation signal.
   * @returns The committed file version.
   */
  commitWorkspaceAtomicWrite(
    handleId: string,
    signal?: AbortSignal,
  ): Promise<WorkspaceFileVersion> {
    return this.#client.call<WorkspaceFileVersion>(
      'commitWorkspaceAtomicWrite',
      { handleId },
      signal,
    )
  }

  /**
   * Release an opaque native file, directory, or write handle.
   * @param handleId - Opaque native handle.
   * @param signal - Optional request cancellation signal.
   * @returns Resolution after native cleanup.
   */
  closeWorkspaceFile(handleId: string, signal?: AbortSignal): Promise<void> {
    return this.#client.call<void>('closeWorkspaceFile', { handleId }, signal)
  }

  /**
   * Spawn only a Host-approved command inside an authorized workspace.
   * @param workspaceId - Authorized workspace identifier used as confinement root.
   * @param approvedCommand - Host policy result; arbitrary browser argv is not accepted.
   * @param signal - Optional request cancellation signal.
   * @returns An opaque process handle.
   */
  spawnWorkspaceProcess(
    workspaceId: string,
    approvedCommand: ApprovedCommand,
    signal?: AbortSignal,
  ): Promise<WorkspaceProcessHandle> {
    return this.#client.call<WorkspaceProcessHandle>(
      'spawnWorkspaceProcess',
      { approvedCommand, workspaceId },
      signal,
    )
  }
}
