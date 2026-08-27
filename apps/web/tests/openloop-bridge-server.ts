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

export interface RecordedBridgeCall {
  readonly method: string
  readonly payload: unknown
}

interface AuthenticatedUnixBridgeOptions {
  readonly launchId: string
  readonly secret: Uint8Array
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
  readonly #replacementOpened: Promise<void>
  #resolveReplacementOpened!: () => void
  #resolveReplacement: ((result: 'saved') => void) | undefined

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

  completeCredentialReplacement(): void {
    if (this.#resolveReplacement === undefined) {
      throw new Error('credential replacement sheet is not pending')
    }
    this.configured = true
    this.#resolveReplacement('saved')
    this.#resolveReplacement = undefined
  }

  async close(): Promise<void> {
    const failures: unknown[] = []
    for (const socket of this.#sockets) socket.destroy()
    this.#secret.fill(0)
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
    switch (request.method) {
      case 'describeCredential':
        return {
          configured: this.configured,
          writable: true,
          ...(this.configured ? { source: 'keychain' } : {}),
        }
      case 'openCredentialReplacement':
        this.#resolveReplacementOpened()
        return await new Promise<'saved'>((resolve) => {
          this.#resolveReplacement = resolve
        })
      case 'resolveCredential':
        return null
      case 'getAppInfo':
        return { appVersion: '0.1.0', channel: 'test' }
      case 'getCandidateCredentialHealthPlan':
        return { migrationTransactionId: null, references: [] }
      case 'acknowledgeMainWebviewHealth':
      case '$cancel':
        return null
      default:
        throw new Error(`unexpected fake native bridge method ${request.method}`)
    }
  }
}
