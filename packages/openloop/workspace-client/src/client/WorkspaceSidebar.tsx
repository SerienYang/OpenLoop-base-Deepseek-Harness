import { useState } from 'react'
import {
  IconFolderClose16,
  IconProjectAddOutline16,
  Tooltip,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { ActionError, RailActionError, useActionState } from './actions.tsx'
import type { WorkspaceDataProps } from './shared.tsx'
import { copy, isBusy } from './shared.tsx'
import {
  WorkspaceActionModal,
  type WorkspaceDialogState,
} from './WorkspaceDialogs.tsx'
import { WorkspaceRows } from './WorkspaceRows.tsx'
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
  const [dialog, setDialog] = useState<WorkspaceDialogState | null>(null)
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
        {operation.error !== null && (
          <RailActionError
            error={operation.error}
            closeLabel={copy(t, 'close')}
            onClose={() => { operation.clearError() }}
          />
        )}
      </div>
    )
  }

  return (
    <>
      <section className={css.sidebar} aria-label={copy(t, 'workspaces')}>
        <div className={css.sectionHeader}>
          <span>{copy(t, 'workspaces')}</span>
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
        {grants.state === 'loading' && (
          <div className={css.loading} role="status">{copy(t, 'loading')}</div>
        )}
        <WorkspaceRows
          useGrants={useGrants}
          useSessions={useSessions}
          actions={actions}
          t={t}
          operation={operation}
          onRename={(workspace) => { setDialog({ kind: 'rename', target: workspace }) }}
          onRemove={(workspace) => { setDialog({ kind: 'remove', target: workspace }) }}
          showSessions
        />
        {operation.error !== null && dialog === null && (
          <ActionError
            closeLabel={copy(t, 'close')}
            onClose={() => { operation.clearError() }}
          >
            {operation.error}
          </ActionError>
        )}
        {grants.error !== null && <ActionError>{grants.error.message}</ActionError>}
      </section>
      <WorkspaceActionModal
        dialog={dialog}
        operation={operation}
        actions={actions}
        onClose={() => { setDialog(null) }}
        t={t}
      />
    </>
  )
}
