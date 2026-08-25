import { readFileSync } from 'node:fs'
import { EventEmitter } from 'node:events'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { Readable } from 'node:stream'
import { Context, symbols } from '@deepseek-ai/cordis'
import TypertGatewayService from '@deepseek-ai/dsh-api-gateway'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import {
  API_PATH,
  apply as applyConnection,
  inject as connectionInject,
} from '@deepseek-ai/dsh-client-connection'
import { toFetchHandler } from '@deepseek-ai/dsh-host-apiproxy'
import type { ApiProxy } from '@deepseek-ai/dsh-host-apiproxy/api'
import type { WebRoute, WebServer } from '@deepseek-ai/dsh-host-webserver'
import { installRuntimeBootstrap } from '@openloop/runtime-bootstrap'
import { describe, expect, it, vi } from 'vitest'
import {
  createBrowserApiPolicy,
  parseBrowserApiPolicyManifest,
} from '../src/api-policy.ts'
import OpenloopBrowserApiPolicyService from '../src/index.ts'

function shippedManifest(): unknown {
  return JSON.parse(
    readFileSync(new URL('../openloop-browser-api.json', import.meta.url), 'utf8'),
  ) as unknown
}

function manifest() {
  return {
    version: 1,
    default: 'deny',
    legacyRpcMethods: ['session.list', 'session.create'],
    typertRemoteEndpoints: ['commands/list', 'commands/execute'],
    payloadRules: {
      'session.create': {
        required: ['workspaceId'],
        optional: ['sessionId', 'agentPreset'],
      },
    },
    transportRoutes: [
      { method: 'GET', path: '/api/events.mux' },
      { method: 'POST', path: '/api/respond' },
    ],
  }
}

function fakeWebServer(
  routes: WebRoute[],
): Pick<WebServer, 'register' | 'registerUpgrade' | 'tapIndex' | 'port'> {
  return {
    register(route) {
      routes.push(route)
      return () => { routes.splice(routes.indexOf(route), 1) }
    },
    registerUpgrade: () => () => {},
    tapIndex: () => () => {},
    port: 0,
  }
}

function lazyPost(
  url: string,
  body: () => unknown,
): { request: IncomingMessage; reads: () => number } {
  let reads = 0
  const request = new Readable({
    read() {
      reads += 1
      this.push(Buffer.from(JSON.stringify(body())))
      this.push(null)
    },
  }) as unknown as IncomingMessage
  Object.assign(request, {
    url,
    method: 'POST',
    headers: {
      host: '127.0.0.1:3080',
      'content-type': 'application/json',
    },
  })
  return { request, reads: () => reads }
}

function fakeResponse(): {
  response: ServerResponse
  state: { status?: number; body?: string }
} {
  const state: { status?: number; body?: string } = {}
  const chunks: Buffer[] = []
  const response = Object.assign(new EventEmitter(), {
    writableEnded: false,
    writeHead(value: number) { state.status = value; return this },
    write(value: string | Uint8Array) { chunks.push(Buffer.from(value)); return true },
    end(this: { writableEnded: boolean }, value?: string | Uint8Array) {
      if (value !== undefined) chunks.push(Buffer.from(value))
      if (chunks.length > 0) state.body = Buffer.concat(chunks).toString()
      this.writableEnded = true
      return this
    },
  }) as unknown as ServerResponse
  return { response, state }
}

function installBridgeBootstrap(ctx: Context): () => void {
  return installRuntimeBootstrap(ctx, {
    launchId: '8f5d7e17-9b2b-4b2c-9c2a-1f3e6b2a4d90',
    bootstrapToken: Uint8Array.from({ length: 32 }, () => 1),
    bridgeSecret: Uint8Array.from({ length: 32 }, () => 2),
    socketPath: '/tmp/openloop-policy-test.sock',
  })
}

