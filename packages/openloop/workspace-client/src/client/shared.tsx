import type {
  SessionId,
  SessionListState,
} from '@deepseek-ai/dsh-client-runtime/client'
import type { SnapshotSelectorHook } from '@deepseek-ai/dsh-client-ui-slots'
import type { WorkspaceGrantView } from '@openloop/desktop-bridge-host/types'
import { en, type WorkspaceClientKey } from './locales.ts'

export interface WorkspaceGrantListState {
  readonly items: readonly WorkspaceGrantView[]
  readonly state: 'idle' | 'loading' | 'error'
  readonly error: Error | null
}

export interface WorkspaceClientActions {
  authorize(): Promise<WorkspaceGrantView | 'cancelled'>
  reauthorize(workspaceId: string): Promise<WorkspaceGrantView | 'cancelled'>
  rename(workspaceId: string, name: string): Promise<void>
  remove(workspaceId: string): Promise<'revoked' | 'cancelled'>
  reveal(workspaceId: string): Promise<void>
  startSession(workspaceId: string): Promise<void>
  openSession(sessionId: SessionId): void
}

export type WorkspaceTranslate = (
  key: WorkspaceClientKey,
  params?: Readonly<Record<string, string>>,
) => string

export interface WorkspaceDataProps {
  useGrants: SnapshotSelectorHook<WorkspaceGrantListState>
  useSessions: SnapshotSelectorHook<SessionListState>
  actions: WorkspaceClientActions
  t?: WorkspaceTranslate | undefined
}

function fallbackTranslate(
  key: WorkspaceClientKey,
  params: Readonly<Record<string, string>> = {},
): string {
  let value: string = en[key]
  for (const [name, replacement] of Object.entries(params)) {
    value = value.replaceAll(`{${name}}`, replacement)
  }
  return value
}

export function copy(
  t: WorkspaceTranslate | undefined,
  key: WorkspaceClientKey,
  params?: Readonly<Record<string, string>>,
): string {
  return (t ?? fallbackTranslate)(key, params)
}

export function isBusy(state: WorkspaceGrantView['state']): boolean {
  return state === 'revoking' || state === 'reauthorizing'
}

export function dotState(state: WorkspaceGrantView['state']) {
  if (state === 'ready') return 'done' as const
  if (isBusy(state)) return 'ongoing' as const
  if (state === 'permission-denied' || state === 'identity-mismatch') return 'error' as const
  return 'warning' as const
}

export function stateLabel(
  t: WorkspaceTranslate | undefined,
  state: WorkspaceGrantView['state'],
): string {
  const keys: Record<WorkspaceGrantView['state'], WorkspaceClientKey> = {
    ready: 'stateReady',
    'needs-authorization': 'stateNeedsAuthorization',
    missing: 'stateMissing',
    'permission-denied': 'statePermissionDenied',
    'identity-mismatch': 'stateIdentityMismatch',
    revoking: 'stateRevoking',
    reauthorizing: 'stateReauthorizing',
  }
  return copy(t, keys[state])
}

export function grantForCurrent(
  grants: readonly WorkspaceGrantView[],
  current: SessionId | undefined,
): WorkspaceGrantView | undefined {
  return current === undefined
    ? undefined
    : grants.find(grant => grant.sessionIds.includes(current))
}
