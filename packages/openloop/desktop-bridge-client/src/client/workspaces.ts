import type { Context } from '@deepseek-ai/cordis'
import type {
  DirectoryListing,
  RpcError,
  SessionId,
  WorkspaceId,
  WorkspaceView,
} from '@deepseek-ai/dsh-api-remotes/client'
import {
  createSnapshotStore,
  type IWorkspaces,
  type SessionsPort,
  type SnapshotStore,
  type WorkspaceListState,
  type WorkspaceRuntimeAdapter,
} from '@deepseek-ai/dsh-client-runtime/client'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type { WorkspaceGrantView } from '@openloop/desktop-bridge-host/types'

export interface OpenloopWorkspaceListState {
  readonly items: readonly WorkspaceGrantView[]
  readonly state: 'idle' | 'loading' | 'error'
  readonly error: Error | null
}

export interface OpenloopWorkspaceRemote {
  listWorkspaceGrants(): Promise<RemoteResult<WorkspaceGrantView[]>>
  authorizeWorkspace(): Promise<RemoteResult<WorkspaceGrantView | 'cancelled'>>
  reauthorizeWorkspace(
    workspaceId: string,
  ): Promise<RemoteResult<WorkspaceGrantView | 'cancelled'>>
  renameWorkspace(
    workspaceId: string,
    name: string,
  ): Promise<RemoteResult<WorkspaceGrantView>>
  revokeWorkspace(workspaceId: string): Promise<RemoteResult<'revoked' | 'cancelled'>>
  revealWorkspace(workspaceId: string): Promise<RemoteResult<void>>
}

export interface OpenloopWorkspaceSessions {
  create(options: {
    workspaceId: WorkspaceId
    agentPreset?: string
  }): Promise<SessionId>
  open(sessionId: SessionId): void
  clear(): void
}

export type OpenloopWorkspaceRemoteSource =
  | OpenloopWorkspaceRemote
  | (() => Promise<OpenloopWorkspaceRemote>)

const EMPTY_WORKSPACE_LIST: WorkspaceListState = {
  items: [],
  archivedSessionIds: [],
  state: 'idle',
  phase: 'ready',
  error: null,
  baselinesReady: true,
  recentWorkspaceId: undefined,
}

const SYNTHETIC_WORKSPACE_TIMESTAMP = '1970-01-01T00:00:00.000Z'

function isRoutableGrant(
  grant: WorkspaceGrantView | undefined,
): grant is WorkspaceGrantView & {
  readonly workspaceId: WorkspaceId
  readonly displayPath: string
  readonly state: 'ready'
} {
  return grant !== undefined
    && grant.state === 'ready'
    && grant.workspaceId.length > 0
    && grant.displayPath !== undefined
    && grant.displayPath.length > 0
}

function compatibilityItems(grants: readonly WorkspaceGrantView[]): WorkspaceView[] {
  return grants.filter(isRoutableGrant).map(grant => ({
    workspaceId: grant.workspaceId,
    path: grant.displayPath,
    title: grant.name,
    sessionIds: [...grant.sessionIds],
    createdAt: SYNTHETIC_WORKSPACE_TIMESTAMP,
    updatedAt: SYNTHETIC_WORKSPACE_TIMESTAMP,
  }))
}

function compatibilityError(error: Error | null): RpcError | null {
  return error === null
    ? null
    : { code: 'internal', message: error.message, details: {} }
}

export class OpenloopWorkspaceService implements IWorkspaces {
  /** Browser-safe Host grant projection used by Openloop-owned Workspace UI. */
  readonly grants: SnapshotStore<OpenloopWorkspaceListState> =
    createSnapshotStore<OpenloopWorkspaceListState>({
      items: [],
      state: 'idle',
      error: null,
    })
  /** Browser-safe DSH-compatible projection for shared renderer infrastructure. */
  readonly list: SnapshotStore<WorkspaceListState> =
    createSnapshotStore<WorkspaceListState>(EMPTY_WORKSPACE_LIST)

  constructor(
    private readonly remoteSource: OpenloopWorkspaceRemoteSource,
    private readonly sessions: OpenloopWorkspaceSessions,
  ) {}

  async refresh(): Promise<void> {
    this.publish({
      ...this.grants.getSnapshot(),
      state: 'loading',
      error: null,
    })
    try {
      const remote = await this.remote()
      const result = await remote.listWorkspaceGrants()
      if (!result.ok) {
        throw new Error(
          `Openloop Workspace list failed: ${result.error.code}: ${result.error.message}`,
        )
      }
      this.publish({
        items: result.value,
        state: 'idle',
        error: null,
      })
    } catch (reason) {
      const error = reason instanceof Error ? reason : new Error(String(reason))
      this.publish({
        ...this.grants.getSnapshot(),
        state: 'error',
        error,
      })
      throw error
    }
  }

  async authorize(): Promise<WorkspaceGrantView | 'cancelled'> {
    const remote = await this.remote()
    const value = this.value(await remote.authorizeWorkspace(), 'authorize')
    if (value !== 'cancelled') this.upsert(value)
    return value
  }

  async reauthorize(workspaceId: string): Promise<WorkspaceGrantView | 'cancelled'> {
    const remote = await this.remote()
    const value = this.value(
      await remote.reauthorizeWorkspace(workspaceId),
      'reauthorize',
    )
    if (value !== 'cancelled') this.upsert(value)
    return value
  }

