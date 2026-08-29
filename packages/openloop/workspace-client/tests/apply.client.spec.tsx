// @vitest-environment jsdom
import { Context } from '@deepseek-ai/cordis'
import { createSnapshotStore, SlotRegistry } from '@deepseek-ai/dsh-client-runtime/client'
import type { SessionId, SessionListState } from '@deepseek-ai/dsh-client-runtime/client'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import type { WorkspaceGrantView } from '@openloop/desktop-bridge-host/types'
import { describe, expect, it, vi } from 'vitest'
import { WorkspaceHero, WorkspaceSettings, WorkspaceSidebar } from '../src/client/index.ts'
import { apply, inject, WORKSPACE_BLOCK_OWNER } from '../src/client/index.ts'

const sid = (value: string): SessionId => value as SessionId

function sessionState(current: SessionId | undefined): SessionListState {
  return {
    ids: current === undefined ? [] : [current],
    byId: current === undefined
      ? {}
      : {
        [current]: {
          id: current,
          displayTitle: 'Session',
          running: false,
          blank: false,
          updatedAt: 1,
        },
      },
    current,
    phase: 'ready',
    subagentsByParent: {},
    jobsBySession: {},
    currentAddress: undefined,
  }
}

async function bench() {
  const ctx = new Context()
  await ctx.plugin(SlotRegistry).await()
  const slots = ctx.get('slots') as SlotRegistry
  slots.register({
    name: 'root',
    children: {
      'sidebar.workspaces': { kind: 'single', scope: 'root' },
      'sidebar.settings': { kind: 'single', scope: 'root' },
      'conversation.hero.workspace': { kind: 'single', scope: 'root' },
    },
  } as never, () => null)
  const grants = createSnapshotStore<{
    readonly items: readonly WorkspaceGrantView[]
    readonly state: 'idle' | 'loading' | 'error'
    readonly error: Error | null
  }>({
    items: [{
      workspaceId: 'alpha',
      name: 'Alpha',
      displayPath: '~/Alpha',
      state: 'permission-denied',
      sessionIds: [sid('session-1')],
    }],
    state: 'idle' as const,
    error: null,
  })
  const sessions = createSnapshotStore(sessionState(sid('session-1')))
  const setOwned = vi.fn()
  const actions = {
    authorize: vi.fn(async () => 'cancelled' as const),
    reauthorize: vi.fn(async () => 'cancelled' as const),
    renameWorkspace: vi.fn(async () => ({})),
    revoke: vi.fn(async () => 'cancelled' as const),
    reveal: vi.fn(async () => {}),
    startSession: vi.fn(async () => {}),
  }
  ctx.provide('sessions', { list: sessions, open: vi.fn() } as never)
  ctx.provide('openloopWorkspaces', { grants, ...actions } as never)
  ctx.provide('conversation', { blocks: { setOwned } } as never)
  ctx.provide('locale', new LocaleRuntime(ctx))
  return { ctx, slots, grants, sessions, setOwned, actions }
}

describe('Openloop Workspace client plugin', () => {
  it('declares its dependencies and registers all declared slots through their lifetimes', async () => {
    expect(inject).toEqual([
      'slots',
      'sessions',
      'openloopWorkspaces',
      'conversation',
      'locale',
    ])
    const b = await bench()
    const fiber = b.ctx.plugin({ inject: [...inject], apply })
    await fiber.await()

    expect(b.slots.entries('sidebar.workspaces')[0]?.component).toBe(WorkspaceSidebar)
    expect(b.slots.entries('sidebar.settings')[0]?.component).toBe(WorkspaceSettings)
    expect(b.slots.entries('conversation.hero.workspace')[0]?.component).toBe(WorkspaceHero)

    await fiber.dispose()
    expect(b.slots.entries('sidebar.workspaces')).toHaveLength(0)
    expect(b.slots.entries('sidebar.settings')).toHaveLength(0)
    expect(b.slots.entries('conversation.hero.workspace')).toHaveLength(0)
  })

  it('owns only its composer block and clears it on ready, session removal, and disposal', async () => {
    const b = await bench()
    const fiber = b.ctx.plugin({ inject: [...inject], apply })
    await fiber.await()

    expect(b.setOwned).toHaveBeenLastCalledWith(
      sid('session-1'),
      WORKSPACE_BLOCK_OWNER,
      { reason: 'Workspace authorization is required before sending.' },
    )

    b.grants.set({
      ...b.grants.getSnapshot(),
      items: [{ ...b.grants.getSnapshot().items[0]!, state: 'ready' }],
    })
    expect(b.setOwned).toHaveBeenLastCalledWith(
      sid('session-1'),
      WORKSPACE_BLOCK_OWNER,
      undefined,
    )

    b.sessions.set(sessionState(undefined))
    expect(b.setOwned).toHaveBeenLastCalledWith(
      sid('session-1'),
      WORKSPACE_BLOCK_OWNER,
      undefined,
    )

    b.sessions.set(sessionState(sid('session-1')))
    b.grants.set({
      ...b.grants.getSnapshot(),
      items: [{ ...b.grants.getSnapshot().items[0]!, state: 'missing' }],
    })
    await fiber.dispose()
    expect(b.setOwned).toHaveBeenLastCalledWith(
      sid('session-1'),
      WORKSPACE_BLOCK_OWNER,
      undefined,
    )
  })
})
