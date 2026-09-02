import { useState } from 'react'
import {
  Button,
  Input,
  Modal,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { WorkspaceGrantView } from '@openloop/desktop-bridge-host/types'
import { ActionError, type ActionState } from './actions.tsx'
import type {
  WorkspaceClientActions,
  WorkspaceTranslate,
} from './shared.tsx'
import { copy } from './shared.tsx'

export interface WorkspaceDialogState {
  readonly kind: 'rename' | 'remove'
  readonly target: WorkspaceGrantView
}

export function workspaceDialogTitle(
  dialog: WorkspaceDialogState,
  t: WorkspaceTranslate | undefined,
): string {
  return copy(t, dialog.kind === 'rename' ? 'renameTitle' : 'removeTitle')
}

export function WorkspaceDialogBody({
  dialog,
  renameValue,
  onRenameValue,
  t,
}: {
  dialog: WorkspaceDialogState
  renameValue: string
  onRenameValue: (value: string) => void
  t?: WorkspaceTranslate | undefined
}) {
  return dialog.kind === 'rename'
    ? (
      <Input
        autoFocus
        aria-label={copy(t, 'rename')}
        value={renameValue}
        onChange={(event) => { onRenameValue(event.currentTarget.value) }}
      />
    )
    : <p>{copy(t, 'removeBoundary')}</p>
}

export function WorkspaceDialogFooter({
  dialog,
  renameValue,
  operation,
  actions,
  onCancel,
  onComplete,
  t,
}: {
  dialog: WorkspaceDialogState
  renameValue: string
  operation: ActionState
  actions: WorkspaceClientActions
  onCancel: () => void
  onComplete: () => void
  t?: WorkspaceTranslate | undefined
}) {
  const confirm = (): void => {
    if (dialog.kind === 'rename') {
      operation.run(`rename:${dialog.target.workspaceId}`, async () => {
        await actions.rename(dialog.target.workspaceId, renameValue.trim())
        onComplete()
      })
      return
    }
    operation.run(`remove:${dialog.target.workspaceId}`, async () => {
      const result = await actions.remove(dialog.target.workspaceId)
      if (result === 'revoked') onComplete()
    })
  }

  return (
    <>
      <Button variant="outline" onClick={onCancel}>
        {copy(t, 'cancel')}
      </Button>
      <Button
        variant="primary"
        disabled={(dialog.kind === 'rename' && renameValue.trim() === '')
          || operation.pending !== null}
        onClick={confirm}
      >
        {copy(t, dialog.kind === 'rename' ? 'rename' : 'remove')}
      </Button>
    </>
  )
}

export function WorkspaceActionModal({
  dialog,
  operation,
  actions,
  onClose,
  t,
}: {
  dialog: WorkspaceDialogState | null
  operation: ActionState
  actions: WorkspaceClientActions
  onClose: () => void
  t?: WorkspaceTranslate | undefined
}) {
  if (dialog === null) return null
  return (
    <OpenWorkspaceActionModal
      dialog={dialog}
      operation={operation}
      actions={actions}
      onClose={onClose}
      t={t}
    />
  )
}

function OpenWorkspaceActionModal({
  dialog,
  operation,
  actions,
  onClose,
  t,
}: {
  dialog: WorkspaceDialogState
  operation: ActionState
  actions: WorkspaceClientActions
  onClose: () => void
  t?: WorkspaceTranslate | undefined
}) {
  const [renameValue, setRenameValue] = useState(dialog.target.name)
  return (
    <Modal
      open
      onClose={onClose}
      title={workspaceDialogTitle(dialog, t)}
      closeLabel={copy(t, 'close')}
      footer={(
        <WorkspaceDialogFooter
          dialog={dialog}
          renameValue={renameValue}
          operation={operation}
          actions={actions}
          onCancel={onClose}
          onComplete={onClose}
          t={t}
        />
      )}
    >
      <WorkspaceDialogBody
        dialog={dialog}
        renameValue={renameValue}
        onRenameValue={setRenameValue}
        t={t}
      />
      {operation.error !== null && (
        <ActionError
          closeLabel={copy(t, 'close')}
          onClose={() => { operation.clearError() }}
        >
          {operation.error}
        </ActionError>
      )}
    </Modal>
  )
}
