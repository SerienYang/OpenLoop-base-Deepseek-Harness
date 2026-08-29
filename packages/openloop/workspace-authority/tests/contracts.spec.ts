import { describe, expect, expectTypeOf, it } from 'vitest'
import {
  GRANT_STATUSES,
  PERSISTED_GRANT_STATUSES,
  RECOVERY_OUTCOMES,
  TRANSACTION_STAGES,
  type AddWorkspaceTransaction,
  type GrantStatus,
  type PersistedGrantStatus,
  type ReauthorizeWorkspaceTransaction,
  type RevokeWorkspaceTransaction,
  type WorkspaceGrant,
  type WorkspaceGrantView,
  type WorkspaceRecoveryOutcome,
  type WorkspaceTransaction,
} from '../src/types.ts'

describe('Workspace authority contracts', () => {
  it('pins stable grant statuses and keeps Host identity out of browser views', () => {
    expect(GRANT_STATUSES).toEqual([
      'ready',
      'needs-authorization',
      'missing',
      'permission-denied',
      'identity-mismatch',
    ])
    expectTypeOf<GrantStatus>().toEqualTypeOf<
      | 'ready'
      | 'needs-authorization'
      | 'missing'
      | 'permission-denied'
      | 'identity-mismatch'
    >()
    expectTypeOf<keyof WorkspaceGrant>().toEqualTypeOf<
      | 'version'
      | 'generation'
      | 'operationId'
      | 'workspaceId'
      | 'canonicalPath'
      | 'displayPath'
      | 'volumeId'
      | 'fileId'
      | 'status'
      | 'authorizedAt'
    >()
    expect(PERSISTED_GRANT_STATUSES).toEqual([
      ...GRANT_STATUSES,
      'revoking',
      'reauthorizing',
    ])
    expectTypeOf<PersistedGrantStatus>().toEqualTypeOf<
      GrantStatus | 'revoking' | 'reauthorizing'
    >()
    expectTypeOf<WorkspaceGrant['status']>().toEqualTypeOf<PersistedGrantStatus>()
    expectTypeOf<keyof WorkspaceGrantView>().toEqualTypeOf<
      'workspaceId' | 'name' | 'displayPath' | 'state' | 'sessionIds'
    >()
    expectTypeOf<WorkspaceGrantView['sessionIds']>().toEqualTypeOf<
      readonly import('@deepseek-ai/dsh-session').SessionId[]
    >()
    expectTypeOf<WorkspaceGrantView>().not.toHaveProperty('canonicalPath')
    expectTypeOf<WorkspaceGrantView>().not.toHaveProperty('volumeId')
    expectTypeOf<WorkspaceGrantView>().not.toHaveProperty('fileId')
    expectTypeOf<WorkspaceGrantView>().not.toHaveProperty('pendingGrantId')
  })

  it('binds transaction stages to their operation kind', () => {
    expect(TRANSACTION_STAGES).toEqual({
      add: ['prepared', 'registry-committed', 'grant-committed', 'authorization-failed'],
      revoke: ['revoke-prepared', 'registry-deleted', 'grant-deleted'],
      reauthorize: ['reauthorize-prepared', 'grant-committed'],
    })
    expectTypeOf<AddWorkspaceTransaction['stage']>().toEqualTypeOf<
      'prepared' | 'registry-committed' | 'grant-committed' | 'authorization-failed'
    >()
    expectTypeOf<RevokeWorkspaceTransaction['stage']>().toEqualTypeOf<
      'revoke-prepared' | 'registry-deleted' | 'grant-deleted'
    >()
    expectTypeOf<ReauthorizeWorkspaceTransaction['stage']>().toEqualTypeOf<
      'reauthorize-prepared' | 'grant-committed'
    >()
    expectTypeOf<Extract<WorkspaceTransaction, { kind: 'revoke' }>['workspaceId']>()
      .toEqualTypeOf<string>()
  })

  it('pins recovery outcomes without exposing pending grants or paths', () => {
    expect(RECOVERY_OUTCOMES).toEqual([
      'completed',
      'rolled-back',
      'needs-authorization',
      'stale-generation',
    ])
    expectTypeOf<WorkspaceRecoveryOutcome>().toEqualTypeOf<
      | 'completed'
      | 'rolled-back'
      | 'needs-authorization'
      | 'stale-generation'
    >()
  })
})
