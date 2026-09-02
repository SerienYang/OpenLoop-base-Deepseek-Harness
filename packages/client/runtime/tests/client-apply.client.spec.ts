/**
 * Runtime plugin browser-half apply: slots + object services mounting over the
 * connection handle, stream-loop sink wiring into the object layer, and the
 * fiber-scoped loop teardown.
 */
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import type { ConnectionHandle } from '@deepseek-ai/dsh-api-remotes/client'
import type { ConnectionSinks } from '@deepseek-ai/dsh-api-remotes/client'
import { SESSION_SEARCH_RESULT_LIMIT } from '@deepseek-ai/dsh-host-apiproxy/api'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import * as RuntimeClient from '../src/client/index.ts'
import type { ConversationNodeDefinition } from '../src/client/contract/conversation.ts'
import { Session } from '../src/client/sessions/session.ts'
import type { SessionRuntime } from '../src/client/sessions/service.ts'
import { WorkspaceRuntime } from '../src/client/workspaces/service.ts'
import { FakeApiClient, fakeRemote, ok } from './fake-api.client.ts'

interface Bench {
  ctx: Context
  api: FakeApiClient
  sinks: ConnectionSinks | undefined
  stopped: number
}

async function mount(): Promise<Bench> {
  const ctx = new Context()
  await ctx.plugin(TypertRegistry)
  const api = new FakeApiClient()
  const bench: Bench = { ctx, api, sinks: undefined, stopped: 0 }
  const handle: ConnectionHandle = {
    api,
    isLoopback: true,
    hostDescription: {
      getSnapshot: () => undefined,
      subscribe: () => () => {},
    },
    rpc: {
      call: () => Promise.reject(new Error('unexpected generic RPC call')),
    },
    start: (sinks) => {
      bench.sinks = sinks
      return { stop: () => { bench.stopped += 1 } }
    },
  }
  ctx.reflect.provide('connection', handle)
  ctx.reflect.provide('remote', {})
  ctx.reflect.provide('remote.commands', fakeRemote().commands)
  await ctx.plugin(RuntimeClient).await()
  return bench
}

async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 12; i++) await Promise.resolve()
}

