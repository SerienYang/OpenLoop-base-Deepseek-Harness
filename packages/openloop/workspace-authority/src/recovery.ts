import type {
  PersistedGrantStatus,
  TransactionVersion,
  WorkspaceRecoveryOutcome,
  WorkspaceTransaction,
} from './types.ts'

export interface WorkspaceGrantRecoveryState {
  readonly exists: boolean
  readonly generation?: number
  readonly operationId?: string
  readonly identityValid: boolean
  readonly status?: PersistedGrantStatus
}

export interface WorkspaceRecoveryPort {
  catalogGeneration: () => Promise<number>
  grantGeneration: () => Promise<number>
  workspaceExists: (workspaceId: string) => Promise<boolean>
  inspectGrant: (workspaceId: string) => Promise<WorkspaceGrantRecoveryState>
  restoreGrantReady: (
    workspaceId: string,
    expectedGrantGeneration: number,
    operationId: string,
  ) => Promise<number>
  markNeedsAuthorization: (
    workspaceId: string,
    expectedGrantGeneration?: number,
    operationId?: string,
  ) => Promise<number | undefined>
  deleteGrant: (
    workspaceId: string,
    expectedGrantGeneration: number,
    operationId: string,
  ) => Promise<number>
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
      ? actual === expected || actual === expected + 1
      : actual === expected + 1
  }
  return actual === expected || actual === expected + 1
}

