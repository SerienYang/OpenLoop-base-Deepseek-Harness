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
    operationId?: string,
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
  if (transaction.kind === 'reauthorize') {
    return actual === expected || actual === expected + 1
  }
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

function isOriginalUnfrozenGrant(
  transaction: WorkspaceTransaction,
  grant: WorkspaceGrantRecoveryState,
  currentGrantGeneration: number,
): boolean {
  return grant.exists
    && grant.generation === transaction.expectedGrantGeneration
    && currentGrantGeneration === transaction.expectedGrantGeneration
    && grant.status !== undefined
    && grant.status !== 'revoking'
    && grant.status !== 'reauthorizing'
}

function isStableOriginalAddGrant(
  transaction: WorkspaceTransaction,
  grant: WorkspaceGrantRecoveryState,
  currentGrantGeneration: number,
): boolean {
  return grant.exists
    && grant.generation === transaction.expectedGrantGeneration
    && currentGrantGeneration === transaction.expectedGrantGeneration
    && grant.operationId !== undefined
    && grant.operationId !== transaction.operationId
    && grant.status !== undefined
    && grant.status !== 'revoking'
    && grant.status !== 'reauthorizing'
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
  const currentCatalogGeneration = await port.catalogGeneration()
  if (!catalogGenerationMatches(transaction, currentCatalogGeneration)) {
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
        const hasOriginalUnfrozenGrant = isOriginalUnfrozenGrant(
          transaction,
          grant,
          currentGrantGeneration,
        )
        if (!hasOwnedFreeze && !hasOriginalUnfrozenGrant && (
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
        } else if (hasOriginalUnfrozenGrant) {
          await port.deleteGrant(
            workspaceId,
            grantGeneration(workspaceId, grant),
          )
        }
        await advanceAndComplete(port, registryDeleted, 'grant-deleted')
        return 'completed'
      }
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
      const isOriginalUnfrozen = isOriginalUnfrozenGrant(
        transaction,
        grant,
        currentGrantGeneration,
      )
      if (!isOriginalUnfrozen && !isOwnedFreeze) {
        return 'stale-generation'
      }
      if (isOwnedFreeze) {
        if (grant.identityValid) {
          await port.restoreGrantReady(
            workspaceId,
            grantGeneration(workspaceId, grant),
            transaction.operationId,
          )
        } else {
          await port.markNeedsAuthorization(
            workspaceId,
            grantGeneration(workspaceId, grant),
            transaction.operationId,
          )
        }
      } else if (!grant.identityValid) {
        await port.markNeedsAuthorization(
          workspaceId,
          grantGeneration(workspaceId, grant),
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
        if (currentCatalogGeneration !== transaction.expectedCatalogGeneration + 1) {
          return 'stale-generation'
        }
        const grant = await port.inspectGrant(workspaceId)
        const isOwnedLegacyGrant = isMatchingGrant(
          transaction,
          grant,
          transaction.expectedGrantGeneration + 1,
          'ready',
        ) && currentGrantGeneration === transaction.expectedGrantGeneration + 1
        const isOwnedReplacementGrant = isMatchingGrant(
          transaction,
          grant,
          transaction.expectedGrantGeneration + 2,
          'ready',
        ) && currentGrantGeneration === transaction.expectedGrantGeneration + 2
        if (isOwnedLegacyGrant) {
          await port.deleteGrant(
            workspaceId,
            grantGeneration(workspaceId, grant),
            transaction.operationId,
          )
          await advanceAndComplete(port, versionOf(transaction), 'grant-committed')
          return 'completed'
        }
        if (isOwnedReplacementGrant) {
          await port.deleteGrant(
            workspaceId,
            grantGeneration(workspaceId, grant),
            transaction.operationId,
          )
          await port.abortTransaction(versionOf(transaction))
          return 'completed'
        }
        if (isMatchingGrant(
          transaction,
          grant,
          transaction.expectedGrantGeneration + 1,
          'reauthorizing',
        ) && currentGrantGeneration === transaction.expectedGrantGeneration + 1) {
          await port.deleteGrant(
            workspaceId,
            grantGeneration(workspaceId, grant),
            transaction.operationId,
          )
        } else if (isOriginalUnfrozenGrant(transaction, grant, currentGrantGeneration)) {
          await port.deleteGrant(workspaceId, grantGeneration(workspaceId, grant))
        } else if (grant.exists
          || currentGrantGeneration < transaction.expectedGrantGeneration
          || currentGrantGeneration > transaction.expectedGrantGeneration + 2) {
          return 'stale-generation'
        }
        await port.abortTransaction(versionOf(transaction))
        return 'rolled-back'
      }
      const grant = await port.inspectGrant(workspaceId)
      const isOwnedLegacyGrant = isMatchingGrant(
        transaction,
        grant,
        transaction.expectedGrantGeneration + 1,
        'ready',
      ) && currentGrantGeneration === transaction.expectedGrantGeneration + 1
      const isOwnedReplacementGrant = isMatchingGrant(
        transaction,
        grant,
        transaction.expectedGrantGeneration + 2,
        'ready',
      ) && currentGrantGeneration === transaction.expectedGrantGeneration + 2
      if (isOwnedLegacyGrant || isOwnedReplacementGrant) {
        await advanceAndComplete(port, versionOf(transaction), 'grant-committed')
        return 'completed'
      }
      const isOwnedFreeze = isMatchingGrant(
        transaction,
        grant,
        transaction.expectedGrantGeneration + 1,
        'reauthorizing',
      )
      const isOriginalUnfrozen = isOriginalUnfrozenGrant(
        transaction,
        grant,
        currentGrantGeneration,
      )
      if (!isOriginalUnfrozen && !isOwnedFreeze) {
        return 'stale-generation'
      }
      if (isOwnedFreeze) {
        if (grant.identityValid) {
          await port.restoreGrantReady(
            workspaceId,
            grantGeneration(workspaceId, grant),
            transaction.operationId,
          )
        } else {
          await port.markNeedsAuthorization(
            workspaceId,
            grantGeneration(workspaceId, grant),
            transaction.operationId,
          )
        }
      } else if (!grant.identityValid) {
        await port.markNeedsAuthorization(
          workspaceId,
          grantGeneration(workspaceId, grant),
        )
      }
      await port.abortTransaction(versionOf(transaction))
      return 'rolled-back'
    }
    const grant = await port.inspectGrant(workspaceId)
    const isOwnedNewGrant = isMatchingGrant(
      transaction,
      grant,
      transaction.expectedGrantGeneration + 1,
      'ready',
    ) && currentGrantGeneration === transaction.expectedGrantGeneration + 1
    const isOwnedReplacementGrant = isMatchingGrant(
      transaction,
      grant,
      transaction.expectedGrantGeneration + 2,
      'ready',
    ) && currentGrantGeneration === transaction.expectedGrantGeneration + 2
    if (!workspaceExists) {
      if (currentCatalogGeneration !== transaction.expectedCatalogGeneration + 1) {
        return 'stale-generation'
      }
      if (!grant.exists) {
        await port.completeTransaction(versionOf(transaction))
        return 'completed'
      }
      if (!isOwnedNewGrant && !isOwnedReplacementGrant) return 'stale-generation'
      await port.deleteGrant(
        workspaceId,
        grantGeneration(workspaceId, grant),
        transaction.operationId,
      )
      await port.completeTransaction(versionOf(transaction))
      return 'completed'
    }
    if (!isOwnedNewGrant && !isOwnedReplacementGrant) return 'stale-generation'
    await port.completeTransaction(versionOf(transaction))
    return 'completed'
  }

  let addTransaction = versionOf(transaction)
  if (transaction.stage === 'prepared') {
    await port.discardPendingGrant(transaction.operationId)
    const catalogGeneration = await port.catalogGeneration()
    if (catalogGeneration === transaction.expectedCatalogGeneration && !workspaceExists) {
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
    ) && currentGrantGeneration === transaction.expectedGrantGeneration + 1) {
      await advanceAndComplete(port, addTransaction, 'grant-committed')
      return 'completed'
    }
    if (isStableOriginalAddGrant(transaction, grant, currentGrantGeneration)) {
      if (grant.status === 'ready' && grant.identityValid) {
        await advanceAndComplete(port, addTransaction, 'grant-committed')
        return 'completed'
      }
      if (grant.status !== 'needs-authorization') {
        await port.markNeedsAuthorization(
          workspaceId,
          grantGeneration(workspaceId, grant),
        )
      }
      await advanceAndComplete(port, addTransaction, 'authorization-failed')
      return 'needs-authorization'
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
