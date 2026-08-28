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
import type { TransactionVersion, WorkspaceTransaction } from './types.ts'

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
        created: result.created,
        generation: result.generation,
      }
    },
    deleteExpected: (workspaceId, expectedGeneration) =>
      registry.deleteExpected(WorkspaceId(workspaceId), expectedGeneration),
    // Missing a committed Host grant is itself the needs-authorization projection;
    // DSH registry rows remain untouched so sessions stay visible.
    markNeedsAuthorization: async () => {},
    has: workspaceId => registry.get(WorkspaceId(workspaceId)) !== undefined,
    get: (workspaceId) => {
      const workspace = registry.get(WorkspaceId(workspaceId))
      return workspace === undefined
        ? undefined
        : { name: workspace.title, canonicalPath: workspace.path }
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

  async list(signal: AbortSignal = new AbortController().signal) {
    signal.throwIfAborted()
    return await Promise.all(this.registry.list().map(async (workspace) => {
      const grant = await this.bridge.inspectWorkspaceGrant(workspace.id, signal)
      if (grant.exists && (grant.generation === undefined || grant.status === undefined)) {
        throw new Error(`Workspace grant ${JSON.stringify(workspace.id)} is incomplete`)
      }
      return {
        workspaceId: workspace.id,
        name: workspace.title,
        state: grant.exists && grant.status !== undefined
          ? !grant.identityValid && grant.effectiveStatus === 'ready'
            ? 'identity-mismatch' as const
            : grant.effectiveStatus
              ?? (grant.status === 'ready' && !grant.identityValid
                ? 'identity-mismatch' as const
                : grant.status)
          : 'needs-authorization' as const,
      }
    }))
  }

  add(signal?: AbortSignal) {
    return this.authority.add(signal)
  }

  revoke(workspaceId: string, signal?: AbortSignal) {
    return this.authority.revoke(workspaceId, signal)
  }

  reauthorize(workspaceId: string, signal?: AbortSignal) {
    return this.authority.reauthorize(workspaceId, signal)
  }
}

export default WorkspaceAuthorityService
