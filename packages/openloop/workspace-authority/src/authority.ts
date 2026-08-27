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
  catalogGeneration(): number
  createExpected(
    canonicalPath: string,
    expectedGeneration: number,
  ): Promise<{
    readonly workspaceId: string
    readonly name: string
    readonly created: boolean
    readonly generation: number
  }>
  deleteExpected(
    workspaceId: string,
    expectedGeneration: number,
  ): Promise<{ readonly deleted: boolean; readonly generation: number }>
  markNeedsAuthorization(workspaceId: string): Promise<void>
  has(workspaceId: string): boolean
}

export interface NativeWorkspaceAuthorityPort {
  grantGeneration(): Promise<number>
  beginWorkspaceAuthorization(): Promise<{
    readonly pendingGrantId: string
    readonly canonicalPath: string
  }>
  commitWorkspaceAuthorization(
    pendingGrantId: string,
    workspaceId: string,
    expectedGrantGeneration: number,
  ): Promise<WorkspaceGrantView>
  abortWorkspaceAuthorization(pendingGrantId: string): Promise<void>
  confirmWorkspaceRevoke(workspaceId: string): Promise<'confirmed' | 'cancelled'>
  markGrantRevoking(workspaceId: string, expectedGrantGeneration: number): Promise<number>
  deleteWorkspaceGrant(workspaceId: string, expectedGrantGeneration: number): Promise<number>
  prepareWorkspaceTransaction(input: {
    readonly kind: WorkspaceTransaction['kind']
    readonly workspaceId?: string
    readonly expectedCatalogGeneration: number
    readonly expectedGrantGeneration: number
    readonly stage: WorkspaceTransaction['stage']
  }): Promise<TransactionVersion>
  advanceWorkspaceTransaction(
    operationId: string,
    expectedStage: WorkspaceTransaction['stage'],
    nextStage: WorkspaceTransaction['stage'],
  ): Promise<TransactionVersion>
  abortWorkspaceTransaction(
    operationId: string,
    expectedStage: WorkspaceTransaction['stage'],
  ): Promise<void>
  completeWorkspaceTransaction(
    operationId: string,
    expectedStage: WorkspaceTransaction['stage'],
  ): Promise<void>
}

export class WorkspaceAuthority {
  readonly #registry: WorkspaceRegistryPort
  readonly #native: NativeWorkspaceAuthorityPort
  #operationTail: Promise<void> = Promise.resolve()

  constructor(registry: WorkspaceRegistryPort, native: NativeWorkspaceAuthorityPort) {
    this.#registry = registry
    this.#native = native
  }

  add(): Promise<WorkspaceGrantView> {
    return this.#enqueue(() => this.#add())
  }

  revoke(workspaceId: string): Promise<'revoked' | 'cancelled'> {
    return this.#enqueue(() => this.#revoke(workspaceId))
  }

  reauthorize(workspaceId: string): Promise<WorkspaceGrantView> {
    return this.#enqueue(() => this.#reauthorize(workspaceId))
  }

  async #add(): Promise<WorkspaceGrantView> {
    const expectedCatalogGeneration = this.#registry.catalogGeneration()
    const expectedGrantGeneration = await this.#native.grantGeneration()
    const pending = await this.#native.beginWorkspaceAuthorization()
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
        transaction.stage,
        'registry-committed',
      )
      let view: WorkspaceGrantView
      try {
        view = await this.#native.commitWorkspaceAuthorization(
          pending.pendingGrantId,
          workspace.workspaceId,
          expectedGrantGeneration,
        )
      } catch (error) {
        await this.#registry.markNeedsAuthorization(workspace.workspaceId)
        await this.#native.abortWorkspaceTransaction(
          transaction.operationId,
          transaction.stage,
        )
        throw error
      }
      transaction = await this.#native.advanceWorkspaceTransaction(
        transaction.operationId,
        transaction.stage,
        'grant-committed',
      )
      await this.#native.completeWorkspaceTransaction(
        transaction.operationId,
        transaction.stage,
      )
      return { ...view, name: workspace.name }
    } catch (error) {
      await this.#native.abortWorkspaceAuthorization(pending.pendingGrantId)
      if (transaction !== undefined && transaction.stage === 'prepared') {
        await this.#native.abortWorkspaceTransaction(
          transaction.operationId,
          transaction.stage,
        )
      }
      throw error
    }
  }

  async #revoke(workspaceId: string): Promise<'revoked' | 'cancelled'> {
    if (!this.#registry.has(workspaceId)) return 'revoked'
    if (await this.#native.confirmWorkspaceRevoke(workspaceId) === 'cancelled') {
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
      transaction.stage,
      'registry-deleted',
    )
    await this.#native.deleteWorkspaceGrant(workspaceId, revokingGeneration)
    transaction = await this.#native.advanceWorkspaceTransaction(
      transaction.operationId,
      transaction.stage,
      'grant-deleted',
    )
    await this.#native.completeWorkspaceTransaction(
      transaction.operationId,
      transaction.stage,
    )
    return 'revoked'
  }

  async #reauthorize(workspaceId: string): Promise<WorkspaceGrantView> {
    if (!this.#registry.has(workspaceId)) {
      throw new Error(`cannot reauthorize unknown Workspace ${JSON.stringify(workspaceId)}`)
    }
    const expectedCatalogGeneration = this.#registry.catalogGeneration()
    const expectedGrantGeneration = await this.#native.grantGeneration()
    const pending = await this.#native.beginWorkspaceAuthorization()
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
      )
      transaction = await this.#native.advanceWorkspaceTransaction(
        transaction.operationId,
        transaction.stage,
        'grant-committed',
      )
      await this.#native.completeWorkspaceTransaction(
        transaction.operationId,
        transaction.stage,
      )
      return view
    } catch (error) {
      await this.#native.abortWorkspaceAuthorization(pending.pendingGrantId)
      await this.#native.abortWorkspaceTransaction(
        transaction.operationId,
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
