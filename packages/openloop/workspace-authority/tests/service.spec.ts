import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import WorkspaceAuthorityService from '../src/index.ts'
import type { WorkspaceTransaction } from '../src/types.ts'

function transaction(): WorkspaceTransaction {
  return {
    operationId: 'operation-1',
    generation: 2,
    kind: 'add',
    workspaceId: 'workspace-1',
    expectedCatalogGeneration: 0,
    expectedGrantGeneration: 0,
    stage: 'registry-committed',
  }
}

describe('WorkspaceAuthorityService recovery lifecycle', () => {
  it('serves grant projections through the Cordis service proxy', async () => {
    const ctx = new Context()
    ctx.provide('workspaceRegistry', {
      catalogGeneration: () => 0,
      createExpected: vi.fn(),
      deleteExpected: vi.fn(),
      get: () => undefined,
      list: () => [{
        id: 'workspace-1',
        title: 'Project Alpha',
        path: '/host/project',
      }],
    } as never)
    ctx.provide('desktopBridge', {
      readWorkspaceTransaction: vi.fn(async () => null),
      getWorkspaceGrantGeneration: vi.fn(async () => 8),
      inspectWorkspaceGrant: vi.fn(async () => ({
        exists: true,
        generation: 1,
        identityValid: true,
        operationId: 'operation-1',
        status: 'ready',
        effectiveStatus: 'ready',
        displayPath: '/Users/example/Project Alpha',
      })),
    } as never)

    const fiber = ctx.plugin(WorkspaceAuthorityService)
    await fiber

    await expect(ctx.workspaceAuthority.list()).resolves.toEqual([{
      workspaceId: 'workspace-1',
      name: 'Project Alpha',
      displayPath: '/Users/example/Project Alpha',
      state: 'ready',
    }])
    await fiber.dispose()
  })

  it('renames through the registry CAS and reports only the safe grant projection', async () => {
    const renameExpected = vi.fn(async () => ({
      workspace: {
        id: 'workspace-1',
        title: 'Renamed',
        path: '/canonical/private/project',
      },
      generation: 4,
    }))
    const ctx = new Context()
    ctx.provide('workspaceRegistry', {
      catalogGeneration: () => 3,
      createExpected: vi.fn(),
      deleteExpected: vi.fn(),
      renameExpected,
      get: () => ({
        id: 'workspace-1',
        title: 'Project Alpha',
        path: '/canonical/private/project',
      }),
      list: () => [],
    } as never)
    ctx.provide('desktopBridge', {
      readWorkspaceTransaction: vi.fn(async () => null),
      getWorkspaceGrantGeneration: vi.fn(async () => 8),
      inspectWorkspaceGrant: vi.fn(async () => ({
        exists: true,
        generation: 8,
        identityValid: true,
        operationId: 'operation-1',
        status: 'ready',
        effectiveStatus: 'ready',
        displayPath: '~/Project Alpha',
      })),
    } as never)

    const fiber = ctx.plugin(WorkspaceAuthorityService)
    await fiber

    const renamed = await ctx.workspaceAuthority.rename('workspace-1', ' Renamed ')
    expect(renamed).toEqual({
      workspaceId: 'workspace-1',
      name: 'Renamed',
      displayPath: '~/Project Alpha',
      state: 'ready',
    })
    expect(JSON.stringify(renamed)).not.toContain('canonical')
    expect(renameExpected).toHaveBeenCalledWith(
      'workspace-1',
      'Renamed',
      3,
    )
    await fiber.dispose()
  })

  it.each([
    ['missing grant', { exists: false, identityValid: false }, false],
    ['needs authorization', {
      exists: true,
      generation: 1,
      identityValid: false,
      status: 'needs-authorization',
      effectiveStatus: 'needs-authorization',
      displayPath: '~/Project Alpha',
    }, false],
    ['permission denied', {
      exists: true,
      generation: 1,
      identityValid: false,
      status: 'permission-denied',
      effectiveStatus: 'permission-denied',
      displayPath: '~/Project Alpha',
    }, false],
    ['identity mismatch', {
      exists: true,
      generation: 1,
      identityValid: false,
      status: 'ready',
      effectiveStatus: 'identity-mismatch',
      displayPath: '~/Project Alpha',
    }, false],
    ['revoking', {
      exists: true,
      generation: 1,
      identityValid: true,
      status: 'revoking',
      effectiveStatus: 'ready',
      displayPath: '~/Project Alpha',
    }, false],
    ['reauthorizing', {
      exists: true,
      generation: 1,
      identityValid: true,
      status: 'reauthorizing',
      effectiveStatus: 'ready',
      displayPath: '~/Project Alpha',
    }, false],
    ['ready', {
      exists: true,
      generation: 1,
      identityValid: true,
      status: 'ready',
      effectiveStatus: 'ready',
      displayPath: '~/Project Alpha',
    }, true],
  ] as const)('reports %s readiness for session creation', async (_label, inspection, ready) => {
    const ctx = new Context()
    ctx.provide('workspaceRegistry', {
      catalogGeneration: () => 0,
      createExpected: vi.fn(),
      deleteExpected: vi.fn(),
      get: () => ({
        id: 'workspace-1',
        title: 'Project Alpha',
        path: '/canonical/private/project',
      }),
      list: () => [],
    } as never)
    ctx.provide('desktopBridge', {
      readWorkspaceTransaction: vi.fn(async () => null),
      inspectWorkspaceGrant: vi.fn(async () => inspection),
    } as never)
    const fiber = ctx.plugin(WorkspaceAuthorityService)
    await fiber

    await expect(ctx.workspaceAuthority.isReady('workspace-1')).resolves.toBe(ready)
    await fiber.dispose()
  })

  it('reports an unknown workspace id as not ready without inspecting native grants', async () => {
    const inspectWorkspaceGrant = vi.fn()
    const ctx = new Context()
    ctx.provide('workspaceRegistry', {
      catalogGeneration: () => 0,
      createExpected: vi.fn(),
      deleteExpected: vi.fn(),
      get: () => undefined,
      list: () => [],
    } as never)
    ctx.provide('desktopBridge', {
      readWorkspaceTransaction: vi.fn(async () => null),
      inspectWorkspaceGrant,
    } as never)
    const fiber = ctx.plugin(WorkspaceAuthorityService)
    await fiber

    await expect(ctx.workspaceAuthority.isReady('unknown')).resolves.toBe(false)
    expect(inspectWorkspaceGrant).not.toHaveBeenCalled()
    await fiber.dispose()
  })

  it('fails closed when a registry row has no complete Host grant projection', async () => {
    const ctx = new Context()
    ctx.provide('workspaceRegistry', {
      catalogGeneration: () => 0,
      createExpected: vi.fn(),
      deleteExpected: vi.fn(),
      get: () => undefined,
      list: () => [{
        id: 'workspace-1',
        title: 'Project Alpha',
        path: '/host/project',
      }],
    } as never)
    ctx.provide('desktopBridge', {
      readWorkspaceTransaction: vi.fn(async () => null),
      inspectWorkspaceGrant: vi.fn(async () => ({
        exists: true,
        generation: 1,
        identityValid: true,
      })),
    } as never)

    const fiber = ctx.plugin(WorkspaceAuthorityService)
    await fiber

    await expect(ctx.workspaceAuthority.list()).rejects.toThrow(
      'Workspace grant "workspace-1" is incomplete',
    )
    await fiber.dispose()
  })

  it('fails closed through the Cordis proxy when a persisted ready grant has invalid identity', async () => {
    const ctx = new Context()
    ctx.provide('workspaceRegistry', {
      catalogGeneration: () => 0,
      createExpected: vi.fn(),
      deleteExpected: vi.fn(),
      get: () => undefined,
      list: () => [{
        id: 'workspace-1',
        title: 'Project Alpha',
        path: '/host/project',
      }],
    } as never)
    ctx.provide('desktopBridge', {
      readWorkspaceTransaction: vi.fn(async () => null),
      inspectWorkspaceGrant: vi.fn(async () => ({
        exists: true,
        generation: 1,
        identityValid: false,
        operationId: 'operation-1',
        status: 'ready',
      })),
    } as never)

    const fiber = ctx.plugin(WorkspaceAuthorityService)
    await fiber

    await expect(ctx.workspaceAuthority.list()).resolves.toEqual([{
      workspaceId: 'workspace-1',
      name: 'Project Alpha',
      state: 'identity-mismatch',
    }])
    await fiber.dispose()
  })

  it.each([
    ['revoking', 'ready'],
    ['reauthorizing', 'ready'],
  ] as const)(
    'lists persisted %s instead of its %s effective status through the service proxy',
    async (status, effectiveStatus) => {
      const ctx = new Context()
      ctx.provide('workspaceRegistry', {
        catalogGeneration: () => 0,
        createExpected: vi.fn(),
        deleteExpected: vi.fn(),
        get: () => undefined,
        list: () => [{
          id: 'workspace-1',
          title: 'Project Alpha',
          path: '/host/project',
        }],
      } as never)
      ctx.provide('desktopBridge', {
        readWorkspaceTransaction: vi.fn(async () => null),
        inspectWorkspaceGrant: vi.fn(async () => ({
          exists: true,
          generation: 1,
          identityValid: true,
          operationId: 'operation-1',
          status,
          effectiveStatus,
        })),
      } as never)

      const fiber = ctx.plugin(WorkspaceAuthorityService)
      await fiber

      await expect(ctx.workspaceAuthority.list()).resolves.toEqual([{
        workspaceId: 'workspace-1',
        name: 'Project Alpha',
        state: status,
      }])
      await fiber.dispose()
    },
  )

  it('never lists ready when native identity is invalid', async () => {
    const ctx = new Context()
    ctx.provide('workspaceRegistry', {
      catalogGeneration: () => 0,
      createExpected: vi.fn(),
      deleteExpected: vi.fn(),
      get: () => undefined,
      list: () => [{
        id: 'workspace-1',
        title: 'Project Alpha',
        path: '/host/project',
      }],
    } as never)
    ctx.provide('desktopBridge', {
      readWorkspaceTransaction: vi.fn(async () => null),
      inspectWorkspaceGrant: vi.fn(async () => ({
        exists: true,
        generation: 1,
        identityValid: false,
        operationId: 'operation-1',
        status: 'ready',
        effectiveStatus: 'ready',
      })),
    } as never)

    const fiber = ctx.plugin(WorkspaceAuthorityService)
    await fiber

    await expect(ctx.workspaceAuthority.list()).resolves.toEqual([{
      workspaceId: 'workspace-1',
      name: 'Project Alpha',
      state: 'identity-mismatch',
    }])
    await fiber.dispose()
  })

  it('finishes durable recovery before publishing the service or accepting new operations', async () => {
    const events: string[] = []
    let releaseJournal!: (value: WorkspaceTransaction | null) => void
    const journal = new Promise<WorkspaceTransaction | null>((resolve) => {
      releaseJournal = resolve
    })
    const ctx = new Context()
    ctx.provide('workspaceRegistry', {
      catalogGeneration: () => 0,
      createExpected: vi.fn(),
      deleteExpected: vi.fn(),
      get: (workspaceId: string) => workspaceId === 'workspace-1'
        ? { id: workspaceId, title: 'Project Alpha', path: '/host/project' }
        : undefined,
      list: () => [],
    } as never)
    ctx.provide('desktopBridge', {
      readWorkspaceTransaction: vi.fn(async () => {
        events.push('read-journal')
        return await journal
      }),
      inspectWorkspaceGrant: vi.fn(async () => {
        events.push('inspect-grant')
        return { exists: false, identityValid: false }
      }),
      getWorkspaceGrantGeneration: vi.fn(async () => 0),
      markWorkspaceGrantNeedsAuthorization: vi.fn(),
      restoreWorkspaceGrantReady: vi.fn(),
      deleteWorkspaceGrant: vi.fn(),
      advanceWorkspaceTransaction: vi.fn(async (
        _operationId: string,
        _expectedGeneration: number,
        _expectedStage: string,
        nextStage: string,
      ) => {
        events.push(`advance:${nextStage}`)
        return { operationId: 'operation-1', generation: 3, stage: nextStage }
      }),
      abortWorkspaceTransaction: vi.fn(),
      completeWorkspaceTransaction: vi.fn(async () => {
        events.push('complete')
      }),
    } as never)

    const fiber = ctx.plugin(WorkspaceAuthorityService)
    await Promise.resolve()
    expect(ctx.get('workspaceAuthority')).toBeUndefined()

    releaseJournal(transaction())
    await fiber

    expect(ctx.workspaceAuthority).toBeInstanceOf(WorkspaceAuthorityService)
    expect(events).toEqual([
      'read-journal',
      'inspect-grant',
      'advance:authorization-failed',
      'complete',
    ])
  })
})
