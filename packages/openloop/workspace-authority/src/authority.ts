import { randomUUID } from 'node:crypto'
import type {
  TransactionVersion,
  WorkspaceGrantView,
  WorkspaceTransaction,
} from './types.ts'

export class WorkspaceGenerationConflictError extends Error {
  constructor(
    readonly store: 'catalog' | 'grant' | 'transaction',
    readonly expected: number,
    readonly actual: number,
  ) {
    super(`${store} generation conflict: expected ${expected}, actual ${actual}`)
    this.name = 'WorkspaceGenerationConflictError'
  }
}

export interface WorkspaceRegistryPort {
  catalogGeneration: () => number
  resolveWorkspaceIdExpected: (
    canonicalPath: string,
    expectedGeneration: number,
  ) => Promise<string>
  createExpected: (
    canonicalPath: string,
    expectedGeneration: number,
    workspaceId: string,
  ) => Promise<{
    readonly workspaceId: string
    readonly name: string
    readonly created: boolean
    readonly generation: number
  }>
  deleteExpected: (
    workspaceId: string,
    expectedGeneration: number,
  ) => Promise<{ readonly deleted: boolean; readonly generation: number }>
  renameExpected: (
    workspaceId: string,
    name: string,
    expectedGeneration: number,
  ) => Promise<{ readonly name: string; readonly generation: number }>
  markNeedsAuthorization: (workspaceId: string) => Promise<void>
  has: (workspaceId: string) => boolean
  get: (workspaceId: string) => {
    readonly name: string
    readonly canonicalPath: string
  } | undefined
}

export interface NativeWorkspaceAuthorityPort {
  grantGeneration: (signal: AbortSignal) => Promise<number>
  inspectWorkspaceGrant: (workspaceId: string, signal: AbortSignal) => Promise<{
    readonly exists: boolean
    readonly generation?: number
    readonly operationId?: string
    readonly identityValid: boolean
    readonly displayPath?: string
    readonly status?: WorkspaceGrantView['state']
    readonly effectiveStatus?: WorkspaceGrantView['state']
  }>
  beginWorkspaceAuthorization: (signal: AbortSignal) => Promise<
    | {
      readonly outcome: 'pending'
      readonly pendingGrantId: string
      readonly canonicalPath: string
    }
    | { readonly outcome: 'cancelled' }
  >
  commitWorkspaceAuthorization: (
    pendingGrantId: string,
    workspaceId: string,
    expectedGrantGeneration: number,
    operationId: string,
    expectedCanonicalPath?: string,
    signal?: AbortSignal,
  ) => Promise<Omit<WorkspaceGrantView, 'name'>>
  abortWorkspaceAuthorization: (pendingGrantId: string, signal: AbortSignal) => Promise<void>
  confirmWorkspaceRevoke: (
    workspaceId: string,
    title: string,
    signal: AbortSignal,
  ) => Promise<'confirmed' | 'cancelled'>
  markGrantRevoking: (
    workspaceId: string,
    expectedGrantGeneration: number,
    operationId: string,
    signal: AbortSignal,
  ) => Promise<number>
  markGrantReauthorizing: (
    workspaceId: string,
    expectedGrantGeneration: number,
    operationId: string,
    signal: AbortSignal,
  ) => Promise<number>
  restoreGrantReady: (
    workspaceId: string,
    expectedGrantGeneration: number,
    operationId: string,
    signal: AbortSignal,
  ) => Promise<number>
  markGrantNeedsAuthorization: (
    workspaceId: string,
    expectedGrantGeneration: number,
    operationId: string,
    signal: AbortSignal,
  ) => Promise<number>
  deleteWorkspaceGrant: (
    workspaceId: string,
    expectedGrantGeneration: number,
    operationId: string,
    signal: AbortSignal,
  ) => Promise<number>
  prepareWorkspaceTransaction: (input: {
    readonly operationId?: string
    readonly kind: WorkspaceTransaction['kind']
    readonly workspaceId?: string
    readonly expectedCatalogGeneration: number
    readonly expectedGrantGeneration: number
    readonly stage: WorkspaceTransaction['stage']
  }, signal: AbortSignal) => Promise<TransactionVersion>
  readWorkspaceTransaction: (
    signal: AbortSignal,
  ) => Promise<WorkspaceTransaction | undefined>
  advanceWorkspaceTransaction: (
    operationId: string,
    expectedGeneration: number,
    expectedStage: WorkspaceTransaction['stage'],
    nextStage: WorkspaceTransaction['stage'],
    signal: AbortSignal,
    workspaceId?: string,
  ) => Promise<TransactionVersion>
  abortWorkspaceTransaction: (
    operationId: string,
    expectedGeneration: number,
    expectedStage: WorkspaceTransaction['stage'],
    signal: AbortSignal,
  ) => Promise<void>
  completeWorkspaceTransaction: (
    operationId: string,
    expectedGeneration: number,
    expectedStage: WorkspaceTransaction['stage'],
    signal: AbortSignal,
  ) => Promise<void>
}

