// @vitest-environment jsdom
import { useRef, useState } from 'react'
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
  type WorkspaceGrantListState,
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

function anchor() {
  const element = document.createElement('button')
  const anchorRef = { current: element }
  const rect = new DOMRect(24, 36, 120, 32)
  const getAnchorRect = vi.spyOn(element, 'getBoundingClientRect').mockReturnValue(rect)
  anchorRef.current = element
  return { anchorRef, getAnchorRect }
}

function harness(
  items: readonly WorkspaceGrantView[],
  current: SessionId | undefined = sid('session-current'),
) {
  const grants = createSnapshotStore<WorkspaceGrantListState>({
    items,
    state: 'idle' as const,
    error: null,
  })
  const sessionStore = createSnapshotStore(sessions(current))
  const authorize = vi.fn(async () => 'cancelled' as const)
  const reauthorize = vi.fn(async () => 'cancelled' as const)
  const rename = vi.fn(async () => {})
  const remove = vi.fn<WorkspaceClientActions['remove']>(
    async () => 'cancelled',
  )
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

    for (const label of [
      'Ready',
      'Needs authorization',
      'Missing',
      'Permission denied',
      'Identity mismatch',
      'Removing',
      'Reauthorizing',
    ]) expect(screen.getByText(label)).toBeTruthy()
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

  it('surfaces and clears an authorize failure after a controlled Hero owner closes the Menu', async () => {
    const failure = deferred<'cancelled'>()
    const h = harness([])
    h.authorize.mockReturnValueOnce(failure.promise)
    function ControlledHero() {
      const [open, setOpen] = useState(true)
      const anchorRef = useRef<HTMLButtonElement>(null)
      return (
        <>
          <button
            ref={anchorRef}
            type="button"
            aria-label="Workspace picker"
            aria-haspopup="menu"
            aria-expanded={open}
            onClick={() => { setOpen(value => !value) }}
          />
          <WorkspaceHero
            open={open}
            anchorRef={anchorRef}
            onPick={vi.fn()}
            onClose={() => { setOpen(false) }}
            useGrants={h.useGrants}
            useSessions={h.useSessions}
            actions={h.actions}
          />
        </>
      )
    }
    render(<ControlledHero />)

    fireEvent.click(screen.getByRole('menuitem', { name: 'Add Workspace' }))
    expect(screen.queryByRole('menu')).toBeNull()
    failure.reject(new Error('chooser unavailable after close'))

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('chooser unavailable after close')
    fireEvent.click(within(alert).getByRole('button', { name: 'Close' }))
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('surfaces a reauthorize failure after a controlled Hero owner closes the Menu', async () => {
    const failure = deferred<'cancelled'>()
    const h = harness([grant('missing-workspace', 'missing')])
    h.reauthorize.mockReturnValueOnce(failure.promise)
    function ControlledHero() {
      const [open, setOpen] = useState(true)
      const anchorRef = useRef<HTMLButtonElement>(null)
      return (
        <>
          <button ref={anchorRef} type="button" aria-label="Workspace picker" />
          <WorkspaceHero
            open={open}
            anchorRef={anchorRef}
            onPick={vi.fn()}
            onClose={() => { setOpen(false) }}
            useGrants={h.useGrants}
            useSessions={h.useSessions}
            actions={h.actions}
          />
        </>
      )
    }
    render(<ControlledHero />)

    fireEvent.click(screen.getByRole('menuitem', { name: 'Reauthorize missing-workspace' }))
    expect(screen.queryByRole('menu')).toBeNull()
    failure.reject(new Error('reauthorize unavailable after close'))

    expect((await screen.findByRole('alert')).textContent)
      .toContain('reauthorize unavailable after close')
  })

  it('surfaces and clears collapsed rail failures without expanding the layout', async () => {
    const h = harness([])
    h.authorize.mockRejectedValueOnce(new Error('rail chooser unavailable'))
    const view = render(
      <WorkspaceSidebar
        wide={false}
        expandSidebar={vi.fn()}
        useGrants={h.useGrants}
        useSessions={h.useSessions}
        actions={h.actions}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Add Workspace' }))
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('rail chooser unavailable')
    expect(view.container.querySelector('[data-workspace-rail-error="true"]')).toBe(alert)
    fireEvent.click(within(alert).getByRole('button', { name: 'Close' }))
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('runs Add once, treats native cancellation as stable, and surfaces real failures', async () => {
    const pending = deferred<'cancelled'>()
    const h = harness([])
    const { anchorRef } = anchor()
    h.authorize.mockReturnValueOnce(pending.promise)
    render(
      <WorkspaceHero
        open
        anchorRef={anchorRef}
        onPick={vi.fn()}
        onClose={vi.fn()}
        useGrants={h.useGrants}
        useSessions={h.useSessions}
        actions={h.actions}
      />,
    )
    const add = screen.getByRole<HTMLButtonElement>('menuitem', { name: 'Add Workspace' })
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
    const { anchorRef } = anchor()
    const onPick = vi.fn()
    render(
      <WorkspaceHero
        open
        anchorRef={anchorRef}
        onPick={onPick}
        onClose={vi.fn()}
        useGrants={h.useGrants}
        useSessions={h.useSessions}
        actions={h.actions}
      />,
    )

    fireEvent.click(screen.getByRole('menuitem', { name: 'Alpha' }))
    expect(onPick).toHaveBeenCalledWith('alpha')
    fireEvent.click(screen.getByRole('menuitem', { name: 'Reauthorize missing-workspace' }))
    await waitFor(() => {
      expect(h.reauthorize).toHaveBeenCalledWith('missing-workspace')
    })
    expect(onPick).not.toHaveBeenCalledWith('missing-workspace')
  })

  it('anchors the Hero Menu and closes on outside click, Escape, selection, and cancellation', async () => {
    const h = harness([grant('alpha')])
    const { anchorRef, getAnchorRect } = anchor()
    const onPick = vi.fn()
    const onClose = vi.fn()
    h.authorize.mockResolvedValueOnce('cancelled')
    render(
      <WorkspaceHero
        open
        anchorRef={anchorRef}
        onPick={onPick}
        onClose={onClose}
        useGrants={h.useGrants}
        useSessions={h.useSessions}
        actions={h.actions}
      />,
    )

    expect(getAnchorRect).toHaveBeenCalled()
    expect(screen.getByRole('menu').parentElement).toBe(document.body)
    fireEvent.pointerDown(document.body)
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(2)

    fireEvent.click(screen.getByRole('menuitem', { name: 'Alpha' }))
    expect(onPick).toHaveBeenCalledWith('alpha')
    expect(onClose).toHaveBeenCalledTimes(3)

    fireEvent.click(screen.getByRole('menuitem', { name: 'Add Workspace' }))
    await waitFor(() => { expect(h.authorize).toHaveBeenCalledOnce() })
    expect(onClose).toHaveBeenCalledTimes(4)
    expect(onPick).toHaveBeenCalledTimes(1)
  })

  it('provides settings actions and states the non-destructive Remove boundary', async () => {
    const h = harness([grant('alpha', 'ready', [sid('session-current')])])
    render(
      <WorkspaceSettings
        close={vi.fn()}
        useGrants={h.useGrants}
        useSessions={h.useSessions}
        actions={h.actions}
      />,
    )
    const section = screen.getByRole('region', { name: 'Workspace settings' })
    expect(within(section).getByText('~/Projects/alpha')).toBeTruthy()

    fireEvent.click(within(section).getByRole('button', { name: 'Workspace actions for Alpha' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Rename' }))
    const renameView = screen.getByRole('region', { name: 'Rename Workspace' })
    fireEvent.change(within(renameView).getByRole('textbox'), { target: { value: 'Alpha Two' } })
    fireEvent.click(within(renameView).getByRole('button', { name: 'Rename' }))
    await waitFor(() => {
      expect(h.rename).toHaveBeenCalledWith('alpha', 'Alpha Two')
    })

    fireEvent.click(within(section).getByRole('button', { name: 'Workspace actions for Alpha' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Reveal in Finder' }))
    await waitFor(() => { expect(h.reveal).toHaveBeenCalledWith('alpha') })

    fireEvent.click(within(section).getByRole('button', { name: 'Workspace actions for Alpha' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Remove' }))
    const removeView = screen.getByRole('region', { name: 'Remove Workspace' })
    expect(removeView.textContent).toContain(
      'Only the authorization and list item are removed. Files and session history are kept.',
    )
    fireEvent.click(within(removeView).getByRole('button', { name: 'Remove' }))
    await waitFor(() => { expect(h.remove).toHaveBeenCalledWith('alpha') })
    expect(screen.getByRole('region', { name: 'Remove Workspace' })).toBeTruthy()
  })

  it('uses inline subviews without nested dialogs and restores focus on return', async () => {
    const h = harness([grant('alpha')])
    render(
      <WorkspaceSettings
        close={vi.fn()}
        useGrants={h.useGrants}
        useSessions={h.useSessions}
        actions={h.actions}
      />,
    )

    const openActions = () => {
      const trigger = screen.getByRole<HTMLButtonElement>('button', {
        name: 'Workspace actions for Alpha',
      })
      expect(trigger.getAttribute('aria-haspopup')).toBe('menu')
      expect(trigger.getAttribute('aria-expanded')).toBe('false')
      fireEvent.click(trigger)
      expect(trigger.getAttribute('aria-expanded')).toBe('true')
      return trigger
    }

    openActions()
    fireEvent.click(screen.getByRole('menuitem', { name: 'Rename' }))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(screen.getByRole('region', { name: 'Rename Workspace' })).toBeTruthy()

    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Escape' })
    await waitFor(() => {
      expect(screen.getByRole('region', { name: 'Workspace settings' })).toBeTruthy()
      expect(screen.getByRole('button', { name: 'Workspace actions for Alpha' }))
        .toBe(document.activeElement)
    })

    openActions()
    fireEvent.click(screen.getByRole('menuitem', { name: 'Remove' }))
    const removeView = screen.getByRole('region', { name: 'Remove Workspace' })
    fireEvent.click(within(removeView).getByRole('button', { name: 'Cancel' }))
    await waitFor(() => {
      expect(screen.getByRole('region', { name: 'Workspace settings' })).toBeTruthy()
      expect(screen.getByRole('button', { name: 'Workspace actions for Alpha' }))
        .toBe(document.activeElement)
    })

    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('focuses the management heading after a revoked Workspace row disappears', async () => {
    const h = harness([grant('alpha')])
    h.remove.mockImplementationOnce(async () => {
      h.grants.set({ ...h.grants.getSnapshot(), items: [] })
      return 'revoked'
    })
    render(
      <WorkspaceSettings
        close={vi.fn()}
        useGrants={h.useGrants}
        useSessions={h.useSessions}
        actions={h.actions}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Workspace actions for Alpha' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Remove' }))
    fireEvent.click(within(screen.getByRole('region', {
      name: 'Remove Workspace',
    })).getByRole('button', { name: 'Remove' }))

    await waitFor(() => {
      expect(screen.queryByRole('button', { name: 'Workspace actions for Alpha' })).toBeNull()
      expect(screen.getByRole('heading', { name: 'Workspace settings' }))
        .toBe(document.activeElement)
    })
  })

  it('closes the owning Settings shell after starting a Workspace session', async () => {
    const h = harness([grant('alpha')])
    const close = vi.fn()
    render(
      <WorkspaceSettings
        close={close}
        useGrants={h.useGrants}
        useSessions={h.useSessions}
        actions={h.actions}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Switch to Alpha' }))
    await waitFor(() => {
      expect(h.startSession).toHaveBeenCalledWith('alpha')
      expect(close).toHaveBeenCalledOnce()
    })
  })

  it('does not let a session started by an unmounted Settings instance close a later one', async () => {
    const h = harness([grant('alpha')])
    const pending = deferred<undefined>()
    h.startSession.mockReturnValueOnce(pending.promise)
    const firstClose = vi.fn()
    const first = render(
      <WorkspaceSettings
        close={firstClose}
        useGrants={h.useGrants}
        useSessions={h.useSessions}
        actions={h.actions}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Switch to Alpha' }))
    expect(h.startSession).toHaveBeenCalledWith('alpha')
    first.unmount()

    const laterClose = vi.fn()
    render(
      <WorkspaceSettings
        close={laterClose}
        useGrants={h.useGrants}
        useSessions={h.useSessions}
        actions={h.actions}
      />,
    )
    await act(async () => {
      pending.resolve(undefined)
      await pending.promise
    })

    expect(firstClose).not.toHaveBeenCalled()
    expect(laterClose).not.toHaveBeenCalled()
    expect(screen.getByRole('region', { name: 'Workspace settings' })).toBeTruthy()
  })

  it('shows existing Workspace sessions and closes Settings after opening one', () => {
    const h = harness([
      grant('alpha', 'ready', [sid('session-current'), sid('session-history')]),
    ])
    const close = vi.fn()
    render(
      <WorkspaceSettings
        close={close}
        useGrants={h.useGrants}
        useSessions={h.useSessions}
        actions={h.actions}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Historical discussion' }))

    expect(h.openSession).toHaveBeenCalledWith(sid('session-history'))
    expect(close).toHaveBeenCalledOnce()
  })

  it('routes the section title, loading label, and all authority states through locale copy', () => {
    const allStates: WorkspaceGrantView['state'][] = [
      'ready',
      'needs-authorization',
      'missing',
      'permission-denied',
      'identity-mismatch',
      'revoking',
      'reauthorizing',
    ]
    const h = harness(allStates.map((state, index) => grant(`workspace-${index}`, state)))
    h.grants.set({ ...h.grants.getSnapshot(), state: 'loading' })
    const translations: Record<string, string> = {
      workspaces: 'Localized workspaces',
      loading: 'Localized loading',
      stateReady: 'Localized ready',
      stateNeedsAuthorization: 'Localized needs authorization',
      stateMissing: 'Localized missing',
      statePermissionDenied: 'Localized permission denied',
      stateIdentityMismatch: 'Localized identity mismatch',
      stateRevoking: 'Localized revoking',
      stateReauthorizing: 'Localized reauthorizing',
    }
    const t = vi.fn((key: string) => translations[key] ?? key) as never
    render(
      <WorkspaceSidebar
        wide
        expandSidebar={vi.fn()}
        useGrants={h.useGrants}
        useSessions={h.useSessions}
        actions={h.actions}
        t={t}
      />,
    )

    for (const value of Object.values(translations)) {
      expect(screen.getByText(value)).toBeTruthy()
    }
  })

  it('disables conflicting row operations while revoking or reauthorizing', () => {
    const h = harness([
      grant('revoking-workspace', 'revoking'),
      grant('reauthorizing-workspace', 'reauthorizing'),
    ], undefined)
    render(
      <WorkspaceSettings
        close={vi.fn()}
        useGrants={h.useGrants}
        useSessions={h.useSessions}
        actions={h.actions}
      />,
    )
    expect(screen.getByRole<HTMLButtonElement>('button', {
      name: 'Workspace actions for revoking-workspace',
    }).disabled).toBe(true)
    expect(screen.getByRole<HTMLButtonElement>('button', {
      name: 'Workspace actions for reauthorizing-workspace',
    }).disabled).toBe(true)
    expect(screen.getAllByRole('status')).toHaveLength(2)
  })

  it('disables Settings row actions while Add is pending', () => {
    const pending = deferred<'cancelled'>()
    const h = harness([
      grant('alpha'),
      grant('missing-workspace', 'missing'),
    ], undefined)
    h.authorize.mockReturnValueOnce(pending.promise)
    render(
      <WorkspaceSettings
        close={vi.fn()}
        useGrants={h.useGrants}
        useSessions={h.useSessions}
        actions={h.actions}
      />,
    )
    const section = screen.getByRole('region', { name: 'Workspace settings' })
    const add = within(section).getByRole<HTMLButtonElement>('button', { name: 'Add Workspace' })
    fireEvent.click(within(section).getByRole('button', { name: 'Workspace actions for Alpha' }))
    fireEvent.click(add)

    expect(within(section).getByRole<HTMLButtonElement>('button', { name: 'Switch to Alpha' }).disabled)
      .toBe(true)
    expect(screen.getByRole<HTMLButtonElement>('menuitem', { name: 'Rename' }).disabled).toBe(true)
    expect(screen.getByRole<HTMLButtonElement>('menuitem', { name: 'Reveal in Finder' }).disabled)
      .toBe(true)
    expect(screen.getByRole<HTMLButtonElement>('menuitem', { name: 'Remove' }).disabled).toBe(true)
    expect(within(section).getByRole<HTMLButtonElement>('button', {
      name: 'Workspace actions for Alpha',
    }).disabled).toBe(true)
    expect(within(section).getByRole<HTMLButtonElement>('button', {
      name: 'Workspace actions for missing-workspace',
    }).disabled).toBe(true)
    expect(add.disabled).toBe(true)
  })

  it('disables reauthorization while Settings Add is pending', () => {
    const pending = deferred<'cancelled'>()
    const h = harness([grant('missing-workspace', 'missing')], undefined)
    h.authorize.mockReturnValueOnce(pending.promise)
    render(
      <WorkspaceSettings
        close={vi.fn()}
        useGrants={h.useGrants}
        useSessions={h.useSessions}
        actions={h.actions}
      />,
    )
    const section = screen.getByRole('region', { name: 'Workspace settings' })
    fireEvent.click(within(section).getByRole('button', {
      name: 'Workspace actions for missing-workspace',
    }))
    fireEvent.click(within(section).getByRole('button', { name: 'Add Workspace' }))

    expect(screen.getByRole<HTMLButtonElement>('menuitem', {
      name: 'Reauthorize missing-workspace',
    }).disabled).toBe(true)
    expect(within(section).getByRole<HTMLButtonElement>('button', {
      name: 'Reauthorize missing-workspace',
    }).disabled).toBe(true)
  })

  it('disables Sidebar Add and every conflicting row control while a row action is pending', () => {
    const pending = deferred<undefined>()
    const h = harness([
      grant('alpha'),
      grant('beta'),
    ], undefined)
    h.reveal.mockReturnValueOnce(pending.promise)
    render(
      <WorkspaceSidebar
        wide
        expandSidebar={vi.fn()}
        useGrants={h.useGrants}
        useSessions={h.useSessions}
        actions={h.actions}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Workspace actions for Alpha' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Reveal in Finder' }))

    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Add Workspace' }).disabled)
      .toBe(true)
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Switch to Alpha' }).disabled)
      .toBe(true)
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Switch to beta' }).disabled)
      .toBe(true)
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'New session in beta' }).disabled)
      .toBe(true)
    expect(screen.getByRole<HTMLButtonElement>('button', {
      name: 'Workspace actions for beta',
    }).disabled).toBe(true)
  })
})
