// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import type { SessionId, SessionListState } from '@deepseek-ai/dsh-client-runtime/client'
import { bindSnapshotSelector } from '@deepseek-ai/dsh-client-web-react'
import type { WorkspaceGrantView } from '@openloop/desktop-bridge-host/types'
import {
  WorkspaceHero,
  WorkspaceSettings,
  WorkspaceSidebar,
  type WorkspaceClientActions,
} from '../src/client/index.ts'

afterEach(cleanup)

const sid = (value: string): SessionId => value as SessionId
const grant = (
  workspaceId: string,
  state: WorkspaceGrantView['state'] = 'ready',
  sessionIds: readonly SessionId[] = [],
): WorkspaceGrantView => ({
  workspaceId,
  name: workspaceId === 'alpha' ? 'Alpha' : workspaceId,
  displayPath: `~/Projects/${workspaceId}`,
  state,
  sessionIds,
})

const sessions = (current?: SessionId): SessionListState => ({
  ids: [sid('session-current'), sid('session-history')],
  byId: {
    [sid('session-current')]: {
      id: sid('session-current'),
      displayTitle: 'Current discussion',
      running: false,
      blank: false,
      updatedAt: 2,
    },
    [sid('session-history')]: {
      id: sid('session-history'),
      displayTitle: 'Historical discussion',
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
})

function deferred<T>() {
  return Promise.withResolvers<T>()
}

function harness(
  items: readonly WorkspaceGrantView[],
  current: SessionId | undefined = sid('session-current'),
) {
  const grants = createSnapshotStore({
    items,
    state: 'idle' as const,
    error: null,
  })
  const sessionStore = createSnapshotStore(sessions(current))
  const authorize = vi.fn(async () => 'cancelled' as const)
  const reauthorize = vi.fn(async () => 'cancelled' as const)
  const rename = vi.fn(async () => {})
  const remove = vi.fn(async () => 'cancelled' as const)
  const reveal = vi.fn(async () => {})
  const startSession = vi.fn(async () => {})
  const openSession = vi.fn()
  const actions: WorkspaceClientActions = {
    authorize,
    reauthorize,
    rename,
    remove,
    reveal,
    startSession,
    openSession,
  }
  return {
    grants,
    sessionStore,
    actions,
    authorize,
    reauthorize,
    rename,
    remove,
    reveal,
    startSession,
    openSession,
    useGrants: bindSnapshotSelector(grants),
    useSessions: bindSnapshotSelector(sessionStore),
  }
}

describe('Openloop Workspace surfaces', () => {
  it('renders every authority state, current/history sessions, and opens existing sessions', () => {
    const allStates: WorkspaceGrantView['state'][] = [
      'ready',
      'needs-authorization',
      'missing',
      'permission-denied',
      'identity-mismatch',
      'revoking',
      'reauthorizing',
    ]
    const h = harness(allStates.map((state, index) =>
      grant(index === 0 ? 'alpha' : `${state}-${index}`, state, index === 0
        ? [sid('session-current'), sid('session-history')]
        : [])))
    render(
      <WorkspaceSidebar
        wide
        expandSidebar={vi.fn()}
        useGrants={h.useGrants}
        useSessions={h.useSessions}
        actions={h.actions}
      />,
    )

    for (const state of allStates) expect(screen.getByText(state)).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Switch to Alpha' }).getAttribute('aria-current')).toBe('true')
    fireEvent.click(screen.getByRole('button', { name: 'Historical discussion' }))
    expect(h.openSession).toHaveBeenCalledWith(sid('session-history'))
    fireEvent.click(screen.getByRole('button', { name: 'New session in Alpha' }))
    expect(h.startSession).toHaveBeenCalledWith('alpha')
  })

  it('keeps the collapsed rail compact while retaining Add and Workspace entry points', () => {
    const h = harness([grant('alpha')])
    const view = render(
      <WorkspaceSidebar
        wide={false}
        expandSidebar={vi.fn()}
        useGrants={h.useGrants}
        useSessions={h.useSessions}
        actions={h.actions}
      />,
    )

    expect(view.container.querySelector('[data-workspace-rail="true"]')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Add Workspace' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Open Workspace Alpha' })).toBeTruthy()
    expect(screen.queryByText('~/Projects/alpha')).toBeNull()
  })

  it('runs Add once, treats native cancellation as stable, and surfaces real failures', async () => {
    const pending = deferred<'cancelled'>()
    const h = harness([])
    h.authorize.mockReturnValueOnce(pending.promise)
    render(
      <WorkspaceHero
        open
        onPick={vi.fn()}
        onClose={vi.fn()}
        useGrants={h.useGrants}
        useSessions={h.useSessions}
        actions={h.actions}
      />,
    )
    const add = screen.getByRole<HTMLButtonElement>('button', { name: 'Add Workspace' })
    fireEvent.click(add)
    fireEvent.click(add)
    expect(h.authorize).toHaveBeenCalledOnce()
    expect(add.disabled).toBe(true)
    await act(async () => { pending.resolve('cancelled'); await pending.promise })
    expect(screen.queryByRole('alert')).toBeNull()

    h.authorize.mockRejectedValueOnce(new Error('chooser unavailable'))
    fireEvent.click(add)
    await waitFor(() => {
      expect(screen.getByRole('alert').textContent).toContain('chooser unavailable')
    })
  })

  it('picks ready Workspaces and reauthorizes non-ready Workspaces without selecting them', async () => {
    const h = harness([
      grant('alpha'),
      grant('missing-workspace', 'missing'),
    ])
    const onPick = vi.fn()
    render(
      <WorkspaceHero
        open
        onPick={onPick}
        onClose={vi.fn()}
        useGrants={h.useGrants}
        useSessions={h.useSessions}
        actions={h.actions}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Alpha' }))
    expect(onPick).toHaveBeenCalledWith('alpha')
    fireEvent.click(screen.getByRole('button', { name: 'Reauthorize missing-workspace' }))
    await waitFor(() => {
      expect(h.reauthorize).toHaveBeenCalledWith('missing-workspace')
    })
    expect(onPick).not.toHaveBeenCalledWith('missing-workspace')
  })

  it('provides settings actions and states the non-destructive Remove boundary', async () => {
    const h = harness([grant('alpha', 'ready', [sid('session-current')])])
    render(
      <WorkspaceSettings
        wide
        useGrants={h.useGrants}
        useSessions={h.useSessions}
        actions={h.actions}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Settings' }))
    const dialog = screen.getByRole('dialog', { name: 'Workspace settings' })
    expect(within(dialog).getByText('~/Projects/alpha')).toBeTruthy()

    fireEvent.click(within(dialog).getByRole('button', { name: 'Workspace actions for Alpha' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Rename' }))
    const renameDialog = screen.getByRole('dialog', { name: 'Rename Workspace' })
    fireEvent.change(within(renameDialog).getByRole('textbox'), { target: { value: 'Alpha Two' } })
    fireEvent.click(within(renameDialog).getByRole('button', { name: 'Rename' }))
    await waitFor(() => {
      expect(h.rename).toHaveBeenCalledWith('alpha', 'Alpha Two')
    })

    fireEvent.click(within(dialog).getByRole('button', { name: 'Workspace actions for Alpha' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Reveal in Finder' }))
    await waitFor(() => { expect(h.reveal).toHaveBeenCalledWith('alpha') })

    fireEvent.click(within(dialog).getByRole('button', { name: 'Workspace actions for Alpha' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Remove' }))
    const removeDialog = screen.getByRole('dialog', { name: 'Remove Workspace' })
    expect(removeDialog.textContent).toContain(
      'Only the authorization and list item are removed. Files and session history are kept.',
    )
    fireEvent.click(within(removeDialog).getByRole('button', { name: 'Remove' }))
    await waitFor(() => { expect(h.remove).toHaveBeenCalledWith('alpha') })
  })

  it('disables conflicting row operations while revoking or reauthorizing', () => {
    const h = harness([
      grant('revoking-workspace', 'revoking'),
      grant('reauthorizing-workspace', 'reauthorizing'),
    ], undefined)
    render(
      <WorkspaceSettings
        wide
        useGrants={h.useGrants}
        useSessions={h.useSessions}
        actions={h.actions}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Settings' }))
    expect(screen.getByRole<HTMLButtonElement>('button', {
      name: 'Workspace actions for revoking-workspace',
    }).disabled).toBe(true)
    expect(screen.getByRole<HTMLButtonElement>('button', {
      name: 'Workspace actions for reauthorizing-workspace',
    }).disabled).toBe(true)
    expect(screen.getAllByRole('status')).toHaveLength(2)
  })
})
