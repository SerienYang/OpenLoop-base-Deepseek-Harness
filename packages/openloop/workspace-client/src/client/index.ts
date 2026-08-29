import type { ClientContext, SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import { bindSnapshotSelector } from '@deepseek-ai/dsh-client-web-react'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@openloop/desktop-bridge-client/client'
import { WorkspaceHero } from './WorkspaceHero.tsx'
import { WorkspaceSettings } from './WorkspaceSettings.tsx'
import { WorkspaceSidebar } from './WorkspaceSidebar.tsx'
import { en, zh, type WorkspaceClientKey } from './locales.ts'
import type { WorkspaceClientActions } from './shared.tsx'

export { WorkspaceHero } from './WorkspaceHero.tsx'
export type { WorkspaceHeroProps } from './WorkspaceHero.tsx'
export { WorkspaceSettings } from './WorkspaceSettings.tsx'
export type { WorkspaceSettingsProps } from './WorkspaceSettings.tsx'
export { WorkspaceSidebar } from './WorkspaceSidebar.tsx'
export type { WorkspaceSidebarProps } from './WorkspaceSidebar.tsx'
export type {
  WorkspaceClientActions,
  WorkspaceDataProps,
  WorkspaceGrantListState,
} from './shared.tsx'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    openloopWorkspace: WorkspaceClientKey
  }
}

const NS = 'openloopWorkspace'
export const WORKSPACE_BLOCK_OWNER = '@openloop/workspace-client'

export const inject = [
  'slots',
  'sessions',
  'openloopWorkspaces',
  'conversation',
  'locale',
]

function installComposerGuard(ctx: ClientContext, reason: () => string): () => void {
  const owned = new Set<SessionId>()
  const reconcile = (): void => {
    const sessionSnapshot = ctx.sessions.list.getSnapshot()
    const current = sessionSnapshot.current
    const grants = ctx.openloopWorkspaces.grants.getSnapshot().items
    const active = current === undefined
      ? undefined
      : grants.find(grant => grant.sessionIds.includes(current))

    for (const sessionId of [...owned]) {
      if (sessionId === current && active?.state !== 'ready') continue
      ctx.conversation.blocks.setOwned(sessionId, WORKSPACE_BLOCK_OWNER, undefined)
      owned.delete(sessionId)
    }
    if (current === undefined
      || (active?.state === 'ready' && active.displayPath !== undefined && active.displayPath !== '')) {
      return
    }
    ctx.conversation.blocks.setOwned(
      current,
      WORKSPACE_BLOCK_OWNER,
      { reason: reason() },
    )
    owned.add(current)
  }

  reconcile()
  const stopGrants = ctx.openloopWorkspaces.grants.subscribe(reconcile)
  const stopSessions = ctx.sessions.list.subscribe(reconcile)
  return () => {
    stopGrants()
    stopSessions()
    for (const sessionId of owned) {
      ctx.conversation.blocks.setOwned(sessionId, WORKSPACE_BLOCK_OWNER, undefined)
    }
    owned.clear()
  }
}

export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'openloop-workspace: dictionaries')
  const t = ctx.locale.bind(NS)
  const useGrants = bindSnapshotSelector(ctx.openloopWorkspaces.grants)
  const actions: WorkspaceClientActions = {
    authorize: () => ctx.openloopWorkspaces.authorize(),
    reauthorize: workspaceId => ctx.openloopWorkspaces.reauthorize(workspaceId),
    rename: async (workspaceId, name) => {
      await ctx.openloopWorkspaces.renameWorkspace(workspaceId, name)
    },
    remove: workspaceId => ctx.openloopWorkspaces.revoke(workspaceId),
    reveal: workspaceId => ctx.openloopWorkspaces.reveal(workspaceId),
    startSession: async (workspaceId) => {
      const sessionId = await ctx.openloopWorkspaces.connectWorkspace(workspaceId as never)
      ctx.sessions.open(sessionId)
    },
    openSession: (sessionId) => { ctx.sessions.open(sessionId) },
  }
  const injected = () => ({ useGrants, actions })

  ctx.effect(
    () => installComposerGuard(ctx, () => t('block')),
    'openloop-workspace: composer authority block',
  )
  ctx.slots.inject('sidebar.workspaces', () => ctx.slots.register({
    name: 'sidebar.workspaces',
    inject: injected,
    locale: NS,
  }, WorkspaceSidebar))
  ctx.slots.inject('sidebar.settings', () => ctx.slots.register({
    name: 'sidebar.settings',
    inject: injected,
    locale: NS,
  }, WorkspaceSettings))
  ctx.slots.inject('conversation.hero.workspace', () => ctx.slots.register({
    name: 'conversation.hero.workspace',
    inject: injected,
    locale: NS,
  }, WorkspaceHero))
}
