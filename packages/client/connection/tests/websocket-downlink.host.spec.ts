import { once } from 'node:events'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import WebSocket, { type RawData } from 'ws'
import type {
  ApiProxy, HostFrame, MuxFrame, RpcError, RpcRequest, ServerRequest,
} from '@deepseek-ai/dsh-host-apiproxy/api'
import { RpcId } from '@deepseek-ai/dsh-host-apiproxy/api'
import { HOST_EVENTS_PATH, MUX_EVENTS_PATH } from '../src/api-path.ts'
import { WebSocketDownlinks } from '../src/websocket-downlink.ts'

type MuxSource = (signal: AbortSignal) => AsyncIterable<RpcRequest<MuxFrame>>
type HostSource = (signal: AbortSignal) => AsyncIterable<RpcRequest<HostFrame>>

const running: (() => Promise<void>)[] = []

afterEach(async () => {
  await Promise.all(running.splice(0).map(close => close()))
})

function untilAbort(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve()
  return new Promise((resolve) => {
    signal.addEventListener('abort', () => { resolve() }, { once: true })
  })
}

async function * idle<F>(signal: AbortSignal): AsyncGenerator<RpcRequest<F>> {
  await untilAbort(signal)
}

function api(mux: MuxSource, host: HostSource): ApiProxy {
  return {
    events: {
      mux: (_request, signal) => mux(signal),
      host: (_request, signal) => host(signal),
    },
  } as ApiProxy
}

