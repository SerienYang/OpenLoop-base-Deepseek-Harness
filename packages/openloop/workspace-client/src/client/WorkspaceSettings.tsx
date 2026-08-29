import { useState } from 'react'
import {
  Button,
  IconPlusOutline16,
  IconSettingsOutline16,
  Modal,
  Tooltip,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { WorkspaceDataProps } from './shared.tsx'
import { ActionError, copy, useActionState, WorkspaceRows } from './shared.tsx'
import css from './Workspace.module.css'

export interface WorkspaceSettingsProps extends WorkspaceDataProps {
  readonly wide: boolean
}

export function WorkspaceSettings({
  wide,
  useGrants,
  useSessions,
  actions,
  t,
}: WorkspaceSettingsProps) {
  const [open, setOpen] = useState(false)
  const operation = useActionState()

  return (
    <>
      <Tooltip label={copy(t, 'settings')} disabled={wide}>
        <button
          type="button"
          className={css.settingsTrigger}
          aria-label={copy(t, 'settings')}
          aria-haspopup="dialog"
          aria-expanded={open}
          onClick={() => { setOpen(true) }}
        >
          <IconSettingsOutline16 size={wide ? 16 : 18} />
          {wide && <span>{copy(t, 'settings')}</span>}
        </button>
      </Tooltip>
      <Modal
        open={open}
        onClose={() => { setOpen(false) }}
        title={copy(t, 'settingsTitle')}
        closeLabel={copy(t, 'close')}
        className={css.settingsDialog as string}
      >
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
        />
        {operation.error !== null && <ActionError>{operation.error}</ActionError>}
      </Modal>
    </>
  )
}
