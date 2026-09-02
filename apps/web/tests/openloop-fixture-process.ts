import {
  spawn,
  type ChildProcessWithoutNullStreams,
} from 'node:child_process'
import type { Readable, Writable } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { createInterface } from 'node:readline'

export interface FixtureReady {
  readonly ready: true
  readonly url: string
  readonly workspaceCwd: string
  readonly activeRows: string[]
}

interface FixtureResponse {
  readonly id: number
  readonly ok: boolean
  readonly value?: unknown
  readonly error?: string
}

export interface FixtureChild {
  readonly stdin: Writable
  readonly stdout: Readable
  readonly stderr: Readable
  readonly exitCode: number | null
  readonly signalCode: NodeJS.Signals | null
  once(event: 'error', listener: (error: Error) => void): this
  once(
    event: 'exit',
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): this
  kill(signal?: NodeJS.Signals): boolean
}

interface FixtureProcessOptions {
  readonly spawnFixture?: () => FixtureChild
  readonly closeTimeoutMs?: number
}

function defaultSpawnFixture(): ChildProcessWithoutNullStreams {
  return spawn(
    process.execPath,
    ['--import', 'tsx/esm', 'apps/web/tests/openloop-minimum-shell-server.ts'],
    {
      cwd: fileURLToPath(new URL('../../..', import.meta.url)),
      env: { ...process.env, DSH_SNAPSHOT: 'replay' },
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  )
}

function exitDescription(code: number | null, signal: NodeJS.Signals | null): string {
  return code === null ? `signal ${String(signal)}` : `exit ${String(code)}`
}

export class FixtureProcess {
  readonly child: FixtureChild
  readonly ready: Promise<FixtureReady>
  readonly #pending = new Map<number, {
    readonly resolve: (value: unknown) => void
    readonly reject: (reason: unknown) => void
  }>()
  readonly #closeTimeoutMs: number
  #sequence = 0
  #stderr = ''

  constructor(options: FixtureProcessOptions = {}) {
    this.child = options.spawnFixture?.() ?? defaultSpawnFixture()
    this.#closeTimeoutMs = options.closeTimeoutMs ?? 15_000
    this.child.stderr.on('data', (chunk: Buffer | string) => {
      this.#stderr = `${this.#stderr}${String(chunk)}`.slice(-64 * 1024)
    })
    this.ready = new Promise<FixtureReady>((resolve, reject) => {
      this.child.once('error', (error) => {
        reject(error)
        this.#rejectPending(error)
      })
      this.child.once('exit', (code, signal) => {
        const error = this.#exitError('Openloop fixture exited', code, signal)
        reject(new Error(error.message.replace('exited', 'exited before ready')))
        this.#rejectPending(error)
      })
      createInterface({ input: this.child.stdout }).on('line', (line) => {
        if (!line.startsWith('OPENLOOP_FIXTURE:')) return
        try {
          const message = JSON.parse(line.slice('OPENLOOP_FIXTURE:'.length)) as
            FixtureReady | FixtureResponse
          if ('ready' in message) {
            resolve(message)
            return
          }
          const pending = this.#pending.get(message.id)
          if (pending === undefined) return
          this.#pending.delete(message.id)
          if (message.ok) pending.resolve(message.value)
          else pending.reject(new Error(message.error ?? 'fixture command failed'))
        } catch (error) {
          const failure = error instanceof Error ? error : new Error(String(error))
          reject(failure)
          this.#rejectPending(failure)
        }
      })
    })
  }

  command(command: string, value?: unknown): Promise<unknown> {
    if (this.child.exitCode !== null || this.child.signalCode !== null) {
      return Promise.reject(this.#exitError(
        'Openloop fixture exited',
        this.child.exitCode,
        this.child.signalCode,
      ))
    }
    const id = ++this.#sequence
    const result = new Promise<unknown>((resolve, reject) => {
      this.#pending.set(id, { resolve, reject })
    })
    this.child.stdin.write(`${JSON.stringify({ id, command, value })}\n`, (error) => {
      if (error === null || error === undefined) return
      const pending = this.#pending.get(id)
      this.#pending.delete(id)
      pending?.reject(error)
    })
    return result
  }

  async close(): Promise<void> {
    if (this.child.exitCode !== null || this.child.signalCode !== null) {
      this.#assertCleanExit(this.child.exitCode, this.child.signalCode)
      return
    }
    const exited = new Promise<readonly [number | null, NodeJS.Signals | null]>((resolve) => {
      this.child.once('exit', (code, signal) => { resolve([code, signal]) })
    })
    this.child.kill('SIGTERM')
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      this.child.kill('SIGKILL')
    }, this.#closeTimeoutMs)
    try {
      const [code, signal] = await exited
      if (timedOut) {
        throw new Error(
          `Openloop fixture did not exit within ${String(this.#closeTimeoutMs)}ms`,
        )
      }
      this.#assertCleanExit(code, signal)
    } finally {
      clearTimeout(timer)
    }
  }

  #assertCleanExit(code: number | null, signal: NodeJS.Signals | null): void {
    if (code === 0) return
    throw this.#exitError('Openloop fixture cleanup failed', code, signal)
  }

  #exitError(
    label: string,
    code: number | null,
    signal: NodeJS.Signals | null,
  ): Error {
    const stderr = this.#stderr.trim()
    return new Error(
      `${label} (${exitDescription(code, signal)})${stderr === '' ? '' : `:\n${stderr}`}`,
    )
  }

  #rejectPending(reason: unknown): void {
    for (const pending of this.#pending.values()) pending.reject(reason)
    this.#pending.clear()
  }
}
