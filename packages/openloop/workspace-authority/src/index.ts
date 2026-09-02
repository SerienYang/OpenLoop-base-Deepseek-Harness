import { randomUUID } from 'node:crypto'
import { Context, Service } from '@deepseek-ai/cordis'
import { WorkspaceId, type WorkspaceRegistry } from '@deepseek-ai/dsh-workspace'
import type { OpenloopDesktopHostClient } from '@openloop/desktop-bridge-host'
import {
  WorkspaceAuthority,
  WorkspaceGenerationConflictError,
  type NativeWorkspaceAuthorityPort,
  type WorkspaceRegistryPort,
} from './authority.ts'
import {
  recoverWorkspaceTransaction,
  type WorkspaceRecoveryPort,
} from './recovery.ts'
import type {
  PersistedGrantStatus,
  TransactionVersion,
  WorkspaceGrantView,
  WorkspaceTransaction,
} from './types.ts'

export * from './types.ts'
export * from './authority.ts'
export * from './recovery.ts'

export const name = 'workspace-authority'
export const inject = ['workspaceRegistry', 'desktopBridge']

declare module '@deepseek-ai/cordis' {
  interface Context {
    workspaceAuthority: WorkspaceAuthorityService
  }
}

function registryPort(registry: WorkspaceRegistry): WorkspaceRegistryPort {
  return {
    catalogGeneration: () => registry.catalogGeneration(),
    resolveWorkspaceIdExpected: (canonicalPath, expectedGeneration) => {
      const actual = registry.catalogGeneration()
      if (actual !== expectedGeneration) {
        throw new WorkspaceGenerationConflictError('catalog', expectedGeneration, actual)
      }
      return Promise.resolve(
        registry.list().find(workspace => workspace.path === canonicalPath)?.id
          ?? WorkspaceId(randomUUID()),
      )
    },
    createExpected: async (path, expectedGeneration, workspaceId) => {
      const result = await registry.createExpected(
        path,
        expectedGeneration,
        undefined,
        WorkspaceId(workspaceId),
      )
      return {
        workspaceId: result.workspace.id,
        name: result.workspace.title,
        sessionIds: [...result.workspace.sessionIds],
        created: result.created,
        generation: result.generation,
      }
    },
    deleteExpected: (workspaceId, expectedGeneration) =>
      registry.deleteExpected(WorkspaceId(workspaceId), expectedGeneration),
    renameExpected: async (workspaceId, name, expectedGeneration) => {
      const result = await registry.renameExpected(
        WorkspaceId(workspaceId),
        name,
        expectedGeneration,
      )
      return { name: result.workspace.title, generation: result.generation }
    },
    // Missing a committed Host grant is itself the needs-authorization projection;
    // DSH registry rows remain untouched so sessions stay visible.
    markNeedsAuthorization: async () => {},
    has: workspaceId => registry.get(WorkspaceId(workspaceId)) !== undefined,
    get: (workspaceId) => {
      const workspace = registry.get(WorkspaceId(workspaceId))
      return workspace === undefined
        ? undefined
        : {
          name: workspace.title,
          canonicalPath: workspace.path,
          sessionIds: [...workspace.sessionIds],
        }
    },
  }
}

