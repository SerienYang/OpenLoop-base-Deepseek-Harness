import type {
  WorkspaceRecoveryOutcome,
  WorkspaceTransaction,
} from './types.ts'

export interface WorkspaceRecoveryPort {
  workspaceExists(workspaceId: string): Promise<boolean>
  grantExists(workspaceId: string): Promise<boolean>
  oldIdentityValid(workspaceId: string): Promise<boolean>
  restoreGrantReady(workspaceId: string): Promise<void>
  markNeedsAuthorization(workspaceId: string): Promise<void>
  deleteGrant(workspaceId: string): Promise<void>
  discardPendingGrant(operationId: string): Promise<void>
  completeTransaction(
    operationId: string,
    expectedStage: WorkspaceTransaction['stage'],
  ): Promise<void>
}

export async function recoverWorkspaceTransaction(
  transaction: WorkspaceTransaction | undefined,
  port: WorkspaceRecoveryPort,
): Promise<WorkspaceRecoveryOutcome> {
  if (transaction === undefined) return 'completed'
  const workspaceId = transaction.workspaceId
  if (workspaceId === undefined) {
    await port.discardPendingGrant(transaction.operationId)
    return 'needs-authorization'
  }
  const workspaceExists = await port.workspaceExists(workspaceId)

  if (transaction.kind === 'revoke') {
    if (transaction.stage === 'revoke-prepared') {
      if (!workspaceExists) {
        await port.deleteGrant(workspaceId)
        await port.completeTransaction(transaction.operationId, transaction.stage)
        return 'completed'
      }
      if (await port.oldIdentityValid(workspaceId)) {
        await port.restoreGrantReady(workspaceId)
      } else {
        await port.markNeedsAuthorization(workspaceId)
      }
      await port.completeTransaction(transaction.operationId, transaction.stage)
      return 'rolled-back'
    }
    if (transaction.stage === 'registry-deleted') {
      await port.deleteGrant(workspaceId)
      await port.completeTransaction(transaction.operationId, transaction.stage)
      return 'completed'
    }
    if (workspaceExists || await port.grantExists(workspaceId)) {
      return 'stale-generation'
    }
    await port.completeTransaction(transaction.operationId, transaction.stage)
    return 'completed'
  }

  if (transaction.kind === 'reauthorize') {
    if (transaction.stage === 'reauthorize-prepared') {
      await port.discardPendingGrant(transaction.operationId)
      if (!workspaceExists) return 'stale-generation'
      if (await port.oldIdentityValid(workspaceId)) {
        await port.restoreGrantReady(workspaceId)
      } else {
        await port.markNeedsAuthorization(workspaceId)
      }
      await port.completeTransaction(transaction.operationId, transaction.stage)
      return 'rolled-back'
    }
    if (!workspaceExists) return 'stale-generation'
    await port.completeTransaction(transaction.operationId, transaction.stage)
    return 'completed'
  }

  if (transaction.stage === 'prepared') {
    await port.discardPendingGrant(transaction.operationId)
    await port.completeTransaction(transaction.operationId, transaction.stage)
    return 'rolled-back'
  }
  if (transaction.stage === 'registry-committed') {
    await port.discardPendingGrant(transaction.operationId)
    if (workspaceExists) await port.markNeedsAuthorization(workspaceId)
    await port.completeTransaction(transaction.operationId, transaction.stage)
    return 'needs-authorization'
  }
  await port.completeTransaction(transaction.operationId, transaction.stage)
  return 'completed'
}
