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
      inspectWorkspaceGrant: vi.fn(async () => ({
        exists: true,
        generation: 1,
        identityValid: true,
        operationId: 'operation-1',
        status: 'ready',
      })),
    } as never)

    const fiber = ctx.plugin(WorkspaceAuthorityService)
    await fiber

    await expect(ctx.workspaceAuthority.list()).resolves.toEqual([{
      workspaceId: 'workspace-1',
      name: 'Project Alpha',
      state: 'ready',
    }])
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