describe('OpenLoop browser API policy manifest', () => {
  it('ships a fixed deny-by-default version 1 manifest', () => {
    expect(parseBrowserApiPolicyManifest(shippedManifest())).toMatchObject({
      version: 1,
      default: 'deny',
    })
  })

  it('denies the reviewed sensitive surfaces and allows the reviewed browser surface', () => {
    const policy = createBrowserApiPolicy(shippedManifest())

    for (const method of [
      'credentials.describe',
      'credentials.set',
      'credentials.unset',
      'credentials.resolve',
      'host.pickDirectory',
      'host.listDirectory',
      'host.createDirectory',
      'host.openPath',
      'workspace.create',
      'workspace.delete',
      'llm.discoverModels',
      'settings.mutate',
      'settings.openDocument',
      'settings.replace',
      'settings.update',
      'settings.describe',
    ]) {
      expect([method, policy.allows(method, {})]).toEqual([method, false])
    }
    for (const endpoint of [
      'credentials/set',
      'credentials/unset',
      'credentials/resolve',
      'goals/create',
      'goals/complete',
      'dynamicCordisRunner/getClientCode',
      'dynamicCordisRunner/inventory',
      'dynamicCordisRunner/invoke',
      'dynamicCordisRunner/runHostHalf',
      'dynamicCordisRunner/resolveRequestRun',
      'dynamicCordisRunner/settleUserRun',
      'dynamicCordisRunner/stopFromPanel',
      'dynamicCordisRunner/undefineFromPanel',
      'pluginInventory/list',
    ]) {
      expect([endpoint, policy.allows(endpoint, {})]).toEqual([endpoint, false])
    }
    for (const allowed of [
      'session.list',
      'workspace.list',
      'commands/list',
      'commands/execute',
      'goals/edit',
      'messageFeedback/put',
      'GET /api/events.mux',
      'GET /api/events.host',
      'POST /api/respond',
      'GET /api/session.export',
      'HEAD /api/session.export',
    ]) {
      expect([allowed, policy.allows(allowed, {})]).toEqual([allowed, true])
    }
  })

  it.each([
    ['wrong version', { ...manifest(), version: 2 }],
    ['wrong default', { ...manifest(), default: 'allow' }],
    ['unknown top-level field', { ...manifest(), fallback: 'allow' }],
    ['duplicate legacy method', {
      ...manifest(),
      legacyRpcMethods: ['session.list', 'session.list'],
    }],
    ['duplicate Typert endpoint', {
      ...manifest(),
      typertRemoteEndpoints: ['commands/list', 'commands/list'],
    }],
    ['non-canonical legacy method', {
      ...manifest(),
      legacyRpcMethods: ['session.create', 'session..list'],
    }],
    ['non-canonical transport path', {
      ...manifest(),
      transportRoutes: [
        { method: 'GET', path: '/api//events.mux' },
      ],
    }],
    ['duplicate transport route', {
      ...manifest(),
      transportRoutes: [
        { method: 'GET', path: '/api/events.mux' },
        { method: 'GET', path: '/api/events.mux' },
      ],
    }],
    ['unknown payload rule method', {
      ...manifest(),
      payloadRules: {
        ...manifest().payloadRules,
        'session.unknown': { required: [], optional: [] },
      },
    }],
    ['overlapping payload rule fields', {
      ...manifest(),
      payloadRules: {
        'session.create': {
          required: ['workspaceId'],
          optional: ['workspaceId'],
        },
      },
    }],
    ['unknown payload rule field', {
      ...manifest(),
      payloadRules: {
        'session.create': {
          required: ['workspaceId'],
          optional: ['sessionId'],
          passthrough: true,
        },
      },
    }],
  ])('rejects a malformed manifest: %s', (_case, source) => {
    expect(() => parseBrowserApiPolicyManifest(source)).toThrow()
  })

  it('deep-freezes the detached manifest graph', () => {
    const source = manifest()
    const parsed = parseBrowserApiPolicyManifest(source)

    expect(Object.isFrozen(parsed)).toBe(true)
    expect(Object.isFrozen(parsed.legacyRpcMethods)).toBe(true)
    expect(Object.isFrozen(parsed.typertRemoteEndpoints)).toBe(true)
    expect(Object.isFrozen(parsed.payloadRules)).toBe(true)
    expect(Object.isFrozen(parsed.payloadRules['session.create'])).toBe(true)
    expect(Object.isFrozen(parsed.payloadRules['session.create']?.required)).toBe(true)
    expect(Object.isFrozen(parsed.payloadRules['session.create']?.optional)).toBe(true)
    expect(Object.isFrozen(parsed.transportRoutes)).toBe(true)
    expect(Object.isFrozen(parsed.transportRoutes[0])).toBe(true)

    source.legacyRpcMethods.push('credentials.set')
    source.payloadRules['session.create'].required.push('cwd')
    source.transportRoutes[0]!.path = '/api/changed'
    expect(parsed.legacyRpcMethods).toEqual(['session.list', 'session.create'])
    expect(parsed.payloadRules['session.create']?.required).toEqual(['workspaceId'])
    expect(parsed.transportRoutes[0]).toEqual({ method: 'GET', path: '/api/events.mux' })
  })
})

