import { describe, expect, it, vi } from 'vitest'
import {
  WorkspaceAuthority,
  WorkspaceGenerationConflictError,
  type NativeWorkspaceAuthorityPort,
  type WorkspaceRegistryPort,
} from '../src/authority.ts'
import type { WorkspaceTransaction } from '../src/types.ts'

function fixture(options: {
  readonly catalogGeneration?: number
  readonly grantGeneration?: number
  readonly cancelledRevoke?: boolean
  readonly existingWorkspace?: boolean
} = {}) {
  let catalogGeneration = options.catalogGeneration ?? 0
  let grantGeneration = options.grantGeneration ?? 0
  let committedGrant: {
    workspaceId: string
    generation: number
    operationId: string
    identityValid: boolean
    status: 'ready' | 'revoking' | 'reauthorizing' | 'needs-authorization'
  } | undefined = options.existingWorkspace === true
    ? {
      workspaceId: 'workspace-1',
      generation: grantGeneration,
      operationId: 'prior-operation',
      identityValid: true,
      status: 'ready',
    }
    : undefined
  const workspaces = new Map<string, { path: string; name: string }>()
  const transactions: string[] = []
  const calls: string[] = []
  if (options.existingWorkspace === true) {
    workspaces.set('workspace-1', { path: '/host/project', name: 'Project' })
  }
  const registry: WorkspaceRegistryPort = {
    catalogGeneration: () => catalogGeneration,
    resolveWorkspaceIdExpected: vi.fn(async (path: string, expected: number) => {
      if (expected !== catalogGeneration) {
        throw new WorkspaceGenerationConflictError('catalog', expected, catalogGeneration)
      }
      return [...workspaces].find(([, value]) => value.path === path)?.[0] ?? 'workspace-1'
    }),
    createExpected: vi.fn(async (path: string, expected: number, workspaceId: string) => {
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
      workspaces.set(workspaceId, { path, name: 'Project' })
      return {
        workspaceId,
        name: 'Project',
        created: true,
        generation: catalogGeneration,
      }
    }),
    deleteExpected: vi.fn(async (workspaceId: string, expected: number) => {
      if (expected !== catalogGeneration) {
        throw new WorkspaceGenerationConflictError('catalog', expected, catalogGeneration)
      }
      workspaces.delete(workspaceId)
      catalogGeneration += 1
      return { deleted: true, generation: catalogGeneration }
    }),
    renameExpected: vi.fn(async (workspaceId: string, name: string, expected: number) => {
      if (expected !== catalogGeneration) {
        throw new WorkspaceGenerationConflictError('catalog', expected, catalogGeneration)
      }
      const workspace = workspaces.get(workspaceId)
      if (workspace === undefined) throw new Error('workspace not found')
      workspace.name = name
      return { name, generation: catalogGeneration }
    }),
    markNeedsAuthorization: vi.fn(async () => {}),
    has: workspaceId => workspaces.has(workspaceId),
    get: (workspaceId) => {
      const workspace = workspaces.get(workspaceId)
      return workspace === undefined
        ? undefined
        : { name: workspace.name, canonicalPath: workspace.path }
    },
  }
  const native: NativeWorkspaceAuthorityPort & {
    readWorkspaceTransaction: (
      signal: AbortSignal,
    ) => Promise<WorkspaceTransaction | undefined>
  } = {
    grantGeneration: () => Promise.resolve(grantGeneration),
    beginWorkspaceAuthorization: vi.fn(async () => {
      calls.push('begin-authorization')
      return {
        outcome: 'pending' as const,
        pendingGrantId: 'pending-1',
        canonicalPath: '/host/project',
      }
    }),
    commitWorkspaceAuthorization: vi.fn(async (
      _pending: string,
      workspaceId: string,
      expected: number,
      operationId: string,
    ) => {
      if (expected !== grantGeneration) {
        throw new WorkspaceGenerationConflictError('grant', expected, grantGeneration)
      }
      grantGeneration += 1
      committedGrant = {
        workspaceId,
        generation: grantGeneration,
        operationId,
        identityValid: true,
        status: 'ready',
      }
      return {
        workspaceId,
        displayPath: '/display/project',
        state: 'ready' as const,
      }
    }),
    inspectWorkspaceGrant: vi.fn(async (workspaceId: string) => {
      calls.push('inspect-grant')
      if (committedGrant?.workspaceId !== workspaceId) {
        return { exists: false, identityValid: false }
      }
      return {
        exists: true,
        generation: committedGrant.generation,
        operationId: committedGrant.operationId,
        identityValid: committedGrant.identityValid,
        status: committedGrant.status,
        effectiveStatus: committedGrant.status,
        displayPath: '/display/project',
      }
    }),
    abortWorkspaceAuthorization: vi.fn(async () => {}),
    confirmWorkspaceRevoke: vi.fn(async () =>
      options.cancelledRevoke === true ? 'cancelled' as const : 'confirmed' as const),
    markGrantRevoking: vi.fn(async (workspaceId: string, expected: number, operationId: string) => {
      if (expected !== grantGeneration) {
        throw new WorkspaceGenerationConflictError('grant', expected, grantGeneration)
      }
      grantGeneration += 1
      committedGrant = {
        workspaceId,
        generation: grantGeneration,
        operationId,
        identityValid: committedGrant?.identityValid ?? false,
        status: 'revoking',
      }
      return grantGeneration
    }),
    markGrantReauthorizing: vi.fn(async (
      workspaceId: string,
      expected: number,
      operationId: string,
    ) => {
      calls.push('mark-reauthorizing')
      if (expected !== grantGeneration) {
        throw new WorkspaceGenerationConflictError('grant', expected, grantGeneration)
      }
      grantGeneration += 1
      committedGrant = {
        workspaceId,
        generation: grantGeneration,
        operationId,
        identityValid: committedGrant?.identityValid ?? false,
        status: 'reauthorizing',
      }
      return grantGeneration
    }),
    restoreGrantReady: vi.fn(async (workspaceId: string, expected: number) => {
      calls.push('restore-ready')
      if (expected !== grantGeneration) {
        throw new WorkspaceGenerationConflictError('grant', expected, grantGeneration)
      }
      grantGeneration += 1
      committedGrant = {
        workspaceId,
        generation: grantGeneration,
        operationId: 'prior-operation',
        identityValid: true,
        status: 'ready',
      }
      return grantGeneration
    }),
    markGrantNeedsAuthorization: vi.fn(async (
      workspaceId: string,
      expected: number,
      operationId: string,
    ) => {
      calls.push('mark-needs-authorization')
      if (expected !== grantGeneration) {
        throw new WorkspaceGenerationConflictError('grant', expected, grantGeneration)
      }
      grantGeneration += 1
      committedGrant = {
        workspaceId,
        generation: grantGeneration,
        operationId,
        identityValid: false,
        status: 'needs-authorization',
      }
      return grantGeneration
    }),
    deleteWorkspaceGrant: vi.fn(async () => {
      grantGeneration += 1
      committedGrant = undefined
      return grantGeneration
    }),
    prepareWorkspaceTransaction: vi.fn(async (
      input: Parameters<NativeWorkspaceAuthorityPort['prepareWorkspaceTransaction']>[0],
    ) => {
      transactions.push(`prepare:${input.kind}`)
      calls.push(`prepare:${input.kind}`)
      return { operationId: 'operation-1', generation: 1, stage: input.stage }
    }),
    readWorkspaceTransaction: vi.fn(async () => undefined),
    advanceWorkspaceTransaction: vi.fn(async (
      _id: string,
      _generation: number,
      _expected: WorkspaceTransaction['stage'],
      next: WorkspaceTransaction['stage'],
    ) => {
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
    calls,
    workspaces,
    setCatalogGeneration: (value: number) => { catalogGeneration = value },
    setGrantGeneration: (value: number) => { grantGeneration = value },
    getGrantGeneration: () => grantGeneration,
  }
}

describe('WorkspaceAuthority', () => {
  it('renames a ready Workspace through catalog generation CAS', async () => {
    const value = fixture({ existingWorkspace: true })

    await expect(value.authority.rename('workspace-1', '  Renamed  ')).resolves.toEqual({
      workspaceId: 'workspace-1',
      name: 'Renamed',
      displayPath: '/display/project',
      state: 'ready',
    })
    expect(value.registry.renameExpected).toHaveBeenCalledExactlyOnceWith(
      'workspace-1',
      'Renamed',
      0,
    )
  })

  it('returns the committed name when cancellation arrives after rename persistence', async () => {
    const value = fixture({ existingWorkspace: true })
    const controller = new AbortController()
    const rename = vi.mocked(value.registry.renameExpected).getMockImplementation()!
    vi.mocked(value.registry.renameExpected).mockImplementationOnce(async (...args) => {
      const committed = await rename(...args)
      controller.abort(new Error('cancelled after commit'))
      return committed
    })

    await expect(value.authority.rename(
      'workspace-1',
      'Committed Name',
      controller.signal,
    )).resolves.toEqual({
      workspaceId: 'workspace-1',
      name: 'Committed Name',
      displayPath: '/display/project',
      state: 'ready',
    })
    expect(value.workspaces.get('workspace-1')?.name).toBe('Committed Name')
  })

  it('holds session creation in the authority queue until its business work settles', async () => {
    const value = fixture({ existingWorkspace: true })
    const createStarted = Promise.withResolvers<undefined>()
    const releaseCreate = Promise.withResolvers<undefined>()
    const create = value.authority.runIfReady(
      'workspace-1',
      async () => {
        createStarted.resolve()
        await releaseCreate.promise
        return 'session-created'
      },
    )
    await createStarted.promise

    const revoke = value.authority.revoke('workspace-1')
    await Promise.resolve()
    expect(value.native.confirmWorkspaceRevoke).not.toHaveBeenCalled()

    releaseCreate.resolve()
    await expect(create).resolves.toEqual({
      allowed: true,
      value: 'session-created',
    })
    await expect(revoke).resolves.toBe('revoked')
  })

  it('releases the authority queue when admitted session creation rejects', async () => {
    const value = fixture({ existingWorkspace: true })

    await expect(value.authority.runIfReady(
      'workspace-1',
      async () => { throw new Error('session create failed') },
    )).rejects.toThrow('session create failed')
    await expect(value.authority.rename('workspace-1', 'After Failure')).resolves.toMatchObject({
      name: 'After Failure',
    })
  })

  it('releases the authority queue when admitted session creation is aborted', async () => {
    const value = fixture({ existingWorkspace: true })
    const controller = new AbortController()
    const createStarted = Promise.withResolvers<undefined>()
    const create = value.authority.runIfReady(
      'workspace-1',
      async () => {
        createStarted.resolve()
        await new Promise<void>((_resolve, reject) => {
          controller.signal.addEventListener(
            'abort',
            () => { reject(controller.signal.reason) },
            { once: true },
          )
        })
      },
      controller.signal,
    )
    await createStarted.promise
    const rename = value.authority.rename('workspace-1', 'After Abort')

    controller.abort(new Error('session create aborted'))

    await expect(create).rejects.toThrow('session create aborted')
    await expect(rename).resolves.toMatchObject({ name: 'After Abort' })
  })

  it('rejects invalid rename names before inspecting Host authority', async () => {
    const value = fixture({ existingWorkspace: true })

    await expect(value.authority.rename('workspace-1', '   ')).rejects.toThrow(/non-blank/iu)
    expect(value.native.inspectWorkspaceGrant).not.toHaveBeenCalled()
    expect(value.registry.renameExpected).not.toHaveBeenCalled()
  })

  it('rejects rename when the grant is not currently ready', async () => {
    const value = fixture({ existingWorkspace: true })
    vi.mocked(value.native.inspectWorkspaceGrant).mockResolvedValueOnce({
      exists: true,
      generation: 0,
      operationId: 'operation-1',
      identityValid: true,
      status: 'revoking',
      effectiveStatus: 'ready',
      displayPath: '/display/project',
    })

    await expect(value.authority.rename('workspace-1', 'Renamed')).rejects.toThrow(/not ready/iu)
    expect(value.registry.renameExpected).not.toHaveBeenCalled()
  })

  it('rejects rename when the catalog generation changes during grant inspection', async () => {
    const value = fixture({ existingWorkspace: true })
    vi.mocked(value.native.inspectWorkspaceGrant).mockImplementationOnce(async () => {
      value.setCatalogGeneration(1)
      return {
        exists: true,
        generation: 0,
        operationId: 'operation-1',
        identityValid: true,
        status: 'ready',
        effectiveStatus: 'ready',
        displayPath: '/display/project',
      }
    })

    await expect(value.authority.rename('workspace-1', 'Renamed')).rejects.toEqual(
      new WorkspaceGenerationConflictError('catalog', 0, 1),
    )
  })

  it('adds through pending grant, registry commit, grant commit, and journal completion', async () => {
    const value = fixture()

    await expect(value.authority.add()).resolves.toEqual({
      workspaceId: 'workspace-1',
      name: 'Project',
      displayPath: '/display/project',
      state: 'ready',
    })
    expect(value.transactions).toEqual([
      'prepare:add',
      'registry-committed',
      'grant-committed',
      'complete',
    ])
    expect(value.native.prepareWorkspaceTransaction).toHaveBeenCalledWith({
      kind: 'add',
      workspaceId: 'workspace-1',
      expectedCatalogGeneration: 0,
      expectedGrantGeneration: 0,
      stage: 'prepared',
    }, expect.any(AbortSignal))
    expect(value.registry.createExpected)
      .toHaveBeenCalledWith('/host/project', 0, 'workspace-1')
    expect(value.native.advanceWorkspaceTransaction).toHaveBeenNthCalledWith(
      1,
      'operation-1',
      1,
      'prepared',
      'registry-committed',
      expect.any(AbortSignal),
    )
  })

  it('returns cancelled without touching the registry when the native picker is cancelled', async () => {
    const value = fixture()
    vi.mocked(value.native.beginWorkspaceAuthorization).mockResolvedValueOnce({
      outcome: 'cancelled',
    })

    await expect(value.authority.add()).resolves.toBe('cancelled')
    expect(value.registry.createExpected).not.toHaveBeenCalled()
    expect(value.native.prepareWorkspaceTransaction).not.toHaveBeenCalled()
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
    expect(value.native.abortWorkspaceAuthorization)
      .toHaveBeenCalledWith('pending-1', expect.any(AbortSignal))
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
      'authorization-failed',
      'complete',
    ])
  })

  it('finishes add when the grant committed before its bridge response was lost', async () => {
    const value = fixture()
    vi.mocked(value.native.commitWorkspaceAuthorization).mockImplementationOnce(async (
      _pending,
      workspaceId,
      expectedGeneration,
      operationId,
    ) => {
      value.setGrantGeneration(expectedGeneration + 1)
      vi.mocked(value.native.inspectWorkspaceGrant).mockResolvedValueOnce({
        exists: true,
        generation: expectedGeneration + 1,
        operationId,
        identityValid: true,
        status: 'ready',
        effectiveStatus: 'ready',
        displayPath: '/display/project',
      })
      throw new Error(`response lost for ${workspaceId}`)
    })

    await expect(value.authority.add()).resolves.toEqual({
      workspaceId: 'workspace-1',
      name: 'Project',
      displayPath: '/display/project',
      state: 'ready',
    })
    expect(value.transactions).toEqual([
      'prepare:add',
      'registry-committed',
      'grant-committed',
      'complete',
    ])
    expect(value.native.abortWorkspaceAuthorization).not.toHaveBeenCalled()
    expect(value.registry.markNeedsAuthorization).not.toHaveBeenCalled()
  })

  it('converges an invalid add grant after commit response loss without reporting ready', async () => {
    const value = fixture()
    vi.mocked(value.native.commitWorkspaceAuthorization).mockImplementationOnce(async (
      _pending,
      _workspaceId,
      expectedGeneration,
      operationId,
    ) => {
      value.setGrantGeneration(expectedGeneration + 1)
      vi.mocked(value.native.inspectWorkspaceGrant).mockResolvedValueOnce({
        exists: true,
        generation: expectedGeneration + 1,
        operationId,
        identityValid: false,
        status: 'ready',
        effectiveStatus: 'identity-mismatch',
      })
      throw new Error('commit response lost')
    })

    await expect(value.authority.add()).rejects.toThrow('commit response lost')
    expect(value.native.markGrantNeedsAuthorization).toHaveBeenCalledWith(
      'workspace-1',
      1,
      'operation-1',
      expect.any(AbortSignal),
    )
    expect(value.registry.markNeedsAuthorization).toHaveBeenCalledWith('workspace-1')
    expect(value.transactions).toEqual([
      'prepare:add',
      'registry-committed',
      'authorization-failed',
      'complete',
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
    expect(value.native.confirmWorkspaceRevoke)
      .toHaveBeenCalledWith('workspace-1', 'Project', expect.any(AbortSignal))
    expect(value.native.prepareWorkspaceTransaction).not.toHaveBeenCalled()
    expect(value.registry.deleteExpected).not.toHaveBeenCalled()
  })

  it('restores the grant and aborts the journal when revoke registry deletion fails', async () => {
    const value = fixture({ existingWorkspace: true })
    vi.mocked(value.registry.deleteExpected)
      .mockRejectedValueOnce(new Error('registry delete failed'))
    vi.mocked(value.native.inspectWorkspaceGrant).mockResolvedValueOnce({
      exists: true,
      generation: 1,
      operationId: 'operation-1',
      identityValid: true,
      status: 'revoking',
    })

    await expect(value.authority.revoke('workspace-1'))
      .rejects.toThrow('registry delete failed')
    expect(value.native.restoreGrantReady).toHaveBeenCalledWith(
      'workspace-1',
      1,
      'operation-1',
      expect.any(AbortSignal),
    )
    expect(value.native.abortWorkspaceTransaction).toHaveBeenCalledWith(
      'operation-1',
      1,
      'revoke-prepared',
      expect.any(AbortSignal),
    )
    expect(value.workspaces.has('workspace-1')).toBe(true)
    expect(value.transactions).toEqual(['prepare:revoke', 'abort'])
  })

  it('marks an invalid grant needs-authorization when revoke registry deletion fails', async () => {
    const value = fixture({ existingWorkspace: true })
    vi.mocked(value.registry.deleteExpected)
      .mockRejectedValueOnce(new Error('registry delete failed'))
    vi.mocked(value.native.inspectWorkspaceGrant)
      .mockResolvedValueOnce({
        exists: true,
        generation: 0,
        operationId: 'prior-operation',
        identityValid: false,
        status: 'ready',
      })
      .mockResolvedValueOnce({
        exists: true,
        generation: 1,
        operationId: 'operation-1',
        identityValid: false,
        status: 'revoking',
      })

    await expect(value.authority.revoke('workspace-1'))
      .rejects.toThrow('registry delete failed')
    expect(value.native.restoreGrantReady).not.toHaveBeenCalled()
    expect(value.native.markGrantNeedsAuthorization).toHaveBeenCalledWith(
      'workspace-1',
      1,
      'operation-1',
      expect.any(AbortSignal),
    )
    expect(value.native.abortWorkspaceTransaction).toHaveBeenCalled()
    expect(value.transactions).toEqual(['prepare:revoke', 'abort'])
  })

  it('revokes a legacy Workspace without mutating the missing Host grant generation', async () => {
    const value = fixture({ existingWorkspace: true })
    vi.mocked(value.native.inspectWorkspaceGrant).mockResolvedValueOnce({
      exists: false,
      identityValid: false,
    })

    await expect(value.authority.revoke('workspace-1')).resolves.toBe('revoked')
    expect(value.native.markGrantRevoking).not.toHaveBeenCalled()
    expect(value.native.deleteWorkspaceGrant).not.toHaveBeenCalled()
    expect(value.getGrantGeneration()).toBe(0)
    expect(value.workspaces.has('workspace-1')).toBe(false)
    expect(value.transactions).toEqual([
      'prepare:revoke',
      'registry-deleted',
      'grant-deleted',
      'complete',
    ])
  })

  it('reauthorizes an existing Workspace through the same transaction queue', async () => {
    const value = fixture({ existingWorkspace: true })

    await expect(value.authority.reauthorize('workspace-1')).resolves.toMatchObject({
      workspaceId: 'workspace-1',
      name: 'Project',
      displayPath: '/display/project',
      state: 'ready',
    })
    expect(value.transactions).toEqual([
      'prepare:reauthorize',
      'grant-committed',
      'complete',
    ])
    expect(value.calls.slice(0, 3)).toEqual([
      'inspect-grant',
      'prepare:reauthorize',
      'mark-reauthorizing',
    ])
    expect(value.native.commitWorkspaceAuthorization).toHaveBeenCalledWith(
      'pending-1',
      'workspace-1',
      1,
      'operation-1',
      '/host/project',
      expect.any(AbortSignal),
    )
  })

  it('continues reauthorization when prepare committed before its response was lost', async () => {
    const value = fixture({ existingWorkspace: true })
    let operationId = ''
    vi.mocked(value.native.prepareWorkspaceTransaction)
      .mockImplementationOnce(async (input) => {
        operationId = input.operationId ?? ''
        throw new Error('prepare response lost')
      })
    vi.mocked(value.native.readWorkspaceTransaction).mockImplementationOnce(async () => {
      return {
        operationId,
        generation: 1,
        kind: 'reauthorize',
        workspaceId: 'workspace-1',
        expectedCatalogGeneration: 0,
        expectedGrantGeneration: 0,
        stage: 'reauthorize-prepared',
      }
    })

    await expect(value.authority.reauthorize('workspace-1')).resolves.toMatchObject({
      workspaceId: 'workspace-1',
      state: 'ready',
    })
    expect(value.native.markGrantReauthorizing).toHaveBeenCalledWith(
      'workspace-1',
      0,
      operationId,
      expect.any(AbortSignal),
    )
    expect(value.transactions).toEqual(['grant-committed', 'complete'])
  })

  it('fails closed when prepare response loss reveals a foreign transaction', async () => {
    const value = fixture({ existingWorkspace: true })
    vi.mocked(value.native.prepareWorkspaceTransaction)
      .mockRejectedValueOnce(new Error('prepare response lost'))
    vi.mocked(value.native.readWorkspaceTransaction).mockResolvedValueOnce({
      operationId: 'foreign-operation',
      generation: 1,
      kind: 'reauthorize',
      workspaceId: 'workspace-1',
      expectedCatalogGeneration: 0,
      expectedGrantGeneration: 0,
      stage: 'reauthorize-prepared',
    })

    await expect(value.authority.reauthorize('workspace-1'))
      .rejects.toThrow('prepare response lost')
    expect(value.native.markGrantReauthorizing).not.toHaveBeenCalled()
    expect(value.native.abortWorkspaceTransaction).not.toHaveBeenCalled()
  })

  it('continues reauthorization when mark committed before its response was lost', async () => {
    const value = fixture({ existingWorkspace: true })
    const mark = vi.mocked(value.native.markGrantReauthorizing).getMockImplementation()!
    vi.mocked(value.native.markGrantReauthorizing).mockImplementationOnce(async (...args) => {
      await mark(...args)
      throw new Error('mark response lost')
    })
    vi.mocked(value.native.readWorkspaceTransaction).mockResolvedValueOnce({
      operationId: 'operation-1',
      generation: 1,
      kind: 'reauthorize',
      workspaceId: 'workspace-1',
      expectedCatalogGeneration: 0,
      expectedGrantGeneration: 0,
      stage: 'reauthorize-prepared',
    })

    await expect(value.authority.reauthorize('workspace-1')).resolves.toMatchObject({
      workspaceId: 'workspace-1',
      state: 'ready',
    })
    expect(value.native.beginWorkspaceAuthorization).toHaveBeenCalledOnce()
    expect(value.transactions).toEqual([
      'prepare:reauthorize',
      'grant-committed',
      'complete',
    ])
  })

  it('aborts its journal when mark fails before mutating the original grant', async () => {
    const value = fixture({ existingWorkspace: true })
    vi.mocked(value.native.markGrantReauthorizing)
      .mockRejectedValueOnce(new Error('mark failed'))
    vi.mocked(value.native.readWorkspaceTransaction).mockResolvedValueOnce({
      operationId: 'operation-1',
      generation: 1,
      kind: 'reauthorize',
      workspaceId: 'workspace-1',
      expectedCatalogGeneration: 0,
      expectedGrantGeneration: 0,
      stage: 'reauthorize-prepared',
    })

    await expect(value.authority.reauthorize('workspace-1')).rejects.toThrow('mark failed')
    expect(value.native.beginWorkspaceAuthorization).not.toHaveBeenCalled()
    expect(value.native.restoreGrantReady).not.toHaveBeenCalled()
    expect(value.native.abortWorkspaceTransaction).toHaveBeenCalledWith(
      'operation-1',
      1,
      'reauthorize-prepared',
      expect.any(AbortSignal),
    )
    expect(value.transactions).toEqual(['prepare:reauthorize', 'abort'])
  })

  it('does not mutate a foreign freeze after mark response loss', async () => {
    const value = fixture({ existingWorkspace: true })
    vi.mocked(value.native.markGrantReauthorizing)
      .mockRejectedValueOnce(new Error('mark response lost'))
    vi.mocked(value.native.readWorkspaceTransaction).mockResolvedValueOnce({
      operationId: 'operation-1',
      generation: 1,
      kind: 'reauthorize',
      workspaceId: 'workspace-1',
      expectedCatalogGeneration: 0,
      expectedGrantGeneration: 0,
      stage: 'reauthorize-prepared',
    })
    vi.mocked(value.native.inspectWorkspaceGrant)
      .mockResolvedValueOnce({
        exists: true,
        generation: 0,
        operationId: 'prior-operation',
        identityValid: true,
        status: 'ready',
        effectiveStatus: 'ready',
      })
      .mockResolvedValueOnce({
        exists: true,
        generation: 1,
        operationId: 'foreign-operation',
        identityValid: true,
        status: 'reauthorizing',
        effectiveStatus: 'ready',
      })

    await expect(value.authority.reauthorize('workspace-1'))
      .rejects.toThrow('mark response lost')
    expect(value.native.restoreGrantReady).not.toHaveBeenCalled()
    expect(value.native.markGrantNeedsAuthorization).not.toHaveBeenCalled()
    expect(value.native.abortWorkspaceTransaction).toHaveBeenCalledWith(
      'operation-1',
      1,
      'reauthorize-prepared',
      expect.any(AbortSignal),
    )
  })

  it('restores the frozen grant and aborts the journal when reauthorization is cancelled', async () => {
    const value = fixture({ existingWorkspace: true })
    vi.mocked(value.native.beginWorkspaceAuthorization).mockResolvedValueOnce({
      outcome: 'cancelled',
    })

    await expect(value.authority.reauthorize('workspace-1')).resolves.toBe('cancelled')
    expect(value.calls).toEqual([
      'inspect-grant',
      'prepare:reauthorize',
      'mark-reauthorizing',
      'inspect-grant',
      'restore-ready',
    ])
    expect(value.native.restoreGrantReady)
      .toHaveBeenCalledWith('workspace-1', 1, 'operation-1', expect.any(AbortSignal))
    expect(value.transactions).toEqual(['prepare:reauthorize', 'abort'])
    expect(value.native.commitWorkspaceAuthorization).not.toHaveBeenCalled()
  })

  it('marks an invalid frozen grant needs-authorization when reauthorization is cancelled', async () => {
    const value = fixture({ existingWorkspace: true })
    vi.mocked(value.native.inspectWorkspaceGrant)
      .mockResolvedValueOnce({
        exists: true,
        generation: 0,
        operationId: 'prior-operation',
        identityValid: false,
        status: 'ready',
      })
      .mockResolvedValueOnce({
        exists: true,
        generation: 1,
        operationId: 'operation-1',
        identityValid: false,
        status: 'reauthorizing',
      })
    vi.mocked(value.native.beginWorkspaceAuthorization).mockResolvedValueOnce({
      outcome: 'cancelled',
    })

    await expect(value.authority.reauthorize('workspace-1')).resolves.toBe('cancelled')
    expect(value.native.restoreGrantReady).not.toHaveBeenCalled()
    expect(value.native.markGrantNeedsAuthorization).toHaveBeenCalledWith(
      'workspace-1',
      1,
      'operation-1',
      expect.any(AbortSignal),
    )
    expect(value.transactions).toEqual(['prepare:reauthorize', 'abort'])
  })

  it('does not restore ready when the old grant identity becomes invalid while the picker is open', async () => {
    const value = fixture({ existingWorkspace: true })
    vi.mocked(value.native.inspectWorkspaceGrant).mockResolvedValueOnce({
      exists: true,
      generation: 0,
      operationId: 'prior-operation',
      identityValid: true,
      status: 'ready',
    }).mockResolvedValueOnce({
      exists: true,
      generation: 1,
      operationId: 'operation-1',
      identityValid: false,
      status: 'reauthorizing',
    })
    vi.mocked(value.native.beginWorkspaceAuthorization).mockResolvedValueOnce({
      outcome: 'cancelled',
    })

    await expect(value.authority.reauthorize('workspace-1')).resolves.toBe('cancelled')
    expect(value.native.restoreGrantReady).not.toHaveBeenCalled()
    expect(value.native.markGrantNeedsAuthorization).toHaveBeenCalledWith(
      'workspace-1',
      1,
      'operation-1',
      expect.any(AbortSignal),
    )
    expect(value.transactions).toEqual(['prepare:reauthorize', 'abort'])
  })

  it('restores the frozen grant when the native reauthorization picker fails', async () => {
    const value = fixture({ existingWorkspace: true })
    vi.mocked(value.native.beginWorkspaceAuthorization)
      .mockRejectedValueOnce(new Error('picker failed'))

    await expect(value.authority.reauthorize('workspace-1')).rejects.toThrow('picker failed')
    expect(value.native.restoreGrantReady)
      .toHaveBeenCalledWith('workspace-1', 1, 'operation-1', expect.any(AbortSignal))
    expect(value.transactions).toEqual(['prepare:reauthorize', 'abort'])
  })

  it('marks an invalid frozen grant needs-authorization when the picker fails', async () => {
    const value = fixture({ existingWorkspace: true })
    vi.mocked(value.native.inspectWorkspaceGrant)
      .mockResolvedValueOnce({
        exists: true,
        generation: 0,
        operationId: 'prior-operation',
        identityValid: false,
        status: 'ready',
      })
      .mockResolvedValueOnce({
        exists: true,
        generation: 1,
        operationId: 'operation-1',
        identityValid: false,
        status: 'reauthorizing',
      })
    vi.mocked(value.native.beginWorkspaceAuthorization)
      .mockRejectedValueOnce(new Error('picker failed'))

    await expect(value.authority.reauthorize('workspace-1')).rejects.toThrow('picker failed')
    expect(value.native.restoreGrantReady).not.toHaveBeenCalled()
    expect(value.native.markGrantNeedsAuthorization).toHaveBeenCalledWith(
      'workspace-1',
      1,
      'operation-1',
      expect.any(AbortSignal),
    )
    expect(value.transactions).toEqual(['prepare:reauthorize', 'abort'])
  })

  it('marks an invalid frozen grant needs-authorization when replacement commit fails', async () => {
    const value = fixture({ existingWorkspace: true })
    vi.mocked(value.native.inspectWorkspaceGrant)
      .mockResolvedValueOnce({
        exists: true,
        generation: 0,
        operationId: 'prior-operation',
        identityValid: false,
        status: 'ready',
      })
      .mockResolvedValueOnce({
        exists: true,
        generation: 1,
        operationId: 'operation-1',
        identityValid: false,
        status: 'reauthorizing',
      })
    vi.mocked(value.native.commitWorkspaceAuthorization)
      .mockRejectedValueOnce(new Error('replacement commit failed'))

    await expect(value.authority.reauthorize('workspace-1'))
      .rejects.toThrow('replacement commit failed')
    expect(value.native.abortWorkspaceAuthorization)
      .toHaveBeenCalledWith('pending-1', expect.any(AbortSignal))
    expect(value.native.restoreGrantReady).not.toHaveBeenCalled()
    expect(value.native.markGrantNeedsAuthorization).toHaveBeenCalledWith(
      'workspace-1',
      1,
      'operation-1',
      expect.any(AbortSignal),
    )
    expect(value.transactions).toEqual(['prepare:reauthorize', 'abort'])
  })

  it('finishes reauthorization when a valid replacement commit response was lost', async () => {
    const value = fixture({ existingWorkspace: true })
    vi.mocked(value.native.commitWorkspaceAuthorization).mockImplementationOnce(async (
      _pending,
      _workspaceId,
      expectedGeneration,
      operationId,
    ) => {
      value.setGrantGeneration(expectedGeneration + 1)
      vi.mocked(value.native.inspectWorkspaceGrant).mockResolvedValueOnce({
        exists: true,
        generation: expectedGeneration + 1,
        operationId,
        identityValid: true,
        status: 'ready',
        effectiveStatus: 'ready',
        displayPath: '/display/project',
      })
      throw new Error('commit response lost')
    })

    await expect(value.authority.reauthorize('workspace-1')).resolves.toEqual({
      workspaceId: 'workspace-1',
      name: 'Project',
      displayPath: '/display/project',
      state: 'ready',
    })
    expect(value.native.markGrantNeedsAuthorization).not.toHaveBeenCalled()
    expect(value.transactions).toEqual([
      'prepare:reauthorize',
      'grant-committed',
      'complete',
    ])
  })

  it('converges an invalid replacement after commit response loss without reporting ready', async () => {
    const value = fixture({ existingWorkspace: true })
    vi.mocked(value.native.commitWorkspaceAuthorization).mockImplementationOnce(async (
      _pending,
      _workspaceId,
      expectedGeneration,
      operationId,
    ) => {
      value.setGrantGeneration(expectedGeneration + 1)
      vi.mocked(value.native.inspectWorkspaceGrant).mockResolvedValueOnce({
        exists: true,
        generation: expectedGeneration + 1,
        operationId,
        identityValid: false,
        status: 'ready',
        effectiveStatus: 'identity-mismatch',
      })
      throw new Error('commit response lost')
    })

    await expect(value.authority.reauthorize('workspace-1'))
      .rejects.toThrow('commit response lost')
    expect(value.native.markGrantNeedsAuthorization).toHaveBeenCalledWith(
      'workspace-1',
      2,
      'operation-1',
      expect.any(AbortSignal),
    )
    expect(value.transactions).toEqual([
      'prepare:reauthorize',
      'grant-committed',
      'complete',
    ])
  })

  it('reauthorizes a legacy Workspace without freezing a missing Host grant', async () => {
    const value = fixture({ existingWorkspace: true })
    vi.mocked(value.native.inspectWorkspaceGrant).mockResolvedValueOnce({
      exists: false,
      identityValid: false,
    })

    await expect(value.authority.reauthorize('workspace-1')).resolves.toMatchObject({
      workspaceId: 'workspace-1',
      state: 'ready',
    })
    expect(value.native.inspectWorkspaceGrant)
      .toHaveBeenCalledWith('workspace-1', expect.any(AbortSignal))
    expect(value.native.markGrantReauthorizing).not.toHaveBeenCalled()
    expect(value.native.commitWorkspaceAuthorization).toHaveBeenCalledWith(
      'pending-1',
      'workspace-1',
      0,
      'operation-1',
      '/host/project',
      expect.any(AbortSignal),
    )
    expect(value.calls.slice(0, 3)).toEqual([
      'prepare:reauthorize',
      'begin-authorization',
    ])
  })

  it('aborts a pending reauthorization when the Workspace disappears while the picker is open', async () => {
    const value = fixture({ existingWorkspace: true })
    vi.mocked(value.native.inspectWorkspaceGrant).mockResolvedValueOnce({
      exists: true,
      generation: 0,
      operationId: 'prior-operation',
      identityValid: false,
      status: 'ready',
    }).mockResolvedValueOnce({
      exists: true,
      generation: 1,
      operationId: 'operation-1',
      identityValid: false,
      status: 'reauthorizing',
    })
    vi.mocked(value.native.beginWorkspaceAuthorization).mockImplementationOnce(async () => {
      value.workspaces.delete('workspace-1')
      return {
        outcome: 'pending',
        pendingGrantId: 'pending-1',
        canonicalPath: '/host/project',
      }
    })

    await expect(value.authority.reauthorize('workspace-1'))
      .rejects.toThrow('Workspace changed while reauthorization picker was open')
    expect(value.native.commitWorkspaceAuthorization).not.toHaveBeenCalled()
    expect(value.native.abortWorkspaceAuthorization)
      .toHaveBeenCalledWith('pending-1', expect.any(AbortSignal))
    expect(value.native.restoreGrantReady).not.toHaveBeenCalled()
    expect(value.native.markGrantNeedsAuthorization).toHaveBeenCalledWith(
      'workspace-1',
      1,
      'operation-1',
      expect.any(AbortSignal),
    )
    expect(value.transactions).toEqual(['prepare:reauthorize', 'abort'])
  })

  it('aborts a pending reauthorization when the catalog generation changes while the picker is open', async () => {
    const value = fixture({ existingWorkspace: true })
    vi.mocked(value.native.beginWorkspaceAuthorization).mockImplementationOnce(async () => {
      value.setCatalogGeneration(1)
      return {
        outcome: 'pending',
        pendingGrantId: 'pending-1',
        canonicalPath: '/host/project',
      }
    })

    await expect(value.authority.reauthorize('workspace-1')).rejects.toMatchObject({
      store: 'catalog',
      expected: 0,
      actual: 1,
    })
    expect(value.native.commitWorkspaceAuthorization).not.toHaveBeenCalled()
    expect(value.native.abortWorkspaceAuthorization)
      .toHaveBeenCalledWith('pending-1', expect.any(AbortSignal))
    expect(value.native.restoreGrantReady).toHaveBeenCalledWith(
      'workspace-1',
      1,
      'operation-1',
      expect.any(AbortSignal),
    )
    expect(value.native.markGrantNeedsAuthorization).not.toHaveBeenCalled()
    expect(value.transactions).toEqual(['prepare:reauthorize', 'abort'])
  })

  it('aborts a legacy reauthorization cancellation without a missing-grant mutation', async () => {
    const value = fixture({ existingWorkspace: true })
    vi.mocked(value.native.inspectWorkspaceGrant).mockResolvedValue({
      exists: false,
      identityValid: false,
    })
    vi.mocked(value.native.beginWorkspaceAuthorization).mockResolvedValueOnce({
      outcome: 'cancelled',
    })

    await expect(value.authority.reauthorize('workspace-1')).resolves.toBe('cancelled')
    expect(value.native.markGrantReauthorizing).not.toHaveBeenCalled()
    expect(value.native.restoreGrantReady).not.toHaveBeenCalled()
    expect(value.transactions).toEqual(['prepare:reauthorize', 'abort'])
  })

  it('aborts a failed legacy reauthorization without a missing-grant mutation', async () => {
    const value = fixture({ existingWorkspace: true })
    vi.mocked(value.native.inspectWorkspaceGrant).mockResolvedValue({
      exists: false,
      identityValid: false,
    })
    vi.mocked(value.native.commitWorkspaceAuthorization)
      .mockRejectedValueOnce(new Error('legacy commit failed'))

    await expect(value.authority.reauthorize('workspace-1'))
      .rejects.toThrow('legacy commit failed')
    expect(value.native.abortWorkspaceAuthorization)
      .toHaveBeenCalledWith('pending-1', expect.any(AbortSignal))
    expect(value.native.markGrantReauthorizing).not.toHaveBeenCalled()
    expect(value.native.restoreGrantReady).not.toHaveBeenCalled()
    expect(value.transactions).toEqual(['prepare:reauthorize', 'abort'])
  })

  it('stops after picker completion when add is aborted and discards the pending grant', async () => {
    const value = fixture()
    const controller = new AbortController()
    vi.mocked(value.native.beginWorkspaceAuthorization).mockImplementationOnce(async (signal) => {
      expect(signal).toBe(controller.signal)
      controller.abort()
      return {
        outcome: 'pending',
        pendingGrantId: 'pending-1',
        canonicalPath: '/host/project',
      }
    })

    await expect(value.authority.add(controller.signal)).rejects.toMatchObject({
      name: 'AbortError',
    })
    expect(value.native.abortWorkspaceAuthorization)
      .toHaveBeenCalledWith('pending-1', expect.any(AbortSignal))
    expect(value.native.prepareWorkspaceTransaction).not.toHaveBeenCalled()
    expect(value.registry.createExpected).not.toHaveBeenCalled()
  })

  it('aborts the prepared journal before any registry mutation when add is aborted', async () => {
    const value = fixture()
    const controller = new AbortController()
    vi.mocked(value.native.prepareWorkspaceTransaction).mockImplementationOnce(async () => {
      value.transactions.push('prepare:add')
      controller.abort()
      return { operationId: 'operation-1', generation: 1, stage: 'prepared' }
    })

    await expect(value.authority.add(controller.signal)).rejects.toMatchObject({
      name: 'AbortError',
    })
    expect(value.registry.createExpected).not.toHaveBeenCalled()
    expect(value.native.abortWorkspaceTransaction).toHaveBeenCalledWith(
      'operation-1',
      1,
      'prepared',
      expect.any(AbortSignal),
    )
    expect(value.native.abortWorkspaceAuthorization)
      .toHaveBeenCalledWith('pending-1', expect.any(AbortSignal))
  })

  it('finishes a committed add grant before reporting an abort', async () => {
    const value = fixture()
    const controller = new AbortController()
    vi.mocked(value.native.commitWorkspaceAuthorization).mockImplementationOnce(async (
      _pending,
      workspaceId,
      expectedGeneration,
      operationId,
    ) => {
      value.setGrantGeneration(expectedGeneration + 1)
      controller.abort()
      vi.mocked(value.native.inspectWorkspaceGrant).mockResolvedValue({
        exists: true,
        generation: expectedGeneration + 1,
        operationId,
        identityValid: true,
        status: 'ready',
        effectiveStatus: 'ready',
        displayPath: '/display/project',
      })
      return { workspaceId, displayPath: '/display/project', state: 'ready' }
    })
    vi.mocked(value.native.advanceWorkspaceTransaction).mockImplementation(async (
      _operationId,
      _generation,
      _expectedStage,
      nextStage,
      signal,
    ) => {
      signal.throwIfAborted()
      value.transactions.push(nextStage)
      return {
        operationId: 'operation-1',
        generation: value.transactions.length,
        stage: nextStage,
      }
    })
    vi.mocked(value.native.completeWorkspaceTransaction).mockImplementation(async (
      _operationId,
      _generation,
      _expectedStage,
      signal,
    ) => {
      signal.throwIfAborted()
      value.transactions.push('complete')
    })

    await expect(value.authority.add(controller.signal))
      .rejects.toMatchObject({ name: 'AbortError' })
    expect(value.transactions).toEqual([
      'prepare:add',
      'registry-committed',
      'grant-committed',
      'complete',
    ])
    expect(value.native.abortWorkspaceAuthorization).not.toHaveBeenCalled()
    expect(value.registry.markNeedsAuthorization).not.toHaveBeenCalled()
  })

  it('restores a frozen grant before reporting a reauthorization abort', async () => {
    const value = fixture({ existingWorkspace: true })
    const controller = new AbortController()
    const markReauthorizing = vi.mocked(value.native.markGrantReauthorizing)
      .getMockImplementation()!
    vi.mocked(value.native.markGrantReauthorizing).mockImplementationOnce(async (
      ...args
    ) => {
      const generation = await markReauthorizing(...args)
      controller.abort()
      return generation
    })

    await expect(value.authority.reauthorize('workspace-1', controller.signal))
      .rejects.toMatchObject({ name: 'AbortError' })
    expect(value.native.beginWorkspaceAuthorization).not.toHaveBeenCalled()
    expect(value.native.restoreGrantReady).toHaveBeenCalledWith(
      'workspace-1',
      1,
      'operation-1',
      expect.any(AbortSignal),
    )
    expect(value.native.abortWorkspaceTransaction).toHaveBeenCalledWith(
      'operation-1',
      1,
      'reauthorize-prepared',
      expect.any(AbortSignal),
    )
  })
})
