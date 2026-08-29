import { Context } from '@deepseek-ai/cordis'
import type {
  ConnectionHandle,
  ConnectionSinks,
  IApiClient,
} from '@deepseek-ai/dsh-api-remotes/client'
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

  it('lists only the Host safe grant projection through the zero-argument Remote', async () => {
    const listWorkspaceGrants = vi.fn(() => ok([{
      workspaceId: 'workspace-1',
      name: 'Project Alpha',
      state: 'ready' as const,
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
        state: 'ready',
      }],
      state: 'idle',
      error: null,
    })
    expect(JSON.stringify(service.grants.getSnapshot())).not.toContain('/')
    expect(service.list.getSnapshot()).toEqual({
      items: [],
      archivedSessionIds: [],
      state: 'idle',
      phase: 'ready',
      error: null,
      baselinesReady: true,
      recentWorkspaceId: undefined,
    })
    expect(listWorkspaceGrants).toHaveBeenCalledExactlyOnceWith()
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

  it('routes Workspace authority actions without paths and preserves state on cancellation', async () => {
    const first = {
      workspaceId: 'workspace-1',
      name: 'Project Alpha',
      state: 'ready' as const,
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

  it('creates sessions with only workspaceId and an explicitly selected agentPreset', async () => {
    const createSession = vi.fn(async () => 'session-1' as never)
    const sessionPort: OpenloopWorkspaceSessions = {
      create: createSession,
      open: vi.fn(),
      clear: vi.fn(),
    }
    const service = new OpenloopWorkspaceService(remote(), sessionPort)

    await expect(service.connectWorkspace('workspace-1' as never)).resolves.toBe('session-1')
    await expect(service.connectWorkspace('workspace-2' as never, 'code')).resolves.toBe('session-1')

    expect(createSession).toHaveBeenNthCalledWith(1, { workspaceId: 'workspace-1' })
    expect(createSession).toHaveBeenNthCalledWith(2, {
      workspaceId: 'workspace-2',
      agentPreset: 'code',
    })
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
    const listWorkspaceGrants = vi.fn(() => ok([]))
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
      items: [],
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

  it('publishes the adapter before mounting the generated desktop Remote', async () => {
    const ctx = new Context()
    const dispose = vi.fn(async () => {})
    const mount = vi.fn(async (_remote: unknown) => dispose)
    const cleanup = applyClient(ctx)

    expect(ctx.get('workspaceRuntimeAdapter')).toBeInstanceOf(
      OpenloopWorkspaceRuntimeAdapter,
    )
    ctx.reflect.provide('remote', {
      $mount: mount,
      openloopDesktop: remote(),
    })

    await vi.waitFor(() => { expect(mount).toHaveBeenCalledOnce() })
    expect(mount.mock.calls[0]?.[0]).toMatchObject({
      package: '@openloop/desktop-bridge-host',
    })
    await cleanup()
    expect(dispose).toHaveBeenCalledOnce()
  })
})
