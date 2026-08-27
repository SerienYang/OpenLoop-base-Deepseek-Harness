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
  createExpected: (
    canonicalPath: string,
    expectedGeneration: number,
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
  markNeedsAuthorization: (workspaceId: string) => Promise<void>
  has: (workspaceId: string) => boolean
  get: (workspaceId: string) => {
    readonly name: string
    readonly canonicalPath: string
  } | undefined
}

export interface NativeWorkspaceAuthorityPort {
  grantGeneration: () => Promise<number>
  beginWorkspaceAuthorization: () => Promise<
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
    expectedCanonicalPath?: string,
  ) => Promise<Omit<WorkspaceGrantView, 'name'>>
  abortWorkspaceAuthorization: (pendingGrantId: string) => Promise<void>
  confirmWorkspaceRevoke: (
    workspaceId: string,
    title: string,
  ) => Promise<'confirmed' | 'cancelled'>
  markGrantRevoking: (workspaceId: string, expectedGrantGeneration: number) => Promise<number>
  deleteWorkspaceGrant: (workspaceId: string, expectedGrantGeneration: number) => Promise<number>
  prepareWorkspaceTransaction: (input: {
    readonly kind: WorkspaceTransaction['kind']
    readonly workspaceId?: string
    readonly expectedCatalogGeneration: number
    readonly expectedGrantGeneration: number
    readonly stage: WorkspaceTransaction['stage']
  }) => Promise<TransactionVersion>
  advanceWorkspaceTransaction: (
    operationId: string,
    expectedGeneration: number,
    expectedStage: WorkspaceTransaction['stage'],
    nextStage: WorkspaceTransaction['stage'],
    workspaceId?: string,
  ) => Promise<TransactionVersion>
  abortWorkspaceTransaction: (
    operationId: string,
    expectedGeneration: number,
    expectedStage: WorkspaceTransaction['stage'],
  ) => Promise<void>
  completeWorkspaceTransaction: (
    operationId: string,
    expectedGeneration: number,
    expectedStage: WorkspaceTransaction['stage'],
  ) => Promise<void>
}

export class WorkspaceAuthority {
  readonly #registry: WorkspaceRegistryPort
  readonly #native: NativeWorkspaceAuthorityPort
  #operationTail: Promise<void> = Promise.resolve()

  constructor(registry: WorkspaceRegistryPort, native: NativeWorkspaceAuthorityPort) {
    this.#registry = registry
    this.#native = native
  }

  add(): Promise<WorkspaceGrantView | 'cancelled'> {
    return this.#enqueue(() => this.#add())
  }

  revoke(workspaceId: string): Promise<'revoked' | 'cancelled'> {
    return this.#enqueue(() => this.#revoke(workspaceId))
  }

  reauthorize(workspaceId: string): Promise<WorkspaceGrantView | 'cancelled'> {
    return this.#enqueue(() => this.#reauthorize(workspaceId))
  }

