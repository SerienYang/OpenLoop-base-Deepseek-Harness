/**
 * Tests for the mcp-client plugin's `apply` lifecycle entry point.
 * Isolated file so vi.mock of the MCP SDK doesn't pollute other test suites.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import type { Config } from '@deepseek-ai/dsh-mcp-client'

// ---- Mock MCP SDK ----

// vi.mock factories are hoisted above every import/const, so the mock fns and
// class must be created inside vi.hoisted to exist when the factories run.
const {
  mockConnect,
  mockClose,
  mockListTools,
  mockCallTool,
  mockSetNotificationHandler,
  MockClient,
  MockStreamableHTTPClientTransport,
} = vi.hoisted(() => {
  const mockConnect = vi.fn<(_transport?: unknown) => Promise<void>>()
  const mockClose = vi.fn<() => Promise<void>>()
  const mockListTools = vi.fn<(_params?: Record<string, unknown>) => Promise<unknown>>()
  const mockCallTool = vi.fn<(
    _params?: Record<string, unknown>, _compatibilitySchema?: unknown, _options?: unknown,
  ) => Promise<unknown>>()
  const mockSetNotificationHandler = vi.fn()
  const mockRequest = vi.fn(async (
    request: { method: string; params?: Record<string, unknown> },
    _schema: unknown,
    options?: unknown,
  ): Promise<unknown> => {
    if (request.method === 'tools/list') return await mockListTools(request.params)
    if (request.method === 'tools/call') return await mockCallTool(request.params, undefined, options)
    throw new Error(`unexpected MCP request: ${request.method}`)
  })
  class MockClient {
    connect = mockConnect
    close = mockClose
    listTools = mockListTools
    callTool = mockCallTool
    request = mockRequest
    setNotificationHandler = mockSetNotificationHandler
  }
  class MockStreamableHTTPClientTransport {
    constructor(
      readonly _url: URL,
      readonly options: { fetch?: typeof globalThis.fetch },
    ) {}
  }
  return {
    mockConnect,
    mockClose,
    mockListTools,
    mockCallTool,
    mockSetNotificationHandler,
    MockClient,
    MockStreamableHTTPClientTransport,
  }
})

vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({
  Client: MockClient,
}))

vi.mock('@modelcontextprotocol/sdk/client/stdio.js', () => ({
  StdioClientTransport: vi.fn(),
}))

vi.mock('@modelcontextprotocol/sdk/client/streamableHttp.js', () => ({
  StreamableHTTPClientTransport: MockStreamableHTTPClientTransport,
}))

// vi.mock is hoisted above static imports, so the module under test sees the
// mocked SDK even through a static import.
import { apply, name, inject, Config as ConfigSchema } from '@deepseek-ai/dsh-mcp-client/src/index.ts'

// ---- Helpers ----

async function mountRegistry(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  return ctx
}

function sleep(ms: number): Promise<void> {
  // Annotated binding (not withResolvers<void>()): the tests lint layer runs
  // no-invalid-void-type with default options, which rejects the explicit
  // type argument in call position but accepts the inferred form.
  const gate: PromiseWithResolvers<void> = Promise.withResolvers()
  setTimeout(gate.resolve, ms)
  return gate.promise
}

const stdioConfig: Config = {
  transport: 'stdio',
  serverName: 'srv',
  command: 'echo',
  args: [],
  env: {},
  cwd: '',
  toolCallTimeoutMs: 60_000,
  failOnStartupError: false,
}

// ---- Tests ----

describe('mcp-client plugin module exports', () => {
  it('exports name, inject, and Config', () => {
    expect(name).toBe('mcp-client')
    expect(inject).toEqual(['tools'])
    expect(ConfigSchema).toBeDefined()
  })

  it('Config schema rejects a missing serverName', () => {
    expect(() => ConfigSchema({
      transport: 'stdio',
      command: 'echo',
    } as never)).toThrow()
  })

  it('Config schema rejects an invalid serverName', () => {
    // schemastery unions wrap branch errors in a generic "expected ... but got"
    // message, so assert the throw, not the inner pattern text.
    expect(() => ConfigSchema({
      transport: 'stdio',
      serverName: 'bad name!',
      command: 'echo',
    } as never)).toThrow()
    expect(() => ConfigSchema({
      transport: 'stdio',
      serverName: 'x'.repeat(33),
      command: 'echo',
    } as never)).toThrow()
  })

  it('Config schema accepts a valid serverName', () => {
    const resolved = ConfigSchema({
      transport: 'stdio',
      serverName: 'github-prod_1',
      command: 'echo',
    } as never)
    expect(resolved.serverName).toBe('github-prod_1')
  })

  it('Config schema materializes reconnect defaults and merges partial overrides', () => {
    const omitted = ConfigSchema({
      transport: 'stdio',
      serverName: 'srv',
      command: 'echo',
    } as never)
    expect(omitted.reconnect).toEqual({ enabled: true, initialDelayMs: 500, maxDelayMs: 30_000, maxAttempts: 10 })

    const partial = ConfigSchema({
      transport: 'stdio',
      serverName: 'srv',
      command: 'echo',
      reconnect: { initialDelayMs: 100 },
    } as never)
    expect(partial.reconnect).toEqual({ enabled: true, initialDelayMs: 100, maxDelayMs: 30_000, maxAttempts: 10 })
  })

  it('Config schema rejects an invalid reconnect block', () => {
    // schemastery unions wrap branch errors, so assert the throw only.
    expect(() => ConfigSchema({
      transport: 'stdio',
      serverName: 'srv',
      command: 'echo',
      reconnect: { maxAttempts: 0 },
    } as never)).toThrow()
  })
})

describe('apply (plugin lifecycle)', () => {
  let ctx: Context

  beforeEach(async () => {
    vi.clearAllMocks()
    mockConnect.mockResolvedValue(undefined)
    mockClose.mockImplementation(function (this: { onclose?: () => void }) {
      this.onclose?.()
      return Promise.resolve()
    })
    mockListTools.mockResolvedValue({
      tools: [{ name: 'remote', description: 'A remote tool', inputSchema: { type: 'object' } }],
      nextCursor: undefined,
    })
    mockCallTool.mockResolvedValue({ content: [{ type: 'text', text: 'ok' }] })
    ctx = await mountRegistry()
  })

  it('connects, syncs tools under the namespace, and registers a notification handler', async () => {
    await apply(ctx, stdioConfig)

    expect(mockConnect).toHaveBeenCalled()
    expect(mockListTools).toHaveBeenCalled()
    expect(mockSetNotificationHandler).toHaveBeenCalled()
    expect(ctx.tools.get('mcp__srv__remote')).toBeDefined()
    expect(ctx.tools.get('remote')).toBeUndefined()
  })

  it('registers only explicit HTTP credential references as MCP consumers', async () => {
    const disposeConsumer = vi.fn()
    const registerMcpServer = vi.fn(() => disposeConsumer)
    ctx.provide('credentialConsumers', { registerMcpServer } as never)

    const fiber = ctx.plugin({ name: 'mcp-client-credential-owner', inject, apply }, {
      transport: 'streamable-http',
      serverName: 'github',
      url: 'https://mcp.example.test',
      headers: { 'x-tenant': 'literal' },
      credentialHeaders: {
        Authorization: { ref: 'GITHUB_MCP_TOKEN', prefix: 'Bearer ' },
      },
      toolCallTimeoutMs: 60_000,
      failOnStartupError: false,
    })
    await fiber

    expect(registerMcpServer).toHaveBeenCalledWith('github', 'GITHUB_MCP_TOKEN')
    await fiber.dispose()
    expect(disposeConsumer).toHaveBeenCalledTimes(1)
  })

  it('aborts activation before connecting or publishing tools when initial consumer registration fails', async () => {
    ctx.provide('credentialConsumers', {
      registerMcpServer: vi.fn(() => {
        throw new Error('consumer registry refused MCP')
      }),
    } as never)

    const failure = await ctx.plugin({ name: 'mcp-client-rejected-credential-owner', inject, apply }, {
      transport: 'streamable-http',
      serverName: 'rejected',
      url: 'https://mcp.example.test',
      headers: {},
      credentialHeaders: {
        Authorization: { ref: 'REJECTED_MCP_TOKEN', prefix: 'Bearer ' },
      },
      toolCallTimeoutMs: 60_000,
      failOnStartupError: false,
    }).then(() => undefined, (error: unknown) => error)

    expect(failure).toBeInstanceOf(Error)
    expect((failure as Error).message).toMatch(/consumer registry refused MCP/)
    expect(mockConnect).not.toHaveBeenCalled()
    expect(mockListTools).not.toHaveBeenCalled()
    expect(ctx.tools.get('mcp__rejected__remote')).toBeUndefined()
  })

  it('moves its credential consumer registration with registry service replacement', async () => {
    const firstDispose = vi.fn()
    const secondDispose = vi.fn()
    const firstRegister = vi.fn(() => firstDispose)
    const secondRegister = vi.fn(() => secondDispose)
    const fiber = ctx.plugin({ name: 'mcp-client-dynamic-credential-owner', inject, apply }, {
      transport: 'streamable-http',
      serverName: 'dynamic',
      url: 'https://mcp.example.test',
      headers: {},
      credentialHeaders: {
        Authorization: { ref: 'DYNAMIC_MCP_TOKEN', prefix: 'Bearer ' },
      },
      toolCallTimeoutMs: 60_000,
      failOnStartupError: false,
    })
    await fiber
    expect(firstRegister).not.toHaveBeenCalled()

    const firstProvider = ctx.plugin({
      name: 'first-credential-consumer-registry',
      apply(serviceCtx: Context) {
        serviceCtx.provide('credentialConsumers', {
          registerMcpServer: firstRegister,
        } as never)
      },
    })
    await firstProvider
    await vi.waitFor(() => {
      expect(firstRegister).toHaveBeenCalledWith('dynamic', 'DYNAMIC_MCP_TOKEN')
    })

    await firstProvider.dispose()
    await vi.waitFor(() => {
      expect(firstDispose).toHaveBeenCalledTimes(1)
    })
    const secondProvider = ctx.plugin({
      name: 'second-credential-consumer-registry',
      apply(serviceCtx: Context) {
        serviceCtx.provide('credentialConsumers', {
          registerMcpServer: secondRegister,
        } as never)
      },
    })
    await secondProvider
    await vi.waitFor(() => {
      expect(secondRegister).toHaveBeenCalledWith('dynamic', 'DYNAMIC_MCP_TOKEN')
    })

    await fiber.dispose()
    expect(secondDispose).toHaveBeenCalledTimes(1)
    await secondProvider.dispose()
  })

  it('keeps stdio env values literal and out of the credential registry', async () => {
    const registerMcpServer = vi.fn()
    ctx.provide('credentialConsumers', { registerMcpServer } as never)

    await apply(ctx, {
      ...stdioConfig,
      env: { API_TOKEN: 'literal-child-value' },
    })

    expect(registerMcpServer).not.toHaveBeenCalled()
  })

  it('keeps the Cordis plugin loading until initial discovery publishes its tools', async () => {
    const connection: PromiseWithResolvers<void> = Promise.withResolvers()
    mockConnect.mockImplementation(async () => {
      await connection.promise
    })
    const fiber = ctx.plugin({ name: 'mcp-client-lifecycle', inject, apply }, stdioConfig)
    let activated = false
    const activation = Promise.resolve(fiber).then(() => { activated = true })

    await vi.waitFor(() => { expect(mockConnect).toHaveBeenCalled() })
    expect(activated).toBe(false)
    expect(ctx.tools.get('mcp__srv__remote')).toBeUndefined()

    connection.resolve()
    await activation
    expect(ctx.tools.get('mcp__srv__remote')).toBeDefined()
    await fiber.dispose()
  })

  it('rejects a duplicate serverName at load and leaves the first instance intact', async () => {
    await apply(ctx, stdioConfig)
    expect(ctx.tools.get('mcp__srv__remote')).toBeDefined()

    await expect(apply(ctx, stdioConfig)).rejects.toThrow(/serverName "srv" is already in use/)
    expect(ctx.tools.get('mcp__srv__remote')).toBeDefined()
  })

  it('releases the serverName reservation on dispose', async () => {
    const first = new Context()
    await first.plugin(SystemPrompt)
    await first.plugin(ToolRuntime)
    await apply(first, stdioConfig)

    await first.fiber.dispose()
    await sleep(50)

    // Same root would conflict; a fresh app root reuses the name freely,
    // and the disposed instance no longer holds the reservation on its root.
    const second = new Context()
    await second.plugin(SystemPrompt)
    await second.plugin(ToolRuntime)
    await expect(apply(second, stdioConfig)).resolves.toBeUndefined()
    await second.fiber.dispose()
  })

  it('scopes serverName reservations per app root', async () => {
    const other = await mountRegistry()

    const first = apply(ctx, stdioConfig)
    // Same serverName on a DIFFERENT root is fine.
    const second = apply(other, stdioConfig)
    await Promise.all([first, second])

    expect(ctx.tools.get('mcp__srv__remote')).toBeDefined()
    expect(other.tools.get('mcp__srv__remote')).toBeDefined()
  })

  it('logs error and registers no tools when connect fails; dispose closes the client', async () => {
    mockConnect.mockRejectedValue(new Error('connection refused'))

    await apply(ctx, stdioConfig)

    expect(mockListTools).not.toHaveBeenCalled()
    expect(ctx.tools.get('mcp__srv__remote')).toBeUndefined()

    // Disposal cancels the scheduled reconnect attempt: nothing to
    // unregister, close already attempted by the failed attempt, no throw.
    await ctx.fiber.dispose()
    await sleep(50)
    expect(mockClose).toHaveBeenCalled()
  })

  it('redacts credential resolver failures from startup and reconnect logs', async () => {
    const privateReference = 'PRIVATE_MCP_RESOLVER_REFERENCE'
    const privateSecret = 'mcp-private-secret'
    const authorization = `Authorization: Bearer ${privateSecret}`
    const diagnostics: string[] = []
    ctx.logger.warn = ((message: unknown) => {
      diagnostics.push(String(message))
    }) as typeof ctx.logger.warn
    ctx.logger.error = ((message: unknown) => {
      diagnostics.push(String(message))
    }) as typeof ctx.logger.error
    ctx.provide('credentials', {
      resolve: vi.fn(() => Promise.reject(
        new Error(`${privateReference} ${authorization}`),
      )),
    } as never)
    mockConnect.mockImplementation(async (transport: unknown) => {
      const http = transport as InstanceType<typeof MockStreamableHTTPClientTransport>
      await http.options.fetch!('https://mcp.example.test')
    })

    await apply(ctx, {
      transport: 'streamable-http',
      serverName: 'secret-log',
      url: 'https://mcp.example.test',
      headers: {},
      credentialHeaders: {
        Authorization: { ref: privateReference, prefix: 'Bearer ' },
      },
      toolCallTimeoutMs: 60_000,
      failOnStartupError: false,
      reconnect: { enabled: true, initialDelayMs: 1, maxDelayMs: 1, maxAttempts: 1 },
    })
    await vi.waitFor(() => {
      expect(mockConnect).toHaveBeenCalledTimes(2)
    })

    const serialized = diagnostics.join('\n')
    expect(serialized).toContain('mcp-client: configured credential could not be resolved')
    expect(serialized).not.toContain(privateReference)
    expect(serialized).not.toContain(privateSecret)
    expect(serialized).not.toContain(authorization)
  })

  it('rejects activation and still closes the client when startup failure is configured as fatal', async () => {
    const cause = new Error('connection refused')
    mockConnect.mockRejectedValue(cause)
    await expect(apply(ctx, {
      ...stdioConfig,
      failOnStartupError: true,
    })).rejects.toMatchObject({
      message: 'mcp-client(srv): initial connection or tool synchronization failed',
      cause,
    })

    expect(mockListTools).not.toHaveBeenCalled()
    expect(ctx.tools.get('mcp__srv__remote')).toBeUndefined()
    await ctx.fiber.dispose()
    expect(mockClose).toHaveBeenCalled()
  })

  it('retains only a cause-free generic credential failure on fatal startup', async () => {
    const privateReference = 'PRIVATE_MCP_FATAL_REFERENCE'
    const privateSecret = 'mcp-fatal-private-secret'
    const authorization = `Authorization: Bearer ${privateSecret}`
    ctx.provide('credentials', {
      resolve: vi.fn(() => Promise.reject(
        new Error(`${privateReference} ${authorization}`),
      )),
    } as never)
    mockConnect.mockImplementation(async (transport: unknown) => {
      const http = transport as InstanceType<typeof MockStreamableHTTPClientTransport>
      await http.options.fetch!('https://mcp.example.test')
    })

    const failure = await apply(ctx, {
      transport: 'streamable-http',
      serverName: 'secret-fatal',
      url: 'https://mcp.example.test',
      headers: {},
      credentialHeaders: {
        Authorization: { ref: privateReference, prefix: 'Bearer ' },
      },
      toolCallTimeoutMs: 60_000,
      failOnStartupError: true,
      reconnect: { enabled: false },
    }).then(() => undefined, (error: unknown) => error)

    expect(failure).toBeInstanceOf(Error)
    const startup = failure as Error
    expect(startup.message).toBe(
      'mcp-client(secret-fatal): initial connection or tool synchronization failed',
    )
    expect(startup.cause).toBeInstanceOf(Error)
    expect((startup.cause as Error).message)
      .toBe('mcp-client: configured credential could not be resolved')
    expect((startup.cause as Error).cause).toBeUndefined()
    const serialized = `${startup.stack}\n${String(startup.cause)}`
    expect(serialized).not.toContain(privateReference)
    expect(serialized).not.toContain(privateSecret)
    expect(serialized).not.toContain(authorization)
  })

  it('rejects strict startup when the initial tool generation cannot be registered', async () => {
    ctx.tools.register({
      name: 'mcp__srv__remote',
      description: 'Foreign squatter',
      parameters: { type: 'object' },
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: value as string }],
      },
      execute: async () => 'foreign',
    })

    await expect(apply(ctx, {
      ...stdioConfig,
      failOnStartupError: true,
    })).rejects.toThrow('initial connection or tool synchronization failed')

    expect(ctx.tools.get('mcp__srv__remote')).toBeDefined()
    await ctx.fiber.dispose()
    expect(mockClose).toHaveBeenCalled()
  })

  it('preserves strict startup registration when list_changed arrives before connect resolves', async () => {
    ctx.tools.register({
      name: 'mcp__srv__remote',
      description: 'Foreign squatter',
      parameters: { type: 'object' },
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: value as string }],
      },
      execute: async () => 'foreign',
    })
    mockConnect.mockImplementation(async () => {
      const handler = mockSetNotificationHandler.mock.calls[0]![1] as () => Promise<void>
      await handler()
    })

    await expect(apply(ctx, {
      ...stdioConfig,
      failOnStartupError: true,
    })).rejects.toThrow('initial connection or tool synchronization failed')

    expect(mockListTools).toHaveBeenCalledTimes(2)
    expect(ctx.tools.get('mcp__srv__remote')?.description).toBe('Foreign squatter')
    await ctx.fiber.dispose()
  })

  it('re-syncs tools on ToolListChanged notification', async () => {
    await apply(ctx, stdioConfig)

    expect(ctx.tools.get('mcp__srv__remote')).toBeDefined()

    mockListTools.mockResolvedValue({
      tools: [{ name: 'updated', inputSchema: { type: 'object' } }],
      nextCursor: undefined,
    })

    const handler = mockSetNotificationHandler.mock.calls[0]![1] as () => Promise<void>
    await handler()

    expect(ctx.tools.get('mcp__srv__remote')).toBeUndefined()
    expect(ctx.tools.get('mcp__srv__updated')).toBeDefined()
  })

  it('keeps the previous generation when a re-sync fails', async () => {
    await apply(ctx, stdioConfig)
    expect(ctx.tools.get('mcp__srv__remote')).toBeDefined()

    mockListTools.mockRejectedValue(new Error('flaky server'))
    const handler = mockSetNotificationHandler.mock.calls[0]![1] as () => Promise<void>
    // Must not reject (contained), and must keep the last good generation.
    await handler()

    expect(ctx.tools.get('mcp__srv__remote')).toBeDefined()
  })

  it('effect disposer unregisters the CURRENT generation and closes client', async () => {
    // Load through ctx.plugin so ONLY the plugin's fiber is disposed — the
    // registry must survive to observe the unregistration.
    const fiber = ctx.plugin({ name: 'mcp-client', inject: ['tools'], apply }, stdioConfig)
    await fiber

    // Advance to a second generation first.
    mockListTools.mockResolvedValue({
      tools: [{ name: 'updated', inputSchema: { type: 'object' } }],
      nextCursor: undefined,
    })
    const handler = mockSetNotificationHandler.mock.calls[0]![1] as () => Promise<void>
    await handler()
    expect(ctx.tools.get('mcp__srv__updated')).toBeDefined()

    await fiber.dispose()
    await sleep(50)

    expect(mockClose).toHaveBeenCalled()
    // The live (second) generation was unregistered, not just the first.
    expect(ctx.tools.get('mcp__srv__updated')).toBeUndefined()
  })

  it('effect disposer handles client.close failure gracefully', async () => {
    mockClose.mockImplementation(function (this: { onclose?: () => void }) {
      this.onclose?.()
      return Promise.reject(new Error('already closed'))
    })

    await apply(ctx, stdioConfig)

    // Should not throw when dispose is triggered.
    await ctx.fiber.dispose()
    await sleep(50)

    expect(mockClose).toHaveBeenCalled()
  })

  it('uses streamable-http config path', async () => {
    const httpConfig: Config = {
      transport: 'streamable-http',
      serverName: 'web',
      url: 'http://localhost:3000/mcp',
      headers: { Authorization: 'Bearer x' },
      toolCallTimeoutMs: 30_000,
      failOnStartupError: false,
    }

    await apply(ctx, httpConfig)

    expect(mockConnect).toHaveBeenCalled()
    expect(ctx.tools.get('mcp__web__remote')).toBeDefined()
  })
})
