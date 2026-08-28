import type { Context } from '@deepseek-ai/cordis'
import type { SessionId, WorkspaceId } from '@deepseek-ai/dsh-api-remotes/client'
import {
  createSnapshotStore,
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

export class OpenloopWorkspaceService {
  /** Browser-safe Host grant projection used by Openloop-owned Workspace UI. */
  readonly grants: SnapshotStore<OpenloopWorkspaceListState> =
    createSnapshotStore<OpenloopWorkspaceListState>({
      items: [],
      state: 'idle',
      error: null,
    })
  /** Empty DSH-compatible projection for shared renderer infrastructure. */
  readonly list: SnapshotStore<WorkspaceListState> =
    createSnapshotStore<WorkspaceListState>(EMPTY_WORKSPACE_LIST)

  constructor(
    private readonly remoteSource: OpenloopWorkspaceRemoteSource,
    private readonly sessions: OpenloopWorkspaceSessions,
  ) {}

  async refresh(): Promise<void> {
    this.grants.set({
      ...this.grants.getSnapshot(),
      state: 'loading',
      error: null,
    })
    const remote = await this.remote()
    const result = await remote.listWorkspaceGrants()
    if (!result.ok) {
      const error = new Error(
        `Openloop Workspace list failed: ${result.error.code}: ${result.error.message}`,
      )
      this.grants.set({
        ...this.grants.getSnapshot(),
        state: 'error',
        error,
      })
      throw error
    }
    this.grants.set({
      items: result.value,
      state: 'idle',
      error: null,
    })
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
      this.grants.set({
        ...current,
        items: current.items.filter(item => item.workspaceId !== workspaceId),
      })
    }
    return value
  }

  async reveal(workspaceId: string): Promise<void> {
    const remote = await this.remote()
    this.value(await remote.revealWorkspace(workspaceId), 'reveal')
  }

  connectWorkspace(workspaceId: WorkspaceId, agentPreset?: string): Promise<SessionId> {
    return this.sessions.create({
      workspaceId,
      ...(agentPreset === undefined ? {} : { agentPreset }),
    })
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
    this.grants.set({ ...current, items })
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
