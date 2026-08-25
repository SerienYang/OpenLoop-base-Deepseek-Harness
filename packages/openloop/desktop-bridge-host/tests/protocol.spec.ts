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
} from '../src/protocol.ts'
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
    const ids = ['request-1', 'cancel-1'][Symbol.iterator]()
    const nonces = [
      Uint8Array.from({ length: 32 }, () => 1),
      Uint8Array.from({ length: 32 }, () => 2),
    ][Symbol.iterator]()
    const transport: BridgeWireTransport = {
      async exchange(frame, signal) {
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
  })

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
