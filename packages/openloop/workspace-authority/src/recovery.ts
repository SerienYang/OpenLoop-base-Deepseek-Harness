import type {
  PersistedGrantStatus,
  TransactionVersion,
  WorkspaceRecoveryOutcome,
  WorkspaceTransaction,
} from './types.ts'

export interface WorkspaceGrantRecoveryState {
  readonly exists: boolean
  readonly generation?: number
  readonly identityValid: boolean
  readonly status?: PersistedGrantStatus
}

export interface WorkspaceRecoveryPort {
  catalogGeneration: () => Promise<number>
  workspaceExists: (workspaceId: string) => Promise<boolean>
  inspectGrant: (workspaceId: string) => Promise<WorkspaceGrantRecoveryState>
  restoreGrantReady: (workspaceId: string, expectedGrantGeneration: number) => Promise<number>
  markGrantRevoking: (workspaceId: string, expectedGrantGeneration: number) => Promise<number>
  markNeedsAuthorization: (
    workspaceId: string,
    expectedGrantGeneration?: number,
  ) => Promise<number | undefined>
  deleteGrant: (workspaceId: string, expectedGrantGeneration: number) => Promise<number>
  discardPendingGrant: (operationId: string) => Promise<void>
  advanceTransaction: (
    transaction: TransactionVersion,
    nextStage: WorkspaceTransaction['stage'],
  ) => Promise<TransactionVersion>
  abortTransaction: (transaction: TransactionVersion) => Promise<void>
  completeTransaction: (
    transaction: TransactionVersion,
  ) => Promise<void>
}

function catalogGenerationMatches(
  transaction: WorkspaceTransaction,
  actual: number,
): boolean {
  const expected = transaction.expectedCatalogGeneration
  if (transaction.kind === 'reauthorize') return actual === expected
  if (transaction.kind === 'revoke') {
    return transaction.stage === 'revoke-prepared'
      ? actual === expected
      : actual === expected + 1
  }
  return transaction.stage === 'prepared'
    ? actual === expected
    : actual === expected || actual === expected + 1
}

function versionOf(transaction: WorkspaceTransaction): TransactionVersion {
  return {
    operationId: transaction.operationId,
    generation: transaction.generation,
    stage: transaction.stage,
  }
}

function grantGeneration(
  workspaceId: string,
  grant: WorkspaceGrantRecoveryState,
): number {
  if (!grant.exists || grant.generation === undefined) {
    throw new Error(`Workspace grant ${JSON.stringify(workspaceId)} has no generation`)
  }
  return grant.generation
}

async function advanceAndComplete(
  port: WorkspaceRecoveryPort,
  transaction: TransactionVersion,
  terminalStage: WorkspaceTransaction['stage'],
): Promise<void> {
  const terminal = await port.advanceTransaction(transaction, terminalStage)
  await port.completeTransaction(terminal)
}

export async function recoverWorkspaceTransaction(
  transaction: WorkspaceTransaction | undefined,
  port: WorkspaceRecoveryPort,
): Promise<WorkspaceRecoveryOutcome> {
  if (transaction === undefined) return 'completed'
  if (!catalogGenerationMatches(transaction, await port.catalogGeneration())) {
    return 'stale-generation'
  }
  const workspaceId = transaction.workspaceId
  if (workspaceId === undefined) {
    await port.discardPendingGrant(transaction.operationId)
    await port.abortTransaction(versionOf(transaction))
    return 'rolled-back'
  }
  const workspaceExists = await port.workspaceExists(workspaceId)

  if (transaction.kind === 'revoke') {
    if (transaction.stage === 'revoke-prepared') {
      if (!workspaceExists) {
        const grant = await port.inspectGrant(workspaceId)
        let generation = grantGeneration(workspaceId, grant)
        if (grant.status !== 'revoking') {
          generation = await port.markGrantRevoking(workspaceId, generation)
        }
        const registryDeleted = await port.advanceTransaction(
          versionOf(transaction),
          'registry-deleted',
        )
        await port.deleteGrant(workspaceId, generation)
        await advanceAndComplete(port, registryDeleted, 'grant-deleted')
        return 'completed'
      }
      const grant = await port.inspectGrant(workspaceId)
      if (grant.exists && grant.identityValid) {
        if (grant.status !== 'ready') {
          await port.restoreGrantReady(workspaceId, grantGeneration(workspaceId, grant))
        }
      } else {
        await port.markNeedsAuthorization(
          workspaceId,
          grant.exists ? grantGeneration(workspaceId, grant) : undefined,
        )
      }
      await port.abortTransaction(versionOf(transaction))
      return 'rolled-back'
    }
    if (transaction.stage === 'registry-deleted') {
      const grant = await port.inspectGrant(workspaceId)
      if (grant.exists) {
        await port.deleteGrant(workspaceId, grantGeneration(workspaceId, grant))
      }
      await advanceAndComplete(port, versionOf(transaction), 'grant-deleted')
      return 'completed'
    }
    if (workspaceExists || (await port.inspectGrant(workspaceId)).exists) {
      return 'stale-generation'
    }
    await port.completeTransaction(versionOf(transaction))
    return 'completed'
  }

  if (transaction.kind === 'reauthorize') {
    if (transaction.stage === 'reauthorize-prepared') {
      await port.discardPendingGrant(transaction.operationId)
      if (!workspaceExists) {
        await port.abortTransaction(versionOf(transaction))
        return 'stale-generation'
      }
      const grant = await port.inspectGrant(workspaceId)
      if (grant.exists && grant.identityValid) {
        if (grant.status !== 'ready') {
          await port.restoreGrantReady(workspaceId, grantGeneration(workspaceId, grant))
        }
      } else {
        await port.markNeedsAuthorization(
          workspaceId,
          grant.exists ? grantGeneration(workspaceId, grant) : undefined,
        )
      }
      await port.abortTransaction(versionOf(transaction))
      return 'rolled-back'
    }
    if (!workspaceExists) return 'stale-generation'
    await port.completeTransaction(versionOf(transaction))
    return 'completed'
  }

  if (transaction.stage === 'prepared') {
    await port.discardPendingGrant(transaction.operationId)
    await port.abortTransaction(versionOf(transaction))
    return 'rolled-back'
  }
  if (transaction.stage === 'registry-committed') {
    await port.discardPendingGrant(transaction.operationId)
    if (workspaceExists) await port.markNeedsAuthorization(workspaceId)
    await advanceAndComplete(port, versionOf(transaction), 'authorization-failed')
    return 'needs-authorization'
  }
  await port.completeTransaction(versionOf(transaction))
  return 'completed'
}
