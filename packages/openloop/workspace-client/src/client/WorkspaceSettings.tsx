import {
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react'
import {
  Button,
  IconPlusOutline16,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { WorkspaceGrantView } from '@openloop/desktop-bridge-host/types'
import type { SettingsSectionOwnerProps } from '@deepseek-ai/dsh-client-ui-settings/client'
import { ActionError, useActionState } from './actions.tsx'
import type { WorkspaceDataProps } from './shared.tsx'
import { copy } from './shared.tsx'
import {
  WorkspaceDialogBody,
  WorkspaceDialogFooter,
  type WorkspaceDialogState,
  workspaceDialogTitle,
} from './WorkspaceDialogs.tsx'
import { WorkspaceRows } from './WorkspaceRows.tsx'
import css from './Workspace.module.css'

export interface WorkspaceSettingsProps extends WorkspaceDataProps, SettingsSectionOwnerProps {}

type SettingsView = { readonly kind: 'manage' } | WorkspaceDialogState

export function WorkspaceSettings({
  close,
  useGrants,
  useSessions,
  actions,
  t,
}: WorkspaceSettingsProps) {
  const [view, setView] = useState<SettingsView>({ kind: 'manage' })
  const [renameValue, setRenameValue] = useState('')
  const operation = useActionState()
  const actionTriggers = useRef(new Map<string, HTMLButtonElement>())
  const manageHeading = useRef<HTMLHeadingElement | null>(null)
  const focusWorkspaceId = useRef<string | null>(null)

  const setActionTrigger = useCallback((
    workspaceId: string,
    element: HTMLButtonElement | null,
  ) => {
    if (element === null) actionTriggers.current.delete(workspaceId)
    else actionTriggers.current.set(workspaceId, element)
  }, [])

  useEffect(() => {
    if (view.kind !== 'manage' || focusWorkspaceId.current === null) return
    const workspaceId = focusWorkspaceId.current
    focusWorkspaceId.current = null
    const trigger = actionTriggers.current.get(workspaceId)
    if (trigger?.isConnected === true) trigger.focus()
    else manageHeading.current?.focus()
  }, [view])

  const returnToManage = (): void => {
    if (view.kind === 'manage') return
    focusWorkspaceId.current = view.target.workspaceId
    setView({ kind: 'manage' })
  }

  const openDialog = (
    kind: WorkspaceDialogState['kind'],
    workspace: WorkspaceGrantView,
  ): void => {
    if (kind === 'rename') setRenameValue(workspace.name)
    setView({ kind, target: workspace })
  }

  const managing = view.kind === 'manage'
  const sectionActions = {
    ...actions,
    startSession: async (workspaceId: string): Promise<void> => {
      await actions.startSession(workspaceId)
      close()
    },
    openSession: (sessionId: Parameters<typeof actions.openSession>[0]): void => {
      actions.openSession(sessionId)
      close()
    },
  }

  return (
    <section
      className={css.settingsSection}
      role="region"
      aria-label={managing ? copy(t, 'settingsTitle') : workspaceDialogTitle(view, t)}
      onKeyDown={(event) => {
        if (event.key !== 'Escape' || managing) return
        event.stopPropagation()
        returnToManage()
      }}
    >
      {managing
        ? (
          <>
            <div className={css.settingsToolbar}>
              <h3 ref={manageHeading} tabIndex={-1}>{copy(t, 'settingsTitle')}</h3>
              <Button
                variant="outline"
                size="sm"
                icon={<IconPlusOutline16 size={14} />}
                disabled={operation.pending !== null}
                onClick={() => { operation.run('authorize', () => actions.authorize()) }}
              >
                {copy(t, 'add')}
              </Button>
            </div>
            <WorkspaceRows
              useGrants={useGrants}
              useSessions={useSessions}
              actions={sectionActions}
              t={t}
              operation={operation}
              onRename={(workspace) => { openDialog('rename', workspace) }}
              onRemove={(workspace) => { openDialog('remove', workspace) }}
              setActionTrigger={setActionTrigger}
              showSessions
            />
          </>
        )
        : (
          <>
            <div className={css.settingsSubviewHeader}>
              <h3>{workspaceDialogTitle(view, t)}</h3>
            </div>
            <WorkspaceDialogBody
              dialog={view}
              renameValue={renameValue}
              onRenameValue={setRenameValue}
              t={t}
            />
            <div className={css.settingsSubviewFooter}>
              <WorkspaceDialogFooter
                operation={operation}
                dialog={view}
                renameValue={renameValue}
                actions={actions}
                onCancel={returnToManage}
                onComplete={returnToManage}
                t={t}
              />
            </div>
          </>
        )}
      {operation.error !== null && (
        <ActionError
          closeLabel={copy(t, 'close')}
          onClose={() => { operation.clearError() }}
        >
          {operation.error}
        </ActionError>
      )}
    </section>
  )
}
