import {
  IconFolderClose16,
  IconProjectAddOutline16,
  Tooltip,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { WorkspaceDataProps } from './shared.tsx'
import { ActionError, copy, isBusy, useActionState, WorkspaceRows } from './shared.tsx'
import css from './Workspace.module.css'

export interface WorkspaceSidebarProps extends WorkspaceDataProps {
  readonly wide: boolean
  readonly expandSidebar: () => void
}

export function WorkspaceSidebar({
  wide,
  expandSidebar,
  useGrants,
  useSessions,
  actions,
  t,
}: WorkspaceSidebarProps) {
  const grants = useGrants(snapshot => snapshot)
  const operation = useActionState()
  const add = (): void => {
    operation.run('authorize', () => actions.authorize())
  }

  if (!wide) {
    return (
      <div className={css.rail} data-workspace-rail="true">
        <Tooltip label={copy(t, 'add')}>
          <button
            type="button"
            className={css.railButton}
            aria-label={copy(t, 'add')}
            disabled={operation.pending !== null}
            onClick={add}
          >
            <IconProjectAddOutline16 size={18} />
          </button>
        </Tooltip>
        {grants.items.map(workspace => (
          <Tooltip key={workspace.workspaceId} label={workspace.name}>
            <button
              type="button"
              className={css.railButton}
              aria-label={copy(t, 'openWorkspace', { name: workspace.name })}
              disabled={isBusy(workspace.state) || operation.pending !== null}
              onClick={() => {
                expandSidebar()
                if (workspace.state === 'ready') {
                  operation.run(`switch:${workspace.workspaceId}`, () =>
                    actions.startSession(workspace.workspaceId))
                }
                else if (!isBusy(workspace.state)) {
                  operation.run(`reauthorize:${workspace.workspaceId}`, () =>
                    actions.reauthorize(workspace.workspaceId))
                }
              }}
            >
              <IconFolderClose16 size={18} />
            </button>
          </Tooltip>
        ))}
      </div>
    )
  }

  return (
    <section className={css.sidebar} aria-label="Workspaces">
      <div className={css.sectionHeader}>
        <span>Workspaces</span>
        <Tooltip label={copy(t, 'add')}>
          <button
            type="button"
            className={css.iconButton}
            aria-label={copy(t, 'add')}
            disabled={operation.pending !== null}
            onClick={add}
          >
            <IconProjectAddOutline16 />
          </button>
        </Tooltip>
      </div>
      {grants.state === 'loading' && <div className={css.loading} role="status">Loading…</div>}
      <WorkspaceRows
        useGrants={useGrants}
        useSessions={useSessions}
        actions={actions}
        t={t}
        operation={operation}
        showSessions
      />
      {operation.error !== null && <ActionError>{operation.error}</ActionError>}
      {grants.error !== null && <ActionError>{grants.error.message}</ActionError>}
    </section>
  )
}