function isMatchingGrant(
  transaction: WorkspaceTransaction,
  grant: WorkspaceGrantRecoveryState,
  expectedGeneration: number,
  status: PersistedGrantStatus,
): boolean {
  return grant.exists
    && grant.operationId === transaction.operationId
    && grant.generation === expectedGeneration
    && grant.status === status
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
  const currentGrantGeneration = await port.grantGeneration()

  if (transaction.kind === 'revoke') {
    if (transaction.stage === 'revoke-prepared') {
      const grant = await port.inspectGrant(workspaceId)
      if (!workspaceExists) {
        const hasOwnedFreeze = isMatchingGrant(
          transaction,
          grant,
          transaction.expectedGrantGeneration + 1,
          'revoking',
        )
        if (!hasOwnedFreeze && (
          grant.exists
          || (currentGrantGeneration !== transaction.expectedGrantGeneration
            && currentGrantGeneration !== transaction.expectedGrantGeneration + 2)
        )) {
          return 'stale-generation'
        }
        const registryDeleted = await port.advanceTransaction(
          versionOf(transaction),
          'registry-deleted',
        )
        if (hasOwnedFreeze) {
          await port.deleteGrant(
            workspaceId,
            grantGeneration(workspaceId, grant),
            transaction.operationId,
          )
        }
        await advanceAndComplete(port, registryDeleted, 'grant-deleted')
        return 'completed'
      }
      const isOriginalReady = grant.exists
        && grant.generation === transaction.expectedGrantGeneration
        && currentGrantGeneration === transaction.expectedGrantGeneration
        && grant.status === 'ready'
      const isOwnedFreeze = isMatchingGrant(
        transaction,
        grant,
        transaction.expectedGrantGeneration + 1,
        'revoking',
      )
      const isLegacyUntouched = !grant.exists
        && currentGrantGeneration === transaction.expectedGrantGeneration
      if (isLegacyUntouched) {
        await port.abortTransaction(versionOf(transaction))
        return 'rolled-back'
      }
      if (!isOriginalReady && !isOwnedFreeze) return 'stale-generation'
      if (grant.identityValid) {
        if (grant.status !== 'ready') {
          await port.restoreGrantReady(
            workspaceId,
            grantGeneration(workspaceId, grant),
            transaction.operationId,
          )
        }
      } else {
        await port.markNeedsAuthorization(
          workspaceId,
          grant.exists ? grantGeneration(workspaceId, grant) : undefined,
          transaction.operationId,
        )
      }
      await port.abortTransaction(versionOf(transaction))
      return 'rolled-back'
    }
    if (transaction.stage === 'registry-deleted') {
      const grant = await port.inspectGrant(workspaceId)
      if (isMatchingGrant(
        transaction,
        grant,
        transaction.expectedGrantGeneration + 1,
        'revoking',
      )) {
        await port.deleteGrant(
          workspaceId,
          grantGeneration(workspaceId, grant),
          transaction.operationId,
        )
      } else if (grant.exists
        || (currentGrantGeneration !== transaction.expectedGrantGeneration
          && currentGrantGeneration !== transaction.expectedGrantGeneration + 2)) {
        return 'stale-generation'
      }
      await advanceAndComplete(port, versionOf(transaction), 'grant-deleted')
      return 'completed'
    }
    if (workspaceExists
      || (await port.inspectGrant(workspaceId)).exists
      || (currentGrantGeneration !== transaction.expectedGrantGeneration
        && currentGrantGeneration !== transaction.expectedGrantGeneration + 2)) {
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
      if (isMatchingGrant(
        transaction,
        grant,
        transaction.expectedGrantGeneration + 2,
        'ready',
      )) {
        await advanceAndComplete(port, versionOf(transaction), 'grant-committed')
        return 'completed'
      }
      const isOriginalReady = grant.exists
        && grant.generation === transaction.expectedGrantGeneration
        && currentGrantGeneration === transaction.expectedGrantGeneration
        && grant.status === 'ready'
      const isOwnedFreeze = isMatchingGrant(
        transaction,
        grant,
        transaction.expectedGrantGeneration + 1,
        'reauthorizing',
      )
      if (!isOriginalReady && !isOwnedFreeze) return 'stale-generation'
      if (grant.identityValid) {
        if (grant.status !== 'ready') {
          await port.restoreGrantReady(
            workspaceId,
            grantGeneration(workspaceId, grant),
            transaction.operationId,
          )
        }
      } else {
        await port.markNeedsAuthorization(
          workspaceId,
          grant.exists ? grantGeneration(workspaceId, grant) : undefined,
          transaction.operationId,
        )
      }
      await port.abortTransaction(versionOf(transaction))
      return 'rolled-back'
    }
    if (!workspaceExists) return 'stale-generation'
    const grant = await port.inspectGrant(workspaceId)
    if (!isMatchingGrant(
      transaction,
      grant,
      transaction.expectedGrantGeneration + 2,
      'ready',
    )) return 'stale-generation'
    await port.completeTransaction(versionOf(transaction))
    return 'completed'
  }

  let addTransaction = versionOf(transaction)
  if (transaction.stage === 'prepared') {
    await port.discardPendingGrant(transaction.operationId)
    const catalogGeneration = await port.catalogGeneration()
    if (catalogGeneration === transaction.expectedCatalogGeneration) {
      await port.abortTransaction(addTransaction)
      return 'rolled-back'
    }
    if (!workspaceExists) return 'stale-generation'
    addTransaction = await port.advanceTransaction(addTransaction, 'registry-committed')
  }
  if (addTransaction.stage === 'registry-committed') {
    await port.discardPendingGrant(transaction.operationId)
    if (!workspaceExists) return 'stale-generation'
    const grant = await port.inspectGrant(workspaceId)
    if (isMatchingGrant(
      transaction,
      grant,
      transaction.expectedGrantGeneration + 1,
      'ready',
    )) {
      await advanceAndComplete(port, addTransaction, 'grant-committed')
      return 'completed'
    }
    if (grant.exists || currentGrantGeneration !== transaction.expectedGrantGeneration) {
      return 'stale-generation'
    }
    await port.markNeedsAuthorization(workspaceId)
    await advanceAndComplete(port, addTransaction, 'authorization-failed')
    return 'needs-authorization'
  }
  if (transaction.stage === 'authorization-failed') {
    await port.completeTransaction(versionOf(transaction))
    return 'needs-authorization'
  }
  await port.completeTransaction(versionOf(transaction))
  return 'completed'
}