function nativePort(bridge: OpenloopDesktopHostClient): NativeWorkspaceAuthorityPort {
  return {
    grantGeneration: signal => bridge.getWorkspaceGrantGeneration(signal),
    inspectWorkspaceGrant: (workspaceId, signal) =>
      bridge.inspectWorkspaceGrant(workspaceId, signal),
    beginWorkspaceAuthorization: async (signal) => {
      const selection = await bridge.beginWorkspaceAuthorization(signal)
      return selection.outcome === 'cancelled'
        ? selection
        : {
          outcome: 'pending',
          pendingGrantId: selection.pendingGrantId,
          canonicalPath: selection.path,
        }
    },
    commitWorkspaceAuthorization: (
      pendingGrantId,
      workspaceId,
      expectedGrantGeneration,
      operationId,
      expectedCanonicalPath,
      signal,
    ) => bridge.commitWorkspaceAuthorization(
      pendingGrantId,
      workspaceId,
      expectedGrantGeneration,
      operationId,
      expectedCanonicalPath,
      signal,
    ),
    abortWorkspaceAuthorization: (pendingGrantId, signal) =>
      bridge.abortWorkspaceAuthorization(pendingGrantId, signal),
    confirmWorkspaceRevoke: (workspaceId, title, signal) =>
      bridge.confirmWorkspaceRevoke(workspaceId, title, signal),
    markGrantRevoking: (workspaceId, expectedGrantGeneration, operationId, signal) =>
      bridge.markWorkspaceGrantRevoking(
        workspaceId,
        expectedGrantGeneration,
        operationId,
        signal,
      ),
    markGrantReauthorizing: (workspaceId, expectedGrantGeneration, operationId, signal) =>
      bridge.markWorkspaceGrantReauthorizing(
        workspaceId,
        expectedGrantGeneration,
        operationId,
        signal,
      ),
    restoreGrantReady: (workspaceId, expectedGrantGeneration, operationId, signal) =>
      bridge.restoreWorkspaceGrantReady(
        workspaceId,
        expectedGrantGeneration,
        operationId,
        signal,
      ),
    markGrantNeedsAuthorization: (
      workspaceId,
      expectedGrantGeneration,
      operationId,
      signal,
    ) => bridge.markWorkspaceGrantNeedsAuthorization(
      workspaceId,
      expectedGrantGeneration,
      operationId,
      signal,
    ),
    deleteWorkspaceGrant: (workspaceId, expectedGrantGeneration, operationId, signal) =>
      bridge.deleteWorkspaceGrant(workspaceId, expectedGrantGeneration, operationId, signal),
    prepareWorkspaceTransaction: (input, signal) =>
      bridge.prepareWorkspaceTransaction(input, signal),
    readWorkspaceTransaction: async signal =>
      (await bridge.readWorkspaceTransaction(signal)) ?? undefined,
    advanceWorkspaceTransaction: (
      operationId,
      expectedGeneration,
      expectedStage,
      nextStage,
      signal,
      workspaceId,
    ) => bridge.advanceWorkspaceTransaction(
      operationId,
      expectedGeneration,
      expectedStage,
      nextStage,
      workspaceId,
      signal,
    ),
    abortWorkspaceTransaction: (operationId, expectedGeneration, expectedStage, signal) =>
      bridge.abortWorkspaceTransaction(operationId, expectedGeneration, expectedStage, signal),
    completeWorkspaceTransaction: (operationId, expectedGeneration, expectedStage, signal) =>
      bridge.completeWorkspaceTransaction(operationId, expectedGeneration, expectedStage, signal),
  }
}

function recoveryPort(
  registry: WorkspaceRegistry,
  bridge: OpenloopDesktopHostClient,
): WorkspaceRecoveryPort {
  return {
    catalogGeneration: () => Promise.resolve(registry.catalogGeneration()),
    grantGeneration: () => bridge.getWorkspaceGrantGeneration(),
    workspaceExists: workspaceId =>
      Promise.resolve(registry.get(WorkspaceId(workspaceId)) !== undefined),
    inspectGrant: workspaceId => bridge.inspectWorkspaceGrant(workspaceId),
    restoreGrantReady: (workspaceId, expectedGrantGeneration, operationId) =>
      bridge.restoreWorkspaceGrantReady(
        workspaceId,
        expectedGrantGeneration,
        operationId,
      ),
    markNeedsAuthorization: async (workspaceId, expectedGrantGeneration, operationId) => {
      if (registry.get(WorkspaceId(workspaceId)) === undefined) return undefined
      if (expectedGrantGeneration === undefined) return undefined
      return await bridge.markWorkspaceGrantNeedsAuthorization(
        workspaceId,
        expectedGrantGeneration,
        operationId,
      )
    },
    deleteGrant: (workspaceId, expectedGrantGeneration, operationId) =>
      bridge.deleteWorkspaceGrant(workspaceId, expectedGrantGeneration, operationId),
    // Pending grants are launch-local and the native registry starts empty after a restart.
    discardPendingGrant: async () => {},
    advanceTransaction: (
      transaction: TransactionVersion,
      nextStage: WorkspaceTransaction['stage'],
    ) => bridge.advanceWorkspaceTransaction(
      transaction.operationId,
      transaction.generation,
      transaction.stage,
      nextStage,
    ),
    abortTransaction: transaction => bridge.abortWorkspaceTransaction(
      transaction.operationId,
      transaction.generation,
      transaction.stage,
    ),
    completeTransaction: transaction => bridge.completeWorkspaceTransaction(
      transaction.operationId,
      transaction.generation,
      transaction.stage,
    ),
  }
}

/**
 * Host-owned coordinator for Workspace registry rows and native directory
 * grants. Mutations are serialized and journaled across both durable stores;
 * browser code receives only value-free grant projections.
 */
export class WorkspaceAuthorityService extends Service {
  static inject = inject
  private readonly authority: WorkspaceAuthority
  private readonly registry: WorkspaceRegistry
  private readonly bridge: OpenloopDesktopHostClient

