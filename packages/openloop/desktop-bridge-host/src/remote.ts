import type { Context } from '@deepseek-ai/cordis'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type {} from 'zod'
import type { BridgeRequest } from './protocol.ts'
import type { DesktopBridgeClient } from './client.ts'
import type {
  AppInfo,
  ApprovedCommand,
  CredentialMigrationStatus,
  CredentialStatus,
  PendingWorkspaceGrant,
  SecretBytes,
  UpdateStatus,
  WorkspaceFileHandle,
  WorkspaceGrantView,
  WorkspaceProcessHandle,
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
  'beginWorkspaceAuthorization',
  'commitWorkspaceAuthorization',
  'abortWorkspaceAuthorization',
  'openWorkspaceFile',
  'spawnWorkspaceProcess',
] as const

type BrowserSafeBridgeMethod = typeof BROWSER_SAFE_METHODS[number]
type HostOnlyBridgeMethod = typeof HOST_ONLY_METHODS[number]
type BridgeHandler = (payload: unknown, signal: AbortSignal) => unknown

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
  readonly #client: DesktopBridgeClient

  constructor(ctx: Context, client: DesktopBridgeClient) {
    super(ctx, 'openloopDesktop')
    this.#client = client
  }

  @Remote
  getAppInfo(signal: AbortSignal): Promise<AppInfo> {
    return this.#client.call<AppInfo>('getAppInfo', null, signal)
  }

  @Remote
  getUpdateStatus(signal: AbortSignal): Promise<UpdateStatus> {
    return this.#client.call<UpdateStatus>('getUpdateStatus', null, signal)
  }

  @Remote
  checkForUpdate(signal: AbortSignal): Promise<UpdateStatus> {
    return this.#client.call<UpdateStatus>('checkForUpdate', null, signal)
  }

  @Remote
  installUpdateAndRestart(
    updateId: string,
    signal: AbortSignal,
  ): Promise<'restarting' | 'cancelled'> {
    return this.#client.call('installUpdateAndRestart', { updateId }, signal)
  }

  @Remote
  describeCredential(ref: string, signal: AbortSignal): Promise<CredentialStatus> {
    return this.#client.call<CredentialStatus>('describeCredential', { ref }, signal)
  }

  @Remote
  openCredentialReplacement(
    ref: string,
    signal: AbortSignal,
  ): Promise<'saved' | 'cancelled'> {
    return this.#client.call('openCredentialReplacement', { ref }, signal)
  }

  @Remote
  unsetCredential(ref: string, signal: AbortSignal): Promise<'deleted' | 'cancelled'> {
    return this.#client.call('unsetCredential', { ref }, signal)
  }

  @Remote
  getCredentialMigrationStatus(signal: AbortSignal): Promise<CredentialMigrationStatus> {
    return this.#client.call<CredentialMigrationStatus>(
      'getCredentialMigrationStatus',
      null,
      signal,
    )
  }

  @Remote
  listWorkspaceGrants(signal: AbortSignal): Promise<WorkspaceGrantView[]> {
    return this.#client.call<WorkspaceGrantView[]>('listWorkspaceGrants', null, signal)
  }

  @Remote
  authorizeWorkspace(signal: AbortSignal): Promise<WorkspaceGrantView | 'cancelled'> {
    return this.#client.call('authorizeWorkspace', null, signal)
  }

  @Remote
  reauthorizeWorkspace(
    workspaceId: string,
    signal: AbortSignal,
  ): Promise<WorkspaceGrantView | 'cancelled'> {
    return this.#client.call('reauthorizeWorkspace', { workspaceId }, signal)
  }

  @Remote
  revokeWorkspace(workspaceId: string, signal: AbortSignal): Promise<'revoked' | 'cancelled'> {
    return this.#client.call('revokeWorkspace', { workspaceId }, signal)
  }

  @Remote
  revealWorkspace(workspaceId: string, signal: AbortSignal): Promise<void> {
    return this.#client.call<void>('revealWorkspace', { workspaceId }, signal)
  }
}

/** Host-only named facade; this class is never decorated or mounted as a Remote. */
export class OpenloopDesktopHostClient {
  readonly #client: DesktopBridgeClient

  constructor(client: DesktopBridgeClient) {
    this.#client = client
  }

  resolveCredential(ref: string, signal?: AbortSignal): Promise<SecretBytes | undefined> {
    return this.#client.call<SecretBytes | undefined>('resolveCredential', { ref }, signal)
  }

  beginWorkspaceAuthorization(signal?: AbortSignal): Promise<PendingWorkspaceGrant> {
    return this.#client.call<PendingWorkspaceGrant>(
      'beginWorkspaceAuthorization',
      null,
      signal,
    )
  }

  commitWorkspaceAuthorization(
    pendingGrantId: string,
    workspaceId: string,
    signal?: AbortSignal,
  ): Promise<WorkspaceGrantView> {
    return this.#client.call<WorkspaceGrantView>(
      'commitWorkspaceAuthorization',
      { pendingGrantId, workspaceId },
      signal,
    )
  }

  abortWorkspaceAuthorization(pendingGrantId: string, signal?: AbortSignal): Promise<void> {
    return this.#client.call<void>('abortWorkspaceAuthorization', { pendingGrantId }, signal)
  }

  openWorkspaceFile(
    workspaceId: string,
    relativePath: string,
    mode: string,
    signal?: AbortSignal,
  ): Promise<WorkspaceFileHandle> {
    return this.#client.call<WorkspaceFileHandle>(
      'openWorkspaceFile',
      { mode, relativePath, workspaceId },
      signal,
    )
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
