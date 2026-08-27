/* oxlint-disable typescript/no-unsafe-argument, typescript/no-unsafe-assignment */
/* oxlint-disable typescript/no-unsafe-member-access, typescript/unbound-method */
// Vitest object-literal test doubles erase contextual parameter types and have no `this` binding.
import { describe, expect, it, vi } from 'vitest'
import {
  WorkspaceAuthority,
  WorkspaceGenerationConflictError,
  type NativeWorkspaceAuthorityPort,
  type WorkspaceRegistryPort,
} from '../src/authority.ts'

function fixture(options: {
  readonly catalogGeneration?: number
  readonly grantGeneration?: number
  readonly cancelledRevoke?: boolean
  readonly existingWorkspace?: boolean
} = {}) {
  let catalogGeneration = options.catalogGeneration ?? 0
  let grantGeneration = options.grantGeneration ?? 0
  const workspaces = new Map<string, { path: string; name: string }>()
  const transactions: string[] = []
  if (options.existingWorkspace === true) {
    workspaces.set('workspace-1', { path: '/host/project', name: 'Project' })
  }
  const registry: WorkspaceRegistryPort = {
    catalogGeneration: () => catalogGeneration,
    createExpected: vi.fn(async (path, expected) => {
      if (expected !== catalogGeneration) {
        throw new WorkspaceGenerationConflictError('catalog', expected, catalogGeneration)
      }
      const existing = [...workspaces].find(([, value]) => value.path === path)
      if (existing !== undefined) {
        return {
          workspaceId: existing[0],
          name: existing[1].name,
          created: false,
          generation: catalogGeneration,
        }
      }
      catalogGeneration += 1
      workspaces.set('workspace-1', { path, name: 'Project' })
      return {
        workspaceId: 'workspace-1',
        name: 'Project',
        created: true,
        generation: catalogGeneration,
      }
    }),
    deleteExpected: vi.fn(async (workspaceId, expected) => {
      if (expected !== catalogGeneration) {
        throw new WorkspaceGenerationConflictError('catalog', expected, catalogGeneration)
      }
      workspaces.delete(workspaceId)
      catalogGeneration += 1
      return { deleted: true, generation: catalogGeneration }
    }),
    markNeedsAuthorization: vi.fn(async () => {}),
    has: workspaceId => workspaces.has(workspaceId),
  }
  const native: NativeWorkspaceAuthorityPort = {
    grantGeneration: () => Promise.resolve(grantGeneration),
    beginWorkspaceAuthorization: vi.fn(async () => ({
      pendingGrantId: 'pending-1',
      canonicalPath: '/host/project',
    })),
    commitWorkspaceAuthorization: vi.fn(async (_pending, workspaceId, expected) => {
      if (expected !== grantGeneration) {
        throw new WorkspaceGenerationConflictError('grant', expected, grantGeneration)
      }
      grantGeneration += 1
      return {
        workspaceId,
        name: 'Project',
        state: 'ready' as const,
      }
    }),
    abortWorkspaceAuthorization: vi.fn(async () => {}),
    confirmWorkspaceRevoke: vi.fn(async () =>
      options.cancelledRevoke === true ? 'cancelled' as const : 'confirmed' as const),
    markGrantRevoking: vi.fn(async (_id, expected) => {
      if (expected !== grantGeneration) {
        throw new WorkspaceGenerationConflictError('grant', expected, grantGeneration)
      }
      grantGeneration += 1
      return grantGeneration
    }),
    deleteWorkspaceGrant: vi.fn(async () => {
      grantGeneration += 1
      return grantGeneration
    }),
    prepareWorkspaceTransaction: vi.fn(async (input) => {
      transactions.push(`prepare:${input.kind}`)
      return { operationId: 'operation-1', generation: 1, stage: input.stage }
    }),
    advanceWorkspaceTransaction: vi.fn(async (_id, _expected, next) => {
      transactions.push(next)
      return { operationId: 'operation-1', generation: transactions.length, stage: next }
    }),
    abortWorkspaceTransaction: vi.fn(async () => { transactions.push('abort') }),
    completeWorkspaceTransaction: vi.fn(async () => { transactions.push('complete') }),
  }
  return {
    authority: new WorkspaceAuthority(registry, native),
    native,
    registry,
    transactions,
    workspaces,
    setCatalogGeneration: (value: number) => { catalogGeneration = value },
    setGrantGeneration: (value: number) => { grantGeneration = value },
  }
}

describe('WorkspaceAuthority', () => {
  it('adds through pending grant, registry commit, grant commit, and journal completion', async () => {
    const value = fixture()

    await expect(value.authority.add()).resolves.toEqual({
      workspaceId: 'workspace-1',
      name: 'Project',
      state: 'ready',
    })
    expect(value.transactions).toEqual([
      'prepare:add',
      'registry-committed',
      'grant-committed',
      'complete',
    ])
  })

  it('reuses a duplicate canonical path without creating a second row', async () => {
    const value = fixture()
    await value.authority.add()
    await value.authority.add()

    expect(value.registry.createExpected).toHaveBeenCalledTimes(2)
    expect(value.workspaces).toHaveLength(1)
  })

  it('aborts pending native grant and transaction when registry creation fails', async () => {
    const value = fixture()
    vi.mocked(value.registry.createExpected).mockRejectedValueOnce(new Error('registry failed'))

    await expect(value.authority.add()).rejects.toThrow('registry failed')
    expect(value.native.abortWorkspaceAuthorization).toHaveBeenCalledWith('pending-1')
    expect(value.transactions).toContain('abort')
  })

  it('marks the registry row needs-authorization when grant commit fails', async () => {
    const value = fixture()
    vi.mocked(value.native.commitWorkspaceAuthorization)
      .mockRejectedValueOnce(new Error('grant failed'))

    await expect(value.authority.add()).rejects.toThrow('grant failed')
    expect(value.registry.markNeedsAuthorization).toHaveBeenCalledWith('workspace-1')
    expect(value.transactions).toEqual([
      'prepare:add',
      'registry-committed',
      'abort',
    ])
  })

  it('rejects stale catalog and grant generations', async () => {
    const staleCatalog = fixture()
    vi.mocked(staleCatalog.registry.createExpected)
      .mockRejectedValueOnce(new WorkspaceGenerationConflictError('catalog', 0, 1))
    await expect(staleCatalog.authority.add()).rejects.toMatchObject({
      store: 'catalog',
      expected: 0,
      actual: 1,
    })

    const staleGrant = fixture()
    vi.mocked(staleGrant.native.commitWorkspaceAuthorization)
      .mockRejectedValueOnce(new WorkspaceGenerationConflictError('grant', 0, 1))
    await expect(staleGrant.authority.add()).rejects.toMatchObject({
      store: 'grant',
      expected: 0,
      actual: 1,
    })
  })

  it('cancels revoke before writing a transaction or touching the registry', async () => {
    const value = fixture({ cancelledRevoke: true, existingWorkspace: true })

    await expect(value.authority.revoke('workspace-1')).resolves.toBe('cancelled')
    expect(value.native.prepareWorkspaceTransaction).not.toHaveBeenCalled()
    expect(value.registry.deleteExpected).not.toHaveBeenCalled()
  })

  it('reauthorizes an existing Workspace through the same transaction queue', async () => {
    const value = fixture({ existingWorkspace: true })

    await expect(value.authority.reauthorize('workspace-1')).resolves.toMatchObject({
      workspaceId: 'workspace-1',
      state: 'ready',
    })
    expect(value.transactions).toEqual([
      'prepare:reauthorize',
      'grant-committed',
      'complete',
    ])
  })
})
