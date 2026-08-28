import { describe, expect, it, vi } from 'vitest'
import {
  recoverWorkspaceTransaction,
  type WorkspaceRecoveryPort,
} from '../src/recovery.ts'
import type { TransactionVersion, WorkspaceTransaction } from '../src/types.ts'

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

  it('discards pending state and never recreates a concurrently deleted workspace', async () => {
    const value = port({ workspaceExists: vi.fn(async () => false) })
    await expect(recoverWorkspaceTransaction(
      transaction('reauthorize', 'reauthorize-prepared'),
      value,
    )).resolves.toBe('stale-generation')
    expect(value.discardPendingGrant).toHaveBeenCalledWith('operation-1')
    expect(value.restoreGrantReady).not.toHaveBeenCalled()
    expect(value.abortTransaction).toHaveBeenCalled()
  })

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
