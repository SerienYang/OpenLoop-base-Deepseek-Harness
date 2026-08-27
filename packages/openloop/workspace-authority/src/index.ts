import { Context, Service } from '@deepseek-ai/cordis'
import { WorkspaceId, type WorkspaceRegistry } from '@deepseek-ai/dsh-workspace'
import type { OpenloopDesktopHostClient } from '@openloop/desktop-bridge-host'
import {
  WorkspaceAuthority,
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
    createExpected: async (path, expectedGeneration) => {
      const result = await registry.createExpected(path, expectedGeneration)
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
    grantGeneration: () => bridge.getWorkspaceGrantGeneration(),
    beginWorkspaceAuthorization: async () => {
      const selection = await bridge.beginWorkspaceAuthorization()
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
      expectedCanonicalPath,
    ) => bridge.commitWorkspaceAuthorization(
      pendingGrantId,
      workspaceId,
      expectedGrantGeneration,
      expectedCanonicalPath,
    ),
    abortWorkspaceAuthorization: pendingGrantId =>
      bridge.abortWorkspaceAuthorization(pendingGrantId),
    confirmWorkspaceRevoke: (workspaceId, title) =>
      bridge.confirmWorkspaceRevoke(workspaceId, title),
    markGrantRevoking: (workspaceId, expectedGrantGeneration) =>
      bridge.markWorkspaceGrantRevoking(workspaceId, expectedGrantGeneration),
    deleteWorkspaceGrant: (workspaceId, expectedGrantGeneration) =>
      bridge.deleteWorkspaceGrant(workspaceId, expectedGrantGeneration),
    prepareWorkspaceTransaction: input =>
      bridge.prepareWorkspaceTransaction(input),
    advanceWorkspaceTransaction: (
      operationId,
      expectedGeneration,
      expectedStage,
      nextStage,
      workspaceId,
    ) => bridge.advanceWorkspaceTransaction(
      operationId,
      expectedGeneration,
      expectedStage,
      nextStage,
      workspaceId,
    ),
    abortWorkspaceTransaction: (operationId, expectedGeneration, expectedStage) =>
      bridge.abortWorkspaceTransaction(operationId, expectedGeneration, expectedStage),
    completeWorkspaceTransaction: (operationId, expectedGeneration, expectedStage) =>
      bridge.completeWorkspaceTransaction(operationId, expectedGeneration, expectedStage),
  }
}

function recoveryPort(
  registry: WorkspaceRegistry,
  bridge: OpenloopDesktopHostClient,
): WorkspaceRecoveryPort {
  return {
    catalogGeneration: () => Promise.resolve(registry.catalogGeneration()),
    workspaceExists: workspaceId =>
      Promise.resolve(registry.get(WorkspaceId(workspaceId)) !== undefined),
    inspectGrant: workspaceId => bridge.inspectWorkspaceGrant(workspaceId),
    restoreGrantReady: (workspaceId, expectedGrantGeneration) =>
      bridge.restoreWorkspaceGrantReady(workspaceId, expectedGrantGeneration),
    markGrantRevoking: (workspaceId, expectedGrantGeneration) =>
      bridge.markWorkspaceGrantRevoking(workspaceId, expectedGrantGeneration),
    markNeedsAuthorization: async (workspaceId, expectedGrantGeneration) => {
      if (registry.get(WorkspaceId(workspaceId)) === undefined) return undefined
      if (expectedGrantGeneration === undefined) return undefined
      return await bridge.markWorkspaceGrantNeedsAuthorization(
        workspaceId,
        expectedGrantGeneration,
      )
    },
    deleteGrant: (workspaceId, expectedGrantGeneration) =>
      bridge.deleteWorkspaceGrant(workspaceId, expectedGrantGeneration),
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
  readonly #authority: WorkspaceAuthority
  readonly #registry: WorkspaceRegistry
  readonly #bridge: OpenloopDesktopHostClient

  constructor(ctx: Context) {
    super(ctx, 'workspaceAuthority')
    this.#registry = ctx.workspaceRegistry
    this.#bridge = ctx.desktopBridge
    this.#authority = new WorkspaceAuthority(registryPort(this.#registry), nativePort(this.#bridge))
  }

  protected async [Service.init](): Promise<void> {
    const transaction = await this.#bridge.readWorkspaceTransaction()
    const outcome = await recoverWorkspaceTransaction(
      transaction ?? undefined,
      recoveryPort(this.#registry, this.#bridge),
    )
    if (outcome === 'stale-generation') {
      throw new Error('Workspace transaction recovery found stale durable state')
    }
  }

  async list() {
    return await Promise.all(this.#registry.list().map(async (workspace) => {
      const grant = await this.#bridge.inspectWorkspaceGrant(workspace.id)
      return {
        workspaceId: workspace.id,
        name: workspace.title,
        state: grant.exists && grant.status !== undefined
          ? grant.status
          : 'needs-authorization' as const,
      }
    }))
  }

  add() {
    return this.#authority.add()
  }

  revoke(workspaceId: string) {
    return this.#authority.revoke(workspaceId)
  }

  reauthorize(workspaceId: string) {
    return this.#authority.reauthorize(workspaceId)
  }
}

export default WorkspaceAuthorityService