const NEVER_ABORTED = new AbortController().signal
const cleanupSignal = (): AbortSignal => new AbortController().signal

function versionOf(transaction: WorkspaceTransaction): TransactionVersion {
  return {
    operationId: transaction.operationId,
    generation: transaction.generation,
    stage: transaction.stage,
  }
}

function isMatchingPreparedReauthorization(
  transaction: WorkspaceTransaction | undefined,
  workspaceId: string,
  expectedCatalogGeneration: number,
  expectedGrantGeneration: number,
  operationId?: string,
): transaction is Extract<WorkspaceTransaction, { kind: 'reauthorize' }> {
  return transaction?.kind === 'reauthorize'
    && transaction.workspaceId === workspaceId
    && transaction.expectedCatalogGeneration === expectedCatalogGeneration
    && transaction.expectedGrantGeneration === expectedGrantGeneration
    && transaction.stage === 'reauthorize-prepared'
    && (operationId === undefined || transaction.operationId === operationId)
}

export class WorkspaceAuthority {
  readonly #registry: WorkspaceRegistryPort
  readonly #native: NativeWorkspaceAuthorityPort
  #operationTail: Promise<void> = Promise.resolve()

  constructor(registry: WorkspaceRegistryPort, native: NativeWorkspaceAuthorityPort) {
    this.#registry = registry
    this.#native = native
  }

  add(signal: AbortSignal = NEVER_ABORTED): Promise<WorkspaceGrantView | 'cancelled'> {
    return this.#enqueue(() => this.#add(signal))
  }

  revoke(workspaceId: string, signal: AbortSignal = NEVER_ABORTED): Promise<'revoked' | 'cancelled'> {
    return this.#enqueue(() => this.#revoke(workspaceId, signal))
  }

  reauthorize(
    workspaceId: string,
    signal: AbortSignal = NEVER_ABORTED,
  ): Promise<WorkspaceGrantView | 'cancelled'> {
    return this.#enqueue(() => this.#reauthorize(workspaceId, signal))
  }

  rename(
    workspaceId: string,
    name: string,
    signal: AbortSignal = NEVER_ABORTED,
  ): Promise<WorkspaceGrantView> {
    return this.#enqueue(() => this.#rename(workspaceId, name, signal))
  }

  isReady(workspaceId: string, signal: AbortSignal = NEVER_ABORTED): Promise<boolean> {
    return this.#enqueue(() => this.#isReady(workspaceId, signal))
  }

