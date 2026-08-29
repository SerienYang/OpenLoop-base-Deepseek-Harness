import {
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react'
import {
  Button,
  IconPlusOutline16,
  IconSettingsOutline16,
  Modal,
  Tooltip,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { WorkspaceGrantView } from '@openloop/desktop-bridge-host/types'
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

export interface WorkspaceSettingsProps extends WorkspaceDataProps {
  readonly wide: boolean
}

type SettingsView = { readonly kind: 'manage' } | WorkspaceDialogState

export function WorkspaceSettings({
  wide,
  useGrants,
  useSessions,
  actions,
  t,
}: WorkspaceSettingsProps) {
  const [open, setOpen] = useState(false)
  const [view, setView] = useState<SettingsView>({ kind: 'manage' })
  const [renameValue, setRenameValue] = useState('')
  const operation = useActionState()
  const settingsTrigger = useRef<HTMLButtonElement>(null)
  const actionTriggers = useRef(new Map<string, HTMLButtonElement>())
  const focusWorkspaceId = useRef<string | null>(null)
  const restoreSettingsFocus = useRef(false)

  const setActionTrigger = useCallback((
    workspaceId: string,
    element: HTMLButtonElement | null,
  ) => {
    if (element === null) actionTriggers.current.delete(workspaceId)
    else actionTriggers.current.set(workspaceId, element)
  }, [])

  useEffect(() => {
    if (!open && restoreSettingsFocus.current) {
      restoreSettingsFocus.current = false
      settingsTrigger.current?.focus()
    }
  }, [open])

  useEffect(() => {
    if (!open || view.kind !== 'manage' || focusWorkspaceId.current === null) return
    const workspaceId = focusWorkspaceId.current
    focusWorkspaceId.current = null
    actionTriggers.current.get(workspaceId)?.focus()
  }, [open, view])

  const closeSettings = (): void => {
    restoreSettingsFocus.current = true
    setView({ kind: 'manage' })
    setOpen(false)
  }

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

  return (
    <>
      <Tooltip label={copy(t, 'settings')} disabled={wide}>
        <button
          ref={settingsTrigger}
          type="button"
          className={css.settingsTrigger}
          aria-label={copy(t, 'settings')}
          aria-haspopup="dialog"
          aria-expanded={open}
          onClick={() => {
            setView({ kind: 'manage' })
            setOpen(true)
          }}
        >
          <IconSettingsOutline16 size={wide ? 16 : 18} />
          {wide && <span>{copy(t, 'settings')}</span>}
        </button>
      </Tooltip>
      <Modal
        open={open}
        onClose={managing ? closeSettings : returnToManage}
        title={managing ? copy(t, 'settingsTitle') : workspaceDialogTitle(view, t)}
        closeLabel={copy(t, 'close')}
        className={css.settingsDialog as string}
        contentClassName={css.settingsContent as string}
        footer={managing
          ? undefined
          : (
            <WorkspaceDialogFooter
              dialog={view}
              renameValue={renameValue}
              operation={operation}
              actions={actions}
              onCancel={returnToManage}
              onComplete={returnToManage}
              t={t}
            />
          )}
      >
        {managing
          ? (
            <>
              <div className={css.settingsToolbar}>
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
                actions={actions}
                t={t}
                operation={operation}
                onRename={(workspace) => { openDialog('rename', workspace) }}
                onRemove={(workspace) => { openDialog('remove', workspace) }}
                setActionTrigger={setActionTrigger}
              />
            </>
          )
          : (
            <WorkspaceDialogBody
              dialog={view}
              renameValue={renameValue}
              onRenameValue={setRenameValue}
              t={t}
            />
          )}
        {operation.error !== null && (
          <ActionError
            closeLabel={copy(t, 'close')}
            onClose={() => { operation.clearError() }}
          >
            {operation.error}
          </ActionError>
        )}
      </Modal>
    </>
  )
}
