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
    return remoteBridgeClient(this).call<UpdateStatus>('getUpdateStatus', null, signal)
  }

  @Remote
  checkForUpdate(signal: AbortSignal): Promise<UpdateStatus> {
    return remoteBridgeClient(this).call<UpdateStatus>('checkForUpdate', null, signal)
  }

  @Remote
  installUpdateAndRestart(
    updateId: string,
    signal: AbortSignal,
  ): Promise<'restarting' | 'cancelled'> {
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

  beginWorkspaceAuthorization(signal?: AbortSignal): Promise<WorkspaceAuthorizationSelection> {
    return this.#client.call<WorkspaceAuthorizationSelection>(
      'beginWorkspaceAuthorization',
      null,
      signal,
    )
  }

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

  abortWorkspaceAuthorization(pendingGrantId: string, signal?: AbortSignal): Promise<void> {
    return this.#client.call<void>('abortWorkspaceAuthorization', { pendingGrantId }, signal)
  }

  getWorkspaceGrantGeneration(signal?: AbortSignal): Promise<number> {
    return this.#client.call<number>('getWorkspaceGrantGeneration', null, signal)
  }

  inspectWorkspaceGrant(
    workspaceId: string,
    signal?: AbortSignal,
  ): Promise<WorkspaceGrantInspection> {
    return this.#client.call('inspectWorkspaceGrant', { workspaceId }, signal)
  }

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

  confirmWorkspaceRevoke(
    workspaceId: string,
    title: string,
    signal?: AbortSignal,
  ): Promise<'confirmed' | 'cancelled'> {
    return this.#client.call('confirmWorkspaceRevoke', { title, workspaceId }, signal)
  }

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

  prepareWorkspaceTransaction(
    input: WorkspaceTransactionInput,
    signal?: AbortSignal,
  ): Promise<WorkspaceTransactionVersion> {
    return this.#client.call('prepareWorkspaceTransaction', input, signal)
  }

  readWorkspaceTransaction(signal?: AbortSignal): Promise<WorkspaceTransaction | null> {
    return this.#client.call('readWorkspaceTransaction', null, signal)
  }

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

  statWorkspaceFile(
    handleId: string,
    signal?: AbortSignal,
  ): Promise<WorkspaceFileStat> {
    return this.#client.call<WorkspaceFileStat>('statWorkspaceFile', { handleId }, signal)
  }

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

  closeWorkspaceFile(handleId: string, signal?: AbortSignal): Promise<void> {
    return this.#client.call<void>('closeWorkspaceFile', { handleId }, signal)
  }

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
