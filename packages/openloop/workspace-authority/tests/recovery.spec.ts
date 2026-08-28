import { describe, expect, it, vi } from 'vitest'
import {
  recoverWorkspaceTransaction,
  type WorkspaceRecoveryPort,
} from '../src/recovery.ts'
import type {
  PersistedGrantStatus,
  TransactionVersion,
  WorkspaceTransaction,
} from '../src/types.ts'

function transaction(
  kind: WorkspaceTransaction['kind'],
  stage: WorkspaceTransaction['stage'],
): WorkspaceTransaction {
  return {
    operationId: 'operation-1',
    generation: 1,
    kind,
    workspaceId: 'workspace-1',
    expectedCatalogGeneration: 1,
    expectedGrantGeneration: 1,
    stage,
  } as WorkspaceTransaction
}

function port(overrides: Partial<WorkspaceRecoveryPort> = {}): WorkspaceRecoveryPort {
  return {
    catalogGeneration: vi.fn(async () => 1),
    grantGeneration: vi.fn(async () => 1),
    workspaceExists: vi.fn(async () => true),
    inspectGrant: vi.fn(async () => ({
      exists: true,
      generation: 1,
      operationId: 'operation-1',
      identityValid: true,
      status: 'revoking' as const,
    })),
    restoreGrantReady: vi.fn(async () => 2),
    markNeedsAuthorization: vi.fn(async () => 2),
    deleteGrant: vi.fn(async () => 2),
    discardPendingGrant: vi.fn(async () => {}),
    advanceTransaction: vi.fn(async (
      current: TransactionVersion,
      nextStage: WorkspaceTransaction['stage'],
    ) => ({
      ...current,
      generation: current.generation + 1,
      stage: nextStage,
    })),
    abortTransaction: vi.fn(async () => {}),
    completeTransaction: vi.fn(async () => {}),
    ...overrides,
  }
}

function portAfterCommittedCatalogDeletion(
  overrides: Partial<WorkspaceRecoveryPort> = {},
): WorkspaceRecoveryPort {
  let catalogGeneration = 1
  const workspaces = new Set(['workspace-1'])
  const deleteWorkspace = (workspaceId: string) => {
    if (workspaces.delete(workspaceId)) catalogGeneration += 1
  }
  deleteWorkspace('workspace-1')
  return port({
    catalogGeneration: vi.fn(async () => catalogGeneration),
    workspaceExists: vi.fn(async (workspaceId: string) => workspaces.has(workspaceId)),
    ...overrides,
  })
}

const stableDuplicateGrantCases = (
  ['prepared', 'registry-committed'] as const
).flatMap(stage => ([
  ['ready-valid', 'ready', true, 'completed', false],
  ['ready-invalid', 'ready', false, 'needs-authorization', true],
  ['needs-authorization', 'needs-authorization', false, 'needs-authorization', false],
  ['missing', 'missing', false, 'needs-authorization', true],
  ['permission-denied', 'permission-denied', false, 'needs-authorization', true],
  ['identity-mismatch', 'identity-mismatch', false, 'needs-authorization', true],
] as const).map(([label, status, identityValid, outcome, marksNeedsAuthorization]) => ({
  stage,
  label,
  status,
  identityValid,
  outcome,
  marksNeedsAuthorization,
})))

const addRecoveryMatrix = (
  [true, false] as const
).flatMap(workspaceExists => ([
  {
    label: 'grant absent',
    grantGeneration: 1,
    grant: { exists: false, identityValid: false },
    presentOutcome: 'needs-authorization',
  },
  {
    label: 'owned new grant',
    grantGeneration: 2,
    grant: {
      exists: true,
      generation: 2,
      operationId: 'operation-1',
      identityValid: true,
      status: 'ready' as const,
    },
    presentOutcome: 'completed',
  },
  {
    label: 'original stable grant',
    grantGeneration: 1,
    grant: {
      exists: true,
      generation: 1,
      operationId: 'prior-operation',
      identityValid: true,
      status: 'ready' as const,
    },
    presentOutcome: 'completed',
  },
  {
    label: 'revoking grant',
    grantGeneration: 1,
    grant: {
      exists: true,
      generation: 1,
      operationId: 'prior-operation',
      identityValid: true,
      status: 'revoking' as const,
    },
    presentOutcome: 'stale-generation',
  },
  {
    label: 'reauthorizing grant',
    grantGeneration: 1,
    grant: {
      exists: true,
      generation: 1,
      operationId: 'prior-operation',
      identityValid: true,
      status: 'reauthorizing' as const,
    },
    presentOutcome: 'stale-generation',
  },
  {
    label: 'foreign generation',
    grantGeneration: 3,
    grant: {
      exists: true,
      generation: 3,
      operationId: 'prior-operation',
      identityValid: true,
      status: 'ready' as const,
    },
    presentOutcome: 'stale-generation',
  },
] as const).map(value => ({
  ...value,
  workspaceExists,
  outcome: workspaceExists ? value.presentOutcome : 'stale-generation',
})))

