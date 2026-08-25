import { randomBytes, randomUUID } from 'node:crypto'
import { createConnection, type Socket } from 'node:net'
import type { RuntimeBootstrap } from '@openloop/runtime-bootstrap'
import {
  authenticateBridgeRequest,
  BRIDGE_PROTOCOL_VERSION,
  decodeBridgeFrame,
  encodeBridgeFrame,
  MAX_BRIDGE_FRAME_BYTES,
  verifyBridgeResponse,
  type AuthenticatedBridgeResponse,
  type BridgeRequest,
} from './protocol.ts'

export interface BridgeWireTransport {
  exchange(frame: Uint8Array, signal?: AbortSignal): Promise<Uint8Array>
  close(): void
}

export interface DesktopBridgeClientOptions {
  readonly launchId: string
  readonly secret: Uint8Array
  readonly socketPath?: string
  readonly transport?: BridgeWireTransport
  readonly requestId?: () => string
  readonly nonce?: () => Uint8Array
}

interface ClientSecretState {
  readonly bytes: Uint8Array
  closed: boolean
}

const clientSecrets = new WeakMap<DesktopBridgeClient, ClientSecretState>()

/** Authenticated UDS client retained only by trusted Host plugins. */
export class DesktopBridgeClient {
  readonly #launchId: string
  readonly #transport: BridgeWireTransport
  readonly #requestId: () => string
  readonly #nonce: () => Uint8Array

  constructor(options: DesktopBridgeClientOptions) {
    if (options.launchId.length === 0) throw new TypeError('bridge launch id is required')
    if (options.secret.length < 32) throw new TypeError('bridge secret must contain at least 32 bytes')
    if (options.transport === undefined && options.socketPath === undefined) {
      throw new TypeError('bridge socket path is required')
    }
    this.#launchId = options.launchId
    this.#transport = options.transport ?? new UnixBridgeTransport(
      requiredSocketPath(options.socketPath),
    )
    this.#requestId = options.requestId ?? randomUUID
    this.#nonce = options.nonce ?? (() => randomBytes(32))
    clientSecrets.set(this, {
      bytes: Uint8Array.from(options.secret),
      closed: false,
    })
  }

  async call<Result = unknown>(
    method: string,
    payload: unknown,
    signal?: AbortSignal,
  ): Promise<Result> {
    const state = this.#state()
    if (signal?.aborted === true) throw abortReason(signal)
    const request: BridgeRequest = {
      version: BRIDGE_PROTOCOL_VERSION,
      requestId: this.#requestId(),
      launchId: this.#launchId,
      method,
      payload,
    }
    const nonce = this.#nonce()
    const frame = encodeBridgeFrame(authenticateBridgeRequest(request, nonce, state.bytes))
    let cancel: Promise<void> | undefined
    const onAbort = (): void => {
      cancel = this.#cancel(request.requestId).catch(() => {})
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    try {
      const responseFrame = await this.#transport.exchange(frame, signal)
      const envelope = decodeBridgeFrame(responseFrame) as AuthenticatedBridgeResponse
      const response = verifyBridgeResponse(envelope, {
        requestId: request.requestId,
        nonce,
        secret: state.bytes,
      })
      if (!response.ok) {
        throw new Error(`desktop bridge ${response.error.code}: ${response.error.message}`)
      }
      return response.result as Result
    } catch (error) {
      if (signalAborted(signal)) {
        await cancel
        throw abortReason(signal)
      }
      throw error
    } finally {
      signal?.removeEventListener('abort', onAbort)
    }
  }

  close(): void {
    const state = clientSecrets.get(this)
    if (state === undefined || state.closed) return
    state.closed = true
    state.bytes.fill(0)
    this.#transport.close()
  }

  async #cancel(requestId: string): Promise<void> {
    const state = this.#state()
    const cancellation: BridgeRequest = {
      version: BRIDGE_PROTOCOL_VERSION,
      requestId: this.#requestId(),
      launchId: this.#launchId,
      method: '$cancel',
      payload: { requestId },
    }
    const nonce = this.#nonce()
    const frame = encodeBridgeFrame(authenticateBridgeRequest(cancellation, nonce, state.bytes))
    const responseFrame = await this.#transport.exchange(frame)
    verifyBridgeResponse(
      decodeBridgeFrame(responseFrame),
      { requestId: cancellation.requestId, nonce, secret: state.bytes },
    )
  }

  #state(): ClientSecretState {
    const state = clientSecrets.get(this)
    if (state === undefined || state.closed) throw new Error('desktop bridge client is closed')
    return state
  }
}

