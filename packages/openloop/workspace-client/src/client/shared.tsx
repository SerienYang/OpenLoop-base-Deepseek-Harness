import { useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type {
  SessionId,
  SessionListState,
} from '@deepseek-ai/dsh-client-runtime/client'
import type { SnapshotSelectorHook } from '@deepseek-ai/dsh-client-ui-slots'
import {
  Button,
  IconEllipsisOutline16,
  IconFolderOpenOutline16,
  IconRefreshOutline14,
  IconTrashOutline16,
  Input,
  Menu,
  Modal,
  StateDot,
  Tooltip,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { WorkspaceGrantView } from '@openloop/desktop-bridge-host/types'
import { en, type WorkspaceClientKey } from './locales.ts'
import css from './Workspace.module.css'

export interface WorkspaceGrantListState {
  readonly items: readonly WorkspaceGrantView[]
  readonly state: 'idle' | 'loading' | 'error'
  readonly error: Error | null
}

export interface WorkspaceClientActions {
  authorize(): Promise<WorkspaceGrantView | 'cancelled'>
  reauthorize(workspaceId: string): Promise<WorkspaceGrantView | 'cancelled'>
  rename(workspaceId: string, name: string): Promise<void>
  remove(workspaceId: string): Promise<'revoked' | 'cancelled'>
  reveal(workspaceId: string): Promise<void>
  startSession(workspaceId: string): Promise<void>
  openSession(sessionId: SessionId): void
}

export type WorkspaceTranslate = (
  key: WorkspaceClientKey,
  params?: Readonly<Record<string, string>>,
) => string

export interface WorkspaceDataProps {
  useGrants: SnapshotSelectorHook<WorkspaceGrantListState>
  useSessions: SnapshotSelectorHook<SessionListState>
  actions: WorkspaceClientActions
  t?: WorkspaceTranslate | undefined
}

function fallbackTranslate(
  key: WorkspaceClientKey,
  params: Readonly<Record<string, string>> = {},
): string {
  let value: string = en[key]
  for (const [name, replacement] of Object.entries(params)) {
    value = value.replaceAll(`{${name}}`, replacement)
  }
  return value
}

export function copy(
  t: WorkspaceTranslate | undefined,
  key: WorkspaceClientKey,
  params?: Readonly<Record<string, string>>,
): string {
  return (t ?? fallbackTranslate)(key, params)
}

export function isBusy(state: WorkspaceGrantView['state']): boolean {
  return state === 'revoking' || state === 'reauthorizing'
}

function dotState(state: WorkspaceGrantView['state']) {
  if (state === 'ready') return 'done' as const
  if (isBusy(state)) return 'ongoing' as const
  if (state === 'permission-denied' || state === 'identity-mismatch') return 'error' as const
  return 'warning' as const
}

export function grantForCurrent(
  grants: readonly WorkspaceGrantView[],
  current: SessionId | undefined,
): WorkspaceGrantView | undefined {
  return current === undefined
    ? undefined
    : grants.find(grant => grant.sessionIds.includes(current))
}

export interface ActionState {
  readonly pending: string | null
  readonly error: string | null
  run(key: string, action: () => Promise<unknown>): void
  clearError(): void
}

export function useActionState(): ActionState {
  const [pending, setPending] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const inFlight = useRef(false)
  return {
    pending,
    error,
    run(key, action) {
      if (inFlight.current) return
      inFlight.current = true
      setPending(key)
      setError(null)
      void action().catch((reason: unknown) => {
        setError(reason instanceof Error ? reason.message : String(reason))
      }).finally(() => {
        inFlight.current = false
        setPending(null)
      })
    },
    clearError() {
      setError(null)
    },
  }
}

interface WorkspaceRowsProps extends WorkspaceDataProps {
  readonly operation: ActionState
  readonly showSessions?: boolean
  readonly onReadyWorkspace?: (workspace: WorkspaceGrantView) => void
}

export function WorkspaceRows({
  useGrants,
  useSessions,
  actions,
  t,
  operation,
  showSessions = false,
  onReadyWorkspace,
}: WorkspaceRowsProps) {
  const grants = useGrants(snapshot => snapshot.items)
  const sessions = useSessions(snapshot => snapshot)
  const active = grantForCurrent(grants, sessions.current)
  const [menuId, setMenuId] = useState<string | null>(null)
  const [renameTarget, setRenameTarget] = useState<WorkspaceGrantView | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [removeTarget, setRemoveTarget] = useState<WorkspaceGrantView | null>(null)

  const selectWorkspace = (workspace: WorkspaceGrantView): void => {
    if (workspace.state === 'ready') {
      if (onReadyWorkspace !== undefined) onReadyWorkspace(workspace)
      else {
        operation.run(`switch:${workspace.workspaceId}`, () =>
          actions.startSession(workspace.workspaceId))
      }
      return
    }
    if (!isBusy(workspace.state)) {
      operation.run(`reauthorize:${workspace.workspaceId}`, () =>
        actions.reauthorize(workspace.workspaceId))
    }
  }

  if (grants.length === 0) return <p className={css.empty}>{copy(t, 'empty')}</p>

  return (
    <>
      <div className={css.rows}>
        {grants.map((workspace) => {
          const authorityBusy = isBusy(workspace.state)
          const surfaceBusy = operation.pending !== null
          const busy = authorityBusy || surfaceBusy
          const workspaceSessions = workspace.sessionIds
            .map(sessionId => sessions.byId[sessionId])
            .filter(summary => summary !== undefined)
          const menuItems = [
            ...(workspace.state === 'ready'
              ? [{ id: 'rename', label: copy(t, 'rename'), disabled: surfaceBusy }]
              : authorityBusy
                ? []
                : [{
                  id: 'reauthorize',
                  label: copy(t, 'reauthorize', { name: workspace.name }),
                  icon: <IconRefreshOutline14 />,
                  disabled: surfaceBusy,
                }]),
            {
              id: 'reveal',
              label: copy(t, 'reveal'),
              icon: <IconFolderOpenOutline16 />,
              disabled: busy,
            },
            {
              id: 'remove',
              label: copy(t, 'remove'),
              icon: <IconTrashOutline16 />,
              danger: true,
              disabled: busy,
            },
          ]
          return (
            <div className={css.workspaceGroup} key={workspace.workspaceId}>
              <div className={css.workspaceRow} data-state={workspace.state}>
                <StateDot state={dotState(workspace.state)} />
                <button
                  type="button"
                  className={css.workspaceMain}
                  aria-label={workspace.state === 'ready'
                    ? copy(t, 'switchWorkspace', { name: workspace.name })
                    : copy(t, 'reauthorize', { name: workspace.name })}
                  aria-current={active?.workspaceId === workspace.workspaceId ? 'true' : undefined}
                  disabled={busy}
                  onClick={() => { selectWorkspace(workspace) }}
                >
                  <span className={css.workspaceName}>{workspace.name}</span>
                  <span className={css.workspacePath}>{workspace.displayPath}</span>
                </button>
                <span className={css.status} role={isBusy(workspace.state) ? 'status' : undefined}>
                  {workspace.state}
                </span>
                <Menu
                  open={menuId === workspace.workspaceId}
                  onClose={() => { setMenuId(null) }}
                  items={menuItems}
                  onSelect={(id) => {
                    setMenuId(null)
                    if (id === 'rename') {
                      setRenameValue(workspace.name)
                      setRenameTarget(workspace)
                    } else if (id === 'remove') {
                      setRemoveTarget(workspace)
                    } else if (id === 'reveal') {
                      operation.run(`reveal:${workspace.workspaceId}`, () =>
                        actions.reveal(workspace.workspaceId))
                    } else if (id === 'reauthorize') {
                      operation.run(`reauthorize:${workspace.workspaceId}`, () =>
                        actions.reauthorize(workspace.workspaceId))
                    }
                  }}
                  portal
                  anchor={(
                    <Tooltip label={copy(t, 'workspaceActions', { name: workspace.name })}>
                      <button
                        type="button"
                        className={css.iconButton}
                        aria-label={copy(t, 'workspaceActions', { name: workspace.name })}
                        disabled={busy}
                        onClick={() => { setMenuId(workspace.workspaceId) }}
                      >
                        <IconEllipsisOutline16 />
                      </button>
                    </Tooltip>
                  )}
                />
                {workspace.state === 'ready' && (
                  <Tooltip label={copy(t, 'newSession', { name: workspace.name })}>
                    <button
                      type="button"
                      className={css.iconButton}
                      aria-label={copy(t, 'newSession', { name: workspace.name })}
                      disabled={busy}
                      onClick={() => {
                        operation.run(`new:${workspace.workspaceId}`, () =>
                          actions.startSession(workspace.workspaceId))
                      }}
                    >
                      +
                    </button>
                  </Tooltip>
                )}
              </div>
              {showSessions && workspaceSessions.length > 0 && (
                <div className={css.sessions}>
                  {workspaceSessions.map(summary => (
                    <button
                      type="button"
                      className={css.sessionRow}
                      key={summary.id}
                      aria-current={sessions.current === summary.id ? 'true' : undefined}
                      disabled={surfaceBusy}
                      onClick={() => { actions.openSession(summary.id) }}
                    >
                      {summary.displayTitle}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )
        })}
      </div>
      {operation.error !== null && (
        <div className={css.error} role="alert">
          {operation.error}
          <button type="button" onClick={() => { operation.clearError() }}>{copy(t, 'close')}</button>
        </div>
      )}
      <Modal
        open={renameTarget !== null}
        onClose={() => { setRenameTarget(null) }}
        title={copy(t, 'renameTitle')}
        closeLabel={copy(t, 'close')}
        footer={(
          <>
            <Button variant="outline" onClick={() => { setRenameTarget(null) }}>
              {copy(t, 'cancel')}
            </Button>
            <Button
              variant="primary"
              disabled={renameValue.trim() === '' || operation.pending !== null}
              onClick={() => {
                if (renameTarget === null) return
                const target = renameTarget
                operation.run(`rename:${target.workspaceId}`, async () => {
                  await actions.rename(target.workspaceId, renameValue.trim())
                  setRenameTarget(null)
                })
              }}
            >
              {copy(t, 'rename')}
            </Button>
          </>
        )}
      >
        <Input
          autoFocus
          aria-label={copy(t, 'rename')}
          value={renameValue}
          onChange={(event) => { setRenameValue(event.currentTarget.value) }}
        />
      </Modal>
      <Modal
        open={removeTarget !== null}
        onClose={() => { setRemoveTarget(null) }}
        title={copy(t, 'removeTitle')}
        closeLabel={copy(t, 'close')}
        footer={(
          <>
            <Button variant="outline" onClick={() => { setRemoveTarget(null) }}>
              {copy(t, 'cancel')}
            </Button>
            <Button
              variant="primary"
              disabled={operation.pending !== null}
              onClick={() => {
                if (removeTarget === null) return
                const target = removeTarget
                operation.run(`remove:${target.workspaceId}`, async () => {
                  const result = await actions.remove(target.workspaceId)
                  if (result === 'revoked') setRemoveTarget(null)
                })
              }}
            >
              {copy(t, 'remove')}
            </Button>
          </>
        )}
      >
        <p>{copy(t, 'removeBoundary')}</p>
      </Modal>
    </>
  )
}

export function ActionError({ children }: { children: ReactNode }) {
  return <div className={css.error} role="alert">{children}</div>
}