describe('OpenLoop browser API policy', () => {
  it('blocks all four settings actions before the real legacy handlers run', async () => {
    const openDocument = vi.fn(async (request: { rpcId: string }) => ({
      rpcId: request.rpcId,
      result: { ok: true as const, value: { opened: true as const } },
    }))
    const update = vi.fn(async (request: { rpcId: string }) => ({
      rpcId: request.rpcId,
      result: { ok: false as const, error: { code: 'settings-rejected' as const, message: 'stub', details: { ns: 'stub' } } },
    }))
    const replace = vi.fn(async (request: { rpcId: string }) => ({
      rpcId: request.rpcId,
      result: { ok: false as const, error: { code: 'settings-rejected' as const, message: 'stub', details: { ns: 'stub' } } },
    }))
    const mutate = vi.fn(async (request: { rpcId: string }) => ({
      rpcId: request.rpcId,
      result: { ok: false as const, error: { code: 'settings-rejected' as const, message: 'stub', details: { ns: 'stub' } } },
    }))
    const api = { settings: { openDocument, update, replace, mutate } } as unknown as ApiProxy
    const attempts = [
      ['settings.openDocument', {}],
      ['settings.update', { ns: 'llm-deepseek', patch: { apiKeyEnv: 'EXFILTRATE_ME' } }],
      ['settings.replace', {
        ns: 'llm-deepseek',
        section: {
          apiKeyEnv: 'EXFILTRATE_ME',
          baseURL: 'https://attacker.example',
        },
      }],
      ['settings.mutate', {
        ns: 'llm-deepseek',
        ops: [{ op: 'set', path: ['baseURL'], value: 'https://attacker.example' }],
      }],
    ] as const

    for (const [index, [method, payload]] of attempts.entries()) {
      const request = new Request(`http://openloop.internal/api/${method}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          type: 'client-request',
          rpcId: `openloop-settings-${String(index)}`,
          method,
          payload,
        }),
      })
      const denied = await toFetchHandler(
        api,
        createBrowserApiPolicy(shippedManifest()),
      ).fetch(request)

      expect([method, denied.status]).toEqual([method, 403])
    }
    expect(openDocument).not.toHaveBeenCalled()
    expect(update).not.toHaveBeenCalled()
    expect(replace).not.toHaveBeenCalled()
    expect(mutate).not.toHaveBeenCalled()
  })

  it('keeps all four default DSH settings actions callable when no product policy is mounted', async () => {
    const success = (request: { rpcId: string; payload: { ns: string } }) => ({
      rpcId: request.rpcId,
      result: {
        ok: true as const,
        value: {
          ns: request.payload.ns,
          schema: {},
          value: {},
          applies: 'live' as const,
          secrets: [],
          revision: 1,
        },
      },
    })
    const openDocument = vi.fn(async (request: { rpcId: string }) => ({
      rpcId: request.rpcId,
      result: { ok: true as const, value: { opened: true as const } },
    }))
    const update = vi.fn(async (request: { rpcId: string; payload: { ns: string } }) => success(request))
    const replace = vi.fn(async (request: { rpcId: string; payload: { ns: string } }) => success(request))
    const mutate = vi.fn(async (request: { rpcId: string; payload: { ns: string } }) => success(request))
    const handler = toFetchHandler({
      settings: { openDocument, update, replace, mutate },
    } as unknown as ApiProxy)
    const attempts = [
      ['settings.openDocument', {}],
      ['settings.update', { ns: 'llm-deepseek', patch: { apiKeyEnv: 'DEEPSEEK_API_KEY' } }],
      ['settings.replace', {
        ns: 'llm-deepseek',
        section: {
          apiKeyEnv: 'DEEPSEEK_API_KEY',
          baseURL: 'https://provider.example',
        },
      }],
      ['settings.mutate', {
        ns: 'llm-deepseek',
        ops: [{ op: 'set', path: ['baseURL'], value: 'https://provider.example' }],
      }],
    ] as const

    for (const [index, [method, payload]] of attempts.entries()) {
      const response = await handler.fetch(new Request(`http://dsh.internal/api/${method}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          type: 'client-request',
          rpcId: `dsh-settings-${String(index)}`,
          method,
          payload,
        }),
      }))

      expect([method, response.status]).toEqual([method, 200])
    }
    expect(openDocument).toHaveBeenCalledOnce()
    expect(update).toHaveBeenCalledOnce()
    expect(replace).toHaveBeenCalledOnce()
    expect(mutate).toHaveBeenCalledOnce()
  })

  it('preflights the real Service before Connection reads a denied body and still checks admitted payloads', async () => {
    const ctx = new Context()
    const disposeBootstrap = installBridgeBootstrap(ctx)
    const routes: WebRoute[] = []
    const replace = vi.fn()
    const create = vi.fn()
    ctx.provide('webServer', fakeWebServer(routes) as WebServer)
    ctx.provide('apiProxy', {
      settings: { replace },
      sessions: { create },
    } as unknown as ApiProxy)
    const policyFiber = ctx.plugin(OpenloopBrowserApiPolicyService)
    await policyFiber
    const connectionFiber = ctx.plugin({
      inject: [...connectionInject, 'browserApiPolicy'],
      apply: applyConnection,
    })
    await connectionFiber
    const route = routes.find(candidate => candidate.path === API_PATH)
    expect(route).toBeDefined()

    let deniedPayloadReads = 0
    const deniedPayload = { ns: 'llm-deepseek' } as Record<string, unknown>
    Object.defineProperty(deniedPayload, 'section', {
      enumerable: true,
      get() {
        deniedPayloadReads += 1
        return { apiKeyEnv: 'EXFILTRATE_ME' }
      },
    })
    const deniedBody = lazyPost('/api/settings.replace', () => ({
      type: 'client-request',
      rpcId: 'real-policy-preflight',
      method: 'settings.replace',
      payload: deniedPayload,
    }))
    const denied = fakeResponse()

    await route!.handler(deniedBody.request, denied.response)

    expect(denied.state).toEqual({ status: 403, body: 'forbidden' })
    expect(deniedBody.reads()).toBe(0)
    expect(deniedPayloadReads).toBe(0)
    expect(replace).not.toHaveBeenCalled()

    let admittedPayloadReads = 0
    const admittedPayload = {}
    const admittedBody = lazyPost('/api/session.create', () => {
      admittedPayloadReads += 1
      return {
        type: 'client-request',
        rpcId: 'real-policy-payload',
        method: 'session.create',
        payload: admittedPayload,
      }
    })
    const payloadDenied = fakeResponse()

    await route!.handler(admittedBody.request, payloadDenied.response)

    expect(payloadDenied.state).toEqual({ status: 403, body: 'forbidden' })
    expect(admittedBody.reads()).toBeGreaterThan(0)
    expect(admittedPayloadReads).toBe(1)
    expect(create).not.toHaveBeenCalled()
    await connectionFiber.dispose()
    await policyFiber.dispose()
    disposeBootstrap()
  })

  it('uses the same policy instance at legacy and Typert dispatch boundaries', async () => {
    const ctx = new Context()
    const disposeBootstrap = installBridgeBootstrap(ctx)
    const policyFiber = ctx.plugin(OpenloopBrowserApiPolicyService)
    await policyFiber
    const policy = ctx.browserApiPolicy
    const original = (policy as OpenloopBrowserApiPolicyService & {
      [symbols.original]?: OpenloopBrowserApiPolicyService
    })[symbols.original] ?? policy
    const allowsTarget = vi.spyOn(original, 'allowsTarget')
    const allows = vi.spyOn(original, 'allows')
    const legacyHandler = toFetchHandler({} as ApiProxy, policy)
    const legacy = await legacyHandler.fetch(new Request('http://x/api/credentials.set', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        type: 'client-request',
        rpcId: 'legacy-denied',
        method: 'credentials.set',
        payload: {},
      }),
    }))

    await ctx.plugin(TypertRegistry)
    await ctx.plugin(TypertGatewayService)
    const typert = ctx.typertGateway.invoke({
      namespace: 'credentials',
      method: 'set',
      args: {},
    })

    expect(legacy.status).toBe(403)
    await expect(typert).rejects.toMatchObject({
      code: 'policy-denied',
      endpoint: 'credentials/set',
    })
    expect(allowsTarget).toHaveBeenCalledWith('credentials.set')
    expect(allows).toHaveBeenCalledOnce()
    expect(allows).toHaveBeenCalledWith('credentials/set', {})
    await policyFiber.dispose()
    expect(ctx.get('browserApiPolicy')).toBeUndefined()
    disposeBootstrap()
  })

  it('uses exact canonical names and fails closed across legacy and Typert', () => {
    const policy = createBrowserApiPolicy(manifest())

    expect(policy.allows('session.list', {})).toBe(true)
    expect(policy.allows('commands/list', {})).toBe(true)
    expect(policy.allows(' session.list', {})).toBe(false)
    expect(policy.allows('SESSION.LIST', {})).toBe(false)
    expect(policy.allows('commands.list', {})).toBe(false)
    expect(policy.allows('credentials.set', {})).toBe(false)
    expect(policy.allows('credentials/set', {})).toBe(false)
    expect(policy.allows('dynamicCordisRunner/invoke', {})).toBe(false)
    expect(policy.allows('future/newEndpoint', {})).toBe(false)
  })

  it('allows session.create only with an own workspaceId and exact optional fields', () => {
    const policy = createBrowserApiPolicy(manifest())
    const inheritedWorkspace = Object.create({ workspaceId: 'workspace-1' }) as Record<string, unknown>
    const symbolField = { workspaceId: 'workspace-1' } as Record<PropertyKey, unknown>
    symbolField[Symbol('extra')] = true

    expect(policy.allows('session.create', { workspaceId: 'workspace-1' })).toBe(true)
    expect(policy.allows('session.create', {
      workspaceId: 'workspace-1',
      sessionId: 'session-1',
      agentPreset: 'standard',
    })).toBe(true)
    expect(policy.allows('session.create', inheritedWorkspace)).toBe(false)
    expect(policy.allows('session.create', symbolField)).toBe(false)
    expect(policy.allows('session.create', {})).toBe(false)
    expect(policy.allows('session.create', { cwd: '/tmp' })).toBe(false)
    expect(policy.allows('session.create', {
      workspaceId: 'workspace-1',
      futureField: true,
    })).toBe(false)
  })

  it('separates target admission from payload rules for legacy body preflight', () => {
    const policy = createBrowserApiPolicy(manifest()) as ReturnType<typeof createBrowserApiPolicy> & {
      allowsTarget(method: string): boolean
    }

    expect(policy.allowsTarget('session.list')).toBe(true)
    expect(policy.allowsTarget('session.create')).toBe(true)
    expect(policy.allowsTarget('settings.update')).toBe(false)
    expect(policy.allows('session.create', {})).toBe(false)
    expect(policy.allows('session.create', { workspaceId: 'workspace-1' })).toBe(true)
  })

  it('allows only explicit physical transport routes', () => {
    const policy = createBrowserApiPolicy(manifest())

    expect(policy.allows('GET /api/events.mux', undefined)).toBe(true)
    expect(policy.allows('POST /api/respond', {})).toBe(true)
    expect(policy.allows('HEAD /api/events.mux', undefined)).toBe(false)
    expect(policy.allows('GET /api/unknown', undefined)).toBe(false)
    expect(policy.allows('get /api/events.mux', undefined)).toBe(false)
  })
})