  constructor(ctx: Context) {
    super(ctx, 'workspaceAuthority')
    this.registry = ctx.workspaceRegistry
    this.bridge = ctx.desktopBridge
    this.authority = new WorkspaceAuthority(registryPort(this.registry), nativePort(this.bridge))
  }

  protected async [Service.init](): Promise<void> {
    const transaction = await this.bridge.readWorkspaceTransaction()
    const outcome = await recoverWorkspaceTransaction(
      transaction ?? undefined,
      recoveryPort(this.registry, this.bridge),
    )
    if (outcome === 'stale-generation') {
      throw new Error('Workspace transaction recovery found stale durable state')
    }
  }

  /**
   * Combine durable Workspace records with value-free native grant status.
   * @param signal - Optional request cancellation signal.
   * @returns Workspace projections in registry order.
   */
  async list(
    signal: AbortSignal = new AbortController().signal,
  ): Promise<WorkspaceGrantView[]> {
    signal.throwIfAborted()
    return await Promise.all(this.registry.list().map(async (workspace) => {
      const grant = await this.bridge.inspectWorkspaceGrant(workspace.id, signal)
      if (grant.exists && (grant.generation === undefined || grant.status === undefined)) {
        throw new Error(`Workspace grant ${JSON.stringify(workspace.id)} is incomplete`)
      }
      let state: PersistedGrantStatus = 'needs-authorization'
      if (grant.exists && grant.status !== undefined) {
        state = grant.status
        if (grant.status === 'ready') {
          state = !grant.identityValid && grant.effectiveStatus === 'ready'
            ? 'identity-mismatch'
            : grant.effectiveStatus
              ?? (!grant.identityValid ? 'identity-mismatch' : grant.status)
        }
      }
      return {
        workspaceId: workspace.id,
        name: workspace.title,
        ...(grant.displayPath === undefined ? {} : { displayPath: grant.displayPath }),
        state,
        sessionIds: [...workspace.sessionIds],
      }
    }))
  }

  /**
   * Ask trusted native UI for a directory and atomically register its grant.
   * @param signal - Optional request cancellation signal.
   * @returns The committed Workspace projection, or `cancelled`.
   */
  add(signal?: AbortSignal): Promise<WorkspaceGrantView | 'cancelled'> {
    return this.authority.add(signal)
  }

  /**
   * Revoke a Workspace through trusted confirmation while retaining session logs.
   * @param workspaceId - Workspace whose registry row and grant are targeted.
   * @param signal - Optional request cancellation signal.
   * @returns The confirmation outcome.
   */
  revoke(workspaceId: string, signal?: AbortSignal): Promise<'revoked' | 'cancelled'> {
    return this.authority.revoke(workspaceId, signal)
  }

  /**
   * Replace an unusable grant through trusted native directory selection.
   * @param workspaceId - Existing Workspace to reauthorize.
   * @param signal - Optional request cancellation signal.
   * @returns The ready Workspace projection, or `cancelled`.
   */
  reauthorize(
    workspaceId: string,
    signal?: AbortSignal,
  ): Promise<WorkspaceGrantView | 'cancelled'> {
    return this.authority.reauthorize(workspaceId, signal)
  }

  /**
   * Rename a ready Workspace under the same serialized authority lease.
   * @param workspaceId - Workspace to rename.
   * @param name - New non-blank display name.
   * @param signal - Optional request cancellation signal.
   * @returns The updated Workspace projection.
   */
  rename(
    workspaceId: string,
    name: string,
    signal?: AbortSignal,
  ): Promise<WorkspaceGrantView> {
    return this.authority.rename(workspaceId, name, signal)
  }

  /**
   * Check that both registry ownership and the native grant are ready.
   * @param workspaceId - Workspace to inspect.
   * @param signal - Optional request cancellation signal.
   * @returns `true` only while the Workspace is authorized for Host operations.
   */
  isReady(workspaceId: string, signal?: AbortSignal): Promise<boolean> {
    return this.authority.isReady(workspaceId, signal)
  }

  /**
   * Run a Host operation while holding the authority queue after a ready check.
   * @param workspaceId - Workspace whose authorization gates the operation.
   * @param operation - Deferred Host operation; never called when access is denied.
   * @param signal - Optional request cancellation signal.
   * @returns A denied result or the operation value.
   */
  runIfReady<T>(
    workspaceId: string,
    operation: () => Promise<T>,
    signal?: AbortSignal,
  ): Promise<
    | { readonly allowed: false }
    | { readonly allowed: true; readonly value: T }
  > {
    return this.authority.runIfReady(workspaceId, operation, signal)
  }
}

export default WorkspaceAuthorityService