async function serve(downlinks: WebSocketDownlinks): Promise<{
  origin: string
  close: () => Promise<void>
}> {
  const server = createServer()
  server.on('upgrade', (request, socket, head) => {
    const pathname = new URL(request.url ?? '/', 'http://dsh.internal').pathname
    if (pathname === MUX_EVENTS_PATH) downlinks.handleMux(request, socket, head)
    else if (pathname === HOST_EVENTS_PATH) downlinks.handleHost(request, socket, head)
    else socket.destroy()
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port
  return {
    origin: `ws://127.0.0.1:${String(port)}`,
    close: async () => {
      await downlinks.close()
      await new Promise<void>(resolve => server.close(() => { resolve() }))
    },
  }
}

function read(socket: WebSocket): Promise<ServerRequest> {
  return once(socket, 'message').then(([data]) => JSON.parse(String(data)) as ServerRequest)
}

function rawDataText(data: RawData): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8')
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8')
  return data.toString('utf8')
}

async function acceptedSocket(downlinks: WebSocketDownlinks): Promise<WebSocket> {
  const server = (downlinks as unknown as { server: { clients: Set<WebSocket> } }).server
  let accepted: WebSocket | undefined
  await vi.waitFor(() => {
    accepted = server.clients.values().next().value
    expect(accepted).toBeDefined()
  })
  return accepted as WebSocket
}

describe('WebSocket downlinks', () => {
  it('carries mux and host over independent downstream sockets and cancels each source on close', async () => {
    let muxAborted = false
    let hostAborted = false
    const downlinks = new WebSocketDownlinks(api(
      async function * (signal) {
        try {
          yield {
            rpcId: RpcId('mux-1'),
            payload: { type: 'session/subscribed', sessionId: 'session-1' as never, lastSeq: 4 },
          }
          await untilAbort(signal)
        } finally {
          muxAborted = true
        }
      },
      async function * (signal) {
        try {
          yield { rpcId: RpcId('host-1'), payload: { type: 'host/remote-event', event: 'commands/change', args: [] } }
          await untilAbort(signal)
        } finally {
          hostAborted = true
        }
      },
    ))
    const host = await serve(downlinks)
    running.push(host.close)

    const mux = new WebSocket(`${host.origin}${MUX_EVENTS_PATH}`)
    const hostSocket = new WebSocket(`${host.origin}${HOST_EVENTS_PATH}`)
    const muxFrame = read(mux)
    const hostFrame = read(hostSocket)
    expect(await muxFrame).toEqual({
      type: 'server-request',
      rpcId: 'mux-1',
      method: 'session/subscribed',
      payload: { type: 'session/subscribed', sessionId: 'session-1', lastSeq: 4 },
    })
    expect(await hostFrame).toEqual({
      type: 'server-request',
      rpcId: 'host-1',
      method: 'host/remote-event',
      payload: { type: 'host/remote-event', event: 'commands/change', args: [] },
    })

    const muxClosed = once(mux, 'close')
    const hostClosed = once(hostSocket, 'close')
    mux.close()
    hostSocket.close()
    await Promise.all([muxClosed, hostClosed])
    await vi.waitFor(() => {
      expect(muxAborted).toBe(true)
      expect(hostAborted).toBe(true)
    })
  })

  it('projects and drops server frames before WebSocket serialization', async () => {
    const projectStreamFrame = vi.fn((frame: MuxFrame | HostFrame) => {
      if (frame.type === 'host/workspace-changed') return undefined
      if (frame.type !== 'host/session-added') return frame
      const { cwd: _cwd, ...projected } = frame
      return projected
    })
    const downlinks = new WebSocketDownlinks(api(
      idle,
      async function * () {
        yield {
          rpcId: RpcId('host-added'),
          payload: {
            type: 'host/session-added',
            sessionId: 'session-1' as never,
            blank: true,
            cwd: '/private/canonical/workspace',
          },
        }
        yield {
          rpcId: RpcId('host-workspace'),
          payload: {
            type: 'host/workspace-changed',
            workspace: {
              workspaceId: 'workspace-1' as never,
              path: '/private/canonical/workspace',
              title: 'Workspace',
              sessionIds: ['session-1' as never],
              createdAt: '2026-01-01T00:00:00.000Z',
              updatedAt: '2026-01-01T00:00:00.000Z',
            },
          },
        }
        yield {
          rpcId: RpcId('host-status'),
          payload: {
            type: 'host/session-status',
            sessionId: 'session-1' as never,
            running: true,
          },
        }
      },
    ), {
      version: 1,
      allows: () => true,
      projectStreamFrame,
    })
    const host = await serve(downlinks)
    running.push(host.close)
    const socket = new WebSocket(`${host.origin}${HOST_EVENTS_PATH}`)
    const messages: ServerRequest[] = []
    socket.on('message', (data) => {
      messages.push(JSON.parse(rawDataText(data)) as ServerRequest)
    })
    await once(socket, 'close')

    expect(messages).toEqual([{
      type: 'server-request',
      rpcId: 'host-added',
      method: 'host/session-added',
      payload: {
        type: 'host/session-added',
        sessionId: 'session-1',
        blank: true,
      },
    }, {
      type: 'server-request',
      rpcId: 'host-status',
      method: 'host/session-status',
      payload: {
        type: 'host/session-status',
        sessionId: 'session-1',
        running: true,
      },
    }])
    expect(projectStreamFrame).toHaveBeenCalledTimes(3)
  })

  it('rejects client messages because upstream remains HTTP', async () => {
    let aborted = false
    const downlinks = new WebSocketDownlinks(api(
      async function * (signal) {
        try {
          await untilAbort(signal)
        } finally {
          aborted = true
        }
      },
      idle,
    ))
    const host = await serve(downlinks)
    running.push(host.close)
    const socket = new WebSocket(`${host.origin}${MUX_EVENTS_PATH}`)
    await once(socket, 'open')
    const closed = once(socket, 'close')
    socket.send('upstream payload')
    const [code, reason] = await closed as [number, Buffer]
    expect(code).toBe(1008)
    expect(String(reason)).toBe('downlink only')
    await vi.waitFor(() => { expect(aborted).toBe(true) })
  })

  it('sends stream/error before closing when a source fails', async () => {
    const downlinks = new WebSocketDownlinks(api(
      async function * () {
        throw new Error('mux source failed')
      },
      idle,
    ))
    const host = await serve(downlinks)
    running.push(host.close)
    const socket = new WebSocket(`${host.origin}${MUX_EVENTS_PATH}`)
    const failure = read(socket)
    const closed = once(socket, 'close')
    expect((await failure).payload).toEqual({
      type: 'stream/error',
      error: { code: 'internal', message: 'Error: mux source failed', details: {} },
    })
    await closed
  })

  it('projects a source failure before WebSocket serialization', async () => {
    const canonicalPath = '/private/canonical/workspace'
    const projectError = vi.fn((_method: string, _error: RpcError): RpcError => ({
      code: 'internal',
      message: 'mux source failed',
      details: { requestedCwd: canonicalPath, retained: 'public detail' },
    }))
    const projectStreamFrame = vi.fn((frame: MuxFrame | HostFrame) => {
      if (frame.type !== 'stream/error') return frame
      const { requestedCwd: _requestedCwd, ...details } = frame.error.details as Record<string, unknown>
      return { ...frame, error: { ...frame.error, details } } as MuxFrame | HostFrame
    })
    const downlinks = new WebSocketDownlinks(api(
      async function * () {
        throw new Error(`mux source failed at ${canonicalPath}`)
      },
      idle,
    ), {
      version: 1,
      allows: () => true,
      projectError,
      projectStreamFrame,
    })
    const host = await serve(downlinks)
    running.push(host.close)
    const socket = new WebSocket(`${host.origin}${MUX_EVENTS_PATH}`)
    const failure = read(socket)
    const closed = once(socket, 'close')
    const payload = (await failure).payload

    expect(payload).toEqual({
      type: 'stream/error',
      error: {
        code: 'internal',
        message: 'mux source failed',
        details: { retained: 'public detail' },
      },
    })
    expect(JSON.stringify(payload)).not.toContain(canonicalPath)
    expect(projectError).toHaveBeenCalledExactlyOnceWith('stream/error', {
      code: 'internal',
      message: `Error: mux source failed at ${canonicalPath}`,
      details: {},
    })
    expect(projectStreamFrame).toHaveBeenCalledExactlyOnceWith({
      type: 'stream/error',
      error: {
        code: 'internal',
        message: 'mux source failed',
        details: { requestedCwd: canonicalPath, retained: 'public detail' },
      },
    })
    await closed
  })

  it('does not send a source failure frame dropped by the WebSocket policy', async () => {
    const projectStreamFrame = vi.fn((frame: MuxFrame | HostFrame) =>
      frame.type === 'stream/error' ? undefined : frame)
    const downlinks = new WebSocketDownlinks(api(
      async function * () {
        throw new Error('mux source failed')
      },
      idle,
    ), {
      version: 1,
      allows: () => true,
      projectStreamFrame,
    })
    const host = await serve(downlinks)
    running.push(host.close)
    const socket = new WebSocket(`${host.origin}${MUX_EVENTS_PATH}`)
    const messages: ServerRequest[] = []
    socket.on('message', (data) => {
      messages.push(JSON.parse(rawDataText(data)) as ServerRequest)
    })
    await once(socket, 'close')

    expect(messages).toEqual([])
    expect(projectStreamFrame).toHaveBeenCalledExactlyOnceWith({
      type: 'stream/error',
      error: { code: 'internal', message: 'Error: mux source failed', details: {} },
    })
  })

  it('aborts the source when an accepted socket reports a transport error', async () => {
    let aborted = false
    const downlinks = new WebSocketDownlinks(api(
      async function * (signal) {
        try {
          await untilAbort(signal)
        } finally {
          aborted = true
        }
      },
      idle,
    ))
    const host = await serve(downlinks)
    running.push(host.close)
    const socket = new WebSocket(`${host.origin}${MUX_EVENTS_PATH}`)
    await once(socket, 'open')
    const accepted = await acceptedSocket(downlinks)
    const closed = once(socket, 'close')
    accepted.emit('error', new Error('transport failed'))
    await closed
    expect(aborted).toBe(true)
  })

  it('drops a source frame that races after the client has closed', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    let finish!: () => void
    const finished = new Promise<void>((resolve) => { finish = resolve })
    let sourceSignal: AbortSignal | undefined
    const downlinks = new WebSocketDownlinks(api(
      async function * (signal) {
        sourceSignal = signal
        try {
          await gate
          yield {
            rpcId: RpcId('late'),
            payload: { type: 'session/subscribed', sessionId: 'session-late' as never, lastSeq: 0 },
          }
        } finally {
          finish()
        }
      },
      idle,
    ))
    const host = await serve(downlinks)
    running.push(host.close)
    const socket = new WebSocket(`${host.origin}${MUX_EVENTS_PATH}`)
    await once(socket, 'open')
    const closed = once(socket, 'close')
    socket.close()
    await closed
    await vi.waitFor(() => { expect(sourceSignal?.aborted).toBe(true) })
    release()
    await finished
  })

  it('contains socket send callback failures and closes the downlink', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const downlinks = new WebSocketDownlinks(api(
      async function * () {
        await gate
        yield {
          rpcId: RpcId('send-failure'),
          payload: { type: 'session/subscribed', sessionId: 'session-send' as never, lastSeq: 0 },
        }
      },
      idle,
    ))
    const host = await serve(downlinks)
    running.push(host.close)
    const socket = new WebSocket(`${host.origin}${MUX_EVENTS_PATH}`)
    await once(socket, 'open')
    const accepted = await acceptedSocket(downlinks)
    const send = vi.spyOn(accepted, 'send').mockImplementation(((
      _data: unknown,
      optionsOrCallback?: unknown,
      callback?: (error?: Error) => void,
    ) => {
      const done = typeof optionsOrCallback === 'function'
        ? optionsOrCallback as (error?: Error) => void
        : callback
      done?.(new Error('socket send failed'))
    }) as WebSocket['send'])
    const closed = once(socket, 'close')
    release()
    await closed
    expect(send).toHaveBeenCalledTimes(2)
    send.mockRestore()
  })

  it('rejects when its acceptor has already closed', async () => {
    const downlinks = new WebSocketDownlinks(api(idle, idle))
    await downlinks.close()
    await expect(downlinks.close()).rejects.toThrow('The server is not running')
  })

  it('waits for source cleanup before teardown resolves', async () => {
    let cleanupStarted!: () => void
    const started = new Promise<void>((resolve) => { cleanupStarted = resolve })
    let releaseCleanup!: () => void
    const cleanupGate = new Promise<void>((resolve) => { releaseCleanup = resolve })
    let cleaned = false
    const downlinks = new WebSocketDownlinks(api(
      async function * (signal) {
        try {
          await untilAbort(signal)
        } finally {
          cleanupStarted()
          await cleanupGate
          cleaned = true
        }
      },
      idle,
    ))
    const host = await serve(downlinks)
    const socket = new WebSocket(`${host.origin}${MUX_EVENTS_PATH}`)
    await once(socket, 'open')
    let closed = false
    const closing = host.close().then(() => { closed = true })
    try {
      await started
      expect(closed).toBe(false)
      releaseCleanup()
      await closing
      expect(cleaned).toBe(true)
    } finally {
      releaseCleanup()
      await closing
    }
  })
})
