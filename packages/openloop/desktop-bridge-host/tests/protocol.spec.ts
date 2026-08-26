import { mkdtempSync, rmSync } from 'node:fs'
import { createServer, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { remoteMethods } from '@deepseek-ai/dsh-typert-protocol'
import { installRuntimeBootstrap } from '@openloop/runtime-bootstrap'
import { describe, expect, it, vi } from 'vitest'
import OpenloopBrowserApiPolicyService from '../src/index.ts'
import {
  DesktopBridgeClient,
  type BridgeWireTransport,
} from '../src/client.ts'
import {
  authenticateBridgeRequest,
  authenticateBridgeResponse,
  type AuthenticatedBridgeRequest,
  canonicalRequestBytes,
  decodeBridgeFrame,
  encodeBridgeFrame,
  NonceReplayGuard,
  verifyBridgeRequest,
  verifyBridgeResponse,
} from '../src/protocol.ts'
import * as bridgeProtocol from '../src/protocol.ts'
import {
  BROWSER_SAFE_METHODS,
  dispatchBridgeRequest,
  HOST_ONLY_METHODS,
  OpenloopDesktopRemoteService,
} from '../src/remote.ts'

const launchId = '8f5d7e17-9b2b-4b2c-9c2a-1f3e6b2a4d90'
const secret = Uint8Array.from({ length: 32 }, (_, index) => index)
const nonce = Uint8Array.from({ length: 32 }, (_, index) => index)
const request = {
  version: 1 as const,
  requestId: 'request-1',
  launchId,
  method: 'getAppInfo',
  payload: { z: 1, a: [true, null] },
}

function sequencedNonce(sequence: bigint, fill = 0): Uint8Array {
  const value = Buffer.alloc(32, fill)
  value.writeBigUInt64BE(sequence)
  return value
}

describe('authenticated desktop bridge protocol', () => {
  it('uses one exact canonical byte representation and HMAC-SHA256 vector', () => {
    const canonical = canonicalRequestBytes(request, nonce)
    expect(Buffer.from(canonical).toString('hex')).toBe(
      '6f70656e6c6f6f702e6272696467652e726571756573742e763100'
      + '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f'
      + '0000000100000009726571756573742d310000002438663564376531372d396232'
      + '622d346232632d396332612d3166336536623261346439300000000a6765744170'
      + '70496e666f000000177b2261223a5b747275652c6e756c6c5d2c227a223a317d',
    )
    expect(authenticateBridgeRequest(request, nonce, secret).mac).toBe(
      '67238dc6350b46df3b5a3f7acd3212bdd770a086890fb7cd143d4afa3dd23166',
    )
  })

  it('orders non-BMP and BMP object keys by UTF-8 bytes for cross-language HMACs', () => {
    const unicodeOrderingRequest = {
      ...request,
      payload: { '\u{10000}': 1, '\uE000': 2 },
    }
    const canonical = canonicalRequestBytes(unicodeOrderingRequest, nonce)

    expect(Buffer.from(canonical).toString('hex')).toBe(
      '6f70656e6c6f6f702e6272696467652e726571756573742e763100'
      + '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f'
      + '0000000100000009726571756573742d310000002438663564376531372d396232'
      + '622d346232632d396332612d3166336536623261346439300000000a6765744170'
      + '70496e666f000000127b22ee8080223a322c22f0908080223a317d',
    )
    expect(authenticateBridgeRequest(unicodeOrderingRequest, nonce, secret).mac).toBe(
      '95f4c2f387f68c690a4afb58ae051e3372a2ea8142fbb4d0a0f505be3ee5351f',
    )
  })

  it('zeroizes canonical request bytes after HMAC signing', () => {
    const sensitiveRequest = {
      ...request,
      payload: { credential: 'request-buffer-secret' },
    }
    const canonical = canonicalRequestBytes(sensitiveRequest, nonce)
    const canonicalLength = canonical.length
    canonical.fill(0)
    const fill = vi.spyOn(Buffer.prototype, 'fill')
    let wipedCanonical: Buffer | undefined
    try {
      authenticateBridgeRequest(sensitiveRequest, nonce, secret)
      wipedCanonical = fill.mock.contexts.find(
        (value): value is Buffer => Buffer.isBuffer(value) && value.length === canonicalLength,
      )
    } finally {
      fill.mockRestore()
    }

    expect(wipedCanonical).toBeDefined()
    expect([...wipedCanonical!]).toEqual(new Array(canonicalLength).fill(0))
  })

  it('zeroizes canonical response bytes after failed HMAC verification', () => {
    const response = authenticateBridgeResponse({
      version: 1,
      requestId: 'response-hmac-failure',
      ok: true,
      result: 'response-buffer-secret',
    }, nonce, secret)
    const fill = vi.spyOn(Buffer.prototype, 'fill')
    let wipedCanonical: Buffer | undefined
    try {
      expect(() => verifyBridgeResponse(
        { ...response, mac: '00'.repeat(32) },
        { requestId: response.response.requestId, nonce, secret },
      )).toThrow(/authentication/)
      wipedCanonical = fill.mock.contexts.find(
        (value): value is Buffer => Buffer.isBuffer(value) && value.length > 64,
      )
    } finally {
      fill.mockRestore()
    }

    expect(wipedCanonical).toBeDefined()
    expect([...wipedCanonical!]).toEqual(new Array(wipedCanonical!.length).fill(0))
  })

  it('zeroizes every response field buffer after successful HMAC signing', () => {
    const inputs: Array<readonly Uint8Array[]> = []
    const originalConcat = Buffer.concat.bind(Buffer)
    const concat = vi.spyOn(Buffer, 'concat').mockImplementation((
      list: readonly Uint8Array[],
      totalLength?: number,
    ) => {
      inputs.push([...list])
      return originalConcat(list, totalLength)
    })
    try {
      authenticateBridgeResponse({
        version: 1,
        requestId: 'response-field-success',
        ok: true,
        result: 'response-field-secret',
      }, nonce, secret)
    } finally {
      concat.mockRestore()
    }

    const canonicalParts = inputs.find(parts =>
      parts.length === 5
      && Buffer.from(parts[0]!).toString('utf8') === 'openloop.bridge.response.v1\0')
    expect(canonicalParts).toBeDefined()
    for (const part of canonicalParts?.slice(2) ?? []) {
      expect([...part]).toEqual(new Array(part.length).fill(0))
    }
  })

  it('zeroizes every response field buffer after failed HMAC verification', () => {
    const response = authenticateBridgeResponse({
      version: 1,
      requestId: 'response-field-failure',
      ok: true,
      result: 'response-field-secret',
    }, nonce, secret)
    const inputs: Array<readonly Uint8Array[]> = []
    const originalConcat = Buffer.concat.bind(Buffer)
    const concat = vi.spyOn(Buffer, 'concat').mockImplementation((
      list: readonly Uint8Array[],
      totalLength?: number,
    ) => {
      inputs.push([...list])
      return originalConcat(list, totalLength)
    })
    try {
      expect(() => verifyBridgeResponse(
        { ...response, mac: '00'.repeat(32) },
        { requestId: response.response.requestId, nonce, secret },
      )).toThrow(/authentication/)
    } finally {
      concat.mockRestore()
    }

    const canonicalParts = inputs.find(parts =>
      parts.length === 5
      && Buffer.from(parts[0]!).toString('utf8') === 'openloop.bridge.response.v1\0')
    expect(canonicalParts).toBeDefined()
    for (const part of canonicalParts?.slice(2) ?? []) {
      expect([...part]).toEqual(new Array(part.length).fill(0))
    }
  })

  it('zeroizes temporary body and header buffers after frame encoding', () => {
    const inputs: Array<readonly Uint8Array[]> = []
    const originalConcat = Buffer.concat.bind(Buffer)
    const concat = vi.spyOn(Buffer, 'concat').mockImplementation((
      list: readonly Uint8Array[],
      totalLength?: number,
    ) => {
      inputs.push([...list])
      return originalConcat(list, totalLength)
    })
    let frame: Uint8Array
    try {
      frame = encodeBridgeFrame({ credential: 'encoded-frame-secret' })
    } finally {
      concat.mockRestore()
    }

    const encodedParts = inputs.at(-1)
    expect(Buffer.from(frame!).includes(Buffer.from('encoded-frame-secret'))).toBe(true)
    expect(encodedParts).toHaveLength(2)
    for (const part of encodedParts ?? []) {
      expect([...part]).toEqual(new Array(part.length).fill(0))
    }
  })

  it('rejects a wrong version before dispatch', () => {
    const handler = vi.fn()
    const envelope = authenticateBridgeRequest(request, nonce, secret)
    const wrongVersion = {
      ...envelope,
      request: { ...envelope.request, version: 2 },
    }

    expect(() => verifyBridgeRequest(
      wrongVersion,
      { launchId, secret, nonces: new NonceReplayGuard() },
    )).toThrow(/version/)
    expect(handler).not.toHaveBeenCalled()
  })

  it('rejects a wrong HMAC before dispatch', () => {
    const handler = vi.fn()
    const envelope = authenticateBridgeRequest(request, nonce, secret)

    expect(() => verifyBridgeRequest(
      { ...envelope, mac: '00'.repeat(32) },
      { launchId, secret, nonces: new NonceReplayGuard() },
    )).toThrow(/authentication/)
    expect(handler).not.toHaveBeenCalled()
  })

  it('rejects a launch id from another supervised launch before dispatch', () => {
    const handler = vi.fn()
    const envelope = authenticateBridgeRequest(
      { ...request, launchId: '7f5d7e17-9b2b-4b2c-9c2a-1f3e6b2a4d90' },
      nonce,
      secret,
    )

    expect(() => verifyBridgeRequest(
      envelope,
      { launchId, secret, nonces: new NonceReplayGuard() },
    )).toThrow(/launch/)
    expect(handler).not.toHaveBeenCalled()
  })

  it('claims a nonce atomically and rejects replay before dispatch', () => {
    const handler = vi.fn()
    const nonces = new NonceReplayGuard()
    const envelope = authenticateBridgeRequest(request, nonce, secret)

    expect(verifyBridgeRequest(envelope, { launchId, secret, nonces })).toEqual(request)
    expect(() => verifyBridgeRequest(envelope, { launchId, secret, nonces })).toThrow(/replay/)
    expect(handler).not.toHaveBeenCalled()
  })

  it('keeps accepting monotonic nonces after the replay window fills without re-admitting old values', () => {
    const nonces = new NonceReplayGuard(4)

    nonces.claim(Buffer.from(sequencedNonce(10n)).toString('hex'))
    nonces.claim(Buffer.from(sequencedNonce(12n)).toString('hex'))
    nonces.claim(Buffer.from(sequencedNonce(11n)).toString('hex'))
    nonces.claim(Buffer.from(sequencedNonce(9n)).toString('hex'))
    expect(() => {
      nonces.claim(Buffer.from(sequencedNonce(11n)).toString('hex'))
    })
      .toThrow(/replay/)

    for (let sequence = 13n; sequence <= 4_109n; sequence += 1n) {
      nonces.claim(Buffer.from(sequencedNonce(sequence)).toString('hex'))
    }
    expect(() => {
      nonces.claim(Buffer.from(sequencedNonce(10n)).toString('hex'))
    })
      .toThrow(/replay|stale/)
  })

  it('generates a monotonic sequence in each nonce while retaining its launch-local entropy', () => {
    const createNonceGenerator = Reflect.get(
      bridgeProtocol,
      'createBridgeNonceGenerator',
    ) as unknown
    expect(createNonceGenerator).toBeTypeOf('function')
    if (typeof createNonceGenerator !== 'function') return
    const generate = (createNonceGenerator as (
      entropy: Uint8Array,
    ) => () => Uint8Array)(Uint8Array.from({ length: 24 }, (_, index) => index + 1))

    expect(Buffer.from(generate()).toString('hex')).toBe(
      `0000000000000000${Buffer.from(Uint8Array.from({ length: 24 }, (_, index) => index + 1)).toString('hex')}`,
    )
    expect(Buffer.from(generate()).toString('hex')).toBe(
      `0000000000000001${Buffer.from(Uint8Array.from({ length: 24 }, (_, index) => index + 1)).toString('hex')}`,
    )
  })

  it('rejects an oversized frame from its length prefix without a body allocation', () => {
    const header = Buffer.alloc(4)
    header.writeUInt32BE(64 * 1024 + 1)
    expect(() => decodeBridgeFrame(header)).toThrow(/oversized/)
  })

  it('keeps browser-safe and Host-only methods in separate deny-by-default tables', async () => {
    expect(BROWSER_SAFE_METHODS).toEqual([
      'getAppInfo',
      'getUpdateStatus',
      'checkForUpdate',
      'installUpdateAndRestart',
      'describeCredential',
      'openCredentialReplacement',
      'unsetCredential',
      'getCredentialMigrationStatus',
      'listWorkspaceGrants',
      'authorizeWorkspace',
      'reauthorizeWorkspace',
      'revokeWorkspace',
      'revealWorkspace',
    ])
    expect(HOST_ONLY_METHODS).toEqual([
      'resolveCredential',
      'beginWorkspaceAuthorization',
      'commitWorkspaceAuthorization',
      'abortWorkspaceAuthorization',
      'openWorkspaceFile',
      'spawnWorkspaceProcess',
    ])
    expect(BROWSER_SAFE_METHODS.some(method => HOST_ONLY_METHODS.includes(
      method as typeof HOST_ONLY_METHODS[number],
    ))).toBe(false)

    const handler = vi.fn(async () => ({ reached: true }))
    await expect(dispatchBridgeRequest(
      { ...request, method: 'notRegistered' },
      { browserSafe: { getAppInfo: handler }, hostOnly: {} },
      new AbortController().signal,
    )).rejects.toThrow(/unknown method/)
    expect(handler).not.toHaveBeenCalled()
  })

  it('registers only browser-safe methods as DSH Remotes', () => {
    const ctx = new Context()
    const client = {
      call: vi.fn(async () => null),
      close: vi.fn(),
    } as unknown as DesktopBridgeClient
    const service = new OpenloopDesktopRemoteService(ctx, client)

    expect(remoteMethods(service).map(marker => marker.exportName ?? marker.method))
      .toEqual(BROWSER_SAFE_METHODS)
    expect(remoteMethods(service).map(marker => marker.exportName ?? marker.method))
      .not.toEqual(expect.arrayContaining([...HOST_ONLY_METHODS]))
  })

  it('sends an authenticated cancellation request for an aborted call', async () => {
    const seen: string[] = []
    const outboundFrames: Uint8Array[] = []
    const ids = ['request-1', 'cancel-1'][Symbol.iterator]()
    const nonces = [
      Uint8Array.from({ length: 32 }, () => 1),
      Uint8Array.from({ length: 32 }, () => 2),
    ][Symbol.iterator]()
    const transport: BridgeWireTransport = {
      async exchange(frame, signal) {
        outboundFrames.push(frame)
        const envelope = decodeBridgeFrame(frame) as AuthenticatedBridgeRequest
        const parsed = verifyBridgeRequest(envelope, {
          launchId,
          secret,
          nonces: new NonceReplayGuard(),
        })
        seen.push(parsed.method)
        if (parsed.method === '$cancel') {
          return encodeBridgeFrame(authenticateBridgeResponse({
            version: 1,
            requestId: parsed.requestId,
            ok: true,
            result: null,
          }, Buffer.from(envelope.nonce, 'hex'), secret))
        }
        return new Promise((_resolve, reject) => {
          signal?.addEventListener('abort', () => {
            reject(signal.reason instanceof Error ? signal.reason : new Error('aborted'))
          }, { once: true })
        })
      },
      close() {},
    }
    const client = new DesktopBridgeClient({
      launchId,
      secret,
      transport,
      requestId: () => ids.next().value!,
      nonce: () => nonces.next().value!,
    })
    const controller = new AbortController()
    const pending = client.call('getAppInfo', null, controller.signal)

    controller.abort(new Error('test cancellation'))
    await expect(pending).rejects.toThrow(/test cancellation/)
    await vi.waitFor(() => {
      expect(seen).toEqual(['getAppInfo', '$cancel'])
    })
    for (const frame of outboundFrames) {
      expect([...frame]).toEqual(new Array(frame.length).fill(0))
    }
  })

  it('zeroizes a received response frame after successful verification', async () => {
    const responseFrame = encodeBridgeFrame(authenticateBridgeResponse({
      version: 1,
      requestId: 'response-zeroize',
      ok: true,
      result: [115, 101, 99, 114, 101, 116],
    }, nonce, secret))
    let outboundFrame: Uint8Array | undefined
    const transport: BridgeWireTransport = {
      exchange: vi.fn((frame: Uint8Array) => {
        outboundFrame = frame
        return Promise.resolve(responseFrame)
      }),
      close() {},
    }
    const client = new DesktopBridgeClient({
      launchId,
      secret,
      transport,
      requestId: () => 'response-zeroize',
      nonce: () => nonce,
    })

    await expect(client.call('resolveCredential', { ref: 'TEST_KEY' }))
      .resolves.toEqual([115, 101, 99, 114, 101, 116])
    expect([...responseFrame]).toEqual(new Array(responseFrame.length).fill(0))
    expect([...outboundFrame!]).toEqual(new Array(outboundFrame!.length).fill(0))
  })

  it('zeroizes a received response frame when parsing fails', async () => {
    const responseFrame = Uint8Array.from([0, 0, 0, 1, 0xff])
    const transport: BridgeWireTransport = {
      exchange: vi.fn(() => Promise.resolve(responseFrame)),
      close() {},
    }
    const client = new DesktopBridgeClient({
      launchId,
      secret,
      transport,
      requestId: () => 'response-invalid',
      nonce: () => nonce,
    })

    await expect(client.call('resolveCredential', { ref: 'TEST_KEY' })).rejects.toThrow()
    expect([...responseFrame]).toEqual(new Array(responseFrame.length).fill(0))
  })

  it('zeroizes an outbound frame when the transport rejects', async () => {
    let outboundFrame: Uint8Array | undefined
    const transport: BridgeWireTransport = {
      exchange: vi.fn((frame: Uint8Array) => {
        outboundFrame = frame
        return Promise.reject(new Error('transport rejected'))
      }),
      close() {},
    }
    const client = new DesktopBridgeClient({
      launchId,
      secret,
      transport,
      requestId: () => 'outbound-failure',
      nonce: () => nonce,
    })

    await expect(client.call('resolveCredential', { ref: 'TEST_KEY' }))
      .rejects.toThrow('transport rejected')
    expect([...outboundFrame!]).toEqual(new Array(outboundFrame!.length).fill(0))
  })

  it.runIf(process.platform !== 'win32')(
    'zeroizes Unix response chunks, prefix, and aggregate after success',
    async () => {
      const directory = mkdtempSync(join(tmpdir(), 'ol-wipe-'))
      const socketPath = join(directory, 'bridge.sock')
      const responseFrame = Buffer.from(encodeBridgeFrame(authenticateBridgeResponse({
        version: 1,
        requestId: 'unix-response-wipe',
        ok: true,
        result: 'unix-response-secret',
      }, nonce, secret)))
      const captured: Array<{ inputs: readonly Uint8Array[]; output: Uint8Array }> = []
      const originalConcat = Buffer.concat.bind(Buffer)
      const concat = vi.spyOn(Buffer, 'concat').mockImplementation((
        list: readonly Uint8Array[],
        totalLength?: number,
      ) => {
        const output = originalConcat(list, totalLength)
        if (output.equals(responseFrame)
          || (output.length === 4 && output.equals(responseFrame.subarray(0, 4)))) {
          captured.push({ inputs: [...list], output })
        }
        return output
      })
      const server = createServer({ allowHalfOpen: true }, (socket) => {
        socket.on('data', () => {})
        socket.once('end', () => {
          socket.write(responseFrame.subarray(0, 4))
          setImmediate(() => { socket.end(responseFrame.subarray(4)) })
        })
      })
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject)
        server.listen(socketPath, resolve)
      })
      const client = new DesktopBridgeClient({
        launchId,
        secret,
        socketPath,
        requestId: () => 'unix-response-wipe',
        nonce: () => nonce,
      })

      try {
        await expect(client.call('resolveCredential', { ref: 'TEST_KEY' }))
          .resolves.toBe('unix-response-secret')
        expect(captured.some(call => call.output.length === 4)).toBe(true)
        expect(captured.some(call => call.output.length === responseFrame.length)).toBe(true)
        for (const call of captured) {
          expect([...call.output]).toEqual(new Array(call.output.length).fill(0))
          for (const input of call.inputs) {
            expect([...input]).toEqual(new Array(input.length).fill(0))
          }
        }
      } finally {
        concat.mockRestore()
        client.close()
        await new Promise<void>((resolve, reject) => {
          server.close((error) => {
            if (error === undefined) resolve()
            else reject(error)
          })
        })
        responseFrame.fill(0)
        rmSync(directory, { recursive: true, force: true })
      }
    },
  )

  it.runIf(process.platform !== 'win32')(
    'zeroizes Unix response chunks and prefix after a truncated response',
    async () => {
      const directory = mkdtempSync(join(tmpdir(), 'ol-fail-wipe-'))
      const socketPath = join(directory, 'bridge.sock')
      const responseFrame = Buffer.from(encodeBridgeFrame(authenticateBridgeResponse({
        version: 1,
        requestId: 'unix-response-failure-wipe',
        ok: true,
        result: 'truncated-response-secret',
      }, nonce, secret)))
      const captured: Array<{ inputs: readonly Uint8Array[]; output: Uint8Array }> = []
      const originalConcat = Buffer.concat.bind(Buffer)
      const concat = vi.spyOn(Buffer, 'concat').mockImplementation((
        list: readonly Uint8Array[],
        totalLength?: number,
      ) => {
        const output = originalConcat(list, totalLength)
        if (output.length === 4 && output.equals(responseFrame.subarray(0, 4))) {
          captured.push({ inputs: [...list], output })
        }
        return output
      })
      const server = createServer({ allowHalfOpen: true }, (socket) => {
        socket.on('data', () => {})
        socket.once('end', () => {
          socket.end(responseFrame.subarray(0, responseFrame.length - 1))
        })
      })
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject)
        server.listen(socketPath, resolve)
      })
      const client = new DesktopBridgeClient({
        launchId,
        secret,
        socketPath,
        requestId: () => 'unix-response-failure-wipe',
        nonce: () => nonce,
      })

      try {
        await expect(client.call('resolveCredential', { ref: 'TEST_KEY' }))
          .rejects.toThrow(/truncated/)
        expect(captured).toHaveLength(1)
        expect([...captured[0]!.output]).toEqual(new Array(4).fill(0))
        for (const input of captured[0]!.inputs) {
          expect([...input]).toEqual(new Array(input.length).fill(0))
        }
      } finally {
        concat.mockRestore()
        client.close()
        await new Promise<void>((resolve, reject) => {
          server.close((error) => {
            if (error === undefined) resolve()
            else reject(error)
          })
        })
        responseFrame.fill(0)
        rmSync(directory, { recursive: true, force: true })
      }
    },
  )

  it.runIf(process.platform !== 'win32')(
    'rejects an in-flight socket exchange promptly when the client closes',
    async () => {
      const directory = mkdtempSync(join(tmpdir(), 'openloop-bridge-client-close-'))
      const socketPath = join(directory, 'bridge.sock')
      let acceptConnection!: () => void
      let acceptedSocket: Socket | undefined
      const connected = new Promise<void>((resolve) => { acceptConnection = resolve })
      const server = createServer({ allowHalfOpen: true }, (socket) => {
        acceptedSocket = socket
        socket.on('data', () => {})
        acceptConnection()
      })
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject)
        server.listen(socketPath, resolve)
      })
      const client = new DesktopBridgeClient({ launchId, secret, socketPath })

      try {
        const pending = client.call('getAppInfo', null)
        await connected
        client.close()

        await expect(Promise.race([
          pending,
          new Promise((_, reject) => {
            setTimeout(() => { reject(new Error('pending exchange did not settle')) }, 250)
          }),
        ])).rejects.toThrow(/transport is closed/)
      } finally {
        client.close()
        acceptedSocket?.destroy()
        await new Promise<void>((resolve, reject) => {
          server.close((error) => {
            if (error === undefined) resolve()
            else reject(error)
          })
        })
        rmSync(directory, { recursive: true, force: true })
      }
    },
  )

  it('requires runtime-bootstrap and consumes the bridge secret without reflecting it', async () => {
    expect(OpenloopBrowserApiPolicyService.inject).toEqual(['runtimeBootstrap'])
    expect(() => new OpenloopBrowserApiPolicyService(new Context())).toThrow(/runtime bootstrap/)

    const ctx = new Context()
    const bridgeSecret = Uint8Array.from({ length: 32 }, (_, index) => 141 + index)
    const disposeBootstrap = installRuntimeBootstrap(ctx, {
      launchId,
      bootstrapToken: Uint8Array.from([1, 2, 3, 4]),
      bridgeSecret,
      socketPath: '/tmp/openloop-bridge.sock',
    })
    const service = new OpenloopBrowserApiPolicyService(ctx)

    expect(ctx.runtimeBootstrap.consumeBridgeSecret()).toBeUndefined()
    expect(JSON.stringify(ctx.desktopBridge)).not.toContain('141')
    expect(Object.keys(service)).not.toContain('secret')
    await ctx.fiber.dispose()
    disposeBootstrap()
  })
})
