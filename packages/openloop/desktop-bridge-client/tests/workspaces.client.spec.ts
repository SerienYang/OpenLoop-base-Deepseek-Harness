import { Context } from '@deepseek-ai/cordis'
import type {
  ConnectionHandle,
  ConnectionSinks,
  IApiClient,
} from '@deepseek-ai/dsh-api-remotes/client'
import * as ApiGatewayClient from '@deepseek-ai/dsh-api-gateway/client'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import * as RuntimeClient from '@deepseek-ai/dsh-client-runtime/client'
import { describe, expect, it, vi } from 'vitest'
import {
  OpenloopWorkspaceRuntimeAdapter,
  OpenloopWorkspaceService,
  type OpenloopWorkspaceRemote,
  type OpenloopWorkspaceSessions,
} from '../src/client/workspaces.ts'
import {
  apply as applyClient,
  OpenloopWorkspaceRemoteBinding,
} from '../src/client/index.ts'

function ok<T>(value: T) {
  return Promise.resolve({ ok: true as const, value })
}

function rpcOk<T>(value: T) {
  return Promise.resolve({
    rpcId: 'openloop-test' as never,
    result: { ok: true as const, value },
  })
}

function remote(
  overrides: Partial<OpenloopWorkspaceRemote> = {},
): OpenloopWorkspaceRemote {
  return {
    listWorkspaceGrants: vi.fn(() => ok([])),
    authorizeWorkspace: vi.fn(() => ok('cancelled' as const)),
    reauthorizeWorkspace: vi.fn(() => ok('cancelled' as const)),
    renameWorkspace: vi.fn(() => ok({
      workspaceId: 'workspace-1',
      name: 'Renamed',
      displayPath: '~/Project Alpha',
      state: 'ready' as const,
      sessionIds: [],
    })),
    revokeWorkspace: vi.fn(() => ok('cancelled' as const)),
    revealWorkspace: vi.fn(() => ok(undefined)),
    ...overrides,
  }
}

function sessions(): OpenloopWorkspaceSessions {
  return {
    create: vi.fn(async () => 'session-1' as never),
    open: vi.fn(),
    clear: vi.fn(),
  }
}

function deferred<T>() {
  return Promise.withResolvers<T>()
}

function readyGrant(sessionIds: readonly string[] = []) {
  return {
    workspaceId: 'workspace-1',
    name: 'Project Alpha',
    displayPath: '~/Project Alpha',
    state: 'ready' as const,
    sessionIds: sessionIds as never,
  }
}