  async revoke(workspaceId: string): Promise<'revoked' | 'cancelled'> {
    const remote = await this.remote()
    const value = this.value(await remote.revokeWorkspace(workspaceId), 'revoke')
    if (value === 'revoked') {
      const current = this.grants.getSnapshot()
      this.publish({
        ...current,
        items: current.items.filter(item => item.workspaceId !== workspaceId),
      })
    }
    return value
  }

  async renameWorkspace(workspaceId: string, name: string): Promise<WorkspaceGrantView> {
    const remote = await this.remote()
    const value = this.value(await remote.renameWorkspace(workspaceId, name), 'rename')
    this.upsert(value)
    return value
  }

  async reveal(workspaceId: string): Promise<void> {
    const remote = await this.remote()
    this.value(await remote.revealWorkspace(workspaceId), 'reveal')
  }

  async connectWorkspace(workspaceId: WorkspaceId, agentPreset?: string): Promise<SessionId> {
    const current = this.grants.getSnapshot().items.find(
      grant => grant.workspaceId === workspaceId,
    )
    if (current === undefined) {
      throw new Error(`Openloop Workspace connect failed: unknown Workspace ${workspaceId}`)
    }
    if (!isRoutableGrant(current)) {
      throw new Error(`Openloop Workspace connect failed: Workspace ${workspaceId} is not ready`)
    }

    const sessionId = await this.sessions.create({
      workspaceId,
      ...(agentPreset === undefined ? {} : { agentPreset }),
    })
    await this.refresh()
    const refreshed = this.grants.getSnapshot().items.find(
      grant => grant.workspaceId === workspaceId,
    )
    if (!isRoutableGrant(refreshed) || !refreshed.sessionIds.includes(sessionId)) {
      throw new Error(
        `Openloop Workspace connect failed: session ${sessionId} has no ready Workspace grant`,
      )
    }
    return sessionId
  }

  startSession(workspaceId?: WorkspaceId, agentPreset?: string): void {
    if (workspaceId === undefined) {
      this.sessions.clear()
      return
    }
    void this.connectWorkspace(workspaceId, agentPreset).then(
      (sessionId) => { this.sessions.open(sessionId) },
      (error: unknown) => { console.warn('Openloop new session failed:', error) },
    )
  }

  create(_input: { path: string }): Promise<WorkspaceView> {
    return this.unsupported('create')
  }

  pickDirectory(): Promise<string | null> {
    return this.unsupported('pickDirectory')
  }

  listDirectory(
    _path?: string,
    _signal?: AbortSignal,
  ): Promise<DirectoryListing> {
    return this.unsupported('listDirectory')
  }

  createDirectory(_path: string, _name: string): Promise<string> {
    return this.unsupported('createDirectory')
  }

  openPath(_path: string): Promise<void> {
    return this.unsupported('openPath')
  }

  rename(_workspaceId: WorkspaceId, _title: string): Promise<WorkspaceView> {
    return this.unsupported('rename')
  }

  delete(_workspaceId: WorkspaceId): Promise<void> {
    return this.unsupported('delete')
  }

  insertBefore(
    _workspaceId: WorkspaceId,
    _beforeWorkspaceId?: WorkspaceId,
  ): Promise<void> {
    return this.unsupported('insertBefore')
  }

  insertSessionBefore(
    _workspaceId: WorkspaceId,
    _sessionId: SessionId,
    _beforeSessionId?: SessionId,
  ): Promise<WorkspaceView> {
    return this.unsupported('insertSessionBefore')
  }

  archiveSession(_sessionId: SessionId): Promise<void> {
    return this.unsupported('archiveSession')
  }

  startInitialSelection(): () => void {
    return () => {}
  }

  handleHostEnvelope(_envelope: unknown): void {}

  handleConnected(): void {
    void this.refresh().catch(() => {})
  }

  private remote(): Promise<OpenloopWorkspaceRemote> {
    return typeof this.remoteSource === 'function'
      ? this.remoteSource()
      : Promise.resolve(this.remoteSource)
  }

  private unsupported<T>(operation: string): Promise<T> {
    return Promise.reject(new Error(
      `Openloop Workspace ${operation} is unavailable through the legacy client face`,
    ))
  }

  private value<T>(result: RemoteResult<T>, operation: string): T {
    if (result.ok) return result.value
    throw new Error(
      `Openloop Workspace ${operation} failed: ${result.error.code}: ${result.error.message}`,
    )
  }

  private upsert(workspace: WorkspaceGrantView): void {
    const current = this.grants.getSnapshot()
    const index = current.items.findIndex(item => item.workspaceId === workspace.workspaceId)
    const items = index === -1
      ? [workspace, ...current.items]
      : current.items.map(item => item.workspaceId === workspace.workspaceId ? workspace : item)
    this.publish({ ...current, items })
  }

  private publish(snapshot: OpenloopWorkspaceListState): void {
    this.grants.set(snapshot)
    this.list.set({
      items: compatibilityItems(snapshot.items),
      archivedSessionIds: [],
      state: snapshot.state,
      phase: 'ready',
      error: compatibilityError(snapshot.error),
      baselinesReady: true,
      recentWorkspaceId: undefined,
    })
  }
}

export class OpenloopWorkspaceRuntimeAdapter implements WorkspaceRuntimeAdapter {
  constructor(private readonly remote: OpenloopWorkspaceRemoteSource) {}

  create(ctx: Context, _api: unknown, sessions: SessionsPort): OpenloopWorkspaceService {
    const service = new OpenloopWorkspaceService(this.remote, sessions)
    ctx.reflect.provide('workspaces', service)
    ctx.reflect.provide('openloopWorkspaces', service)
    return service
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    openloopWorkspaces: OpenloopWorkspaceService
  }
}
