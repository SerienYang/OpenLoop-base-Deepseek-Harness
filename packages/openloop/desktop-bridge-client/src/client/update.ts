import {
  createSnapshotStore,
  type SnapshotStore,
} from '@deepseek-ai/dsh-client-runtime/client'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'

export type OpenloopUpdateState =
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

/** Value-safe status returned by the native update coordinator. */
export interface OpenloopUpdateStatus {
  readonly state: OpenloopUpdateState
  readonly updateId?: string
  readonly version?: string
  readonly releaseNotes?: string
  readonly message?: string
  readonly progress?: number
  readonly lastCheckedAt?: number
}

export interface UpdateActionView {
  readonly enabled: boolean
  readonly pending?: boolean
}

/** Stable browser projection consumed by the Openloop shell. */
export interface UpdateView {
  readonly phase: OpenloopUpdateState
  readonly lastCheckedAt?: string
  readonly targetVersion?: string
  readonly releaseNotes?: string
  readonly message?: string
  readonly progress?: number
  readonly actions: {
    readonly check: UpdateActionView
    readonly installAndRestart: UpdateActionView
  }
}

export interface OpenloopUpdateRemote {
  getUpdateStatus(): Promise<RemoteResult<OpenloopUpdateStatus>>
  checkForUpdate(): Promise<RemoteResult<OpenloopUpdateStatus>>
  installUpdateAndRestart(
    updateId: string,
  ): Promise<RemoteResult<'restarting' | 'cancelled'>>
}

export type OpenloopUpdateRemoteSource =
  | OpenloopUpdateRemote
  | (() => Promise<OpenloopUpdateRemote>)

const ACTIVE_INSTALL_STATES = new Set<OpenloopUpdateState>([
  'downloading',
  'verifying',
  'ready-to-install',
  'installing',
  'restarting',
])
const TERMINAL_INSTALL_STATES = new Set<OpenloopUpdateState>([
  'committed',
  'failed',
  'rolled-back',
])

function actions(state: OpenloopUpdateState): UpdateView['actions'] {
  const installing = ACTIVE_INSTALL_STATES.has(state)
  return {
    check: {
      enabled: !installing && state !== 'checking',
      ...(state === 'checking' ? { pending: true } : {}),
    },
    installAndRestart: {
      enabled: state === 'available',
      ...(installing ? { pending: true } : {}),
    },
  }
}

function projectStatus(status: OpenloopUpdateStatus): UpdateView {
  return {
    phase: status.state,
    ...(status.lastCheckedAt === undefined
      ? {}
      : { lastCheckedAt: new Date(status.lastCheckedAt).toISOString() }),
    ...(status.version === undefined ? {} : { targetVersion: status.version }),
    ...(status.releaseNotes === undefined
      ? {}
      : { releaseNotes: status.releaseNotes }),
    ...(status.message === undefined ? {} : { message: status.message }),
    ...(status.progress === undefined
      ? {}
      : { progress: Math.max(0, Math.min(100, status.progress)) }),
    actions: actions(status.state),
  }
}

const INITIAL_UPDATE_VIEW: UpdateView = Object.freeze({
  phase: 'idle',
  actions: Object.freeze({
    check: Object.freeze({ enabled: true }),
    installAndRestart: Object.freeze({ enabled: false }),
  }),
})

/**
 * Browser-side update state backed only by the reviewed Desktop Bridge facade.
 * Opaque native update ids are retained privately and never enter the UI view.
 */
export class OpenloopUpdateService {
  readonly view: SnapshotStore<UpdateView> =
    createSnapshotStore<UpdateView>(INITIAL_UPDATE_VIEW)
  private statusGeneration = 0
  private installGeneration = 0
  private updateId: string | undefined
  private inFlightCheck: Promise<void> | undefined
  private inFlightInstall: Promise<'restarting' | 'cancelled'> | undefined
  private closed: Error | undefined

  constructor(private readonly remoteSource: OpenloopUpdateRemoteSource) {}

  /** Refresh the browser-safe view from the native update coordinator. */
  async refresh(): Promise<void> {
    this.requireOpen()
    if (this.inFlightInstall !== undefined) {
      await this.inFlightInstall.catch(() => {})
      return
    }
    const status = await (this.inFlightCheck
      ?? this.readStatus('status', remote => remote.getUpdateStatus())
    )
    if (status?.state === 'checking') await this.checkForUpdate()
  }

  /** Start or join the current update check. */
  async checkForUpdate(): Promise<void> {
    this.requireOpen()
    if (this.inFlightInstall !== undefined) {
      await this.inFlightInstall.catch(() => {})
      return
    }
    if (this.inFlightCheck !== undefined) {
      await this.inFlightCheck
      return
    }
    const previous = this.view.getSnapshot()
    const {
      message: _message,
      progress: _progress,
      ...stable
    } = previous
    this.view.set({
      ...stable,
      phase: 'checking',
      actions: actions('checking'),
    })
    const check = this.readStatus(
      'check',
      remote => remote.checkForUpdate(),
    ).then(() => {})
    this.inFlightCheck = check
    void check.finally(() => {
      if (this.inFlightCheck === check) this.inFlightCheck = undefined
    }).catch(() => {})
    await check
  }