describe('Openloop browser Workspace facade', () => {
  it('rebinds Remote generations and rejects pending work on close', async () => {
    const binding = new OpenloopWorkspaceRemoteBinding()
    const first = binding.wait()
    binding.fail(new Error('first mount failed'))
    await expect(first).rejects.toThrow('first mount failed')

    const second = binding.wait()
    const unpublish = binding.publish(remote())
    await expect(second).resolves.toBeDefined()
    unpublish()

    const afterUnload = binding.wait()
    binding.close()
    await expect(afterUnload).rejects.toThrow(/disposed/iu)
    await expect(binding.wait()).rejects.toThrow(/disposed/iu)
  })

  it('lists the Host grant and a structurally complete safe Workspace compatibility projection', async () => {
    const listWorkspaceGrants = vi.fn(() => ok([{
      workspaceId: 'workspace-1',
      name: 'Project Alpha',
      displayPath: '~/Project Alpha',
      state: 'ready' as const,
      sessionIds: ['session-current', 'session-history'] as never,
    }]))
    const service = new OpenloopWorkspaceService(
      remote({ listWorkspaceGrants }),
      sessions(),
    )

    await service.refresh()

    expect(service.grants.getSnapshot()).toEqual({
      items: [{
        workspaceId: 'workspace-1',
        name: 'Project Alpha',
        displayPath: '~/Project Alpha',
        state: 'ready',
        sessionIds: ['session-current', 'session-history'],
      }],
      state: 'idle',
      error: null,
    })
    expect(service.grants.getSnapshot().items[0]).not.toHaveProperty('canonicalPath')
    expect(service.grants.getSnapshot().items[0]).not.toHaveProperty('pendingGrantId')
    expect(service.grants.getSnapshot().items[0]).not.toHaveProperty('identity')
    expect(service.grants.getSnapshot().items[0]?.sessionIds)
      .toEqual(['session-current', 'session-history'])
    expect(service.list.getSnapshot()).toEqual({
      items: [{
        workspaceId: 'workspace-1',
        path: '~/Project Alpha',
        title: 'Project Alpha',
        sessionIds: ['session-current', 'session-history'],
        createdAt: '1970-01-01T00:00:00.000Z',
        updatedAt: '1970-01-01T00:00:00.000Z',
      }],
      archivedSessionIds: [],
      state: 'idle',
      phase: 'ready',
      error: null,
      baselinesReady: true,
      recentWorkspaceId: undefined,
    })
    expect(listWorkspaceGrants).toHaveBeenCalledExactlyOnceWith()
  })

  it('keeps non-ready and pathless grants out of the routable compatibility projection', async () => {
    const service = new OpenloopWorkspaceService(remote({
      listWorkspaceGrants: vi.fn(() => ok([
        {
          workspaceId: 'permission-denied',
          name: 'Denied',
          displayPath: '~/Denied',
          state: 'permission-denied' as const,
          sessionIds: ['denied-session'] as never,
        },
        {
          workspaceId: 'pathless',
          name: 'Pathless',
          state: 'ready' as const,
          sessionIds: ['pathless-session'] as never,
        },
      ])),
    }), sessions())

    await service.refresh()

    expect(service.grants.getSnapshot().items).toHaveLength(2)
    expect(service.list.getSnapshot().items).toEqual([])
    expect(JSON.stringify(service.list.getSnapshot())).not.toContain('/host/')
  })

  it('publishes an error when the Remote generation is unavailable', async () => {
    const service = new OpenloopWorkspaceService(
      () => Promise.reject(new Error('Remote mount failed')),
      sessions(),
    )

    await expect(service.refresh()).rejects.toThrow('Remote mount failed')
    const snapshot = service.grants.getSnapshot()
    expect(snapshot.state).toBe('error')
    expect(snapshot.error?.message).toBe('Remote mount failed')
  })

  it('keeps the latest refresh when responses settle in reverse order', async () => {
    const first = deferred<Awaited<ReturnType<OpenloopWorkspaceRemote['listWorkspaceGrants']>>>()
    const second = deferred<Awaited<ReturnType<OpenloopWorkspaceRemote['listWorkspaceGrants']>>>()
    const listWorkspaceGrants = vi.fn()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise)
    const service = new OpenloopWorkspaceService(
      remote({ listWorkspaceGrants }),
      sessions(),
    )

    const staleRefresh = service.refresh()
    const latestRefresh = service.refresh()
    second.resolve({ ok: true, value: [readyGrant(['session-latest'])] })
    await latestRefresh
    first.resolve({ ok: true, value: [readyGrant(['session-stale'])] })
    await staleRefresh

    expect(service.grants.getSnapshot()).toEqual({
      items: [readyGrant(['session-latest'])],
      state: 'idle',
      error: null,
    })
  })

  it('does not let a stale refresh failure overwrite the latest success', async () => {
    const first = deferred<Awaited<ReturnType<OpenloopWorkspaceRemote['listWorkspaceGrants']>>>()
    const second = deferred<Awaited<ReturnType<OpenloopWorkspaceRemote['listWorkspaceGrants']>>>()
    const service = new OpenloopWorkspaceService(remote({
      listWorkspaceGrants: vi.fn()
        .mockReturnValueOnce(first.promise)
        .mockReturnValueOnce(second.promise),
    }), sessions())

    const staleRefresh = service.refresh()
    const latestRefresh = service.refresh()
    second.resolve({ ok: true, value: [readyGrant(['session-latest'])] })
    await latestRefresh
    first.reject(new Error('stale refresh failed'))
    await expect(staleRefresh).rejects.toThrow('stale refresh failed')

    expect(service.grants.getSnapshot()).toEqual({
      items: [readyGrant(['session-latest'])],
      state: 'idle',
      error: null,
    })
  })

  it('routes Workspace authority actions without paths and preserves state on cancellation', async () => {
    const first = {
      workspaceId: 'workspace-1',
      name: 'Project Alpha',
      displayPath: '~/Project Alpha',
      state: 'ready' as const,
      sessionIds: [],
    }
    const authorizeWorkspace = vi.fn(() => ok('cancelled' as const))
    const reauthorizeWorkspace = vi.fn(() => ok('cancelled' as const))
    const revokeWorkspace = vi.fn(() => ok('cancelled' as const))
    const revealWorkspace = vi.fn(() => ok(undefined))
    const service = new OpenloopWorkspaceService(remote({
      listWorkspaceGrants: vi.fn(() => ok([first])),
      authorizeWorkspace,
      reauthorizeWorkspace,
      revokeWorkspace,
      revealWorkspace,
    }), sessions())
    await service.refresh()
    const before = service.grants.getSnapshot()

    await expect(service.authorize()).resolves.toBe('cancelled')
    await expect(service.reauthorize('workspace-1')).resolves.toBe('cancelled')
    await expect(service.revoke('workspace-1')).resolves.toBe('cancelled')
    await expect(service.reveal('workspace-1')).resolves.toBeUndefined()

    expect(authorizeWorkspace).toHaveBeenCalledExactlyOnceWith()
    expect(reauthorizeWorkspace).toHaveBeenCalledExactlyOnceWith('workspace-1')
    expect(revokeWorkspace).toHaveBeenCalledExactlyOnceWith('workspace-1')
    expect(revealWorkspace).toHaveBeenCalledExactlyOnceWith('workspace-1')
    expect(service.grants.getSnapshot()).toBe(before)
  })

  it('renames through the dedicated Host facade and updates only the safe grant projection', async () => {
    const initial = {
      workspaceId: 'workspace-1',
      name: 'Project Alpha',
      displayPath: '~/Project Alpha',
      state: 'ready' as const,
      sessionIds: [],
    }
    const renamed = { ...initial, name: 'Renamed' }
    const renameWorkspace = vi.fn(() => ok(renamed))
    const service = new OpenloopWorkspaceService(remote({
      listWorkspaceGrants: vi.fn(() => ok([initial])),
      renameWorkspace,
    }), sessions())
    await service.refresh()

    await expect(service.renameWorkspace('workspace-1', 'Renamed')).resolves.toEqual(renamed)

    expect(renameWorkspace).toHaveBeenCalledExactlyOnceWith('workspace-1', 'Renamed')
    expect(service.grants.getSnapshot().items).toEqual([renamed])
    expect(JSON.stringify(renameWorkspace.mock.calls)).not.toContain('path')
  })

  it('refreshes grant membership after creating a session before resolving it for opening', async () => {
    const createSession = vi.fn(async () => 'session-1' as never)
    const listWorkspaceGrants = vi.fn()
      .mockImplementationOnce(() => ok([{
        workspaceId: 'workspace-1',
        name: 'Project Alpha',
        displayPath: '~/Project Alpha',
        state: 'ready' as const,
        sessionIds: [],
      }]))
      .mockImplementationOnce(() => ok([{
        workspaceId: 'workspace-1',
        name: 'Project Alpha',
        displayPath: '~/Project Alpha',
        state: 'ready' as const,
        sessionIds: ['session-1'] as never,
      }]))
    const sessionPort: OpenloopWorkspaceSessions = {
      create: createSession,
      open: vi.fn(),
      clear: vi.fn(),
    }
    const service = new OpenloopWorkspaceService(
      remote({ listWorkspaceGrants }),
      sessionPort,
    )
    await service.refresh()

    await expect(service.connectWorkspace('workspace-1' as never)).resolves.toBe('session-1')

    expect(createSession).toHaveBeenCalledExactlyOnceWith({ workspaceId: 'workspace-1' })
    expect(listWorkspaceGrants).toHaveBeenCalledTimes(2)
    expect(service.list.getSnapshot().items[0]?.sessionIds).toEqual(['session-1'])
  })

  it('coalesces concurrent connections to one Workspace until create and refresh finish', async () => {
    const createResult = deferred<never>()
    const create = vi.fn(() => createResult.promise)
    const listWorkspaceGrants = vi.fn()
      .mockImplementationOnce(() => ok([readyGrant()]))
      .mockImplementationOnce(() => ok([readyGrant(['session-1'])]))
    const service = new OpenloopWorkspaceService(remote({ listWorkspaceGrants }), {
      create,
      open: vi.fn(),
      clear: vi.fn(),
    })
    await service.refresh()

    const first = service.connectWorkspace('workspace-1' as never)
    const second = service.connectWorkspace('workspace-1' as never)
    expect(second).toBe(first)
    expect(create).toHaveBeenCalledExactlyOnceWith({ workspaceId: 'workspace-1' })

    createResult.resolve('session-1' as never)
    await expect(Promise.all([first, second])).resolves.toEqual(['session-1', 'session-1'])
    expect(create).toHaveBeenCalledOnce()
    expect(listWorkspaceGrants).toHaveBeenCalledTimes(2)
  })

  it('validates concurrent connections against their own reverse-ordered refresh results', async () => {
    const workspace2 = {
      ...readyGrant(),
      workspaceId: 'workspace-2',
      name: 'Project Beta',
      displayPath: '~/Project Beta',
    }
    const firstList = deferred<
      Awaited<ReturnType<OpenloopWorkspaceRemote['listWorkspaceGrants']>>
    >()
    const secondList = deferred<
      Awaited<ReturnType<OpenloopWorkspaceRemote['listWorkspaceGrants']>>
    >()
    const listWorkspaceGrants = vi.fn()
      .mockImplementationOnce(() => ok([readyGrant(), workspace2]))
      .mockReturnValueOnce(firstList.promise)
      .mockReturnValueOnce(secondList.promise)
    const create = vi.fn(async ({ workspaceId }: { workspaceId: string }) => (
      workspaceId === 'workspace-1' ? 'session-1' : 'session-2'
    ) as never)
    const service = new OpenloopWorkspaceService(remote({ listWorkspaceGrants }), {
      create,
      open: vi.fn(),
      clear: vi.fn(),
    })
    await service.refresh()

    const firstConnection = service.connectWorkspace('workspace-1' as never)
    const secondConnection = service.connectWorkspace('workspace-2' as never)
    await vi.waitFor(() => { expect(listWorkspaceGrants).toHaveBeenCalledTimes(3) })

    secondList.resolve({
      ok: true,
      value: [readyGrant(), { ...workspace2, sessionIds: ['session-2'] as never }],
    })
    await expect(secondConnection).resolves.toBe('session-2')
    firstList.resolve({
      ok: true,
      value: [readyGrant(['session-1']), workspace2],
    })

    await expect(firstConnection).resolves.toBe('session-1')
    expect(service.grants.getSnapshot().items).toEqual([
      readyGrant(['session-1']),
      { ...workspace2, sessionIds: ['session-2'] },
    ])
  })

  it('merges a connected session without reverting newer Workspace metadata or state', async () => {
    const connectedList = deferred<
      Awaited<ReturnType<OpenloopWorkspaceRemote['listWorkspaceGrants']>>
    >()
    const changed = {
      ...readyGrant(),
      name: 'Current Name',
      displayPath: '~/Current Path',
      state: 'permission-denied' as const,
    }
    const listWorkspaceGrants = vi.fn()
      .mockImplementationOnce(() => ok([readyGrant()]))
      .mockReturnValueOnce(connectedList.promise)
    const service = new OpenloopWorkspaceService(remote({
      listWorkspaceGrants,
      reauthorizeWorkspace: vi.fn(() => ok(changed)),
    }), sessions())
    await service.refresh()

    const connection = service.connectWorkspace('workspace-1' as never)
    await vi.waitFor(() => { expect(listWorkspaceGrants).toHaveBeenCalledTimes(2) })
    await service.reauthorize('workspace-1')
    connectedList.resolve({ ok: true, value: [readyGrant(['session-1'])] })

    await expect(connection).resolves.toBe('session-1')
    expect(service.grants.getSnapshot().items).toEqual([{
      ...changed,
      sessionIds: ['session-1'],
    }])
  })

  it('does not replace newer Workspace session membership with a stale connection response', async () => {
    const connectedList = deferred<
      Awaited<ReturnType<OpenloopWorkspaceRemote['listWorkspaceGrants']>>
    >()
    const latest = readyGrant(['session-1', 'session-2'])
    const listWorkspaceGrants = vi.fn()
      .mockImplementationOnce(() => ok([readyGrant()]))
      .mockReturnValueOnce(connectedList.promise)
    const service = new OpenloopWorkspaceService(remote({
      listWorkspaceGrants,
      reauthorizeWorkspace: vi.fn(() => ok(latest)),
    }), sessions())
    await service.refresh()

    const connection = service.connectWorkspace('workspace-1' as never)
    await vi.waitFor(() => { expect(listWorkspaceGrants).toHaveBeenCalledTimes(2) })
    await service.reauthorize('workspace-1')
    connectedList.resolve({ ok: true, value: [readyGrant(['session-1'])] })

    await expect(connection).resolves.toBe('session-1')
    expect(service.grants.getSnapshot().items).toEqual([latest])
  })

  it('does not resurrect a Workspace removed while its connection refresh is pending', async () => {
    const connectedList = deferred<
      Awaited<ReturnType<OpenloopWorkspaceRemote['listWorkspaceGrants']>>
    >()
    const listWorkspaceGrants = vi.fn()
      .mockImplementationOnce(() => ok([readyGrant()]))
      .mockReturnValueOnce(connectedList.promise)
    const service = new OpenloopWorkspaceService(remote({
      listWorkspaceGrants,
      revokeWorkspace: vi.fn(() => ok('revoked' as const)),
    }), sessions())
    await service.refresh()

    const connection = service.connectWorkspace('workspace-1' as never)
    await vi.waitFor(() => { expect(listWorkspaceGrants).toHaveBeenCalledTimes(2) })
    await service.revoke('workspace-1')
    connectedList.resolve({ ok: true, value: [readyGrant(['session-1'])] })

    await expect(connection).resolves.toBe('session-1')
    expect(service.grants.getSnapshot().items).toEqual([])
  })

  it('clears a failed Workspace connection so a later attempt can retry', async () => {
    const create = vi.fn()
      .mockRejectedValueOnce(new Error('create failed'))
      .mockResolvedValueOnce('session-2')
    const listWorkspaceGrants = vi.fn()
      .mockImplementationOnce(() => ok([readyGrant()]))
      .mockImplementationOnce(() => ok([readyGrant(['session-2'])]))
    const service = new OpenloopWorkspaceService(remote({ listWorkspaceGrants }), {
      create,
      open: vi.fn(),
      clear: vi.fn(),
    })
    await service.refresh()

    await expect(service.connectWorkspace('workspace-1' as never))
      .rejects.toThrow('create failed')
    await expect(service.connectWorkspace('workspace-1' as never))
      .resolves.toBe('session-2')

    expect(create).toHaveBeenCalledTimes(2)
    expect(listWorkspaceGrants).toHaveBeenCalledTimes(2)
  })

  it('rejects unknown Workspaces and refresh failures without opening an unowned session', async () => {
    const create = vi.fn(async () => 'session-1' as never)
    const open = vi.fn()
    const sessionPort: OpenloopWorkspaceSessions = {
      create,
      open,
      clear: vi.fn(),
    }
    const listWorkspaceGrants = vi.fn()
      .mockImplementationOnce(() => ok([{
        workspaceId: 'workspace-1',
        name: 'Project Alpha',
        displayPath: '~/Project Alpha',
        state: 'ready' as const,
        sessionIds: [],
      }]))
      .mockRejectedValueOnce(new Error('grant refresh failed'))
    const service = new OpenloopWorkspaceService(
      remote({ listWorkspaceGrants }),
      sessionPort,
    )
    await service.refresh()

    await expect(service.connectWorkspace('unknown' as never))
      .rejects.toThrow(/unknown Workspace/iu)
    expect(create).not.toHaveBeenCalled()

    await expect(service.connectWorkspace('workspace-1' as never))
      .rejects.toThrow('grant refresh failed')
    expect(create).toHaveBeenCalledExactlyOnceWith({ workspaceId: 'workspace-1' })
    expect(open).not.toHaveBeenCalled()
  })

  it('implements the shared Workspace face by rejecting legacy local operations', async () => {
    const service = new OpenloopWorkspaceService(remote(), sessions())

    await expect(service.create({ path: '/forbidden' })).rejects.toThrow(/unavailable/iu)
    await expect(service.openPath('/forbidden')).rejects.toThrow(/unavailable/iu)
    await expect(service.delete('workspace-1' as never)).rejects.toThrow(/unavailable/iu)
    await expect(service.rename('workspace-1' as never, 'renamed')).rejects.toThrow(/unavailable/iu)
  })

  it('starts and reconnects without any legacy Workspace RPC', async () => {
    const calls: Array<{ method: string; payload: unknown }> = []
    const api = {
      sessions: {
        list: (payload: unknown) => {
          calls.push({ method: 'session.list', payload })
          return rpcOk({ items: [] })
        },
        create: (payload: unknown) => {
          calls.push({ method: 'session.create', payload })
          return rpcOk({ sessionId: 'session-1' as never })
        },
      },
    } as unknown as IApiClient
    const listWorkspaceGrants = vi.fn(() => ok([{
      workspaceId: 'workspace-1',
      name: 'Project Alpha',
      displayPath: '~/Project Alpha',
      state: 'ready' as const,
      sessionIds: ['session-1'] as never,
    }]))
    const ctx = new Context()
    await ctx.plugin(TypertRegistry)
    let sinks: ConnectionSinks | undefined
    const connection: ConnectionHandle = {
      api,
      isLoopback: true,
      hostDescription: {
        getSnapshot: () => undefined,
        subscribe: () => () => {},
      },
      rpc: { call: () => Promise.reject(new Error('unexpected generic RPC')) },
      start: (next) => {
        sinks = next
        return { stop: vi.fn() }
      },
    }
    ctx.reflect.provide('connection', connection)
    ctx.reflect.provide('remote', {
      commands: {
        list: () => ok([]),
        execute: () => ok(undefined),
      },
      $dispatch: vi.fn(),
    })
    ctx.reflect.provide('remote.commands', {})
    ctx.reflect.provide('workspaceRuntimeAdapter', new OpenloopWorkspaceRuntimeAdapter(
      remote({ listWorkspaceGrants }),
    ))

    await ctx.plugin(RuntimeClient).await()
    sinks?.onConnected?.({
      version: '1',
      cwd: '/host/secret',
      attachedSessions: 0,
      canOpenPath: false,
    })
    sinks?.onConnected?.({
      version: '1',
      cwd: '/host/secret',
      attachedSessions: 0,
      canOpenPath: false,
    })
    await vi.waitFor(() => { expect(listWorkspaceGrants).toHaveBeenCalledTimes(2) })

    const openloopWorkspaces = ctx.get('openloopWorkspaces')
    await openloopWorkspaces?.connectWorkspace('workspace-1' as never, 'code')

    expect(calls.filter(call => call.method.startsWith('workspace.'))).toEqual([])
    expect(calls.filter(call => call.method === 'session.create')).toEqual([{
      method: 'session.create',
      payload: { workspaceId: 'workspace-1', agentPreset: 'code' },
    }])
    expect(ctx.workspaces.list.getSnapshot()).toEqual({
      items: [{
        workspaceId: 'workspace-1',
        path: '~/Project Alpha',
        title: 'Project Alpha',
        sessionIds: ['session-1'],
        createdAt: '1970-01-01T00:00:00.000Z',
        updatedAt: '1970-01-01T00:00:00.000Z',
      }],
      archivedSessionIds: [],
      state: 'idle',
      phase: 'ready',
      error: null,
      baselinesReady: true,
      recentWorkspaceId: undefined,
    })
    expect(JSON.stringify(ctx.workspaces.list.getSnapshot())).not.toContain('/host/secret')
    expect(ctx.openloopWorkspaces).toBeInstanceOf(OpenloopWorkspaceService)
  })

  it('publishes the adapter before mounting and binds the generated Remote namespace', async () => {
    const ctx = new Context()
    await ctx.plugin(TypertRegistry)
    const call = vi.fn<ConnectionHandle['rpc']['call']>(async (
      _path,
      endpoint,
    ) => {
      if (endpoint === 'openloopDesktop/authorizeWorkspace') {
        return { ok: true, value: 'cancelled' }
      }
      throw new Error(`unexpected Remote call ${endpoint}`)
    })
    ctx.provide('connection', { rpc: { call } } as unknown as ConnectionHandle)
    await ctx.plugin(ApiGatewayClient)
    const cleanup = applyClient(ctx)

    const adapter = ctx.get('workspaceRuntimeAdapter')
    if (!(adapter instanceof OpenloopWorkspaceRuntimeAdapter)) {
      throw new Error('Openloop Workspace adapter was not published before Remote mount')
    }
    const service = adapter.create(ctx, {}, sessions() as never)
    const authorization = service.authorize().then(
      value => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error }),
    )
    try {
      await vi.waitFor(() => {
        expect(call).toHaveBeenCalledWith(
          '/api',
          'openloopDesktop/authorizeWorkspace',
          { args: {} },
          expect.any(AbortSignal),
        )
      }, {
        timeout: 1_000,
      })
      await expect(authorization).resolves.toEqual({ ok: true, value: 'cancelled' })
    } finally {
      await cleanup()
      await authorization
    }
  })
})
