import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer, type Server, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  authenticateBridgeResponse,
  decodeBridgeFrame,
  encodeBridgeFrame,
  MAX_BRIDGE_FRAME_BYTES,
  NonceReplayGuard,
  verifyBridgeRequest,
  type AuthenticatedBridgeRequest,
  type BridgeRequest,
} from '@openloop/desktop-bridge-host/test-support'
import type {
  WorkspaceGrantInspection,
  WorkspaceGrantView,
  WorkspaceTransaction,
  WorkspaceTransactionInput,
  WorkspaceTransactionStage,
} from '@openloop/desktop-bridge-host'

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu

export interface RecordedBridgeCall {
  readonly method: string
  readonly payload: unknown
}

export interface FixtureUpdateStatus {
  readonly state:
    | 'idle'
    | 'checking'
    | 'up-to-date'
    | 'available'
    | 'failed'
    | 'downloading'
    | 'verifying'
    | 'ready-to-install'
    | 'installing'
    | 'restarting'
    | 'committed'
    | 'rolled-back'
  readonly updateId?: string
  readonly version?: string
  readonly releaseNotes?: string
  readonly message?: string
  readonly progress?: number
  readonly lastCheckedAt?: number
}

interface AuthenticatedUnixBridgeOptions {
  readonly launchId: string
  readonly secret: Uint8Array
}

interface WorkspaceAuthorizationPlan {
  readonly outcome: 'cancelled' | 'pending'
  readonly pendingGrantId?: string
  readonly canonicalPath?: string
  readonly displayPath?: string
  readonly deferred?: boolean
  released: boolean
  release: ((outcome: 'released' | 'cancelled') => void) | undefined
}

export type WorkspaceAuthorizationInput =
  | { readonly outcome: 'cancelled'; readonly deferred?: boolean }
  | {
    readonly outcome: 'pending'
    readonly canonicalPath: string
    readonly displayPath: string
    readonly deferred?: boolean
  }

export interface WorkspaceAuthorizationControl {
  readonly pendingGrantId: string
  release(): void
}

interface StoredWorkspaceGrant {
  exists: boolean
  readonly workspaceId: string
  readonly canonicalPath: string
  readonly displayPath: string
  generation: number
  operationId: string
  status: WorkspaceGrantView['state']
  effectiveStatus: WorkspaceGrantView['state']
  identityValid: boolean
}

interface BridgeCallWaiter {
  readonly method: string
  readonly count: number
  readonly resolve: () => void
  readonly reject: (error: Error) => void
  readonly timer: NodeJS.Timeout
}

/** Authenticated native-boundary double backed by a real Unix domain socket. */
export class AuthenticatedUnixBridgeServer {
  readonly calls: RecordedBridgeCall[] = []
  readonly socketPath: string
  configured = false

  readonly #directory: string
  readonly #launchId: string
  readonly #secret: Uint8Array
  readonly #nonces = new NonceReplayGuard()
  readonly #server: Server
  readonly #sockets = new Set<Socket>()
  readonly #authorizationQueue: WorkspaceAuthorizationPlan[] = []
  readonly #pendingAuthorizations = new Map<string, WorkspaceAuthorizationPlan>()
  readonly #revokeQueue: Array<'cancelled' | 'confirmed'> = []
  readonly #grants = new Map<string, StoredWorkspaceGrant>()
  readonly #pendingRequestCancels = new Map<string, () => void>()
  readonly #callWaiters = new Set<BridgeCallWaiter>()
  readonly #callRequestIds: string[] = []
  readonly #updateChecks: Array<FixtureUpdateStatus | Error> = []
  readonly #updateInstalls: Array<'cancelled' | 'restarting' | Error> = []
  #credentialBytes: Uint8Array | undefined
  readonly #replacementOpened: Promise<void>
  #resolveReplacementOpened!: () => void
  #resolveReplacement: ((result: 'saved' | 'cancelled') => void) | undefined
  #grantGeneration = 0
  #transaction: WorkspaceTransaction | null = null
  #authorizationSequence = 0
  #updateStatus: FixtureUpdateStatus = { state: 'idle' }