  /**
   * Install the current update.
   * @returns Whether restart was accepted or the native confirmation was cancelled.
   */
  installUpdateAndRestart(): Promise<'restarting' | 'cancelled'> {
    this.requireOpen()
    if (this.inFlightInstall !== undefined) return this.inFlightInstall
    const updateId = this.updateId
    if (updateId === undefined) {
      return Promise.reject(
        new Error('Openloop update install failed: no current update is available'),
      )
    }
    const operation = Promise.withResolvers<'restarting' | 'cancelled'>()
    this.inFlightInstall = operation.promise
    const generation = ++this.installGeneration
    this.statusGeneration += 1
    const previous = this.view.getSnapshot()
    this.view.set({
      ...previous,
      phase: 'installing',
      actions: actions('installing'),
    })
    void this.performInstall(updateId, previous, generation).then(
      operation.resolve,
      operation.reject,
    )
    void operation.promise.finally(() => {
      if (this.inFlightInstall === operation.promise) {
        this.inFlightInstall = undefined
      }
    }).catch(() => {})
    return operation.promise
  }

  private async performInstall(
    updateId: string,
    previous: UpdateView,
    generation: number,
  ): Promise<'restarting' | 'cancelled'> {
    try {
      const remote = await this.remote()
      const result = await remote.installUpdateAndRestart(updateId)
      if (!result.ok) throw remoteError('install', result.error)
      if (!this.isCurrentInstall(generation)) return result.value
      this.statusGeneration += 1
      if (result.value === 'cancelled') {
        this.view.set(previous)
      } else {
        this.updateId = undefined
        this.view.set({
          ...previous,
          phase: 'restarting',
          actions: actions('restarting'),
        })
      }
      return result.value
    } catch (reason) {
      if (this.isCurrentInstall(generation)) {
        await this.publishInstallFailure(reason, previous, generation)
      }
      throw reason
    }
  }

  /** Dispose this service and suppress all later state publication. */
  close(): void {
    if (this.closed !== undefined) return
    this.closed = new Error('Openloop update service was disposed')
    this.statusGeneration += 1
    this.installGeneration += 1
  }

  private async readStatus(
    operation: string,
    request: (remote: OpenloopUpdateRemote) => Promise<RemoteResult<OpenloopUpdateStatus>>,
  ): Promise<OpenloopUpdateStatus | undefined> {
    this.requireOpen()
    const generation = ++this.statusGeneration
    const previous = this.view.getSnapshot()
    try {
      const remote = await this.remote()
      const result = await request(remote)
      if (!result.ok) throw remoteError(operation, result.error)
      if (!this.isCurrentStatus(generation)) return
      this.updateId = result.value.updateId
      this.view.set(projectStatus(result.value))
      return result.value
    } catch (reason) {
      if (this.isCurrentStatus(generation)) this.publishFailure(reason, previous)
      throw reason
    }
  }

  private publishFailure(reason: unknown, previous: UpdateView): void {
    const error = reason instanceof Error ? reason : new Error(String(reason))
    const { progress: _progress, ...stable } = previous
    this.updateId = undefined
    this.view.set({
      ...stable,
      phase: 'failed',
      message: error.message.replace(/^Openloop update \w+ failed: [^:]+: /u, ''),
      actions: actions('failed'),
    })
  }

  private async publishInstallFailure(
    reason: unknown,
    previous: UpdateView,
    generation: number,
  ): Promise<void> {
    try {
      const remote = await this.remote()
      const result = await remote.getUpdateStatus()
      if (!this.isCurrentInstall(generation)) return
      if (result.ok && TERMINAL_INSTALL_STATES.has(result.value.state)) {
        this.statusGeneration += 1
        this.updateId = result.value.updateId
        this.view.set(projectStatus(result.value))
        return
      }
    } catch {
      // Preserve the original install failure when recovery status cannot be read.
    }
    if (this.isCurrentInstall(generation)) {
      this.statusGeneration += 1
      this.publishFailure(reason, previous)
    }
  }

  private isCurrentStatus(generation: number): boolean {
    return this.closed === undefined && generation === this.statusGeneration
  }

  private isCurrentInstall(generation: number): boolean {
    return this.closed === undefined && generation === this.installGeneration
  }

  private remote(): Promise<OpenloopUpdateRemote> {
    return typeof this.remoteSource === 'function'
      ? this.remoteSource()
      : Promise.resolve(this.remoteSource)
  }

  private requireOpen(): void {
    if (this.closed !== undefined) throw this.closed
  }
}

function remoteError(
  operation: string,
  error: { readonly code: string; readonly message: string },
): Error {
  return new Error(
    `Openloop update ${operation} failed: ${error.code}: ${error.message}`,
  )
}

interface RemoteDeferred {
  readonly promise: Promise<OpenloopUpdateRemote>
  readonly resolve: (value: OpenloopUpdateRemote) => void
  readonly reject: (reason: unknown) => void
}

function remoteDeferred(): RemoteDeferred {
  const value = Promise.withResolvers<OpenloopUpdateRemote>()
  void value.promise.catch(() => {})
  return value
}

/** Generation-aware update Remote binding for Cordis replacement and HMR. */
export class OpenloopUpdateRemoteBinding {
  private current = remoteDeferred()
  private closed: Error | undefined

  wait(): Promise<OpenloopUpdateRemote> {
    return this.closed === undefined
      ? this.current.promise
      : Promise.reject(this.closed)
  }

  publish(remote: OpenloopUpdateRemote): () => void {
    if (this.closed !== undefined) return () => {}
    const generation = this.current
    generation.resolve(remote)
    let active = true
    return () => {
      if (!active || this.closed !== undefined || this.current !== generation) return
      active = false
      this.current = remoteDeferred()
    }
  }

  fail(reason: unknown): void {
    if (this.closed !== undefined) return
    const generation = this.current
    this.current = remoteDeferred()
    generation.reject(reason)
  }

  close(): void {
    if (this.closed !== undefined) return
    this.closed = new Error('Openloop update Remote binding was disposed')
    this.current.reject(this.closed)
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    openloopUpdates: OpenloopUpdateService
  }
}
