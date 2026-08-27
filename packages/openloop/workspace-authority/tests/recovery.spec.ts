/* oxlint-disable typescript/unbound-method -- recovery ports are arrow-function test doubles without `this`. */
import { describe, expect, it, vi } from 'vitest'
import {
  recoverWorkspaceTransaction,
  type WorkspaceRecoveryPort,
} from '../src/recovery.ts'
import type { WorkspaceTransaction } from '../src/types.ts'

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
    workspaceExists: vi.fn(async () => true),
    grantExists: vi.fn(async () => true),
    oldIdentityValid: vi.fn(async () => true),
    restoreGrantReady: vi.fn(async () => {}),
    markNeedsAuthorization: vi.fn(async () => {}),
    deleteGrant: vi.fn(async () => {}),
    discardPendingGrant: vi.fn(async () => {}),
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

  it('restores a revoke-prepared grant only while registry and identity remain valid', async () => {
    const valid = port()
    await expect(recoverWorkspaceTransaction(
      transaction('revoke', 'revoke-prepared'),
      valid,
    )).resolves.toBe('rolled-back')
    expect(valid.restoreGrantReady).toHaveBeenCalledWith('workspace-1')

    const invalid = port({ oldIdentityValid: vi.fn(async () => false) })
    await recoverWorkspaceTransaction(transaction('revoke', 'revoke-prepared'), invalid)
    expect(invalid.markNeedsAuthorization).toHaveBeenCalledWith('workspace-1')
  })

  it('finishes grant deletion after registry-deleted', async () => {
    const value = port()
    await expect(recoverWorkspaceTransaction(
      transaction('revoke', 'registry-deleted'),
      value,
    )).resolves.toBe('completed')
    expect(value.deleteGrant).toHaveBeenCalledWith('workspace-1')
    expect(value.completeTransaction).toHaveBeenCalledWith('operation-1', 'registry-deleted')
  })

  it('completes when both registry row and grant are already deleted', async () => {
    const value = port({
      workspaceExists: vi.fn(async () => false),
      grantExists: vi.fn(async () => false),
    })
    await expect(recoverWorkspaceTransaction(
      transaction('revoke', 'grant-deleted'),
      value,
    )).resolves.toBe('completed')
    expect(value.restoreGrantReady).not.toHaveBeenCalled()
  })

  it('recovers reauthorize-prepared according to old identity validity', async () => {
    const valid = port()
    await expect(recoverWorkspaceTransaction(
      transaction('reauthorize', 'reauthorize-prepared'),
      valid,
    )).resolves.toBe('rolled-back')
    expect(valid.discardPendingGrant).toHaveBeenCalledWith('operation-1')
    expect(valid.restoreGrantReady).toHaveBeenCalledWith('workspace-1')

    const invalid = port({ oldIdentityValid: vi.fn(async () => false) })
    await recoverWorkspaceTransaction(
      transaction('reauthorize', 'reauthorize-prepared'),
      invalid,
    )
    expect(invalid.markNeedsAuthorization).toHaveBeenCalledWith('workspace-1')
  })

  it('uses a committed new grant as the completion fact', async () => {
    const value = port()
    await expect(recoverWorkspaceTransaction(
      transaction('reauthorize', 'grant-committed'),
      value,
    )).resolves.toBe('completed')
    expect(value.completeTransaction).toHaveBeenCalledWith('operation-1', 'grant-committed')
  })

  it('discards pending state and never recreates a concurrently deleted workspace', async () => {
    const value = port({ workspaceExists: vi.fn(async () => false) })
    await expect(recoverWorkspaceTransaction(
      transaction('reauthorize', 'reauthorize-prepared'),
      value,
    )).resolves.toBe('stale-generation')
    expect(value.discardPendingGrant).toHaveBeenCalledWith('operation-1')
    expect(value.restoreGrantReady).not.toHaveBeenCalled()
  })
})