  private constructor(
    directory: string,
    options: AuthenticatedUnixBridgeOptions,
  ) {
    this.#directory = directory
    this.socketPath = join(directory, 'desktop-bridge.sock')
    this.#launchId = options.launchId
    this.#secret = Uint8Array.from(options.secret)
    this.#replacementOpened = new Promise<void>((resolve) => {
      this.#resolveReplacementOpened = resolve
    })
    this.#server = createServer({ allowHalfOpen: true }, (socket) => {
      this.#serve(socket)
    })
  }

  static async start(
    options: AuthenticatedUnixBridgeOptions,
  ): Promise<AuthenticatedUnixBridgeServer> {
    const directory = await mkdtemp(join(tmpdir(), 'openloop-web-bridge-'))
    const bridge = new AuthenticatedUnixBridgeServer(directory, options)
    try {
      await new Promise<void>((resolve, reject) => {
        bridge.#server.once('error', reject)
        bridge.#server.listen(bridge.socketPath, resolve)
      })
      return bridge
    } catch (error) {
      bridge.#secret.fill(0)
      await rm(directory, { recursive: true, force: true })
      throw error
    }
  }

  whenCredentialReplacementOpened(): Promise<void> {
    return this.#replacementOpened
  }

  enqueueWorkspaceAuthorization(
    input: WorkspaceAuthorizationInput,
  ): WorkspaceAuthorizationControl {
    const pendingGrantId = input.outcome === 'pending'
      ? `pending-workspace-${++this.#authorizationSequence}`
      : ''
    const plan: WorkspaceAuthorizationPlan = {
      ...input,
      ...(pendingGrantId === '' ? {} : { pendingGrantId }),
      released: input.deferred !== true,
      release: undefined,
    }
    this.#authorizationQueue.push(plan)
    return {
      pendingGrantId,
      release: () => {
        plan.released = true
        plan.release?.('released')
        plan.release = undefined
      },
    }
  }

  enqueueWorkspaceRevoke(outcome: 'cancelled' | 'confirmed'): void {
    this.#revokeQueue.push(outcome)
  }

  setUpdateStatus(status: FixtureUpdateStatus): void {
    this.#updateStatus = status
  }

  enqueueUpdateCheck(status: FixtureUpdateStatus | Error): void {
    this.#updateChecks.push(status)
  }

  enqueueUpdateInstall(outcome: 'cancelled' | 'restarting' | Error): void {
    this.#updateInstalls.push(outcome)
  }

  setWorkspaceGrantState(
    workspaceId: string,
    state: WorkspaceGrantView['state'] | 'absent',
  ): void {
    const grant = this.#grants.get(workspaceId)
    if (grant === undefined) {
      throw new Error(`cannot set state for unknown fake Workspace grant ${workspaceId}`)
    }
    if (state === 'absent') {
      grant.exists = false
      return
    }
    grant.exists = true
    if (state === 'missing'
      || state === 'permission-denied'
      || state === 'identity-mismatch') {
      grant.effectiveStatus = state
      grant.identityValid = false
      return
    }
    grant.status = state
    grant.effectiveStatus = state === 'revoking' || state === 'reauthorizing'
      ? 'ready'
      : state
    grant.identityValid = true
  }

  workspaceGrantCount(): number {
    return [...this.#grants.values()].filter(grant => grant.exists).length
  }

  workspaceGrantState(workspaceId: string): WorkspaceGrantView['state'] | undefined {
    const grant = this.#grants.get(workspaceId)
    return grant?.exists === true ? grant.effectiveStatus : undefined
  }

  pendingRequestCount(): number {
    return this.#pendingRequestCancels.size
  }

  requestIdForCall(method: string, count = 1): string | undefined {
    let matched = 0
    for (const [index, call] of this.calls.entries()) {
      if (call.method !== method || ++matched !== count) continue
      return this.#callRequestIds[index]
    }
    return undefined
  }

  whenCalled(method: string, count = 1): Promise<void> {
    if (this.calls.filter(call => call.method === method).length >= count) {
      return Promise.resolve()
    }
    return new Promise<void>((resolve, reject) => {
      const waiter: BridgeCallWaiter = {
        method,
        count,
        resolve,
        reject,
        timer: setTimeout(() => {
          this.#callWaiters.delete(waiter)
          reject(new Error(
            `timed out waiting for fake native call ${method} #${count}; saw `
            + this.calls.map(call => call.method).join(', '),
          ))
        }, 10_000),
      }
      this.#callWaiters.add(waiter)
    })
  }

  completeCredentialReplacement(secret?: string): void {
    if (this.#resolveReplacement === undefined) {
      throw new Error('credential replacement sheet is not pending')
    }
    this.#credentialBytes?.fill(0)
    this.#credentialBytes = secret === undefined
      ? undefined
      : new TextEncoder().encode(secret)
    this.configured = true
    this.#resolveReplacement('saved')
    this.#resolveReplacement = undefined
  }

  storedCredentialByteLength(): number {
    return this.#credentialBytes?.byteLength ?? 0
  }

  async close(): Promise<void> {
    const failures: unknown[] = []
    for (const cancel of this.#pendingRequestCancels.values()) cancel()
    this.#pendingRequestCancels.clear()
    this.#resolveReplacement?.('cancelled')
    this.#resolveReplacement = undefined
    for (const waiter of this.#callWaiters) {
      clearTimeout(waiter.timer)
      waiter.reject(new Error('authenticated bridge closed before expected call'))
    }
    this.#callWaiters.clear()
    for (const socket of this.#sockets) socket.destroy()
    this.#secret.fill(0)
    this.#credentialBytes?.fill(0)
    this.#credentialBytes = undefined
    await new Promise<void>((resolve, reject) => {
      this.#server.close((error) => {
        if (error === undefined) resolve()
        else reject(error)
      })
    }).catch((error: unknown) => failures.push(error))
    await rm(this.#directory, { recursive: true, force: true })
      .catch((error: unknown) => failures.push(error))
    if (failures.length > 0) {
      throw new AggregateError(failures, 'authenticated bridge cleanup failed')
    }
  }

  #serve(socket: Socket): void {
    this.#sockets.add(socket)
    const chunks: Buffer[] = []
    let received = 0
    socket.on('data', (chunk: Buffer) => {
      if (received > MAX_BRIDGE_FRAME_BYTES + 4) {
        chunk.fill(0)
        return
      }
      received += chunk.length
      chunks.push(chunk)
      if (received > MAX_BRIDGE_FRAME_BYTES + 4) socket.destroy()
    })
    socket.once('end', () => {
      void this.#respond(socket, chunks, received)
    })
    socket.once('close', () => {
      this.#sockets.delete(socket)
      for (const chunk of chunks) chunk.fill(0)
    })
    socket.on('error', () => {})
  }

  async #respond(socket: Socket, chunks: Buffer[], received: number): Promise<void> {
    let requestFrame: Buffer | undefined
    let responseFrame: Uint8Array | undefined
    let nonce: Buffer | undefined
    try {
      requestFrame = Buffer.concat(chunks, received)
      const decoded = decodeBridgeFrame(requestFrame)
      const request = verifyBridgeRequest(decoded, {
        launchId: this.#launchId,
        secret: this.#secret,
        nonces: this.#nonces,
      })
      nonce = Buffer.from((decoded as AuthenticatedBridgeRequest).nonce, 'hex')
      let result: unknown
      try {
        result = await this.#dispatch(request)
        responseFrame = encodeBridgeFrame(authenticateBridgeResponse({
          version: 1,
          requestId: request.requestId,
          ok: true,
          result,
        }, nonce, this.#secret))
      } catch (error) {
        responseFrame = encodeBridgeFrame(authenticateBridgeResponse({
          version: 1,
          requestId: request.requestId,
          ok: false,
          error: {
            code: 'test-native-error',
            message: error instanceof Error ? error.message : String(error),
          },
        }, nonce, this.#secret))
      }
      const outbound = responseFrame
      if (outbound === undefined) throw new Error('bridge response was not encoded')
      await new Promise<void>((resolve) => {
        socket.end(outbound, resolve)
      })
    } catch {
      socket.destroy()
    } finally {
      requestFrame?.fill(0)
      responseFrame?.fill(0)
      nonce?.fill(0)
    }
  }

  async #dispatch(request: BridgeRequest): Promise<unknown> {
    this.calls.push({ method: request.method, payload: request.payload })
    this.#callRequestIds.push(request.requestId)
    this.#resolveCallWaiters()
    switch (request.method) {
      case 'describeCredential':
        return {
          configured: this.configured,
          writable: true,
          ...(this.configured ? { source: 'keychain' } : {}),
        }
      case 'openCredentialReplacement':
        this.#resolveReplacementOpened()
        return await new Promise<'saved' | 'cancelled'>((resolve) => {
          this.#resolveReplacement = resolve
          this.#pendingRequestCancels.set(request.requestId, () => {
            if (this.#resolveReplacement === resolve) this.#resolveReplacement = undefined
            resolve('cancelled')
          })
        }).finally(() => {
          this.#pendingRequestCancels.delete(request.requestId)
        })
      case 'resolveCredential':
        return this.#credentialBytes === undefined
          ? null
          : { bytes: [...this.#credentialBytes], source: 'keychain' }
      case 'getAppInfo':
        return { appVersion: '0.1.0', channel: 'test' }
      case 'getUpdateStatus':
        return this.#updateStatus
      case 'checkForUpdate': {
        const result = this.#updateChecks.shift()
        if (result === undefined) throw new Error('no fake update check result is queued')
        if (result instanceof Error) throw result
        this.#updateStatus = result
        return result
      }
      case 'installUpdateAndRestart': {
        const updateId = this.#stringField(request.payload, 'updateId')
        if (updateId !== this.#updateStatus.updateId) {
          throw new Error('fake update install used an unknown update id')
        }
        const result = this.#updateInstalls.shift()
        if (result === undefined) throw new Error('no fake update install result is queued')
        if (result instanceof Error) throw result
        if (result === 'restarting') this.#updateStatus = { state: 'restarting' }
        return result
      }
      case 'getCandidateCredentialHealthPlan':
        return { migrationTransactionId: null, references: [] }
      case 'acknowledgeMainWebviewHealth':
        return null
      case 'readWorkspaceTransaction':
        return this.#transaction
      case 'getWorkspaceGrantGeneration':
        return this.#grantGeneration
      case 'inspectWorkspaceGrant':
        return this.#inspectWorkspaceGrant(this.#stringField(request.payload, 'workspaceId'))
      case 'beginWorkspaceAuthorization':
        return await this.#beginWorkspaceAuthorization(request.requestId)
      case 'prepareWorkspaceTransaction':
        return this.#prepareWorkspaceTransaction(request.payload)
      case 'advanceWorkspaceTransaction':
        return this.#advanceWorkspaceTransaction(request.payload)
      case 'completeWorkspaceTransaction':
        this.#finishWorkspaceTransaction(request.payload, 'complete')
        return null
      case 'abortWorkspaceTransaction':
        this.#finishWorkspaceTransaction(request.payload, 'abort')
        return null
      case 'commitWorkspaceAuthorization':
        return this.#commitWorkspaceAuthorization(request.payload)
      case 'abortWorkspaceAuthorization':
        this.#pendingAuthorizations.delete(this.#stringField(request.payload, 'pendingGrantId'))
        return null
      case 'confirmWorkspaceRevoke':
        return this.#revokeQueue.shift()
          ?? (() => { throw new Error('no fake Workspace revoke result is queued') })()
      case 'markWorkspaceGrantRevoking':
        return this.#markWorkspaceGrant(request.payload, 'revoking')
      case 'markWorkspaceGrantReauthorizing':
        return this.#markWorkspaceGrant(request.payload, 'reauthorizing')
      case 'restoreWorkspaceGrantReady':
        return this.#markWorkspaceGrant(request.payload, 'ready')
      case 'markWorkspaceGrantNeedsAuthorization':
        return this.#markWorkspaceGrant(request.payload, 'needs-authorization')
      case 'deleteWorkspaceGrant':
        return this.#deleteWorkspaceGrant(request.payload)
      case 'revealWorkspace':
        this.#stringField(request.payload, 'workspaceId')
        return null
      case '$cancel': {
        const requestId = this.#stringField(request.payload, 'requestId')
        this.#pendingRequestCancels.get(requestId)?.()
        this.#pendingRequestCancels.delete(requestId)
        return null
      }
      default:
        throw new Error(`unexpected fake native bridge method ${request.method}`)
    }
  }

  #resolveCallWaiters(): void {
    for (const waiter of this.#callWaiters) {
      if (this.calls.filter(call => call.method === waiter.method).length < waiter.count) continue
      this.#callWaiters.delete(waiter)
      clearTimeout(waiter.timer)
      waiter.resolve()
    }
  }

  async #beginWorkspaceAuthorization(
    requestId: string,
  ): Promise<
    | { readonly outcome: 'cancelled' }
    | { readonly outcome: 'pending'; readonly pendingGrantId: string; readonly path: string }
  > {
    const plan = this.#authorizationQueue.shift()
    if (plan === undefined) throw new Error('no fake Workspace authorization result is queued')
    if (plan.deferred === true && !plan.released) {
      const outcome = await new Promise<'released' | 'cancelled'>((resolve) => {
        plan.release = resolve
        this.#pendingRequestCancels.set(requestId, () => { resolve('cancelled') })
      }).finally(() => {
        plan.release = undefined
        this.#pendingRequestCancels.delete(requestId)
      })
      if (outcome === 'cancelled') return { outcome: 'cancelled' }
    }
    if (plan.outcome === 'cancelled') return { outcome: 'cancelled' }
    if (plan.pendingGrantId === undefined || plan.canonicalPath === undefined) {
      throw new Error('fake pending Workspace authorization is incomplete')
    }
    this.#pendingAuthorizations.set(plan.pendingGrantId, plan)
    return {
      outcome: 'pending',
      pendingGrantId: plan.pendingGrantId,
      path: plan.canonicalPath,
    }
  }

  #prepareWorkspaceTransaction(payload: unknown): {
    readonly operationId: string
    readonly generation: number
    readonly stage: WorkspaceTransactionStage
  } {
    const record = this.#record(payload)
    const input = record as unknown as WorkspaceTransactionInput
    if (!this.#validInitialTransaction(input)) {
      throw new Error('fake Workspace transaction initial payload is invalid')
    }
    if (this.#transaction !== null) {
      throw new Error('fake Workspace transaction is already pending')
    }
    const operationId = input.operationId ?? randomUUID()
    this.#transaction = {
      version: 1,
      operationId,
      generation: 1,
      kind: input.kind,
      ...(input.workspaceId === undefined ? {} : { workspaceId: input.workspaceId }),
      expectedCatalogGeneration: input.expectedCatalogGeneration,
      expectedGrantGeneration: input.expectedGrantGeneration,
      stage: input.stage,
    } as WorkspaceTransaction
    return this.#transactionVersion()
  }

  #advanceWorkspaceTransaction(payload: unknown): {
    readonly operationId: string
    readonly generation: number
    readonly stage: WorkspaceTransactionStage
  } {
    const input = this.#record(payload)
    const transaction = this.#requireTransaction(input)
    const nextStage = this.#stringField(input, 'nextStage') as WorkspaceTransactionStage
    const requestedWorkspaceId = input.workspaceId === undefined
      ? undefined
      : this.#stringField(input, 'workspaceId')
    if (!this.#validTransactionTransition(transaction.kind, transaction.stage, nextStage)
      || !this.#validWorkspaceBinding(
        transaction,
        nextStage,
        requestedWorkspaceId,
      )) {
      throw new Error('fake Workspace transaction transition is invalid')
    }
    const workspaceId = requestedWorkspaceId ?? transaction.workspaceId
    this.#transaction = {
      ...transaction,
      generation: transaction.generation + 1,
      stage: nextStage,
      ...(workspaceId === undefined ? {} : { workspaceId }),
    } as WorkspaceTransaction
    return this.#transactionVersion()
  }

  #finishWorkspaceTransaction(payload: unknown, finish: 'abort' | 'complete'): void {
    const transaction = this.#requireTransaction(this.#record(payload))
    const valid = finish === 'abort'
      ? this.#validAbortStage(transaction.kind, transaction.stage)
      : this.#validCompleteStage(transaction.kind, transaction.stage)
    if (!valid) throw new Error(`fake Workspace transaction cannot ${finish} from this stage`)
    this.#transaction = null
  }

  #commitWorkspaceAuthorization(payload: unknown): {
    readonly workspaceId: string
    readonly displayPath: string
    readonly state: 'ready'
  } {
    const input = this.#record(payload)
    const pendingGrantId = this.#stringField(input, 'pendingGrantId')
    const workspaceId = this.#stringField(input, 'workspaceId')
    const expectedGrantGeneration = this.#numberField(input, 'expectedGrantGeneration')
    const operationId = this.#stringField(input, 'operationId')
    this.#expectGrantGeneration(expectedGrantGeneration)
    const pending = this.#pendingAuthorizations.get(pendingGrantId)
    if (pending?.canonicalPath === undefined || pending.displayPath === undefined) {
      throw new Error(`unknown fake pending Workspace grant ${pendingGrantId}`)
    }
    if (input.expectedCanonicalPath !== undefined
      && input.expectedCanonicalPath !== pending.canonicalPath) {
      throw new Error('fake Workspace authorization selected a different directory')
    }
    this.#grantGeneration += 1
    this.#grants.set(workspaceId, {
      exists: true,
      workspaceId,
      canonicalPath: pending.canonicalPath,
      displayPath: pending.displayPath,
      generation: this.#grantGeneration,
      operationId,
      status: 'ready',
      effectiveStatus: 'ready',
      identityValid: true,
    })
    this.#pendingAuthorizations.delete(pendingGrantId)
    return { workspaceId, displayPath: pending.displayPath, state: 'ready' }
  }

  #markWorkspaceGrant(payload: unknown, state: 'ready' | 'needs-authorization' | 'revoking' | 'reauthorizing'): number {
    const input = this.#record(payload)
    const workspaceId = this.#stringField(input, 'workspaceId')
    const expectedGrantGeneration = this.#numberField(input, 'expectedGrantGeneration')
    const operationId = this.#stringField(input, 'operationId')
    this.#expectGrantGeneration(expectedGrantGeneration)
    const grant = this.#grants.get(workspaceId)
    if (grant?.exists !== true) throw new Error(`unknown fake Workspace grant ${workspaceId}`)
    this.#grantGeneration += 1
    grant.generation = this.#grantGeneration
    grant.operationId = operationId
    grant.status = state
    grant.effectiveStatus = state === 'revoking' || state === 'reauthorizing'
      ? 'ready'
      : state
    grant.identityValid = state !== 'needs-authorization'
    return this.#grantGeneration
  }

  #deleteWorkspaceGrant(payload: unknown): number {
    const input = this.#record(payload)
    const workspaceId = this.#stringField(input, 'workspaceId')
    const expectedGrantGeneration = this.#numberField(input, 'expectedGrantGeneration')
    this.#expectGrantGeneration(expectedGrantGeneration)
    const grant = this.#grants.get(workspaceId)
    if (grant?.exists !== true) throw new Error(`unknown fake Workspace grant ${workspaceId}`)
    grant.exists = false
    this.#grantGeneration += 1
    return this.#grantGeneration
  }

  #inspectWorkspaceGrant(workspaceId: string): WorkspaceGrantInspection {
    const grant = this.#grants.get(workspaceId)
    if (grant?.exists !== true) return { exists: false, identityValid: false }
    return {
      exists: true,
      generation: grant.generation,
      operationId: grant.operationId,
      identityValid: grant.identityValid,
      displayPath: grant.displayPath,
      status: grant.status,
      effectiveStatus: grant.effectiveStatus,
    }
  }

  #transactionVersion(): {
    readonly operationId: string
    readonly generation: number
    readonly stage: WorkspaceTransactionStage
  } {
    const transaction = this.#transaction
    if (transaction === null) throw new Error('fake Workspace transaction is missing')
    return {
      operationId: transaction.operationId,
      generation: transaction.generation,
      stage: transaction.stage,
    }
  }

  #requireTransaction(input: Record<string, unknown>): WorkspaceTransaction {
    const transaction = this.#transaction
    if (transaction === null) throw new Error('fake Workspace transaction is missing')
    const operationId = this.#stringField(input, 'operationId')
    const expectedGeneration = this.#numberField(input, 'expectedGeneration')
    const expectedStage = this.#stringField(input, 'expectedStage')
    if (transaction.operationId !== operationId
      || transaction.generation !== expectedGeneration
      || transaction.stage !== expectedStage) {
      throw new Error('fake Workspace transaction compare-and-set failed')
    }
    return transaction
  }

  #validInitialTransaction(input: WorkspaceTransactionInput): boolean {
    const workspaceId = input.workspaceId
    if (workspaceId === undefined
      || workspaceId === ''
      || !Number.isSafeInteger(input.expectedCatalogGeneration)
      || input.expectedCatalogGeneration < 0
      || !Number.isSafeInteger(input.expectedGrantGeneration)
      || input.expectedGrantGeneration < 0
      || (input.operationId !== undefined && !UUID_PATTERN.test(input.operationId))) {
      return false
    }
    if (input.kind === 'add') return input.stage === 'prepared'
    if (input.kind === 'revoke') return input.stage === 'revoke-prepared'
    return input.kind === 'reauthorize' && input.stage === 'reauthorize-prepared'
  }

  #validTransactionTransition(
    kind: WorkspaceTransaction['kind'],
    current: WorkspaceTransactionStage,
    next: WorkspaceTransactionStage,
  ): boolean {
    return (kind === 'add' && current === 'prepared' && next === 'registry-committed')
      || (kind === 'add'
        && current === 'registry-committed'
        && (next === 'grant-committed' || next === 'authorization-failed'))
      || (kind === 'revoke'
        && current === 'revoke-prepared'
        && next === 'registry-deleted')
      || (kind === 'revoke'
        && current === 'registry-deleted'
        && next === 'grant-deleted')
      || (kind === 'reauthorize'
        && current === 'reauthorize-prepared'
        && next === 'grant-committed')
  }

  #validWorkspaceBinding(
    transaction: WorkspaceTransaction,
    nextStage: WorkspaceTransactionStage,
    requestedWorkspaceId: string | undefined,
  ): boolean {
    if (transaction.kind === 'add'
      && transaction.stage === 'prepared'
      && nextStage === 'registry-committed') {
      return transaction.workspaceId === undefined
        ? requestedWorkspaceId !== undefined
        : requestedWorkspaceId === undefined
    }
    return requestedWorkspaceId === undefined
  }

  #validAbortStage(
    kind: WorkspaceTransaction['kind'],
    stage: WorkspaceTransactionStage,
  ): boolean {
    return (kind === 'add' && stage === 'prepared')
      || (kind === 'revoke' && stage === 'revoke-prepared')
      || (kind === 'reauthorize' && stage === 'reauthorize-prepared')
  }

  #validCompleteStage(
    kind: WorkspaceTransaction['kind'],
    stage: WorkspaceTransactionStage,
  ): boolean {
    return (kind === 'add'
      && (stage === 'grant-committed' || stage === 'authorization-failed'))
      || (kind === 'revoke' && stage === 'grant-deleted')
      || (kind === 'reauthorize' && stage === 'grant-committed')
  }

  #expectGrantGeneration(expected: number): void {
    if (expected !== this.#grantGeneration) {
      throw new Error(
        `fake Workspace grant generation conflict: expected ${expected}, actual ${this.#grantGeneration}`,
      )
    }
  }

  #record(value: unknown): Record<string, unknown> {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw new TypeError('fake native bridge payload must be an object')
    }
    return value as Record<string, unknown>
  }

  #stringField(value: unknown, field: string): string {
    const record = this.#record(value)
    const result = record[field]
    if (typeof result !== 'string' || result === '') {
      throw new TypeError(`fake native bridge payload requires ${field}`)
    }
    return result
  }

  #numberField(value: unknown, field: string): number {
    const record = this.#record(value)
    const result = record[field]
    if (typeof result !== 'number' || !Number.isSafeInteger(result) || result < 0) {
      throw new TypeError(`fake native bridge payload requires non-negative integer ${field}`)
    }
    return result
  }
}
