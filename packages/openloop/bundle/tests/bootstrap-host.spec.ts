import { Readable } from 'node:stream'
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, test, vi } from 'vitest'
import { installRuntimeBootstrap } from '@openloop/runtime-bootstrap'
import {
  OPENLOOP_BOOTSTRAP_PATH,
  apply,
  type BootstrapHostRoute,
} from '../src/bootstrap-host.ts'

function responseRecorder(): {
  response: BootstrapHostRoute['response']
  state: { status: number | undefined; headers: Record<string, string | string[]> | undefined; body: string }
} {
  const state: {
    status: number | undefined
    headers: Record<string, string | string[]> | undefined
    body: string
  } = { status: undefined, headers: undefined, body: '' }
  const response = {
    headersSent: false,
    writeHead(status: number, headers?: Record<string, string | string[]>): void {
      state.status = status
      state.headers = headers
    },
    end(body?: string): void {
      state.body += body ?? ''
    },
    destroy(): void {},
  } as unknown as BootstrapHostRoute['response']
  return { response, state }
}

function request(
  body: string,
  options: { readonly method?: string; readonly cookie?: string } = {},
): BootstrapHostRoute['request'] {
  return Object.assign(Readable.from([body]), {
    method: options.method ?? 'POST',
    headers: {
      ...(options.method === 'GET' ? {} : { 'content-type': 'application/json' }),
      ...(options.cookie === undefined ? {} : { cookie: options.cookie }),
    },
  }) as unknown as BootstrapHostRoute['request']
}

function installDesktopBridge(
  ctx: Context,
  acknowledgeMainWebviewHealth = vi.fn(() => Promise.resolve()),
): void {
  ctx.provide('desktopBridge', { acknowledgeMainWebviewHealth } as never)
}

