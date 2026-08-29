import type { RefObject } from 'react'
import {
  Button,
  IconFolderClose16,
  IconPlusOutline16,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { WorkspaceId } from '@deepseek-ai/dsh-client-runtime/client'
import type { WorkspaceDataProps } from './shared.tsx'
import { ActionError, copy, isBusy, useActionState } from './shared.tsx'
import css from './Workspace.module.css'

export interface WorkspaceHeroProps extends WorkspaceDataProps {
  readonly open: boolean
  readonly anchorRef?: RefObject<HTMLElement> | undefined
  readonly selectedId?: WorkspaceId | undefined
  readonly onPick: (workspaceId: WorkspaceId) => void
  readonly onClose: () => void
}

export function WorkspaceHero({
  open,
  selectedId,
  onPick,
  useGrants,
  actions,
  t,
}: WorkspaceHeroProps) {
  const grants = useGrants(snapshot => snapshot.items)
  const operation = useActionState()

  if (!open) return null

  const authorize = (): void => {
    operation.run('authorize', async () => {
      const workspace = await actions.authorize()
      if (workspace !== 'cancelled' && workspace.state === 'ready') {
        onPick(workspace.workspaceId as WorkspaceId)
      }
    })
  }

  return (
    <div className={css.hero}>
      <div className={css.heroTitle}>{copy(t, 'choose')}</div>
      <div className={css.heroList}>
        {grants.map((workspace) => {
          const busy = isBusy(workspace.state)
            || operation.pending === `reauthorize:${workspace.workspaceId}`
          const ready = workspace.state === 'ready'
          return (
            <button
              type="button"
              className={css.heroRow}
              key={workspace.workspaceId}
              aria-label={ready
                ? workspace.name
                : copy(t, 'reauthorize', { name: workspace.name })}
              aria-current={selectedId === workspace.workspaceId ? 'true' : undefined}
              disabled={busy}
              onClick={() => {
                if (ready) {
                  onPick(workspace.workspaceId as WorkspaceId)
                  return
                }
                operation.run(`reauthorize:${workspace.workspaceId}`, async () => {
                  const next = await actions.reauthorize(workspace.workspaceId)
                  if (next !== 'cancelled' && next.state === 'ready') {
                    onPick(next.workspaceId as WorkspaceId)
                  }
                })
              }}
            >
              <IconFolderClose16 size={16} />
              <span className={css.heroName}>{workspace.name}</span>
              <span className={css.status} role={isBusy(workspace.state) ? 'status' : undefined}>
                {workspace.state}
              </span>
            </button>
          )
        })}
      </div>
      <Button
        variant={grants.length === 0 ? 'primary' : 'outline'}
        size="sm"
        icon={<IconPlusOutline16 size={14} />}
        disabled={operation.pending !== null}
        onClick={authorize}
        aria-label={copy(t, 'add')}
      >
        {copy(t, 'add')}
      </Button>
      {operation.error !== null && <ActionError>{operation.error}</ActionError>}
    </div>
  )
}
