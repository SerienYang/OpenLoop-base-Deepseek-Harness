import { useCallback } from 'react'
import type { RefObject } from 'react'
import {
  IconFolderClose16,
  IconPlusOutline16,
  IconRefreshOutline14,
  Menu,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { MenuEntry } from '@deepseek-ai/dsh-client-ui-primitives'
import type { WorkspaceId } from '@deepseek-ai/dsh-client-runtime/client'
import type { WorkspaceDataProps } from './shared.tsx'
import { ActionError, copy, isBusy, useActionState } from './shared.tsx'

export interface WorkspaceHeroProps extends WorkspaceDataProps {
  readonly open: boolean
  readonly anchorRef?: RefObject<HTMLElement> | undefined
  readonly selectedId?: WorkspaceId | undefined
  readonly onPick: (workspaceId: WorkspaceId) => void
  readonly onClose: () => void
}

export function WorkspaceHero({
  open,
  anchorRef,
  selectedId,
  onPick,
  onClose,
  useGrants,
  actions,
  t,
}: WorkspaceHeroProps) {
  const grants = useGrants(snapshot => snapshot.items)
  const operation = useActionState()
  const getAnchorRect = useCallback(
    () => anchorRef?.current?.getBoundingClientRect() ?? null,
    [anchorRef],
  )

  const authorize = (): void => {
    operation.run('authorize', async () => {
      const workspace = await actions.authorize()
      if (workspace !== 'cancelled' && workspace.state === 'ready') {
        onPick(workspace.workspaceId as WorkspaceId)
      }
    })
  }

  const workspaceItems: MenuEntry[] = grants.map((workspace) => {
    const ready = workspace.state === 'ready'
    return {
      id: workspace.workspaceId,
      label: ready
        ? workspace.name
        : copy(t, 'reauthorize', { name: workspace.name }),
      icon: ready
        ? <IconFolderClose16 size={16} />
        : <IconRefreshOutline14 size={14} />,
      disabled: isBusy(workspace.state) || operation.pending !== null,
    }
  })
  const addItem: MenuEntry = {
    id: '::add-workspace',
    label: copy(t, 'add'),
    icon: <IconPlusOutline16 size={16} />,
    disabled: operation.pending !== null,
  }
  const handleSelect = (id: string): void => {
    onClose()
    if (id === addItem.id) {
      authorize()
      return
    }
    const workspace = grants.find(grant => grant.workspaceId === id)
    if (workspace === undefined || isBusy(workspace.state)) return
    if (workspace.state === 'ready') {
      onPick(workspace.workspaceId as WorkspaceId)
      return
    }
    operation.run(`reauthorize:${workspace.workspaceId}`, async () => {
      const next = await actions.reauthorize(workspace.workspaceId)
      if (next !== 'cancelled' && next.state === 'ready') {
        onPick(next.workspaceId as WorkspaceId)
      }
    })
  }

  return (
    <>
      <Menu
        open={open}
        anchor={null}
        items={grants.length === 0 ? [addItem] : workspaceItems}
        {...grants.length === 0 ? {} : { footer: [addItem] }}
        selectedId={selectedId}
        onSelect={handleSelect}
        onClose={onClose}
        portal
        getAnchorRect={getAnchorRect}
      />
      {open && operation.error !== null && <ActionError>{operation.error}</ActionError>}
    </>
  )
}