describe('runtime client apply', () => {
  it('fails closed for a malformed browser boot graph', () => {
    expect(() => {
      RuntimeClient.requiresWorkspaceRuntimeAdapter({
        __DSH_BOOT__: { rev: 'malformed' },
      })
    }).toThrow(/boot graph/iu)
    expect(RuntimeClient.requiresWorkspaceRuntimeAdapter({
      __DSH_BOOT__: { rev: 'default', entries: [] },
    })).toBe(false)
  })

  it('waits for the signed Openloop Workspace adapter instead of falling back to legacy RPCs', async () => {
    const previousBoot = (globalThis as { __DSH_BOOT__?: unknown }).__DSH_BOOT__
    ;(globalThis as { __DSH_BOOT__?: unknown }).__DSH_BOOT__ = {
      rev: 'openloop-test',
      entries: [{
        id: '@openloop/desktop-bridge-client',
        url: '/plugins/openloop/client.js',
        rev: 'adapter',
      }],
    }
    try {
      const ctx = new Context()
      await ctx.plugin(TypertRegistry)
      const api = new FakeApiClient()
      const start = vi.fn(() => ({ stop: vi.fn() }))
      const create = vi.fn(() => ({
        startInitialSelection: () => () => {},
        handleHostEnvelope: () => {},
        handleConnected: () => {},
      }))
      ctx.reflect.provide('connection', {
        api,
        isLoopback: true,
        hostDescription: {
          getSnapshot: () => undefined,
          subscribe: () => () => {},
        },
        rpc: {
          call: () => Promise.reject(new Error('unexpected generic RPC call')),
        },
        start,
      } satisfies ConnectionHandle)
      ctx.reflect.provide('remote', {})
      ctx.reflect.provide('remote.commands', fakeRemote().commands)

      const fiber = ctx.plugin(RuntimeClient)
      await Promise.resolve()
      expect(start).not.toHaveBeenCalled()
      expect(api.callsOf('workspace.list')).toEqual([])

      ctx.reflect.provide('workspaceRuntimeAdapter', { create })
      await fiber.await()

      expect(create).toHaveBeenCalledOnce()
      expect(start).toHaveBeenCalledOnce()
      await ctx.fiber.dispose()
    } finally {
      if (previousBoot === undefined) {
        delete (globalThis as { __DSH_BOOT__?: unknown }).__DSH_BOOT__
      } else {
        ;(globalThis as { __DSH_BOOT__?: unknown }).__DSH_BOOT__ = previousBoot
      }
    }
  })

  it('uses a profile-provided Workspace adapter', async () => {
    const ctx = new Context()
    await ctx.plugin(TypertRegistry)
    const api = new FakeApiClient()
    const start = vi.fn(() => ({ stop: vi.fn() }))
    const create = vi.fn(() => ({
      startInitialSelection: () => () => {},
      handleHostEnvelope: () => {},
      handleConnected: () => {},
    }))
    ctx.reflect.provide('connection', {
      api,
      isLoopback: true,
      hostDescription: {
        getSnapshot: () => undefined,
        subscribe: () => () => {},
      },
      rpc: {
        call: () => Promise.reject(new Error('unexpected generic RPC call')),
      },
      start,
    } satisfies ConnectionHandle)
    ctx.reflect.provide('remote', {})
    ctx.reflect.provide('remote.commands', fakeRemote().commands)
    ctx.reflect.provide('workspaceRuntimeAdapter', { create })

    await ctx.plugin(RuntimeClient).await()

    expect(ctx.get('slots')).toBeDefined()
    expect(ctx.get('sessions')).toBeDefined()
    expect(create).toHaveBeenCalledOnce()
    expect(start).toHaveBeenCalledOnce()
  })

  it('mounts slots, Sessions, and Workspaces and fans host frames into both managers', async () => {
    const bench = await mount()
    expect(bench.ctx.get('slots') !== undefined).toBe(true)
    // The built-in 'root' declaration ships with this package's SlotRegistry
    // (the SlotMap 'root' merge lives here).
    expect(bench.ctx.slots.spec('root')).toEqual({ kind: 'single', scope: 'root' })
    const sessions = bench.ctx.get('sessions')
    const workspaces = bench.ctx.get('workspaces')
    expect(sessions !== undefined).toBe(true)
    expect(workspaces !== undefined).toBe(true)
    expect(workspaces).toBeInstanceOf(WorkspaceRuntime)
    expect(typeof workspaces?.create).toBe('function')
    expect(typeof workspaces?.delete).toBe('function')
    expect(typeof workspaces?.rename).toBe('function')
    // The bound the wire schema enforces, not a per-connection negotiation.
    expect((sessions as SessionRuntime).searchResultLimit).toBe(SESSION_SEARCH_RESULT_LIMIT)
    if (workspaces === undefined) throw new Error('WorkspaceRuntime missing after runtime apply')
    expect(bench.sinks).toBeDefined()

    // Frame sinks reach the object layer: a host session-added lands in the list store.
    bench.sinks?.onHostEnvelope?.({
      rpcId: 'r1' as never,
      payload: { type: 'host/session-added', blank: true, sessionId: 's-new' } as never,
    })
    await Promise.resolve()
    expect((sessions as { list: { getSnapshot(): { ids: string[] } } }).list.getSnapshot().ids).toContain('s-new')
    bench.sinks?.onHostEnvelope?.({
      rpcId: 'r-workspace' as never,
      payload: {
        type: 'host/workspace-changed',
        workspace: {
          workspaceId: 'w-new', path: '/w/new', title: 'new', sessionIds: [],
          createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
        },
      } as never,
    })
    await Promise.resolve()
    expect(workspaces.list.getSnapshot().items[0]?.workspaceId).toBe('w-new')
    // Mux sink and onConnected route without throwing (manager semantics own the behavior).
    bench.sinks?.onMuxEnvelope?.({ rpcId: 'r2' as never, payload: { type: 'stream/error', message: 'x' } as never })
    bench.sinks?.onConnected?.({ version: '0', cwd: '/f', attachedSessions: 0, canOpenPath: true })
  })

  it('selects the recent Workspace once when the first baselines have no current session', async () => {
    const bench = await mount()
    bench.api.onWorkspaceList = () => Promise.resolve(ok({
      items: [{
        workspaceId: 'w-recent', path: '/w/recent', title: 'recent', sessionIds: [],
        createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
      }] as never[],
    }))
    bench.api.onList = () => Promise.resolve(ok({ items: [] }))

    bench.sinks?.onConnected?.({ version: '0', cwd: '/f', attachedSessions: 0, canOpenPath: true })
    await flushMicrotasks()

    const sessions = bench.ctx.get('sessions') as SessionRuntime
    const workspaces = bench.ctx.get('workspaces') as WorkspaceRuntime
    expect(bench.api.callsOf('session.create')).toEqual([{ workspaceId: 'w-recent' }])
    expect(sessions.list.getSnapshot().current).toBe('fk-new')

    sessions.clear()
    await workspaces.refresh()
    await flushMicrotasks()
    expect(sessions.list.getSnapshot().current).toBeUndefined()
    expect(bench.api.callsOf('session.create')).toHaveLength(1)
  })

  it('wires registry changes into resident Sessions during the runtime apply pass', async () => {
    const bench = await mount()
    const sessions = bench.ctx.get('sessions') as SessionRuntime
    bench.sinks?.onHostEnvelope?.({
      rpcId: 'r-registry' as never,
      payload: { type: 'host/session-added', blank: true, sessionId: 's-registry' } as never,
    })
    await flushMicrotasks()
    expect(sessions.binding('s-registry' as never)).toBeDefined()
    const rebuild = vi.spyOn(Session.prototype, 'rebuildConversationRegistry')
    const definition: ConversationNodeDefinition<null> = {
      kind: 'registry-probe',
      target: 'chat',
      match: () => null,
      start: () => null,
      update: context => context.state,
      buildViewNode: () => null,
    }

    bench.ctx.conversationEvents.register(definition)
    await flushMicrotasks()

    expect(rebuild).toHaveBeenCalledOnce()
    rebuild.mockRestore()
  })

  it('stops the stream loop when the plugin fiber unloads', async () => {
    const bench = await mount()
    const fiber = [...bench.ctx.registry.values()].find(f => f.name?.includes('client'))
    // Dispose the whole tree: the ctx.effect teardown must call loop.stop exactly once.
    await bench.ctx.fiber.dispose()
    expect(bench.stopped).toBe(1)
    void fiber
  })
})