  async #add(): Promise<WorkspaceGrantView | 'cancelled'> {
    const expectedCatalogGeneration = this.#registry.catalogGeneration()
    const expectedGrantGeneration = await this.#native.grantGeneration()
    const pending = await this.#native.beginWorkspaceAuthorization()
    if (pending.outcome === 'cancelled') return 'cancelled'
    let transaction: TransactionVersion | undefined
    try {
      transaction = await this.#native.prepareWorkspaceTransaction({
        kind: 'add',
        expectedCatalogGeneration,
        expectedGrantGeneration,
        stage: 'prepared',
      })
      const workspace = await this.#registry.createExpected(
        pending.canonicalPath,
        expectedCatalogGeneration,
      )
      transaction = await this.#native.advanceWorkspaceTransaction(
        transaction.operationId,
        transaction.generation,
        transaction.stage,
        'registry-committed',
        workspace.workspaceId,
      )
      let view: Omit<WorkspaceGrantView, 'name'>
      try {
        view = await this.#native.commitWorkspaceAuthorization(
          pending.pendingGrantId,
          workspace.workspaceId,
          expectedGrantGeneration,
        )
      } catch (error) {
        await this.#registry.markNeedsAuthorization(workspace.workspaceId)
        transaction = await this.#native.advanceWorkspaceTransaction(
          transaction.operationId,
          transaction.generation,
          transaction.stage,
          'authorization-failed',
        )
        await this.#native.completeWorkspaceTransaction(
          transaction.operationId,
          transaction.generation,
          transaction.stage,
        )
        throw error
      }
      transaction = await this.#native.advanceWorkspaceTransaction(
        transaction.operationId,
        transaction.generation,
        transaction.stage,
        'grant-committed',
      )
      await this.#native.completeWorkspaceTransaction(
        transaction.operationId,
        transaction.generation,
        transaction.stage,
      )
      return { ...view, name: workspace.name }
    } catch (error) {
      await this.#native.abortWorkspaceAuthorization(pending.pendingGrantId)
      if (transaction !== undefined && transaction.stage === 'prepared') {
        await this.#native.abortWorkspaceTransaction(
          transaction.operationId,
          transaction.generation,
          transaction.stage,
        )
      }
      throw error
    }
  }

  async #revoke(workspaceId: string): Promise<'revoked' | 'cancelled'> {
    const workspace = this.#registry.get(workspaceId)
    if (workspace === undefined) return 'revoked'
    if (await this.#native.confirmWorkspaceRevoke(workspaceId, workspace.name) === 'cancelled') {
      return 'cancelled'
    }
    const expectedCatalogGeneration = this.#registry.catalogGeneration()
    const expectedGrantGeneration = await this.#native.grantGeneration()
    let transaction = await this.#native.prepareWorkspaceTransaction({
      kind: 'revoke',
      workspaceId,
      expectedCatalogGeneration,
      expectedGrantGeneration,
      stage: 'revoke-prepared',
    })
    const revokingGeneration = await this.#native.markGrantRevoking(
      workspaceId,
      expectedGrantGeneration,
    )
    await this.#registry.deleteExpected(workspaceId, expectedCatalogGeneration)
    transaction = await this.#native.advanceWorkspaceTransaction(
      transaction.operationId,
      transaction.generation,
      transaction.stage,
      'registry-deleted',
    )
    await this.#native.deleteWorkspaceGrant(workspaceId, revokingGeneration)
    transaction = await this.#native.advanceWorkspaceTransaction(
      transaction.operationId,
      transaction.generation,
      transaction.stage,
      'grant-deleted',
    )
    await this.#native.completeWorkspaceTransaction(
      transaction.operationId,
      transaction.generation,
      transaction.stage,
    )
    return 'revoked'
  }

  async #reauthorize(workspaceId: string): Promise<WorkspaceGrantView | 'cancelled'> {
    const workspace = this.#registry.get(workspaceId)
    if (workspace === undefined) {
      throw new Error(`cannot reauthorize unknown Workspace ${JSON.stringify(workspaceId)}`)
    }
    const expectedCatalogGeneration = this.#registry.catalogGeneration()
    const expectedGrantGeneration = await this.#native.grantGeneration()
    const pending = await this.#native.beginWorkspaceAuthorization()
    if (pending.outcome === 'cancelled') return 'cancelled'
    let transaction = await this.#native.prepareWorkspaceTransaction({
      kind: 'reauthorize',
      workspaceId,
      expectedCatalogGeneration,
      expectedGrantGeneration,
      stage: 'reauthorize-prepared',
    })
    try {
      const view = await this.#native.commitWorkspaceAuthorization(
        pending.pendingGrantId,
        workspaceId,
        expectedGrantGeneration,
        workspace.canonicalPath,
      )
      transaction = await this.#native.advanceWorkspaceTransaction(
        transaction.operationId,
        transaction.generation,
        transaction.stage,
        'grant-committed',
      )
      await this.#native.completeWorkspaceTransaction(
        transaction.operationId,
        transaction.generation,
        transaction.stage,
      )
      return { ...view, name: workspace.name }
    } catch (error) {
      await this.#native.abortWorkspaceAuthorization(pending.pendingGrantId)
      await this.#native.abortWorkspaceTransaction(
        transaction.operationId,
        transaction.generation,
        transaction.stage,
      )
      throw error
    }
  }

  #enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const current = this.#operationTail.then(operation, operation)
    this.#operationTail = current.then(() => {}, () => {})
    return current
  }
}
