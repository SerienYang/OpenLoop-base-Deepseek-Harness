import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { createServer } from 'node:http'
import type { IncomingMessage } from 'node:http'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { inspect } from 'node:util'
import LlmRuntime, { LlmAdapter } from '@deepseek-ai/dsh-llm'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { LocalCredentialProvider } from '@deepseek-ai/dsh-credentials-local'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'
import { FileSettingsProvider } from '@deepseek-ai/dsh-settings-file'
import * as LlmPiAi from '@deepseek-ai/dsh-llm-pi-ai'
import { assemble } from './assemble.ts'
import { closeMockServers, mockServer, textEvents } from './mock-server.ts'

const NS = settingsNamespace('llm-pi-ai')

/** Minimal foreign adapter: only needs to own a route the pi-ai plugin then wants. */
class StubAdapter extends LlmAdapter {

  override async * stream(): AsyncIterable<never> {
    throw new Error('stub adapter must never stream')
  }
}

const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!()
  await closeMockServers()
  vi.unstubAllEnvs()
})

async function home(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-pi-dynamic-'))
  cleanups.push(() => rm(dir, { recursive: true, force: true }))
  return dir
}

async function listingServer(): Promise<{
  readonly url: string
  readonly headers: IncomingMessage['headers'][]
}> {
  const headers: IncomingMessage['headers'][] = []
  const server = createServer((request, response) => {
    headers.push(request.headers)
    const body = JSON.stringify({ data: [{ id: 'listed-model' }] })
    response.writeHead(200, {
      'content-type': 'application/json',
      'content-length': String(Buffer.byteLength(body)),
    })
    response.end(body)
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  cleanups.push(() => new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error === undefined) resolve()
      else reject(error)
    })
  }))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('no port')
  return { url: `http://127.0.0.1:${address.port}`, headers }
}

/** Real dynamic composition mirroring the deepseek twin's harness. */
async function boot(
  dir: string,
  config: LlmPiAi.Config,
  credentialConsumers?: object,
): Promise<Context> {
  const ctx = new Context()
  cleanups.push(async () => {
    await ctx.fiber.dispose()
  })
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(FileSettingsProvider, { path: join(dir, 'settings.yaml'), watch: false })
  await ctx.plugin(LocalCredentialProvider, { path: join(dir, '.credentials.yaml'), watch: false })
  if (credentialConsumers !== undefined) {
    ctx.provide('credentialConsumers', credentialConsumers as never)
  }
  await ctx.plugin(LlmPiAi, config)
  return ctx
}

