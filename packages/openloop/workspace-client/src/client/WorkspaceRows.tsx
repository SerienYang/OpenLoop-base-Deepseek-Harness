import { useState } from 'react'
import {
  IconEllipsisOutline16,
  IconFolderOpenOutline16,
  IconRefreshOutline14,
  IconTrashOutline16,
  Menu,
  StateDot,
  Tooltip,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { WorkspaceGrantView } from '@openloop/desktop-bridge-host/types'
import type { ActionState } from './actions.tsx'
import type { WorkspaceDataProps } from './shared.tsx'
import {
  copy,
  dotState,
  grantForCurrent,
  isBusy,
  stateLabel,
} from './shared.tsx'
import css from './Workspace.module.css'

interface WorkspaceRowsProps extends WorkspaceDataProps {
  readonly operation: ActionState
  readonly showSessions?: boolean
  readonly onReadyWorkspace?: (workspace: WorkspaceGrantView) => void
  readonly onRename: (workspace: WorkspaceGrantView) => void
  readonly onRemove: (workspace: WorkspaceGrantView) => void
  readonly setActionTrigger?: (
    workspaceId: string,
    element: HTMLButtonElement | null,
  ) => void
}

export function WorkspaceRows({
  useGrants,
  useSessions,
  actions,
  t,
  operation,
  showSessions = false,
  onReadyWorkspace,
  onRename,
  onRemove,
  setActionTrigger,
}: WorkspaceRowsProps) {
  const grants = useGrants(snapshot => snapshot.items)
  const sessions = useSessions(snapshot => snapshot)
  const active = grantForCurrent(grants, sessions.current)
  const [menuId, setMenuId] = useState<string | null>(null)

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
    <div className={css.rows}>
      {grants.map((workspace) => {
        const authorityBusy = isBusy(workspace.state)
        const surfaceBusy = operation.pending !== null
        const busy = authorityBusy || surfaceBusy
        const menuOpen = menuId === workspace.workspaceId
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
              <span className={css.status} role={authorityBusy ? 'status' : undefined}>
                {stateLabel(t, workspace.state)}
              </span>
              <Menu
                open={menuOpen}
                onClose={() => { setMenuId(null) }}
                items={menuItems}
                onSelect={(id) => {
                  setMenuId(null)
                  if (id === 'rename') {
                    onRename(workspace)
                  } else if (id === 'remove') {
                    onRemove(workspace)
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
                      ref={(element) => { setActionTrigger?.(workspace.workspaceId, element) }}
                      type="button"
                      className={css.iconButton}
                      aria-label={copy(t, 'workspaceActions', { name: workspace.name })}
                      aria-haspopup="menu"
                      aria-expanded={menuOpen}
                      disabled={busy}
                      onClick={() => {
                        setMenuId(current =>
                          current === workspace.workspaceId ? null : workspace.workspaceId)
                      }}
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
  )
}