const reauthorizeRecoveryMatrix = (
  [true, false] as const
).flatMap(workspaceExists => ([
  {
    label: 'grant absent',
    grantGeneration: 3,
    grant: { exists: false, identityValid: false },
    presentOutcome: 'stale-generation',
    absentOutcome: 'completed',
  },
  {
    label: 'owned new grant',
    grantGeneration: 2,
    grant: {
      exists: true,
      generation: 2,
      operationId: 'operation-1',
      identityValid: true,
      status: 'ready' as const,
    },
    presentOutcome: 'completed',
    absentOutcome: 'completed',
  },
  {
    label: 'owned replacement grant',
    grantGeneration: 3,
    grant: {
      exists: true,
      generation: 3,
      operationId: 'operation-1',
      identityValid: true,
      status: 'ready' as const,
    },
    presentOutcome: 'completed',
    absentOutcome: 'completed',
  },
  {
    label: 'original stable grant',
    grantGeneration: 1,
    grant: {
      exists: true,
      generation: 1,
      operationId: 'prior-operation',
      identityValid: true,
      status: 'ready' as const,
    },
    presentOutcome: 'stale-generation',
    absentOutcome: 'stale-generation',
  },
  {
    label: 'reauthorizing grant',
    grantGeneration: 2,
    grant: {
      exists: true,
      generation: 2,
      operationId: 'operation-1',
      identityValid: true,
      status: 'reauthorizing' as const,
    },
    presentOutcome: 'stale-generation',
    absentOutcome: 'stale-generation',
  },
  {
    label: 'revoking grant',
    grantGeneration: 2,
    grant: {
      exists: true,
      generation: 2,
      operationId: 'operation-1',
      identityValid: true,
      status: 'revoking' as const,
    },
    presentOutcome: 'stale-generation',
    absentOutcome: 'stale-generation',
  },
  {
    label: 'foreign generation',
    grantGeneration: 4,
    grant: {
      exists: true,
      generation: 4,
      operationId: 'other-operation',
      identityValid: true,
      status: 'ready' as const,
    },
    presentOutcome: 'stale-generation',
    absentOutcome: 'stale-generation',
  },
] as const).map(value => ({
  ...value,
  workspaceExists,
  outcome: workspaceExists ? value.presentOutcome : value.absentOutcome,
})))