export function bridgeClientFromRuntimeBootstrap(runtime: RuntimeBootstrap): DesktopBridgeClient {
  const secret = runtime.consumeBridgeSecret()
  if (secret === undefined) throw new Error('runtime bootstrap bridge secret is missing or consumed')
  try {
    return new DesktopBridgeClient({
      launchId: runtime.getLaunchId(),
      socketPath: runtime.getSocketPath(),
      secret,
    })
  } finally {
    secret.fill(0)
  }
}

class UnixBridgeTransport implements BridgeWireTransport {
  readonly #socketPath: string
  readonly #sockets = new Set<Socket>()
  #closed = false

  constructor(socketPath: string) {
    if (!socketPath.startsWith('/')) throw new TypeError('bridge socket path must be absolute')
    this.#socketPath = socketPath
  }

  exchange(frame: Uint8Array, signal?: AbortSignal): Promise<Uint8Array> {
    if (this.#closed) return Promise.reject(new Error('desktop bridge transport is closed'))
    return new Promise((resolve, reject) => {
      const socket = createConnection({ path: this.#socketPath })
      this.#sockets.add(socket)
      const chunks: Buffer[] = []
      let received = 0
      let expected: number | undefined
      let settled = false
      const finish = (error?: unknown, value?: Uint8Array): void => {
        if (settled) return
        settled = true
        signal?.removeEventListener('abort', onAbort)
        this.#sockets.delete(socket)
        socket.destroy()
        if (error === undefined && value !== undefined) resolve(value)
        else reject(error instanceof Error ? error : new Error('desktop bridge transport failed'))
      }
      const onAbort = (): void => {
        if (signal !== undefined) finish(abortReason(signal))
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      socket.once('connect', () => {
        if (signal?.aborted === true) {
          finish(abortReason(signal))
          return
        }
        socket.end(frame)
      })
      socket.on('data', (chunk: Buffer) => {
        if (settled) return
        received += chunk.length
        if (received > MAX_BRIDGE_FRAME_BYTES + 4) {
          finish(new Error('bridge response frame is oversized'))
          return
        }
        chunks.push(chunk)
        if (expected === undefined && received >= 4) {
          const prefix = Buffer.concat(chunks, Math.min(received, 4))
          const bodyLength = prefix.readUInt32BE(0)
          if (bodyLength === 0 || bodyLength > MAX_BRIDGE_FRAME_BYTES) {
            finish(new Error('bridge response frame is oversized or empty'))
            return
          }
          expected = bodyLength + 4
        }
        if (expected !== undefined && received > expected) {
          finish(new Error('bridge response has trailing bytes'))
        }
      })
      socket.once('end', () => {
        if (expected === undefined || received !== expected) {
          finish(new Error('bridge response frame is truncated'))
          return
        }
        finish(undefined, Buffer.concat(chunks, received))
      })
      socket.once('error', finish)
    })
  }

  close(): void {
    if (this.#closed) return
    this.#closed = true
    for (const socket of this.#sockets) socket.destroy()
    this.#sockets.clear()
  }
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error('desktop bridge call was aborted')
}

function signalAborted(signal: AbortSignal | undefined): signal is AbortSignal {
  return signal?.aborted === true
}

function requiredSocketPath(socketPath: string | undefined): string {
  if (socketPath === undefined) throw new TypeError('bridge socket path is required')
  return socketPath
}