describe('Openloop bootstrap Host route', () => {
  test('acknowledges the real main WebView through the authenticated Host bridge after token exchange', async () => {
    let route: BootstrapHostRoute | undefined
    const acknowledgeMainWebviewHealth = vi.fn(() => Promise.resolve())
    const ctx = new Context()
    ctx.provide('webServer', {
      register: (value: BootstrapHostRoute) => {
        route = value
        return () => {}
      },
      tapIndex: () => () => {},
    })
    installDesktopBridge(ctx, acknowledgeMainWebviewHealth)
    installRuntimeBootstrap(ctx, {
      launchId: 'launch-id',
      bootstrapToken: Uint8Array.from([0xab, 0xcd]),
      bridgeSecret: Uint8Array.from([1, 2]),
      socketPath: '/tmp/openloop.sock',
    }, {
      manifest: {
        appVersion: '0.1.0',
        channel: 'test',
        openloopDataVersion: 3,
        dshDataVersion: 7,
      },
      sha256: 'a'.repeat(64),
    })
    apply(ctx)

    const response = responseRecorder()
    await route?.handler(
      request(JSON.stringify({ launchId: 'launch-id', token: 'abcd' })),
      response.response,
    )

    expect(response.state.status).toBe(200)
    expect(acknowledgeMainWebviewHealth).toHaveBeenCalledOnce()
    expect(acknowledgeMainWebviewHealth).toHaveBeenCalledWith({
      launchId: 'launch-id',
      coreManifestSha256: 'a'.repeat(64),
      openloopDataVersion: 3,
      dshDataVersion: 7,
    })
  })

  test('does not report bootstrap success when native WebView health acknowledgment fails', async () => {
    let route: BootstrapHostRoute | undefined
    const ctx = new Context()
    ctx.provide('webServer', {
      register: (value: BootstrapHostRoute) => {
        route = value
        return () => {}
      },
      tapIndex: () => () => {},
    })
    installDesktopBridge(ctx, {
      acknowledgeMainWebviewHealth: vi.fn(() =>
        Promise.reject(new Error('native health rejected'))),
    }.acknowledgeMainWebviewHealth)
    installRuntimeBootstrap(ctx, {
      launchId: 'launch-id',
      bootstrapToken: Uint8Array.from([0xab, 0xcd]),
      bridgeSecret: Uint8Array.from([1, 2]),
      socketPath: '/tmp/openloop.sock',
    }, {
      manifest: {
        appVersion: '0.1.0',
        channel: 'test',
        openloopDataVersion: 3,
        dshDataVersion: 7,
      },
      sha256: 'a'.repeat(64),
    })
    apply(ctx)

    const response = responseRecorder()
    await route?.handler(
      request(JSON.stringify({ launchId: 'launch-id', token: 'abcd' })),
      response.response,
    )

    expect(response.state.status).toBe(503)
    expect(response.state.body).not.toContain('native health rejected')
  })

  test('consumes the launch-bound token once and returns a no-store HttpOnly cookie', async () => {
    let route: BootstrapHostRoute | undefined
    let tap: ((html: string) => string) | undefined
    const ctx = new Context()
    ctx.provide('webServer', {
      register: (value: BootstrapHostRoute) => {
        route = value
        return () => {}
      },
      tapIndex: (value: (html: string) => string) => {
        tap = value
        return () => {}
      },
    })
    installDesktopBridge(ctx)
    installRuntimeBootstrap(ctx, {
      launchId: 'launch-id',
      bootstrapToken: Uint8Array.from([0xab, 0xcd]),
      bridgeSecret: Uint8Array.from([1, 2]),
      socketPath: '/tmp/openloop.sock',
    }, {
      manifest: {
        appVersion: '0.1.0',
        channel: 'test',
        openloopDataVersion: 0,
        dshDataVersion: 0,
      },
      sha256: 'a'.repeat(64),
    })
    apply(ctx)

    expect(route?.path).toBe(OPENLOOP_BOOTSTRAP_PATH)
    expect(tap?.('<head></head>')).toContain('__DSH_PREBOOT__')
    expect(tap?.('<head></head>')).not.toContain('abcd')
    expect(tap?.('<head></head>')).toContain("method: 'GET'")

    const first = responseRecorder()
    await route?.handler(
      request(JSON.stringify({ launchId: 'launch-id', token: 'abcd' })),
      first.response,
    )
    expect(first.state.status).toBe(200)
    expect(first.state.headers?.['cache-control']).toBe('no-store')
    expect(first.state.headers?.['set-cookie']).toEqual(
      expect.stringMatching(/^openloop_bootstrap=[0-9a-f]{64}; Path=\/; HttpOnly; SameSite=Strict$/u),
    )
    expect(JSON.parse(first.state.body)).toEqual({
      launchId: 'launch-id',
      coreManifest: {
        appVersion: '0.1.0',
        channel: 'test',
        openloopDataVersion: 0,
        dshDataVersion: 0,
      },
      coreManifestSha256: 'a'.repeat(64),
    })

    const refresh = responseRecorder()
    await route?.handler(
      request('', {
        method: 'GET',
        cookie: String(first.state.headers?.['set-cookie']).split(';', 1)[0] ?? '',
      }),
      refresh.response,
    )
    expect(refresh.state.status).toBe(200)
    expect(JSON.parse(refresh.state.body)).toEqual(JSON.parse(first.state.body))

    const second = responseRecorder()
    await route?.handler(
      request(JSON.stringify({ launchId: 'launch-id', token: 'abcd' })),
      second.response,
    )
    expect(second.state.status).toBe(410)
  })

  test('rejects a refresh without the bootstrap session cookie', async () => {
    let route: BootstrapHostRoute | undefined
    const ctx = new Context()
    ctx.provide('webServer', {
      register: (value: BootstrapHostRoute) => {
        route = value
        return () => {}
      },
      tapIndex: () => () => {},
    })
    installDesktopBridge(ctx)
    installRuntimeBootstrap(ctx, {
      launchId: 'launch-id',
      bootstrapToken: Uint8Array.from([0xab, 0xcd]),
      bridgeSecret: Uint8Array.from([1, 2]),
      socketPath: '/tmp/openloop.sock',
    }, {
      manifest: {
        appVersion: '0.1.0',
        channel: 'test',
        openloopDataVersion: 0,
        dshDataVersion: 0,
      },
      sha256: 'a'.repeat(64),
    })
    apply(ctx)

    const response = responseRecorder()
    await route?.handler(request('', { method: 'GET' }), response.response)
    expect(response.state.status).toBe(401)
  })

  test('rejects a wrong launch id without burning the valid token', async () => {
    let route: BootstrapHostRoute | undefined
    const ctx = new Context()
    ctx.provide('webServer', {
      register: (value: BootstrapHostRoute) => {
        route = value
        return () => {}
      },
      tapIndex: () => () => {},
    })
    installDesktopBridge(ctx)
    installRuntimeBootstrap(ctx, {
      launchId: 'launch-id',
      bootstrapToken: Uint8Array.from([0xab, 0xcd]),
      bridgeSecret: Uint8Array.from([1, 2]),
      socketPath: '/tmp/openloop.sock',
    }, {
      manifest: {
        appVersion: '0.1.0',
        channel: 'test',
        openloopDataVersion: 0,
        dshDataVersion: 0,
      },
      sha256: 'a'.repeat(64),
    })
    apply(ctx)

    const wrong = responseRecorder()
    await route?.handler(
      request(JSON.stringify({ launchId: 'wrong-launch', token: 'abcd' })),
      wrong.response,
    )
    expect(wrong.state.status).toBe(401)

    const valid = responseRecorder()
    await route?.handler(
      request(JSON.stringify({ launchId: 'launch-id', token: 'abcd' })),
      valid.response,
    )
    expect(valid.state.status).toBe(200)
  })

  test('rejects a wrong token without burning the valid token', async () => {
    let route: BootstrapHostRoute | undefined
    const ctx = new Context()
    ctx.provide('webServer', {
      register: (value: BootstrapHostRoute) => {
        route = value
        return () => {}
      },
      tapIndex: () => () => {},
    })
    installDesktopBridge(ctx)
    installRuntimeBootstrap(ctx, {
      launchId: 'launch-id',
      bootstrapToken: Uint8Array.from([0xab, 0xcd]),
      bridgeSecret: Uint8Array.from([1, 2]),
      socketPath: '/tmp/openloop.sock',
    }, {
      manifest: {
        appVersion: '0.1.0',
        channel: 'test',
        openloopDataVersion: 0,
        dshDataVersion: 0,
      },
      sha256: 'a'.repeat(64),
    })
    apply(ctx)

    const wrong = responseRecorder()
    await route?.handler(
      request(JSON.stringify({ launchId: 'launch-id', token: 'ffff' })),
      wrong.response,
    )
    expect(wrong.state.status).toBe(401)

    const valid = responseRecorder()
    await route?.handler(
      request(JSON.stringify({ launchId: 'launch-id', token: 'abcd' })),
      valid.response,
    )
    expect(valid.state.status).toBe(200)
  })
})