describe('Workspace transaction recovery', () => {
  it('has no action when no durable transaction exists', async () => {
    const value = port()
    await expect(recoverWorkspaceTransaction(undefined, value)).resolves.toBe('completed')
    expect(value.completeTransaction).not.toHaveBeenCalled()
  })

  it('fails closed before inspecting rows when catalog generation is inconsistent', async () => {
    const value = port({
      catalogGeneration: vi.fn(async () => 9),
    })

    await expect(recoverWorkspaceTransaction(
      transaction('add', 'registry-committed'),
      value,
    )).resolves.toBe('stale-generation')
    expect(value.workspaceExists).not.toHaveBeenCalled()
    expect(value.inspectGrant).not.toHaveBeenCalled()
    expect(value.advanceTransaction).not.toHaveBeenCalled()
  })

  it('recovers an add after the registry committed but the prepared journal did not advance', async () => {
    const value = port({
      catalogGeneration: vi.fn(async () => 2),
      grantGeneration: vi.fn(async () => 1),
      inspectGrant: vi.fn(async () => ({
        exists: false,
        identityValid: false,
      })),
    })

    await expect(recoverWorkspaceTransaction(
      transaction('add', 'prepared'),
      value,
    )).resolves.toBe('needs-authorization')
    expect(value.markNeedsAuthorization).toHaveBeenCalledWith('workspace-1')
    expect(value.advanceTransaction).toHaveBeenNthCalledWith(1, {
      operationId: 'operation-1',
      generation: 1,
      stage: 'prepared',
    }, 'registry-committed')
    expect(value.advanceTransaction).toHaveBeenNthCalledWith(2, {
      operationId: 'operation-1',
      generation: 2,
      stage: 'registry-committed',
    }, 'authorization-failed')
    expect(value.completeTransaction).toHaveBeenCalledWith({
      operationId: 'operation-1',
      generation: 3,
      stage: 'authorization-failed',
    })
  })

  it('finishes a matching add grant committed inside the prepared crash window', async () => {
    const value = port({
      catalogGeneration: vi.fn(async () => 2),
      grantGeneration: vi.fn(async () => 2),
      inspectGrant: vi.fn(async () => ({
        exists: true,
        generation: 2,
        operationId: 'operation-1',
        identityValid: true,
        status: 'ready' as const,
      })),
    })

    await expect(recoverWorkspaceTransaction(
      transaction('add', 'prepared'),
      value,
    )).resolves.toBe('completed')
    expect(value.advanceTransaction).toHaveBeenNthCalledWith(1, {
      operationId: 'operation-1',
      generation: 1,
      stage: 'prepared',
    }, 'registry-committed')
    expect(value.advanceTransaction).toHaveBeenNthCalledWith(2, {
      operationId: 'operation-1',
      generation: 2,
      stage: 'registry-committed',
    }, 'grant-committed')
  })

  it('restores a revoke-prepared grant only while registry and identity remain valid', async () => {
    const valid = port({
      grantGeneration: vi.fn(async () => 2),
      inspectGrant: vi.fn(async () => ({
        exists: true,
        generation: 2,
        operationId: 'operation-1',
        identityValid: true,
        status: 'revoking' as const,
      })),
    })
    await expect(recoverWorkspaceTransaction(
      transaction('revoke', 'revoke-prepared'),
      valid,
    )).resolves.toBe('rolled-back')
    expect(valid.restoreGrantReady)
      .toHaveBeenCalledWith('workspace-1', 2, 'operation-1')
    expect(valid.abortTransaction).toHaveBeenCalledWith({
      operationId: 'operation-1',
      generation: 1,
      stage: 'revoke-prepared',
    })

    const invalid = port({
      inspectGrant: vi.fn(async () => ({
        exists: true,
        generation: 2,
        operationId: 'operation-1',
        identityValid: false,
        status: 'revoking' as const,
      })),
      grantGeneration: vi.fn(async () => 2),
    })
    await recoverWorkspaceTransaction(transaction('revoke', 'revoke-prepared'), invalid)
    expect(invalid.markNeedsAuthorization)
      .toHaveBeenCalledWith('workspace-1', 2, 'operation-1')
  })

  it.each([
    ['revoke', 'revoke-prepared'],
    ['reauthorize', 'reauthorize-prepared'],
  ] as const)('preserves an identity-valid stable grant before the %s freeze', async (
    kind,
    stage,
  ) => {
    const value = port({
      inspectGrant: vi.fn(async () => ({
        exists: true,
        generation: 1,
        operationId: 'prior-operation',
        identityValid: true,
        status: 'permission-denied' as const,
      })),
    })

    await expect(recoverWorkspaceTransaction(
      transaction(kind, stage),
      value,
    )).resolves.toBe('rolled-back')
    expect(value.restoreGrantReady).not.toHaveBeenCalled()
    expect(value.markNeedsAuthorization).not.toHaveBeenCalled()
    expect(value.abortTransaction).toHaveBeenCalledWith({
      operationId: 'operation-1',
      generation: 1,
      stage,
    })
  })

  it.each([
    ['revoke', 'revoke-prepared'],
    ['reauthorize', 'reauthorize-prepared'],
  ] as const)('marks an identity-invalid unfrozen grant without claiming the %s operation', async (
    kind,
    stage,
  ) => {
    const value = port({
      inspectGrant: vi.fn(async () => ({
        exists: true,
        generation: 1,
        operationId: 'prior-operation',
        identityValid: false,
        status: 'ready' as const,
      })),
    })

    await expect(recoverWorkspaceTransaction(
      transaction(kind, stage),
      value,
    )).resolves.toBe('rolled-back')
    expect(value.restoreGrantReady).not.toHaveBeenCalled()
    expect(value.markNeedsAuthorization).toHaveBeenCalledWith('workspace-1', 1)
    expect(value.abortTransaction).toHaveBeenCalledWith({
      operationId: 'operation-1',
      generation: 1,
      stage,
    })
  })

  it('finishes grant deletion after registry-deleted', async () => {
    const value = port({
      catalogGeneration: vi.fn(async () => 2),
      grantGeneration: vi.fn(async () => 2),
      inspectGrant: vi.fn(async () => ({
        exists: true,
        generation: 2,
        operationId: 'operation-1',
        identityValid: true,
        status: 'revoking' as const,
      })),
    })
    await expect(recoverWorkspaceTransaction(
      transaction('revoke', 'registry-deleted'),
      value,
    )).resolves.toBe('completed')
    expect(value.deleteGrant).toHaveBeenCalledWith(
      'workspace-1',
      2,
      'operation-1',
    )
    expect(value.advanceTransaction).toHaveBeenCalledWith({
      operationId: 'operation-1',
      generation: 1,
      stage: 'registry-deleted',
    }, 'grant-deleted')
    expect(value.completeTransaction).toHaveBeenCalledWith({
      operationId: 'operation-1',
      generation: 2,
      stage: 'grant-deleted',
    })
  })

  it('finishes a legacy revoke without grant mutations or generation changes', async () => {
    const value = port({
      workspaceExists: vi.fn(async () => false),
      inspectGrant: vi.fn(async () => ({
        exists: false,
        identityValid: false,
      })),
      grantGeneration: vi.fn(async () => 1),
    })

    await expect(recoverWorkspaceTransaction(
      transaction('revoke', 'revoke-prepared'),
      value,
    )).resolves.toBe('completed')
    expect(value.deleteGrant).not.toHaveBeenCalled()
    expect(value.restoreGrantReady).not.toHaveBeenCalled()
    expect(value.markNeedsAuthorization).not.toHaveBeenCalled()
    expect(value.advanceTransaction).toHaveBeenNthCalledWith(1, {
      operationId: 'operation-1',
      generation: 1,
      stage: 'revoke-prepared',
    }, 'registry-deleted')
    expect(value.advanceTransaction).toHaveBeenNthCalledWith(2, {
      operationId: 'operation-1',
      generation: 2,
      stage: 'registry-deleted',
    }, 'grant-deleted')
  })

  it('deletes an original stable grant after revoke registry deletion committed first', async () => {
    const value = portAfterCommittedCatalogDeletion({
      inspectGrant: vi.fn(async () => ({
        exists: true,
        generation: 1,
        operationId: 'prior-operation',
        identityValid: true,
        status: 'ready' as const,
      })),
    })

    await expect(recoverWorkspaceTransaction(
      transaction('revoke', 'revoke-prepared'),
      value,
    )).resolves.toBe('completed')
    expect(value.deleteGrant).toHaveBeenCalledWith('workspace-1', 1)
    expect(value.advanceTransaction).toHaveBeenNthCalledWith(1, {
      operationId: 'operation-1',
      generation: 1,
      stage: 'revoke-prepared',
    }, 'registry-deleted')
    expect(value.advanceTransaction).toHaveBeenNthCalledWith(2, {
      operationId: 'operation-1',
      generation: 2,
      stage: 'registry-deleted',
    }, 'grant-deleted')
    expect(value.completeTransaction).toHaveBeenCalledWith({
      operationId: 'operation-1',
      generation: 3,
      stage: 'grant-deleted',
    })
  })

  it('finishes a legacy revoke from registry-deleted without a grant mutation', async () => {
    const value = port({
      catalogGeneration: vi.fn(async () => 2),
      workspaceExists: vi.fn(async () => false),
      inspectGrant: vi.fn(async () => ({
        exists: false,
        identityValid: false,
      })),
      grantGeneration: vi.fn(async () => 1),
    })

    await expect(recoverWorkspaceTransaction(
      transaction('revoke', 'registry-deleted'),
      value,
    )).resolves.toBe('completed')
    expect(value.deleteGrant).not.toHaveBeenCalled()
    expect(value.advanceTransaction).toHaveBeenCalledWith({
      operationId: 'operation-1',
      generation: 1,
      stage: 'registry-deleted',
    }, 'grant-deleted')
  })

  it('completes a legacy revoke at grant-deleted without changing grant generation', async () => {
    const value = port({
      catalogGeneration: vi.fn(async () => 2),
      workspaceExists: vi.fn(async () => false),
      inspectGrant: vi.fn(async () => ({
        exists: false,
        identityValid: false,
      })),
      grantGeneration: vi.fn(async () => 1),
    })

    await expect(recoverWorkspaceTransaction(
      transaction('revoke', 'grant-deleted'),
      value,
    )).resolves.toBe('completed')
    expect(value.completeTransaction).toHaveBeenCalledWith({
      operationId: 'operation-1',
      generation: 1,
      stage: 'grant-deleted',
    })
  })

  it('completes when both registry row and grant are already deleted', async () => {
    const value = port({
      catalogGeneration: vi.fn(async () => 2),
      workspaceExists: vi.fn(async () => false),
      inspectGrant: vi.fn(async () => ({
        exists: false,
        identityValid: false,
      })),
      grantGeneration: vi.fn(async () => 3),
    })
    await expect(recoverWorkspaceTransaction(
      transaction('revoke', 'grant-deleted'),
      value,
    )).resolves.toBe('completed')
    expect(value.restoreGrantReady).not.toHaveBeenCalled()
  })

  it('recovers reauthorize-prepared according to old identity validity', async () => {
    const valid = port({
      grantGeneration: vi.fn(async () => 2),
      inspectGrant: vi.fn(async () => ({
        exists: true,
        generation: 2,
        operationId: 'operation-1',
        identityValid: true,
        status: 'reauthorizing' as const,
      })),
    })
    await expect(recoverWorkspaceTransaction(
      transaction('reauthorize', 'reauthorize-prepared'),
      valid,
    )).resolves.toBe('rolled-back')
    expect(valid.discardPendingGrant).toHaveBeenCalledWith('operation-1')
    expect(valid.restoreGrantReady)
      .toHaveBeenCalledWith('workspace-1', 2, 'operation-1')

    const invalid = port({
      inspectGrant: vi.fn(async () => ({
        exists: true,
        generation: 2,
        operationId: 'operation-1',
        identityValid: false,
        status: 'reauthorizing' as const,
      })),
      grantGeneration: vi.fn(async () => 2),
    })
    await recoverWorkspaceTransaction(
      transaction('reauthorize', 'reauthorize-prepared'),
      invalid,
    )
    expect(invalid.markNeedsAuthorization)
      .toHaveBeenCalledWith('workspace-1', 2, 'operation-1')
  })

  it('uses a committed new grant as the completion fact', async () => {
    const value = port({
      grantGeneration: vi.fn(async () => 3),
      inspectGrant: vi.fn(async () => ({
        exists: true,
        generation: 3,
        operationId: 'operation-1',
        identityValid: true,
        status: 'ready' as const,
      })),
    })
    await expect(recoverWorkspaceTransaction(
      transaction('reauthorize', 'grant-committed'),
      value,
    )).resolves.toBe('completed')
    expect(value.completeTransaction).toHaveBeenCalledWith({
      operationId: 'operation-1',
      generation: 1,
      stage: 'grant-committed',
    })
  })

  it('finishes reauthorization when the matching replacement grant committed first', async () => {
    const value = port({
      grantGeneration: vi.fn(async () => 3),
      inspectGrant: vi.fn(async () => ({
        exists: true,
        generation: 3,
        operationId: 'operation-1',
        identityValid: true,
        status: 'ready' as const,
      })),
    })

    await expect(recoverWorkspaceTransaction(
      transaction('reauthorize', 'reauthorize-prepared'),
      value,
    )).resolves.toBe('completed')
    expect(value.restoreGrantReady).not.toHaveBeenCalled()
    expect(value.advanceTransaction).toHaveBeenCalledWith({
      operationId: 'operation-1',
      generation: 1,
      stage: 'reauthorize-prepared',
    }, 'grant-committed')
  })

  it('finishes an add whose matching grant committed before its journal advance', async () => {
    const value = port({
      grantGeneration: vi.fn(async () => 2),
      inspectGrant: vi.fn(async () => ({
        exists: true,
        generation: 2,
        operationId: 'operation-1',
        identityValid: true,
        status: 'ready' as const,
      })),
    })

    await expect(recoverWorkspaceTransaction(
      transaction('add', 'registry-committed'),
      value,
    )).resolves.toBe('completed')
    expect(value.markNeedsAuthorization).not.toHaveBeenCalled()
    expect(value.advanceTransaction).toHaveBeenCalledWith({
      operationId: 'operation-1',
      generation: 1,
      stage: 'registry-committed',
    }, 'grant-committed')
  })

  it.each([
    'prepared',
    'registry-committed',
  ] as const)('reuses an identity-valid ready grant for a duplicate-path add at %s', async (stage) => {
    const value = port({
      inspectGrant: vi.fn(async () => ({
        exists: true,
        generation: 1,
        operationId: 'prior-operation',
        identityValid: true,
        status: 'ready' as const,
      })),
    })

    await expect(recoverWorkspaceTransaction(
      transaction('add', stage),
      value,
    )).resolves.toBe('completed')
    expect(value.markNeedsAuthorization).not.toHaveBeenCalled()
    expect(value.advanceTransaction).toHaveBeenLastCalledWith({
      operationId: 'operation-1',
      generation: stage === 'prepared' ? 2 : 1,
      stage: 'registry-committed',
    }, 'grant-committed')
    expect(value.completeTransaction).toHaveBeenCalledWith({
      operationId: 'operation-1',
      generation: stage === 'prepared' ? 3 : 2,
      stage: 'grant-committed',
    })
  })

  it('marks a duplicate-path add needs-authorization when its old ready grant is invalid', async () => {
    const value = port({
      inspectGrant: vi.fn(async () => ({
        exists: true,
        generation: 1,
        operationId: 'prior-operation',
        identityValid: false,
        status: 'ready' as const,
      })),
    })

    await expect(recoverWorkspaceTransaction(
      transaction('add', 'registry-committed'),
      value,
    )).resolves.toBe('needs-authorization')
    expect(value.markNeedsAuthorization).toHaveBeenCalledWith('workspace-1', 1)
    expect(value.advanceTransaction).toHaveBeenCalledWith({
      operationId: 'operation-1',
      generation: 1,
      stage: 'registry-committed',
    }, 'authorization-failed')
  })

  it.each(stableDuplicateGrantCases)(
    'settles duplicate-path add at $stage for stable $label grant',
    async ({
      stage,
      status,
      identityValid,
      outcome,
      marksNeedsAuthorization,
    }) => {
      const value = port({
        catalogGeneration: vi.fn(async () => 2),
        inspectGrant: vi.fn(async () => ({
          exists: true,
          generation: 1,
          operationId: 'prior-operation',
          identityValid,
          status: status as PersistedGrantStatus,
        })),
      })

      await expect(recoverWorkspaceTransaction(
        transaction('add', stage),
        value,
      )).resolves.toBe(outcome)
      if (marksNeedsAuthorization) {
        expect(value.markNeedsAuthorization).toHaveBeenCalledWith('workspace-1', 1)
      } else {
        expect(value.markNeedsAuthorization).not.toHaveBeenCalled()
      }
      expect(value.advanceTransaction).toHaveBeenLastCalledWith({
        operationId: 'operation-1',
        generation: stage === 'prepared' ? 2 : 1,
        stage: 'registry-committed',
      }, outcome === 'completed' ? 'grant-committed' : 'authorization-failed')
      expect(value.completeTransaction).toHaveBeenCalled()
    },
  )

  it.each(addRecoveryMatrix)(
    'add registry-committed matrix: workspace $workspaceExists with $label -> $outcome',
    async ({ workspaceExists, grantGeneration, grant, outcome }) => {
      const value = port({
        catalogGeneration: vi.fn(async () => 2),
        grantGeneration: vi.fn(async () => grantGeneration),
        workspaceExists: vi.fn(async () => workspaceExists),
        inspectGrant: vi.fn(async () => grant),
      })

      await expect(recoverWorkspaceTransaction(
        transaction('add', 'registry-committed'),
        value,
      )).resolves.toBe(outcome)
      if (outcome === 'stale-generation') {
        expect(value.completeTransaction).not.toHaveBeenCalled()
      } else {
        expect(value.completeTransaction).toHaveBeenCalled()
      }
    },
  )

  it('rejects a duplicate-path grant when the grant store generation drifted', async () => {
    const value = port({
      grantGeneration: vi.fn(async () => 2),
      inspectGrant: vi.fn(async () => ({
        exists: true,
        generation: 1,
        operationId: 'prior-operation',
        identityValid: true,
        status: 'ready' as const,
      })),
    })

    await expect(recoverWorkspaceTransaction(
      transaction('add', 'registry-committed'),
      value,
    )).resolves.toBe('stale-generation')
    expect(value.advanceTransaction).not.toHaveBeenCalled()
    expect(value.completeTransaction).not.toHaveBeenCalled()
  })

  it('rejects a matching new add grant when the grant store generation drifted', async () => {
    const value = port({
      grantGeneration: vi.fn(async () => 3),
      inspectGrant: vi.fn(async () => ({
        exists: true,
        generation: 2,
        operationId: 'operation-1',
        identityValid: true,
        status: 'ready' as const,
      })),
    })

    await expect(recoverWorkspaceTransaction(
      transaction('add', 'registry-committed'),
      value,
    )).resolves.toBe('stale-generation')
    expect(value.advanceTransaction).not.toHaveBeenCalled()
    expect(value.completeTransaction).not.toHaveBeenCalled()
  })

  it('rejects a grant from another operation instead of guessing across the crash window', async () => {
    const value = port({
      grantGeneration: vi.fn(async () => 2),
      inspectGrant: vi.fn(async () => ({
        exists: true,
        generation: 2,
        operationId: 'other-operation',
        identityValid: true,
        status: 'ready' as const,
      })),
    })

    await expect(recoverWorkspaceTransaction(
      transaction('add', 'registry-committed'),
      value,
    )).resolves.toBe('stale-generation')
    expect(value.markNeedsAuthorization).not.toHaveBeenCalled()
    expect(value.completeTransaction).not.toHaveBeenCalled()
  })

  it('reports authorization-failed as needs-authorization after clearing its journal', async () => {
    const value = port()

    await expect(recoverWorkspaceTransaction(
      transaction('add', 'authorization-failed'),
      value,
    )).resolves.toBe('needs-authorization')
    expect(value.completeTransaction).toHaveBeenCalledWith({
      operationId: 'operation-1',
      generation: 1,
      stage: 'authorization-failed',
    })
  })

  it('deletes an unfrozen orphan grant after a concurrent catalog deletion', async () => {
    const value = portAfterCommittedCatalogDeletion({
      inspectGrant: vi.fn(async () => ({
        exists: true,
        generation: 1,
        operationId: 'prior-operation',
        identityValid: true,
        status: 'ready' as const,
      })),
    })

    await expect(recoverWorkspaceTransaction(
      transaction('reauthorize', 'reauthorize-prepared'),
      value,
    )).resolves.toBe('rolled-back')
    expect(value.discardPendingGrant).toHaveBeenCalledWith('operation-1')
    expect(value.deleteGrant).toHaveBeenCalledWith('workspace-1', 1)
    expect(value.restoreGrantReady).not.toHaveBeenCalled()
    expect(value.abortTransaction).toHaveBeenCalledWith({
      operationId: 'operation-1',
      generation: 1,
      stage: 'reauthorize-prepared',
    })
  })

  it('deletes its owned reauthorizing freeze after a concurrent catalog deletion', async () => {
    const value = portAfterCommittedCatalogDeletion({
      grantGeneration: vi.fn(async () => 2),
      inspectGrant: vi.fn(async () => ({
        exists: true,
        generation: 2,
        operationId: 'operation-1',
        identityValid: true,
        status: 'reauthorizing' as const,
      })),
    })

    await expect(recoverWorkspaceTransaction(
      transaction('reauthorize', 'reauthorize-prepared'),
      value,
    )).resolves.toBe('rolled-back')
    expect(value.deleteGrant).toHaveBeenCalledWith('workspace-1', 2, 'operation-1')
    expect(value.abortTransaction).toHaveBeenCalled()
  })

  it('rejects an owned reauthorizing freeze after grant generation drift', async () => {
    const value = portAfterCommittedCatalogDeletion({
      grantGeneration: vi.fn(async () => 3),
      inspectGrant: vi.fn(async () => ({
        exists: true,
        generation: 2,
        operationId: 'operation-1',
        identityValid: true,
        status: 'reauthorizing' as const,
      })),
    })

    await expect(recoverWorkspaceTransaction(
      transaction('reauthorize', 'reauthorize-prepared'),
      value,
    )).resolves.toBe('stale-generation')
    expect(value.deleteGrant).not.toHaveBeenCalled()
    expect(value.abortTransaction).not.toHaveBeenCalled()
  })

  it('settles reauthorization when its frozen grant was already deleted concurrently', async () => {
    const value = portAfterCommittedCatalogDeletion({
      grantGeneration: vi.fn(async () => 3),
      inspectGrant: vi.fn(async () => ({
        exists: false,
        identityValid: false,
      })),
    })

    await expect(recoverWorkspaceTransaction(
      transaction('reauthorize', 'reauthorize-prepared'),
      value,
    )).resolves.toBe('rolled-back')
    expect(value.deleteGrant).not.toHaveBeenCalled()
    expect(value.abortTransaction).toHaveBeenCalled()
  })

  it('deletes its committed replacement after reauthorize-prepared loses the registry row', async () => {
    const value = portAfterCommittedCatalogDeletion({
      grantGeneration: vi.fn(async () => 3),
      inspectGrant: vi.fn(async () => ({
        exists: true,
        generation: 3,
        operationId: 'operation-1',
        identityValid: true,
        status: 'ready' as const,
      })),
    })

    await expect(recoverWorkspaceTransaction(
      transaction('reauthorize', 'reauthorize-prepared'),
      value,
    )).resolves.toBe('completed')
    expect(value.deleteGrant).toHaveBeenCalledWith(
      'workspace-1',
      3,
      'operation-1',
    )
    expect(value.abortTransaction).toHaveBeenCalledWith({
      operationId: 'operation-1',
      generation: 1,
      stage: 'reauthorize-prepared',
    })
    expect(value.completeTransaction).not.toHaveBeenCalled()
  })

  it.each(reauthorizeRecoveryMatrix)(
    'reauthorize grant-committed matrix: workspace $workspaceExists with $label -> $outcome',
    async ({ workspaceExists, grantGeneration, grant, outcome, label }) => {
      const value = port({
        catalogGeneration: vi.fn(async () => workspaceExists ? 1 : 2),
        grantGeneration: vi.fn(async () => grantGeneration),
        workspaceExists: vi.fn(async () => workspaceExists),
        inspectGrant: vi.fn(async () => grant),
      })

      await expect(recoverWorkspaceTransaction(
        transaction('reauthorize', 'grant-committed'),
        value,
      )).resolves.toBe(outcome)
      if (outcome === 'completed') {
        expect(value.completeTransaction).toHaveBeenCalledWith({
          operationId: 'operation-1',
          generation: 1,
          stage: 'grant-committed',
        })
      } else {
        expect(value.completeTransaction).not.toHaveBeenCalled()
      }
      if (!workspaceExists && (label === 'owned new grant' || label === 'owned replacement grant')) {
        expect(value.deleteGrant).toHaveBeenCalledWith(
          'workspace-1',
          label === 'owned new grant' ? 2 : 3,
          'operation-1',
        )
      } else {
        expect(value.deleteGrant).not.toHaveBeenCalled()
      }
    },
  )

  it('marks add registry rows and advances to terminal before completion', async () => {
    const value = port({
      inspectGrant: vi.fn(async () => ({
        exists: false,
        identityValid: false,
      })),
    })

    await expect(recoverWorkspaceTransaction(
      transaction('add', 'registry-committed'),
      value,
    )).resolves.toBe('needs-authorization')
    expect(value.markNeedsAuthorization).toHaveBeenCalledWith('workspace-1')
    expect(value.advanceTransaction).toHaveBeenCalledWith({
      operationId: 'operation-1',
      generation: 1,
      stage: 'registry-committed',
    }, 'authorization-failed')
    expect(value.completeTransaction).toHaveBeenCalledWith({
      operationId: 'operation-1',
      generation: 2,
      stage: 'authorization-failed',
    })
  })
})
