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

interface OpenloopWorkspaceGrantView {
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

export interface OpenloopWorkspaceListState {
  readonly items: readonly OpenloopWorkspaceGrantView[]
  readonly state: 'idle' | 'loading' | 'error'
  readonly error: Error | null
}

export interface OpenloopWorkspaceRemote {
  listWorkspaceGrants(): Promise<RemoteResult<OpenloopWorkspaceGrantView[]>>
  authorizeWorkspace(): Promise<RemoteResult<OpenloopWorkspaceGrantView | 'cancelled'>>
  reauthorizeWorkspace(
    workspaceId: string,
  ): Promise<RemoteResult<OpenloopWorkspaceGrantView | 'cancelled'>>
  renameWorkspace(
    workspaceId: string,
    name: string,
  ): Promise<RemoteResult<OpenloopWorkspaceGrantView>>
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
  grant: OpenloopWorkspaceGrantView | undefined,
): grant is OpenloopWorkspaceGrantView & {
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

function compatibilityItems(grants: readonly OpenloopWorkspaceGrantView[]): WorkspaceView[] {
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

/**
 * Browser-side Workspace state backed only by the reviewed OpenLoop Desktop
 * Bridge facade. Legacy path-based Workspace operations remain unavailable.
 */
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
  private refreshGeneration = 0
  private readonly workspaceConnections = new Map<WorkspaceId, Promise<SessionId>>()

  constructor(
    private readonly remoteSource: OpenloopWorkspaceRemoteSource,
    private readonly sessions: OpenloopWorkspaceSessions,
  ) {}

  /** Refresh browser-safe Workspace grant projections from the Host. */
  async refresh(): Promise<void> {
    await this.loadWorkspaceGrants()
  }

  private async loadWorkspaceGrants(): Promise<readonly OpenloopWorkspaceGrantView[]> {
    const generation = ++this.refreshGeneration
    this.publish({
      ...this.grants.getSnapshot(),
      state: 'loading',
      error: null,
    })
    try {
      const grants = await this.listWorkspaceGrants()
      if (generation === this.refreshGeneration) {
        this.publish({
          items: grants,
          state: 'idle',
          error: null,
        })
      }
      return grants
    } catch (reason) {
      const error = reason instanceof Error ? reason : new Error(String(reason))
      if (generation === this.refreshGeneration) {
        this.publish({
          ...this.grants.getSnapshot(),
          state: 'error',
          error,
        })
      }
      throw error
    }
  }

  private async listWorkspaceGrants(): Promise<readonly OpenloopWorkspaceGrantView[]> {
    const remote = await this.remote()
    const result = await remote.listWorkspaceGrants()
    if (result.ok) return result.value
    throw new Error(
      `Openloop Workspace list failed: ${result.error.code}: ${result.error.message}`,
    )
  }

  /**
   * Request a new Workspace through trusted native directory selection.
   * @returns The authorized Workspace projection, or `cancelled`.
   */
  async authorize(): Promise<OpenloopWorkspaceGrantView | 'cancelled'> {
    const remote = await this.remote()
    const value = this.value(await remote.authorizeWorkspace(), 'authorize')
    if (value !== 'cancelled') this.upsert(value)
    return value
  }

  /**
   * Request replacement authorization for an existing Workspace.
   * @param workspaceId - Workspace requiring a new native grant.
   * @returns The updated Workspace projection, or `cancelled`.
   */
  async reauthorize(workspaceId: string): Promise<OpenloopWorkspaceGrantView | 'cancelled'> {
    const remote = await this.remote()
    const value = this.value(
      await remote.reauthorizeWorkspace(workspaceId),
      'reauthorize',
    )
    if (value !== 'cancelled') this.upsert(value)
    return value
  }

  /**
   * Request trusted confirmation before revoking a Workspace.
   * @param workspaceId - Workspace to revoke.
   * @returns The confirmation outcome.
   */
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

  /**
   * Rename a Workspace through the reviewed Desktop Bridge facade.
   * @param workspaceId - Workspace to rename.
   * @param name - New non-blank display name.
   * @returns The updated Workspace projection.
   */
  async renameWorkspace(workspaceId: string, name: string): Promise<OpenloopWorkspaceGrantView> {
    const remote = await this.remote()
    const value = this.value(await remote.renameWorkspace(workspaceId, name), 'rename')
    this.upsert(value)
    return value
  }

  /**
   * Ask native code to reveal an authorized Workspace in Finder.
   * @param workspaceId - Workspace to reveal.
   * @returns Resolution after native accepts the request.
   */
  async reveal(workspaceId: string): Promise<void> {
    const remote = await this.remote()
    this.value(await remote.revealWorkspace(workspaceId), 'reveal')
  }

  /**
   * Create or join the in-flight session creation for a ready Workspace.
   * @param workspaceId - Ready Workspace used for the new session.
   * @param agentPreset - Optional preset forwarded to session creation.
   * @returns The new session id after Host grant verification.
   */
  connectWorkspace(workspaceId: WorkspaceId, agentPreset?: string): Promise<SessionId> {
    const inFlight = this.workspaceConnections.get(workspaceId)
    if (inFlight !== undefined) return inFlight

    const current = this.grants.getSnapshot().items.find(
      grant => grant.workspaceId === workspaceId,
    )
    if (current === undefined) {
      return Promise.reject(new Error(
        `Openloop Workspace connect failed: unknown Workspace ${workspaceId}`,
      ))
    }
    if (!isRoutableGrant(current)) {
      return Promise.reject(new Error(
        `Openloop Workspace connect failed: Workspace ${workspaceId} is not ready`,
      ))
    }

    const connection = this.createWorkspaceSession(workspaceId, agentPreset)
      .finally(() => {
        if (this.workspaceConnections.get(workspaceId) === connection) {
          this.workspaceConnections.delete(workspaceId)
        }
      })
    this.workspaceConnections.set(workspaceId, connection)
    return connection
  }

  private async createWorkspaceSession(
    workspaceId: WorkspaceId,
    agentPreset?: string,
  ): Promise<SessionId> {
    const sessionId = await this.sessions.create({
      workspaceId,
      ...(agentPreset === undefined ? {} : { agentPreset }),
    })
    const grants = await this.listWorkspaceGrants()
    const refreshed = grants.find(
      grant => grant.workspaceId === workspaceId,
    )
    if (!isRoutableGrant(refreshed) || !refreshed.sessionIds.includes(sessionId)) {
      throw new Error(
        `Openloop Workspace connect failed: session ${sessionId} has no ready Workspace grant`,
      )
    }
    this.mergeWorkspaceSessionId(workspaceId, sessionId)
    return sessionId
  }

  /**
   * Start and select a session, or clear selection when no Workspace is supplied.
   * @param workspaceId - Ready Workspace used for session creation.
   * @param agentPreset - Optional preset forwarded to session creation.
   */
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

  /**
   * Reject legacy path-based Workspace creation; authorization must use native UI.
   * @param _input - Legacy path payload, deliberately ignored.
   * @returns A rejected promise.
   */
  create(_input: { path: string }): Promise<WorkspaceView> {
    return this.unsupported('create')
  }

  /**
   * Reject the legacy browser directory picker.
   * @returns A rejected promise.
   */
  pickDirectory(): Promise<string | null> {
    return this.unsupported('pickDirectory')
  }

  /**
   * Reject unrestricted browser directory listing.
   * @param _path - Legacy filesystem path, deliberately ignored.
   * @param _signal - Legacy cancellation signal, deliberately ignored.
   * @returns A rejected promise.
   */
  listDirectory(
    _path?: string,
    _signal?: AbortSignal,
  ): Promise<DirectoryListing> {
    return this.unsupported('listDirectory')
  }

  /**
   * Reject unrestricted browser directory creation.
   * @param _path - Legacy filesystem path, deliberately ignored.
   * @param _name - Legacy directory name, deliberately ignored.
   * @returns A rejected promise.
   */
  createDirectory(_path: string, _name: string): Promise<string> {
    return this.unsupported('createDirectory')
  }

  /**
   * Reject unrestricted browser path opening.
   * @param _path - Legacy filesystem path, deliberately ignored.
   * @returns A rejected promise.
   */
  openPath(_path: string): Promise<void> {
    return this.unsupported('openPath')
  }

  /**
   * Reject the legacy Workspace rename route.
   * @param _workspaceId - Legacy Workspace id, deliberately ignored.
   * @param _title - Legacy title, deliberately ignored.
   * @returns A rejected promise.
   */
  rename(_workspaceId: WorkspaceId, _title: string): Promise<WorkspaceView> {
    return this.unsupported('rename')
  }

  /**
   * Reject the legacy Workspace deletion route.
   * @param _workspaceId - Legacy Workspace id, deliberately ignored.
   * @returns A rejected promise.
   */
  delete(_workspaceId: WorkspaceId): Promise<void> {
    return this.unsupported('delete')
  }

  /**
   * Reject legacy Workspace reordering.
   * @param _workspaceId - Legacy Workspace id, deliberately ignored.
   * @param _beforeWorkspaceId - Legacy ordering anchor, deliberately ignored.
   * @returns A rejected promise.
   */
  insertBefore(
    _workspaceId: WorkspaceId,
    _beforeWorkspaceId?: WorkspaceId,
  ): Promise<void> {
    return this.unsupported('insertBefore')
  }

  /**
   * Reject legacy session reordering within a Workspace.
   * @param _workspaceId - Legacy Workspace id, deliberately ignored.
   * @param _sessionId - Legacy session id, deliberately ignored.
   * @param _beforeSessionId - Legacy ordering anchor, deliberately ignored.
   * @returns A rejected promise.
   */
  insertSessionBefore(
    _workspaceId: WorkspaceId,
    _sessionId: SessionId,
    _beforeSessionId?: SessionId,
  ): Promise<WorkspaceView> {
    return this.unsupported('insertSessionBefore')
  }

  /**
   * Reject the legacy Workspace archive route.
   * @param _sessionId - Legacy session id, deliberately ignored.
   * @returns A rejected promise.
   */
  archiveSession(_sessionId: SessionId): Promise<void> {
    return this.unsupported('archiveSession')
  }

  /**
   * Keep the compatibility lifecycle hook inert; Host state drives selection.
   * @returns A no-op disposer.
   */
  startInitialSelection(): () => void {
    return () => {}
  }

  /**
   * Ignore legacy Host envelopes; this service refreshes through its Remote facade.
   * @param _envelope - Legacy transport envelope, deliberately ignored.
   */
  handleHostEnvelope(_envelope: unknown): void {}

  /** Refresh Workspace grants after the browser transport reconnects. */
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

  private upsert(workspace: OpenloopWorkspaceGrantView): void {
    const current = this.grants.getSnapshot()
    const index = current.items.findIndex(item => item.workspaceId === workspace.workspaceId)
    const items = index === -1
      ? [workspace, ...current.items]
      : current.items.map(item => item.workspaceId === workspace.workspaceId ? workspace : item)
    this.publish({ ...current, items })
  }

  private mergeWorkspaceSessionId(
    workspaceId: WorkspaceId,
    sessionId: SessionId,
  ): void {
    const current = this.grants.getSnapshot()
    const index = current.items.findIndex(item => item.workspaceId === workspaceId)
    const workspace = current.items[index]
    if (workspace === undefined) return
    if (workspace.sessionIds.includes(sessionId)) return
    const items = [...current.items]
    items[index] = {
      ...workspace,
      sessionIds: [...workspace.sessionIds, sessionId],
    }
    this.publish({
      ...current,
      items,
    })
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
