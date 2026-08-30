import { Readable } from 'node:stream'
import { runInNewContext } from 'node:vm'
import { Context } from '@deepseek-ai/cordis'
import {
  createLaunchEnvironmentSnapshot,
  DSH_LAUNCH_ENVIRONMENT_KEY,
} from '@deepseek-ai/dsh-launch-environment'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { KeychainCredentialProvider } from '@openloop/credentials-keychain'
import { describe, expect, test, vi } from 'vitest'
import { installRuntimeBootstrap } from '@openloop/runtime-bootstrap'
import {
  OPENLOOP_BOOTSTRAP_PATH,
  apply,
  type BootstrapHostRoute,
} from '../src/bootstrap-host.ts'

const brand = {
  productName: 'Openloop',
  documentSuffix: 'Openloop',
  markAsset: 'data:image/svg+xml;base64,PHN2Zy8+',
  heroTitle: 'Openloop',
  previewLabel: 'Preview',
  attribution: 'Built on DeepSeek Harness',
} as const

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
  ctx.provide('desktopBridge', {
    getCandidateCredentialHealthPlan: () => Promise.resolve({
      migrationTransactionId: null,
      references: [],
    }),
    acknowledgeMainWebviewHealth,
  } as never)
}

describe('Openloop bootstrap Host route', () => {
  test('executes the injected browser script through exchange, validation, and completion', async () => {
    let route: BootstrapHostRoute | undefined
    let tap: ((html: string) => string) | undefined
    const acknowledgeMainWebviewHealth = vi.fn(() => Promise.resolve())
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
        brand,
      },
      sha256: 'a'.repeat(64),
    })
    apply(ctx)

    const html = tap?.('<html><head></head><body></body></html>') ?? ''
    const script = /<script>([\s\S]+)<\/script>/u.exec(html)?.[1]
    expect(script).toBeDefined()
    const methods: string[] = []
    let cookie: string | undefined
    const location = {
      hash: '#bootstrap=abcd&launch=launch-id',
      pathname: '/',
      search: '',
    }
    const sandbox: Record<string, unknown> = {
      URLSearchParams,
      location,
      history: {
        replaceState: () => {
          location.hash = ''
        },
      },
      document: { documentElement: { dataset: {} as Record<string, string> } },
      fetch: async (_url: string, init: RequestInit) => {
        methods.push(init.method ?? 'GET')
        const recorded = responseRecorder()
        const options = {
          ...(init.method === undefined ? {} : { method: init.method }),
          ...(cookie === undefined ? {} : { cookie }),
        }
        const body = typeof init.body === 'string' ? init.body : ''
        await route?.handler(
          request(body, options),
          recorded.response,
        )
        const setCookie = recorded.state.headers?.['set-cookie']
        if (typeof setCookie === 'string') cookie = setCookie.split(';', 1)[0]
        return {
          ok: recorded.state.status !== undefined && recorded.state.status >= 200
            && recorded.state.status < 300,
          status: recorded.state.status,
          json: () => Promise.resolve(JSON.parse(recorded.state.body)),
        }
      },
    }
    sandbox.globalThis = sandbox

    if (script === undefined) throw new Error('injected bootstrap script is missing')
    runInNewContext(script, sandbox)
    await (sandbox.__DSH_PREBOOT__ as Promise<void>)

    expect(methods).toEqual(['POST', 'PUT'])
    expect(acknowledgeMainWebviewHealth).toHaveBeenCalledOnce()
    expect((sandbox.document as {
      documentElement: { dataset: Record<string, string> }
    }).documentElement.dataset.openloopBootstrap).toBe('ready')
    expect(sandbox.__OPENLOOP_BOOTSTRAP__).toEqual({
      launchId: 'launch-id',
      coreManifest: {
        appVersion: '0.1.0',
        channel: 'test',
        openloopDataVersion: 3,
        dshDataVersion: 7,
        brand,
      },
      coreManifestSha256: 'a'.repeat(64),
    })
    const bootstrap = sandbox.__OPENLOOP_BOOTSTRAP__ as {
      coreManifest: { brand: unknown }
    }
    expect(Object.isFrozen(bootstrap)).toBe(true)
    expect(Object.isFrozen(bootstrap.coreManifest)).toBe(true)
    expect(Object.isFrozen(bootstrap.coreManifest.brand)).toBe(true)
  })

  test('acknowledges the real main WebView only after a cookie-bound completion request', async () => {
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
    expect(acknowledgeMainWebviewHealth).not.toHaveBeenCalled()
    const completion = responseRecorder()
    await route?.handler(
      request(JSON.stringify({
        launchId: 'launch-id',
        coreManifestSha256: 'a'.repeat(64),
        openloopDataVersion: 3,
        dshDataVersion: 7,
      }), {
        method: 'PUT',
        cookie: String(response.state.headers?.['set-cookie']).split(';', 1)[0] ?? '',
      }),
      completion.response,
    )

    expect(completion.state.status).toBe(200)
    expect(acknowledgeMainWebviewHealth).toHaveBeenCalledOnce()
    expect(acknowledgeMainWebviewHealth).toHaveBeenCalledWith({
      launchId: 'launch-id',
      coreManifestSha256: 'a'.repeat(64),
      openloopDataVersion: 3,
      dshDataVersion: 7,
    })
  })

  test('proves every candidate migration credential through ctx.credentials.describe', async () => {
    let route: BootstrapHostRoute | undefined
    const transactionId = '8f5d7e17-9b2b-4b2c-9c2a-1f3e6b2a4d90'
    const getCandidateCredentialHealthPlan = vi.fn(() => Promise.resolve({
      migrationTransactionId: transactionId,
      references: ['ALPHA_TOKEN', 'ZETA_TOKEN'],
    }))
    const acknowledgeMainWebviewHealth = vi.fn(() => Promise.resolve())
    const describeCredential = vi.fn(() => Promise.resolve({
      configured: true,
      source: 'keychain',
      writable: false,
    }))
    const ctx = new Context()
    ctx.provide('webServer', {
      register: (value: BootstrapHostRoute) => {
        route = value
        return () => {}
      },
      tapIndex: () => () => {},
    })
    ctx.provide('desktopBridge', {
      getCandidateCredentialHealthPlan,
      acknowledgeMainWebviewHealth,
      describeCredential,
      resolveCredential: vi.fn(() => Promise.resolve(undefined)),
      openCredentialReplacement: vi.fn(() => Promise.resolve('cancelled')),
      deleteCredentialWithConfirmation: vi.fn(() => Promise.resolve('cancelled')),
    } as never)
    ctx.provide(DSH_LAUNCH_ENVIRONMENT_KEY, createLaunchEnvironmentSnapshot([]))
    const credentials = new KeychainCredentialProvider(ctx)
    await expect(credentials.describe(credentialRef('ALPHA_TOKEN'))).resolves.toMatchObject({
      configured: true,
      source: 'keychain',
    })
    describeCredential.mockClear()
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

    const exchange = responseRecorder()
    await route?.handler(
      request(JSON.stringify({ launchId: 'launch-id', token: 'abcd' })),
      exchange.response,
    )
    const completion = responseRecorder()
    await route?.handler(
      request(JSON.stringify({
        launchId: 'launch-id',
        coreManifestSha256: 'a'.repeat(64),
        openloopDataVersion: 3,
        dshDataVersion: 7,
      }), {
        method: 'PUT',
        cookie: String(exchange.state.headers?.['set-cookie']).split(';', 1)[0] ?? '',
      }),
      completion.response,
    )

    expect(completion.state.status).toBe(200)
    expect(describeCredential.mock.calls).toEqual([
      ['ALPHA_TOKEN'],
      ['ZETA_TOKEN'],
    ])
    expect(acknowledgeMainWebviewHealth).toHaveBeenCalledWith({
      launchId: 'launch-id',
      coreManifestSha256: 'a'.repeat(64),
      openloopDataVersion: 3,
      dshDataVersion: 7,
      credentialHealth: {
        migrationTransactionId: transactionId,
        ready: true,
        checkedCount: 2,
      },
    })
  })

  test('rejects a pending candidate migration unless every credential is Keychain-backed', async () => {
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
    ctx.provide('desktopBridge', {
      getCandidateCredentialHealthPlan: () => Promise.resolve({
        migrationTransactionId: '8f5d7e17-9b2b-4b2c-9c2a-1f3e6b2a4d90',
        references: ['DEEPSEEK_API_KEY'],
      }),
      acknowledgeMainWebviewHealth,
    } as never)
    ctx.provide('credentials', {
      describe: () => Promise.resolve({
        configured: true,
        source: 'environment',
        writable: false,
      }),
    } as never)
    installRuntimeBootstrap(ctx, {
      launchId: 'launch-id',
      bootstrapToken: Uint8Array.from([0xab, 0xcd]),
      bridgeSecret: Uint8Array.from([1, 2]),
      socketPath: '/tmp/openloop.sock',
    }, {
      manifest: {
        openloopDataVersion: 3,
        dshDataVersion: 7,
      },
      sha256: 'a'.repeat(64),
    })
    apply(ctx)

    const exchange = responseRecorder()
    await route?.handler(
      request(JSON.stringify({ launchId: 'launch-id', token: 'abcd' })),
      exchange.response,
    )
    const completion = responseRecorder()
    await route?.handler(
      request(JSON.stringify({
        launchId: 'launch-id',
        coreManifestSha256: 'a'.repeat(64),
        openloopDataVersion: 3,
        dshDataVersion: 7,
      }), {
        method: 'PUT',
        cookie: String(exchange.state.headers?.['set-cookie']).split(';', 1)[0] ?? '',
      }),
      completion.response,
    )

    expect(completion.state.status).toBe(503)
    expect(acknowledgeMainWebviewHealth).not.toHaveBeenCalled()
  })

  test('fails closed when the Host credential health plan is unavailable', async () => {
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
    ctx.provide('desktopBridge', {
      getCandidateCredentialHealthPlan: () =>
        Promise.reject(new Error('desktop bridge not_implemented')),
      acknowledgeMainWebviewHealth,
    } as never)
    ctx.provide('credentials', {
      describe: vi.fn(),
    } as never)
    installRuntimeBootstrap(ctx, {
      launchId: 'launch-id',
      bootstrapToken: Uint8Array.from([0xab, 0xcd]),
      bridgeSecret: Uint8Array.from([1, 2]),
      socketPath: '/tmp/openloop.sock',
    }, {
      manifest: {
        openloopDataVersion: 3,
        dshDataVersion: 7,
      },
      sha256: 'a'.repeat(64),
    })
    apply(ctx)

    const exchange = responseRecorder()
    await route?.handler(
      request(JSON.stringify({ launchId: 'launch-id', token: 'abcd' })),
      exchange.response,
    )
    const completion = responseRecorder()
    await route?.handler(
      request(JSON.stringify({
        launchId: 'launch-id',
        coreManifestSha256: 'a'.repeat(64),
        openloopDataVersion: 3,
        dshDataVersion: 7,
      }), {
        method: 'PUT',
        cookie: String(exchange.state.headers?.['set-cookie']).split(';', 1)[0] ?? '',
      }),
      completion.response,
    )

    expect(completion.state.status).toBe(503)
    expect(acknowledgeMainWebviewHealth).not.toHaveBeenCalled()
  })

  test('retains completion capability after native rejection and rejects replay after success', async () => {
    let route: BootstrapHostRoute | undefined
    const ctx = new Context()
    ctx.provide('webServer', {
      register: (value: BootstrapHostRoute) => {
        route = value
        return () => {}
      },
      tapIndex: () => () => {},
    })
    let session = ''
    const acknowledgeMainWebviewHealth = vi.fn(async () => {
      expect(ctx.runtimeBootstrap.claimBootstrapTokenIfMatches(Uint8Array.from([0xab, 0xcd])))
        .toEqual({ status: 'expired' })
      expect(ctx.runtimeBootstrap.bootstrapCompletionState(session)).toBe('local-committed')
      if (acknowledgeMainWebviewHealth.mock.calls.length === 1) {
        throw new Error('native health rejected')
      }
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

    const exchange = responseRecorder()
    await route?.handler(
      request(JSON.stringify({ launchId: 'launch-id', token: 'abcd' })),
      exchange.response,
    )
    expect(exchange.state.status).toBe(200)
    const cookie = String(exchange.state.headers?.['set-cookie']).split(';', 1)[0] ?? ''
    session = cookie.split('=', 2)[1] ?? ''
    const completionBody = JSON.stringify({
      launchId: 'launch-id',
      coreManifestSha256: 'a'.repeat(64),
      openloopDataVersion: 3,
      dshDataVersion: 7,
    })

    const failed = responseRecorder()
    await route?.handler(
      request(completionBody, { method: 'PUT', cookie }),
      failed.response,
    )
    expect(failed.state.status).toBe(503)
    expect(failed.state.body).not.toContain('native health rejected')
    expect(ctx.runtimeBootstrap.bootstrapCompletionState(session)).toBe('local-committed')

    const retried = responseRecorder()
    await route?.handler(
      request(completionBody, { method: 'PUT', cookie }),
      retried.response,
    )
    expect(retried.state.status).toBe(200)

    const replay = responseRecorder()
    await route?.handler(
      request(completionBody, { method: 'PUT', cookie }),
      replay.response,
    )
    expect(replay.state.status).toBe(410)
    expect(acknowledgeMainWebviewHealth).toHaveBeenCalledTimes(2)
  })

  test('commits the launch-bound token once and returns a no-store HttpOnly cookie', async () => {
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

    const cookie = String(first.state.headers?.['set-cookie']).split(';', 1)[0] ?? ''
    const completion = responseRecorder()
    await route?.handler(
      request(JSON.stringify({
        launchId: 'launch-id',
        coreManifestSha256: 'a'.repeat(64),
        openloopDataVersion: 0,
        dshDataVersion: 0,
      }), { method: 'PUT', cookie }),
      completion.response,
    )
    expect(completion.state.status).toBe(200)

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
