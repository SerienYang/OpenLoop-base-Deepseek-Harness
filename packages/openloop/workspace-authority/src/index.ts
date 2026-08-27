import { Context, Service } from '@deepseek-ai/cordis'
import { WorkspaceId, type WorkspaceRegistry } from '@deepseek-ai/dsh-workspace'
import type { OpenloopDesktopHostClient } from '@openloop/desktop-bridge-host'
import {
  WorkspaceAuthority,
  type NativeWorkspaceAuthorityPort,
  type WorkspaceRegistryPort,
} from './authority.ts'

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
  }
}

function nativePort(bridge: OpenloopDesktopHostClient): NativeWorkspaceAuthorityPort {
  return {
    grantGeneration: () => bridge.getWorkspaceGrantGeneration(),
    beginWorkspaceAuthorization: async () => {
      const pending = await bridge.beginWorkspaceAuthorization()
      return {
        pendingGrantId: pending.pendingGrantId,
        canonicalPath: pending.path,
      }
    },
    commitWorkspaceAuthorization: (
      pendingGrantId,
      workspaceId,
      expectedGrantGeneration,
    ) => bridge.commitWorkspaceAuthorization(
      pendingGrantId,
      workspaceId,
      expectedGrantGeneration,
    ),
    abortWorkspaceAuthorization: pendingGrantId =>
      bridge.abortWorkspaceAuthorization(pendingGrantId),
    confirmWorkspaceRevoke: workspaceId =>
      bridge.confirmWorkspaceRevoke(workspaceId),
    markGrantRevoking: (workspaceId, expectedGrantGeneration) =>
      bridge.markWorkspaceGrantRevoking(workspaceId, expectedGrantGeneration),
    deleteWorkspaceGrant: (workspaceId, expectedGrantGeneration) =>
      bridge.deleteWorkspaceGrant(workspaceId, expectedGrantGeneration),
    prepareWorkspaceTransaction: input =>
      bridge.prepareWorkspaceTransaction(input),
    advanceWorkspaceTransaction: (operationId, expectedStage, nextStage) =>
      bridge.advanceWorkspaceTransaction(operationId, expectedStage, nextStage),
    abortWorkspaceTransaction: (operationId, expectedStage) =>
      bridge.abortWorkspaceTransaction(operationId, expectedStage),
    completeWorkspaceTransaction: (operationId, expectedStage) =>
      bridge.completeWorkspaceTransaction(operationId, expectedStage),
  }
}

export class WorkspaceAuthorityService extends Service {
  static inject = inject
  readonly #authority: WorkspaceAuthority

  constructor(ctx: Context) {
    super(ctx, 'workspaceAuthority')
    this.#authority = new WorkspaceAuthority(
      registryPort(ctx.workspaceRegistry),
      nativePort(ctx.desktopBridge),
    )
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