  runIfReady<T>(
    workspaceId: string,
    operation: () => Promise<T>,
    signal: AbortSignal = NEVER_ABORTED,
  ): Promise<
    | { readonly allowed: false }
    | { readonly allowed: true; readonly value: T }
  > {
    return this.#enqueue(async () => {
      if (!await this.#isReady(workspaceId, signal)) return { allowed: false }
      signal.throwIfAborted()
      return { allowed: true, value: await operation() }
    })
  }

  async #isReady(workspaceId: string, signal: AbortSignal): Promise<boolean> {
    signal.throwIfAborted()
    if (!this.#registry.has(workspaceId)) return false
    const grant = await this.#native.inspectWorkspaceGrant(workspaceId, signal)
    signal.throwIfAborted()
    return grant.exists
      && grant.status === 'ready'
      && grant.identityValid
      && grant.effectiveStatus === 'ready'
  }

  async #rename(
    workspaceId: string,
    name: string,
    signal: AbortSignal,
  ): Promise<WorkspaceGrantView> {
    const normalized = name.trim()
    if (normalized === '') throw new Error('Workspace name must be non-blank')
    signal.throwIfAborted()
    if (!this.#registry.has(workspaceId)) {
      throw new Error(`cannot rename unknown Workspace ${JSON.stringify(workspaceId)}`)
    }
    const expectedCatalogGeneration = this.#registry.catalogGeneration()
    const grant = await this.#native.inspectWorkspaceGrant(workspaceId, signal)
    signal.throwIfAborted()
    if (!grant.exists
      || grant.status !== 'ready'
      || !grant.identityValid
      || grant.effectiveStatus !== 'ready'
      || grant.displayPath === undefined) {
      throw new Error(`Workspace ${JSON.stringify(workspaceId)} grant is not ready`)
    }
    const renamed = await this.#registry.renameExpected(
      workspaceId,
      normalized,
      expectedCatalogGeneration,
    )
    return {
      workspaceId,
      name: renamed.name,
      displayPath: grant.displayPath,
      state: 'ready',
    }
  }

  async #add(signal: AbortSignal): Promise<WorkspaceGrantView | 'cancelled'> {
    signal.throwIfAborted()
    const expectedCatalogGeneration = this.#registry.catalogGeneration()
    const expectedGrantGeneration = await this.#native.grantGeneration(signal)
    signal.throwIfAborted()
    const pending = await this.#native.beginWorkspaceAuthorization(signal)
    if (pending.outcome === 'cancelled') return 'cancelled'
    let pendingActive = true
    let transaction: TransactionVersion | undefined
    let workspace: Awaited<ReturnType<WorkspaceRegistryPort['createExpected']>> | undefined
    try {
      signal.throwIfAborted()
      const workspaceId = await this.#registry.resolveWorkspaceIdExpected(
        pending.canonicalPath,
        expectedCatalogGeneration,
      )
      signal.throwIfAborted()
      transaction = await this.#native.prepareWorkspaceTransaction({
        kind: 'add',
        workspaceId,
        expectedCatalogGeneration,
        expectedGrantGeneration,
        stage: 'prepared',
      }, signal)
      signal.throwIfAborted()
      workspace = await this.#registry.createExpected(
        pending.canonicalPath,
        expectedCatalogGeneration,
        workspaceId,
      )
      signal.throwIfAborted()
      transaction = await this.#native.advanceWorkspaceTransaction(
        transaction.operationId,
        transaction.generation,
        transaction.stage,
        'registry-committed',
        signal,
      )
      signal.throwIfAborted()
      let view: Omit<WorkspaceGrantView, 'name'>
      try {
        view = await this.#native.commitWorkspaceAuthorization(
          pending.pendingGrantId,
          workspace.workspaceId,
          expectedGrantGeneration,
          transaction.operationId,
          undefined,
          signal,
        )
        pendingActive = false
        signal.throwIfAborted()
      } catch (error) {
        const cleanup = cleanupSignal()
        const grant = await this.#native.inspectWorkspaceGrant(workspace.workspaceId, cleanup)
        const grantGeneration = await this.#native.grantGeneration(cleanup)
        const ownedGrant = grant.exists
          && grant.operationId === transaction.operationId
          && grant.generation === expectedGrantGeneration + 1
          && grantGeneration === expectedGrantGeneration + 1
        if (ownedGrant
          && grant.status === 'ready'
          && grant.identityValid
          && grant.effectiveStatus === 'ready') {
          pendingActive = false
          if (grant.displayPath === undefined) throw error
          view = {
            workspaceId: workspace.workspaceId,
            displayPath: grant.displayPath,
            state: 'ready',
          }
          transaction = await this.#native.advanceWorkspaceTransaction(
            transaction.operationId,
            transaction.generation,
            transaction.stage,
            'grant-committed',
            cleanup,
          )
          await this.#native.completeWorkspaceTransaction(
            transaction.operationId,
            transaction.generation,
            transaction.stage,
            cleanup,
          )
          if (signal.aborted) signal.throwIfAborted()
          return { ...view, name: workspace.name }
        } else if (ownedGrant) {
          pendingActive = false
          await this.#native.markGrantNeedsAuthorization(
            workspace.workspaceId,
            expectedGrantGeneration + 1,
            transaction.operationId,
            cleanup,
          )
          await this.#registry.markNeedsAuthorization(workspace.workspaceId)
          transaction = await this.#native.advanceWorkspaceTransaction(
            transaction.operationId,
            transaction.generation,
            transaction.stage,
            'authorization-failed',
            cleanup,
          )
          await this.#native.completeWorkspaceTransaction(
            transaction.operationId,
            transaction.generation,
            transaction.stage,
            cleanup,
          )
          throw error
        } else {
          if (grant.exists || grantGeneration !== expectedGrantGeneration) throw error
          await this.#registry.markNeedsAuthorization(workspace.workspaceId)
          transaction = await this.#native.advanceWorkspaceTransaction(
            transaction.operationId,
            transaction.generation,
            transaction.stage,
            'authorization-failed',
            cleanup,
          )
          await this.#native.completeWorkspaceTransaction(
            transaction.operationId,
            transaction.generation,
            transaction.stage,
            cleanup,
          )
          throw error
        }
      }
      transaction = await this.#native.advanceWorkspaceTransaction(
        transaction.operationId,
        transaction.generation,
        transaction.stage,
        'grant-committed',
        signal,
      )
      await this.#native.completeWorkspaceTransaction(
        transaction.operationId,
        transaction.generation,
        transaction.stage,
        signal,
      )
      signal.throwIfAborted()
      return { ...view, name: workspace.name }
    } catch (error) {
      const cleanup = cleanupSignal()
      if (pendingActive) {
        await this.#native.abortWorkspaceAuthorization(pending.pendingGrantId, cleanup)
      }
      if (transaction !== undefined && transaction.stage === 'prepared') {
        if (workspace?.created === true) {
          transaction = await this.#native.advanceWorkspaceTransaction(
            transaction.operationId,
            transaction.generation,
            transaction.stage,
            'registry-committed',
            cleanup,
          )
          await this.#registry.markNeedsAuthorization(workspace.workspaceId)
          transaction = await this.#native.advanceWorkspaceTransaction(
            transaction.operationId,
            transaction.generation,
            transaction.stage,
            'authorization-failed',
            cleanup,
          )
          await this.#native.completeWorkspaceTransaction(
            transaction.operationId,
            transaction.generation,
            transaction.stage,
            cleanup,
          )
        } else {
          await this.#native.abortWorkspaceTransaction(
            transaction.operationId,
            transaction.generation,
            transaction.stage,
            cleanup,
          )
        }
      }
      throw error
    }
  }

  async #revoke(workspaceId: string, signal: AbortSignal): Promise<'revoked' | 'cancelled'> {
    signal.throwIfAborted()
    const workspace = this.#registry.get(workspaceId)
    if (workspace === undefined) return 'revoked'
    if (await this.#native.confirmWorkspaceRevoke(workspaceId, workspace.name, signal)
      === 'cancelled') {
      return 'cancelled'
    }
    signal.throwIfAborted()
    const expectedCatalogGeneration = this.#registry.catalogGeneration()
    const expectedGrantGeneration = await this.#native.grantGeneration(signal)
    signal.throwIfAborted()
    const originalGrant = await this.#native.inspectWorkspaceGrant(workspaceId, signal)
    signal.throwIfAborted()
    let transaction = await this.#native.prepareWorkspaceTransaction({
      kind: 'revoke',
      workspaceId,
      expectedCatalogGeneration,
      expectedGrantGeneration,
      stage: 'revoke-prepared',
    }, signal)
    let revokingGeneration: number | undefined
    let registryDeleted = false
    try {
      signal.throwIfAborted()
      if (originalGrant.exists) {
        revokingGeneration = await this.#native.markGrantRevoking(
          workspaceId,
          expectedGrantGeneration,
          transaction.operationId,
          signal,
        )
      }
      signal.throwIfAborted()
      await this.#registry.deleteExpected(workspaceId, expectedCatalogGeneration)
      registryDeleted = true
      signal.throwIfAborted()
      transaction = await this.#native.advanceWorkspaceTransaction(
        transaction.operationId,
        transaction.generation,
        transaction.stage,
        'registry-deleted',
        signal,
      )
      signal.throwIfAborted()
      if (revokingGeneration !== undefined) {
        await this.#native.deleteWorkspaceGrant(
          workspaceId,
          revokingGeneration,
          transaction.operationId,
          signal,
        )
      }
      signal.throwIfAborted()
      transaction = await this.#native.advanceWorkspaceTransaction(
        transaction.operationId,
        transaction.generation,
        transaction.stage,
        'grant-deleted',
        signal,
      )
      await this.#native.completeWorkspaceTransaction(
        transaction.operationId,
        transaction.generation,
        transaction.stage,
        signal,
      )
      signal.throwIfAborted()
      return 'revoked'
    } catch (error) {
      const cleanup = cleanupSignal()
      if (!registryDeleted) {
        const grant = await this.#native.inspectWorkspaceGrant(workspaceId, cleanup)
        const grantGeneration = await this.#native.grantGeneration(cleanup)
        const ownedFreeze = grant.exists
          && grant.operationId === transaction.operationId
          && grant.generation === expectedGrantGeneration + 1
          && grant.status === 'revoking'
        const untouched = originalGrant.exists
          ? grant.exists
            && grant.generation === expectedGrantGeneration
            && grant.status === originalGrant.status
            && grantGeneration === expectedGrantGeneration
          : !grant.exists && grantGeneration === expectedGrantGeneration
        if (ownedFreeze) {
          const frozenGeneration = grant.generation
          if (grant.identityValid) {
            await this.#native.restoreGrantReady(
              workspaceId,
              frozenGeneration,
              transaction.operationId,
              cleanup,
            )
          } else {
            await this.#native.markGrantNeedsAuthorization(
              workspaceId,
              frozenGeneration,
              transaction.operationId,
              cleanup,
            )
          }
        } else if (!untouched) {
          throw error
        }
        await this.#native.abortWorkspaceTransaction(
          transaction.operationId,
          transaction.generation,
          transaction.stage,
          cleanup,
        )
        throw error
      }

      if (transaction.stage === 'revoke-prepared') {
        transaction = await this.#native.advanceWorkspaceTransaction(
          transaction.operationId,
          transaction.generation,
          transaction.stage,
          'registry-deleted',
          cleanup,
        )
      }
      const grant = await this.#native.inspectWorkspaceGrant(workspaceId, cleanup)
      const grantGeneration = await this.#native.grantGeneration(cleanup)
      if (revokingGeneration === undefined) {
        if (grant.exists || grantGeneration !== expectedGrantGeneration) throw error
      } else if (grant.exists) {
        if (grant.operationId !== transaction.operationId
          || grant.generation !== expectedGrantGeneration + 1
          || grant.status !== 'revoking') {
          throw error
        }
        await this.#native.deleteWorkspaceGrant(
          workspaceId,
          grant.generation,
          transaction.operationId,
          cleanup,
        )
      } else if (grantGeneration !== expectedGrantGeneration + 2) {
        throw error
      }
      if (transaction.stage === 'registry-deleted') {
        transaction = await this.#native.advanceWorkspaceTransaction(
          transaction.operationId,
          transaction.generation,
          transaction.stage,
          'grant-deleted',
          cleanup,
        )
      }
      await this.#native.completeWorkspaceTransaction(
        transaction.operationId,
        transaction.generation,
        transaction.stage,
        cleanup,
      )
      throw error
    }
  }

  async #reauthorize(
    workspaceId: string,
    signal: AbortSignal,
  ): Promise<WorkspaceGrantView | 'cancelled'> {
    signal.throwIfAborted()
    const workspace = this.#registry.get(workspaceId)
    if (workspace === undefined) {
      throw new Error(`cannot reauthorize unknown Workspace ${JSON.stringify(workspaceId)}`)
    }
    const expectedCatalogGeneration = this.#registry.catalogGeneration()
    const expectedGrantGeneration = await this.#native.grantGeneration(signal)
    signal.throwIfAborted()
    const originalGrant = await this.#native.inspectWorkspaceGrant(workspaceId, signal)
    signal.throwIfAborted()
    let transaction: TransactionVersion | undefined
    let reauthorizingGeneration = expectedGrantGeneration
    let pending: Awaited<ReturnType<NativeWorkspaceAuthorityPort['beginWorkspaceAuthorization']>>
    try {
      transaction = await this.#prepareReauthorizationTransaction(
        workspaceId,
        expectedCatalogGeneration,
        expectedGrantGeneration,
        signal,
      )
      signal.throwIfAborted()
      if (originalGrant.exists) {
        reauthorizingGeneration = await this.#markGrantReauthorizing(
          workspaceId,
          expectedCatalogGeneration,
          expectedGrantGeneration,
          transaction,
          signal,
        )
      }
      signal.throwIfAborted()
      pending = await this.#native.beginWorkspaceAuthorization(signal)
      signal.throwIfAborted()
    } catch (error) {
      if (transaction !== undefined) {
        await this.#abortPreparedReauthorization(
          workspaceId,
          originalGrant,
          expectedGrantGeneration,
          transaction,
        )
      }
      throw error
    }
    if (pending.outcome === 'cancelled') {
      await this.#abortPreparedReauthorization(
        workspaceId,
        originalGrant,
        expectedGrantGeneration,
        transaction,
      )
      return 'cancelled'
    }
    try {
      const actualCatalogGeneration = this.#registry.catalogGeneration()
      if (actualCatalogGeneration !== expectedCatalogGeneration) {
        throw new WorkspaceGenerationConflictError(
          'catalog',
          expectedCatalogGeneration,
          actualCatalogGeneration,
        )
      }
      if (!this.#registry.has(workspaceId)) {
        throw new Error('Workspace changed while reauthorization picker was open')
      }
      const view = await this.#native.commitWorkspaceAuthorization(
        pending.pendingGrantId,
        workspaceId,
        reauthorizingGeneration,
        transaction.operationId,
        workspace.canonicalPath,
        signal,
      )
      signal.throwIfAborted()
      transaction = await this.#native.advanceWorkspaceTransaction(
        transaction.operationId,
        transaction.generation,
        transaction.stage,
        'grant-committed',
        signal,
      )
      await this.#native.completeWorkspaceTransaction(
        transaction.operationId,
        transaction.generation,
        transaction.stage,
        signal,
      )
      signal.throwIfAborted()
      return { ...view, name: workspace.name }
    } catch (error) {
      const cleanup = cleanupSignal()
      const grant = await this.#native.inspectWorkspaceGrant(workspaceId, cleanup)
      const grantGeneration = await this.#native.grantGeneration(cleanup)
      const ownedReplacement = grant.exists
        && grant.operationId === transaction.operationId
        && grant.generation === reauthorizingGeneration + 1
        && grantGeneration === reauthorizingGeneration + 1
      if (ownedReplacement
        && grant.status === 'ready'
        && grant.identityValid
        && grant.effectiveStatus === 'ready') {
        transaction = await this.#native.advanceWorkspaceTransaction(
          transaction.operationId,
          transaction.generation,
          transaction.stage,
          'grant-committed',
          cleanup,
        )
        await this.#native.completeWorkspaceTransaction(
          transaction.operationId,
          transaction.generation,
          transaction.stage,
          cleanup,
        )
        if (signal.aborted) signal.throwIfAborted()
        if (grant.displayPath === undefined) throw error
        return {
          workspaceId,
          name: workspace.name,
          displayPath: grant.displayPath,
          state: 'ready',
        }
      }
      await this.#native.abortWorkspaceAuthorization(pending.pendingGrantId, cleanup)
      if (ownedReplacement) {
        await this.#native.markGrantNeedsAuthorization(
          workspaceId,
          reauthorizingGeneration + 1,
          transaction.operationId,
          cleanup,
        )
        transaction = await this.#native.advanceWorkspaceTransaction(
          transaction.operationId,
          transaction.generation,
          transaction.stage,
          'grant-committed',
          cleanup,
        )
        await this.#native.completeWorkspaceTransaction(
          transaction.operationId,
          transaction.generation,
          transaction.stage,
          cleanup,
        )
        throw error
      }
      if (!originalGrant.exists
        && !grant.exists
        && grantGeneration === expectedGrantGeneration) {
        await this.#native.abortWorkspaceTransaction(
          transaction.operationId,
          transaction.generation,
          transaction.stage,
          cleanup,
        )
        throw error
      }
      if (!grant.exists
        || grant.operationId !== transaction.operationId
        || grant.generation !== reauthorizingGeneration
        || grant.status !== 'reauthorizing'
        || grantGeneration !== reauthorizingGeneration) {
        throw error
      }
      if (grant.identityValid) {
        await this.#native.restoreGrantReady(
          workspaceId,
          reauthorizingGeneration,
          transaction.operationId,
          cleanup,
        )
      } else {
        await this.#native.markGrantNeedsAuthorization(
          workspaceId,
          reauthorizingGeneration,
          transaction.operationId,
          cleanup,
        )
      }
      await this.#native.abortWorkspaceTransaction(
        transaction.operationId,
        transaction.generation,
        transaction.stage,
        cleanup,
      )
      throw error
    }
  }

  async #prepareReauthorizationTransaction(
    workspaceId: string,
    expectedCatalogGeneration: number,
    expectedGrantGeneration: number,
    signal: AbortSignal,
  ): Promise<TransactionVersion> {
    const operationId = randomUUID()
    try {
      return await this.#native.prepareWorkspaceTransaction({
        operationId,
        kind: 'reauthorize',
        workspaceId,
        expectedCatalogGeneration,
        expectedGrantGeneration,
        stage: 'reauthorize-prepared',
      }, signal)
    } catch (error) {
      const transaction = await this.#native.readWorkspaceTransaction(cleanupSignal())
      if (!isMatchingPreparedReauthorization(
        transaction,
        workspaceId,
        expectedCatalogGeneration,
        expectedGrantGeneration,
        operationId,
      )) {
        throw error
      }
      return versionOf(transaction)
    }
  }

  async #markGrantReauthorizing(
    workspaceId: string,
    expectedCatalogGeneration: number,
    expectedGrantGeneration: number,
    transaction: TransactionVersion,
    signal: AbortSignal,
  ): Promise<number> {
    try {
      return await this.#native.markGrantReauthorizing(
        workspaceId,
        expectedGrantGeneration,
        transaction.operationId,
        signal,
      )
    } catch (error) {
      const cleanup = cleanupSignal()
      const durable = await this.#native.readWorkspaceTransaction(cleanup)
      const grant = await this.#native.inspectWorkspaceGrant(workspaceId, cleanup)
      const currentGeneration = await this.#native.grantGeneration(cleanup)
      if (isMatchingPreparedReauthorization(
        durable,
        workspaceId,
        expectedCatalogGeneration,
        expectedGrantGeneration,
        transaction.operationId,
      )
        && durable.operationId === transaction.operationId
        && durable.generation === transaction.generation
        && grant.exists
        && grant.operationId === transaction.operationId
        && grant.generation === expectedGrantGeneration + 1
        && grant.status === 'reauthorizing'
        && currentGeneration === expectedGrantGeneration + 1) {
        return expectedGrantGeneration + 1
      }
      throw error
    }
  }

  async #abortPreparedReauthorization(
    workspaceId: string,
    originalGrant: Awaited<ReturnType<NativeWorkspaceAuthorityPort['inspectWorkspaceGrant']>>,
    expectedGrantGeneration: number,
    transaction: TransactionVersion,
  ): Promise<void> {
    const cleanup = cleanupSignal()
    const grant = await this.#native.inspectWorkspaceGrant(workspaceId, cleanup)
    const currentGeneration = await this.#native.grantGeneration(cleanup)
    const ownedFreeze = grant.exists
      && grant.operationId === transaction.operationId
      && grant.generation === expectedGrantGeneration + 1
      && grant.status === 'reauthorizing'
      && currentGeneration === expectedGrantGeneration + 1
    if (ownedFreeze) {
      if (grant.identityValid) {
        await this.#native.restoreGrantReady(
          workspaceId,
          expectedGrantGeneration + 1,
          transaction.operationId,
          cleanup,
        )
      } else {
        await this.#native.markGrantNeedsAuthorization(
          workspaceId,
          expectedGrantGeneration + 1,
          transaction.operationId,
          cleanup,
        )
      }
    } else {
      const originalUntouched = originalGrant.exists
        ? grant.exists
          && grant.operationId === originalGrant.operationId
          && grant.generation === expectedGrantGeneration
          && grant.status === originalGrant.status
          && currentGeneration === expectedGrantGeneration
        : !grant.exists && currentGeneration === expectedGrantGeneration
      if (!originalUntouched) {
        await this.#native.abortWorkspaceTransaction(
          transaction.operationId,
          transaction.generation,
          transaction.stage,
          cleanup,
        )
        return
      }
    }
    await this.#native.abortWorkspaceTransaction(
      transaction.operationId,
      transaction.generation,
      transaction.stage,
      cleanup,
    )
  }

  #enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const current = this.#operationTail.then(operation, operation)
    this.#operationTail = current.then(() => {}, () => {})
    return current
  }
}