describe('request-level dynamic profiles', () => {
  it('mounts bare and dormant, then registers routes the moment settings supply providers', async () => {
    vi.stubEnv('PI_DYNAMIC_KEY', '')
    const dir = await home()
    await writeFile(
      join(dir, '.credentials.yaml'),
      'PI_DYNAMIC_KEY: pk-from-settings\nPI_LIVE_KEY: live-key\nPI_OTHER_KEY: other\n',
      { mode: 0o600 },
    )
    const server = await mockServer([{ events: textEvents }])
    // The exact product posture: `- id: llm-pi-ai` with no config at all.
    const ctx = await boot(dir, {})

    expect(ctx.llm.listProviders()).toEqual([])
    // Dormant ≠ invisible: every installed catalog provider is configurable
    // before any route exists, each addressed inside the providers dict.
    const directory = ctx.llm.listConfigurableProviders()
    expect(directory.length).toBeGreaterThan(30)
    expect(directory).toContainEqual({
      provider: 'openai',
      displayName: 'openai',
      settingsNs: 'llm-pi-ai',
      settingsPath: ['providers', 'openai'],
      declared: false,
    })
    await ctx.settings.update(NS, {
      providers: { deepseek: { apiKeyEnv: 'PI_DYNAMIC_KEY', baseURL: server.url } },
    })
    expect(ctx.llm.listProviders().map(provider => provider.id)).toEqual(['deepseek'])
    await expect(ctx.llm.listModels('deepseek')).resolves.not.toHaveLength(0)

    const result = await assemble(ctx, { provider: 'deepseek', model: 'deepseek-v4-flash', messages: [] })
    expect(result.message.content).toEqual([{ type: 'text', text: 'hello' }])
    expect(server.headers[0]?.authorization).toBe('Bearer pk-from-settings')

    // Emptying the user layer returns the adapter to its dormant state.
    await ctx.settings.replace(NS, {})
    expect(ctx.llm.listProviders()).toEqual([])
  })

  it('adds a provider route from settings and drops it when the user layer resets', async () => {
    const dir = await home()
    await writeFile(
      join(dir, '.credentials.yaml'),
      'PI_LIVE_KEY: live-key\nPI_OTHER_KEY: other\n',
      { mode: 0o600 },
    )
    const server = await mockServer([{ events: textEvents }])
    const ctx = await boot(dir, {
      providers: { openai: { apiKeyEnv: 'PI_DYNAMIC_KEY', baseURL: 'http://127.0.0.1:1/v1' } },
    })

    expect(ctx.llm.listProviders().map(provider => provider.id)).toEqual(['openai'])
    await ctx.settings.update(NS, {
      providers: { deepseek: { apiKeyEnv: 'PI_LIVE_KEY', baseURL: server.url } },
    })
    expect(ctx.llm.listProviders().map(provider => provider.id)).toEqual(['openai', 'deepseek'])

    const result = await assemble(ctx, { provider: 'deepseek', model: 'deepseek-v4-flash', messages: [] })
    expect(result.message.content).toEqual([{ type: 'text', text: 'hello' }])
    expect(server.headers[0]?.authorization).toBe('Bearer live-key')

    // Reset the user layer: the settings-born route unregisters, the
    // composition route stays.
    await ctx.settings.replace(NS, {})
    expect(ctx.llm.listProviders().map(provider => provider.id)).toEqual(['openai'])
    const removed = await assemble(ctx, { provider: 'deepseek', model: 'deepseek-v4-flash', messages: [] })
    expect(removed.finish).toMatchObject({ kind: 'error', failure: { code: 'NO_ADAPTER' } })
  })

  it('rotates the per-request credential referenced by apiKeyEnv', async () => {
    vi.stubEnv('PI_DYNAMIC_KEY', '')
    const dir = await home()
    await writeFile(join(dir, '.credentials.yaml'), 'PI_DYNAMIC_KEY: pk-one\n', { mode: 0o600 })
    const server = await mockServer([{ events: textEvents }, { events: textEvents }])
    const ctx = await boot(dir, {
      providers: { deepseek: { apiKeyEnv: 'PI_DYNAMIC_KEY', baseURL: server.url } },
    })

    await assemble(ctx, { provider: 'deepseek', model: 'deepseek-v4-flash', messages: [] })
    expect(server.headers[0]?.authorization).toBe('Bearer pk-one')

    await ctx.credentials.set(credentialRef('PI_DYNAMIC_KEY'), 'pk-two')
    await assemble(ctx, { provider: 'deepseek', model: 'deepseek-v4-flash', messages: [] })
    expect(server.headers[1]?.authorization).toBe('Bearer pk-two')
  })

  it('re-registers routes in place when a captured retry policy changes', async () => {
    const dir = await home()
    const ctx = await boot(dir, { providers: { openai: {} } })

    await ctx.settings.update(NS, {
      providers: {
        openai: {
          retryPolicy: { mode: 'always', backoff: { initialDelayMs: 25, maxDelayMs: 100, jitterRatio: 0.2 } },
        },
      },
    })
    expect(ctx.llm.providerRetryPolicy('openai')).toEqual({
      mode: 'always',
      initialDelayMs: 25,
      maxDelayMs: 100,
      jitterRatio: 0.2,
    })
    expect(ctx.llm.listProviders().map(provider => provider.id)).toEqual(['openai'])
  })

  it('atomically replaces credential references for an accepted route update', async () => {
    const dir = await home()
    let consumerRoutes: Array<{ routeId: string; reference: string }> = []
    const replace = vi.fn((routes: typeof consumerRoutes) => {
      consumerRoutes = routes.map(route => ({ ...route }))
    })
    const ctx = await boot(
      dir,
      { providers: { openai: { apiKeyEnv: 'PI_LIVE_KEY' } } },
      {
        registerPiAiModels(routes: typeof consumerRoutes) {
          consumerRoutes = routes.map(route => ({ ...route }))
          return { replace, dispose: vi.fn() }
        },
      },
    )
    replace.mockClear()

    await ctx.settings.update(NS, {
      providers: { openai: { apiKeyEnv: 'PI_OTHER_KEY' } },
    })
    await vi.waitFor(() => {
      expect(consumerRoutes).toEqual([
        { routeId: 'openai', reference: credentialRef('PI_OTHER_KEY') },
      ])
    })
    expect(replace).toHaveBeenCalledTimes(1)
  })

  it('redacts a malformed dynamic reference and retains the accepted routes and consumers', async () => {
    const privateReference = 'sk-live-pi-dynamic-P1/secret'
    const dir = await home()
    let consumerRoutes: Array<{ routeId: string; reference: string }> = []
    const replace = vi.fn((routes: typeof consumerRoutes) => {
      consumerRoutes = routes.map(route => ({ ...route }))
    })
    const ctx = await boot(
      dir,
      { providers: { openai: { apiKeyEnv: 'PI_LIVE_KEY' } } },
      {
        registerPiAiModels(routes: typeof consumerRoutes) {
          consumerRoutes = routes.map(route => ({ ...route }))
          return { replace, dispose: vi.fn() }
        },
      },
    )
    replace.mockClear()
    const logged = vi.spyOn(ctx.logger, 'error').mockImplementation(() => undefined)

    const failure = await ctx.settings.update(NS, {
      providers: { openai: { apiKeyEnv: privateReference } },
    }).then(() => undefined, (error: unknown) => error)

    expect(failure).toBeInstanceOf(TypeError)
    expect((failure as Error).message).toBe('llm-pi-ai: invalid credential reference')
    expect(Object.hasOwn(failure as object, 'cause')).toBe(false)
    expect(consumerRoutes).toEqual([
      { routeId: 'openai', reference: credentialRef('PI_LIVE_KEY') },
    ])
    expect(replace).not.toHaveBeenCalled()
    expect(ctx.llm.listProviders().map(provider => provider.id)).toEqual(['openai'])
    const evidence = inspect([failure, logged.mock.calls], { depth: null, showHidden: true })
    expect(evidence).not.toContain(privateReference)
    expect(evidence).not.toContain('sk-live-pi-dynamic-P1')

    await ctx.settings.update(NS, {
      providers: { openai: { apiKeyEnv: 'PI_OTHER_KEY' } },
    })
    expect(consumerRoutes).toEqual([
      { routeId: 'openai', reference: credentialRef('PI_OTHER_KEY') },
    ])
    expect(replace).toHaveBeenCalledTimes(1)
  })

  it('refuses a settings write this adapter could not serve, leaving its routes alone', async () => {
    const dir = await home()
    const ctx = await boot(dir, { providers: { openai: {} } })

    // Shape-valid but unserviceable: a route the catalog does not ship and
    // that lists no models of its own. The section schema resolves the whole
    // profile set, so this is refused where it is written rather than stored
    // and then quietly disabling every route in the namespace.
    await expect(ctx.settings.update(NS, { providers: { 'not-a-real-provider': {} } }))
      .rejects.toThrow(/resolves no models/)
    expect(ctx.llm.listProviders().map(provider => provider.id)).toEqual(['openai'])
  })

  it('keeps serving its routes when a settings-born route collides with another adapter', async () => {
    const dir = await home()
    await writeFile(
      join(dir, '.credentials.yaml'),
      'PI_LIVE_KEY: live-key\nPI_OTHER_KEY: other\n',
      { mode: 0o600 },
    )
    const acceptedServer = await mockServer([{ events: textEvents }, { events: textEvents }])
    const rejectedServer = await mockServer([{ events: textEvents }])
    const discovery = await listingServer()
    let consumerRoutes: Array<{ routeId: string; reference: string }> = []
    const replaceConsumers = vi.fn((routes: typeof consumerRoutes) => {
      consumerRoutes = routes.map(route => ({ ...route }))
    })
    const disposeConsumers = vi.fn(() => {
      consumerRoutes = []
    })
    const registerPiAiModels = vi.fn((routes: typeof consumerRoutes) => {
      consumerRoutes = routes.map(route => ({ ...route }))
      return { replace: replaceConsumers, dispose: disposeConsumers }
    })
    const ctx = await boot(
      dir,
      {
        providers: {
          'acme-gateway': {
            displayName: 'Accepted Gateway',
            apiKeyEnv: 'PI_LIVE_KEY',
            api: 'openai-completions',
            baseURL: `${acceptedServer.url}/v1`,
            models: [{ id: 'accepted-model', contextWindow: 8192, maxTokens: 1024 }],
          },
        },
      },
      { registerPiAiModels },
    )
    expect(consumerRoutes).toEqual([
      { routeId: 'acme-gateway', reference: credentialRef('PI_LIVE_KEY') },
    ])
    replaceConsumers.mockClear()
    // Another adapter owns `anthropic`; the registry must refuse to hand it over.
    ctx.llm.registerAdapter(['anthropic'], new StubAdapter())

    await ctx.settings.update(NS, {
      providers: {
        'acme-gateway': {
          displayName: 'Rejected Gateway',
          apiKeyEnv: 'PI_OTHER_KEY',
          api: 'openai-completions',
          baseURL: `${rejectedServer.url}/v1`,
          models: [{ id: 'rejected-model', contextWindow: 16_384, maxTokens: 2048 }],
        },
        anthropic: { apiKeyEnv: 'PI_OTHER_KEY' },
      },
    })

    // The conflicting swap was refused whole: the previous route set still
    // owns acme-gateway (an eager dispose would have dropped it), and
    // anthropic still belongs to its original adapter.
    expect(ctx.llm.listProviders().map(provider => provider.id).sort()).toEqual(['acme-gateway', 'anthropic'])
    expect(consumerRoutes).toEqual([
      { routeId: 'acme-gateway', reference: credentialRef('PI_LIVE_KEY') },
    ])
    expect(replaceConsumers.mock.calls).toEqual([
      [[
        { routeId: 'acme-gateway', reference: credentialRef('PI_OTHER_KEY') },
        { routeId: 'anthropic', reference: credentialRef('PI_OTHER_KEY') },
      ]],
      [[
        { routeId: 'acme-gateway', reference: credentialRef('PI_LIVE_KEY') },
      ]],
    ])
    expect(ctx.llm.listConfigurableProviders().find(entry => entry.provider === 'acme-gateway')?.displayName)
      .toBe('Accepted Gateway')
    await expect(ctx.llm.listModels('acme-gateway')).resolves.toMatchObject([
      { id: 'accepted-model' },
    ])

    const result = await assemble(ctx, { provider: 'acme-gateway', model: 'accepted-model', messages: [] })
    expect(result.message.content).toEqual([{ type: 'text', text: 'hello' }])
    expect(acceptedServer.paths).toEqual(['/v1/chat/completions'])
    expect(acceptedServer.headers[0]?.authorization).toBe('Bearer live-key')
    expect(rejectedServer.paths).toEqual([])

    await ctx.llm.discoverModels('llm-pi-ai', {
      provider: 'acme-gateway',
      baseURL: discovery.url,
    })
    expect(discovery.headers[0]?.authorization).toBe('Bearer live-key')

    // Reverting to the working configuration re-applies, even though its
    // facts equal the ones the registry already holds.
    await ctx.settings.replace(NS, {})
    expect(ctx.llm.listProviders().map(provider => provider.id).sort()).toEqual(['acme-gateway', 'anthropic'])
    await assemble(ctx, { provider: 'acme-gateway', model: 'accepted-model', messages: [] })
    expect(acceptedServer.paths).toEqual(['/v1/chat/completions', '/v1/chat/completions'])
  })

  it('ignores a settings document that merely reorders its provider keys', async () => {
    const dir = await home()
    const ctx = await boot(dir, { providers: { openai: {}, anthropic: {} } })
    const before = ctx.llm.listProviders().map(provider => provider.id)

    // Same routes, different YAML key order: nothing about the registration
    // changed, so no swap should happen at all.
    await ctx.settings.update(NS, { providers: { anthropic: {}, openai: {} } })
    expect(ctx.llm.listProviders().map(provider => provider.id)).toEqual(before)
  })
})
