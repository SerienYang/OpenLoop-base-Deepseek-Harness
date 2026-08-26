import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http'
import { inspect } from 'node:util'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import {
  createCredentialResolvingFetch,
  validateCredentialHeaders,
} from '@deepseek-ai/dsh-mcp-client/src/transport.ts'
import { describe, expect, it, vi } from 'vitest'

async function listen(
  handler: (request: IncomingMessage, response: ServerResponse) => void,
): Promise<{ readonly url: string; close(): Promise<void> }> {
  const server = createServer(handler)
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('test server address unavailable')
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error === undefined) resolve()
        else reject(error)
      })
    }),
  }
}

describe('MCP credential-backed HTTP headers', () => {
  it('resolves a credential for every HTTP request and preserves literal headers', async () => {
    const resolve = vi.fn()
      .mockResolvedValueOnce({ value: 'first-token', source: 'keychain' })
      .mockResolvedValueOnce({ value: 'rotated-token', source: 'keychain' })
    const dispatch = vi.fn<typeof globalThis.fetch>(
      () => Promise.resolve(new Response(null, { status: 204 })),
    )
    const credentialFetch = createCredentialResolvingFetch({
      headers: { 'x-tenant': 'literal' },
      credentialHeaders: {
        Authorization: { ref: credentialRef('MCP_API_KEY'), prefix: 'Bearer ' },
      },
      resolve,
      fetch: dispatch,
    })

    await credentialFetch(new URL('https://mcp.example.test'), { method: 'POST' })
    await credentialFetch(new URL('https://mcp.example.test'), { method: 'POST' })

    expect(resolve).toHaveBeenCalledTimes(2)
    expect(resolve).toHaveBeenNthCalledWith(1, credentialRef('MCP_API_KEY'))
    expect(new Headers(dispatch.mock.calls[0]?.[1]?.headers).get('authorization'))
      .toBe('Bearer first-token')
    expect(new Headers(dispatch.mock.calls[1]?.[1]?.headers).get('authorization'))
      .toBe('Bearer rotated-token')
    expect(new Headers(dispatch.mock.calls[1]?.[1]?.headers).get('x-tenant'))
      .toBe('literal')
  })

  it('resolves each distinct reference once per request and snapshots shared-header rotation', async () => {
    const generations = new Map<string, number>()
    const resolve = vi.fn((reference: string) => {
      const generation = (generations.get(reference) ?? 0) + 1
      generations.set(reference, generation)
      return Promise.resolve({
        value: `${reference}-generation-${generation}`,
        source: 'keychain',
      })
    })
    const dispatch = vi.fn<typeof globalThis.fetch>(
      () => Promise.resolve(new Response(null, { status: 204 })),
    )
    const credentialFetch = createCredentialResolvingFetch({
      headers: {},
      credentialHeaders: {
        Authorization: { ref: credentialRef('SHARED_KEY'), prefix: 'Bearer ' },
        'x-api-key': { ref: credentialRef('SHARED_KEY') },
        'x-other-key': { ref: credentialRef('OTHER_KEY') },
      },
      resolve,
      fetch: dispatch,
    })

    await credentialFetch('https://mcp.example.test')
    await credentialFetch('https://mcp.example.test')

    expect(resolve).toHaveBeenCalledTimes(4)
    expect(resolve.mock.calls.filter(([reference]) => reference === 'SHARED_KEY')).toHaveLength(2)
    expect(resolve.mock.calls.filter(([reference]) => reference === 'OTHER_KEY')).toHaveLength(2)
    const first = new Headers(dispatch.mock.calls[0]?.[1]?.headers)
    expect(first.get('authorization')).toBe('Bearer SHARED_KEY-generation-1')
    expect(first.get('x-api-key')).toBe('SHARED_KEY-generation-1')
    expect(first.get('x-other-key')).toBe('OTHER_KEY-generation-1')
    const second = new Headers(dispatch.mock.calls[1]?.[1]?.headers)
    expect(second.get('authorization')).toBe('Bearer SHARED_KEY-generation-2')
    expect(second.get('x-api-key')).toBe('SHARED_KEY-generation-2')
    expect(second.get('x-other-key')).toBe('OTHER_KEY-generation-2')
  })

  it('merges configured, Request, and init headers before applying credentials last', async () => {
    const dispatch = vi.fn<typeof globalThis.fetch>(
      () => Promise.resolve(new Response(null, { status: 204 })),
    )
    const credentialFetch = createCredentialResolvingFetch({
      headers: {
        'x-configured': 'configured',
        'x-precedence': 'configured',
      },
      credentialHeaders: {
        Authorization: { ref: credentialRef('MCP_API_KEY'), prefix: 'Bearer ' },
      },
      resolve: vi.fn(() => Promise.resolve({
        value: 'keychain-token',
        source: 'keychain',
      })),
      fetch: dispatch,
    })
    const request = new Request('https://mcp.example.test', {
      headers: {
        Authorization: 'request-controlled',
        'x-request': 'preserved',
        'x-precedence': 'request',
      },
    })

    await credentialFetch(request, {
      headers: {
        Authorization: 'init-controlled',
        'x-init': 'preserved',
        'x-precedence': 'init',
      },
    })

    const headers = new Headers(dispatch.mock.calls[0]?.[1]?.headers)
    expect(headers.get('authorization')).toBe('Bearer keychain-token')
    expect(headers.get('x-request')).toBe('preserved')
    expect(headers.get('x-init')).toBe('preserved')
    expect(headers.get('x-configured')).toBe('configured')
    expect(headers.get('x-precedence')).toBe('init')
  })

  it.each([
    ['Request.signal', (signal: AbortSignal) => ({
      input: new Request('https://mcp.example.test', { signal }),
      init: undefined,
    })],
    ['init.signal', (signal: AbortSignal) => ({
      input: 'https://mcp.example.test',
      init: { signal },
    })],
  ] as const)('settles promptly on %s while resolution stalls and contains a late rejection', async (
    _label,
    requestOf,
  ) => {
    const stalled: PromiseWithResolvers<never> = Promise.withResolvers()
    const dispatch = vi.fn<typeof globalThis.fetch>(
      () => Promise.resolve(new Response(null, { status: 204 })),
    )
    const credentialFetch = createCredentialResolvingFetch({
      headers: {},
      credentialHeaders: {
        Authorization: { ref: credentialRef('MCP_API_KEY'), prefix: 'Bearer ' },
      },
      resolve: vi.fn(() => stalled.promise),
      fetch: dispatch,
    })
    const controller = new AbortController()
    const abort = new Error('request aborted')
    const { input, init } = requestOf(controller.signal)
    const pending = credentialFetch(input, init)
      .then(() => 'resolved' as const, (error: unknown) => error)
    const unhandled: unknown[] = []
    const onUnhandled = (error: unknown): void => {
      unhandled.push(error)
    }
    process.on('unhandledRejection', onUnhandled)

    try {
      controller.abort(abort)
      const outcome = await Promise.race([
        pending,
        new Promise<'timed-out'>(resolve => setTimeout(() => { resolve('timed-out') }, 100)),
      ])
      expect(outcome).toBe(abort)
      expect(dispatch).not.toHaveBeenCalled()

      stalled.reject(new Error('late provider failure'))
      await new Promise<void>(resolve => setImmediate(resolve))
      expect(unhandled).toEqual([])
    } finally {
      process.off('unhandledRejection', onUnhandled)
    }
  })

  it('removes malicious non-success bodies, headers, and status text before returning', async () => {
    const privateReference = 'MCP_ECHO_REFERENCE'
    const privateToken = 'mcp-echo-token'
    const server = await listen((request, response) => {
      const authorization = request.headers.authorization ?? ''
      response.writeHead(500, `${privateReference}-${privateToken}`, {
        'x-echo-authorization': authorization,
        'x-echo-reference': privateReference,
      })
      response.end(`${privateReference} ${authorization}`)
    })
    const credentialFetch = createCredentialResolvingFetch({
      headers: {},
      credentialHeaders: {
        Authorization: { ref: credentialRef(privateReference), prefix: 'Bearer ' },
      },
      resolve: vi.fn(() => Promise.resolve({
        value: privateToken,
        source: 'keychain',
      })),
    })

    try {
      const response = await credentialFetch(server.url)
      expect(response.status).toBe(500)
      expect(response.statusText).not.toContain(privateReference)
      expect(response.statusText).not.toContain(privateToken)
      expect([...response.headers]).toEqual([])
      expect(await response.text()).toBe('')
    } finally {
      await server.close()
    }
  })

  it('replaces HTTP 200 JSON-RPC errors while preserving successful JSON and streaming responses', async () => {
    const privateToken = 'mcp-json-rpc-echo-token'
    const reflected = new Response(JSON.stringify({
      jsonrpc: '2.0',
      id: 7,
      error: {
        code: -32_000,
        message: `Authorization: Bearer ${privateToken}`,
        data: {
          authorization: `Bearer ${privateToken}`,
          cause: new Error(privateToken),
        },
      },
    }), {
      status: 200,
      headers: {
        'content-type': 'application/json',
        'mcp-session-id': privateToken,
        'x-echo-authorization': `Bearer ${privateToken}`,
      },
    })
    const successful = new Response(
      JSON.stringify({ jsonrpc: '2.0', id: 8, result: { ok: true } }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )
    const streaming = new Response('event: message\ndata: {}\n\n', {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    })
    const dispatch = vi.fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(reflected)
      .mockResolvedValueOnce(successful)
      .mockResolvedValueOnce(streaming)
    const credentialFetch = createCredentialResolvingFetch({
      headers: {},
      credentialHeaders: {
        Authorization: { ref: credentialRef('MCP_API_KEY'), prefix: 'Bearer ' },
      },
      resolve: vi.fn(() => Promise.resolve({
        value: privateToken,
        source: 'keychain',
      })),
      fetch: dispatch,
    })

    const sanitized = await credentialFetch('https://mcp.example.test', {
      method: 'POST',
      body: JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'initialize' }),
    })
    const body = await sanitized.json() as unknown
    expect(body).toEqual({
      jsonrpc: '2.0',
      id: 7,
      error: {
        code: -32_000,
        message: 'mcp-client: credential-backed JSON-RPC request failed',
      },
    })
    expect([...sanitized.headers]).toEqual([['content-type', 'application/json']])
    expect(JSON.stringify(body)).not.toContain(privateToken)

    const successfulResult = await credentialFetch('https://mcp.example.test')
    expect(successfulResult).toBe(successful)
    await expect(successfulResult.json()).resolves.toEqual({
      jsonrpc: '2.0',
      id: 8,
      result: { ok: true },
    })
    const streamingResult = await credentialFetch('https://mcp.example.test')
    expect(streamingResult).toBe(streaming)
    await expect(streamingResult.text()).resolves.toBe('event: message\ndata: {}\n\n')
  })

  it('fails closed when an application/json response exceeds the inspection bound', async () => {
    const privateToken = 'mcp-oversized-error-token'
    const credentialFetch = createCredentialResolvingFetch({
      headers: {},
      credentialHeaders: {
        Authorization: { ref: credentialRef('MCP_API_KEY'), prefix: 'Bearer ' },
      },
      resolve: vi.fn(() => Promise.resolve({
        value: privateToken,
        source: 'keychain',
      })),
      fetch: vi.fn(() => Promise.resolve(new Response(JSON.stringify({
        jsonrpc: '2.0',
        id: 9,
        error: {
          code: -32_000,
          message: privateToken,
          data: 'x'.repeat(1024 * 1024),
        },
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }))),
    })

    const response = await credentialFetch('https://mcp.example.test')
    const body = await response.json() as unknown
    expect(body).toEqual({
      jsonrpc: '2.0',
      id: null,
      error: {
        code: -32_000,
        message: 'mcp-client: credential-backed JSON-RPC request failed',
      },
    })
    expect(JSON.stringify(body)).not.toContain(privateToken)
  })

  it.each([
    ['rejects', () => Promise.reject(new Error('response-secret cleanup failure'))],
    ['throws', () => {
      throw new Error('response-secret cleanup failure')
    }],
  ] as const)('keeps non-success response cleanup secret-safe when cancel %s', async (
    _label,
    cancel,
  ) => {
    const credentialFetch = createCredentialResolvingFetch({
      headers: {},
      credentialHeaders: {
        Authorization: { ref: credentialRef('MCP_API_KEY'), prefix: 'Bearer ' },
      },
      resolve: vi.fn(() => Promise.resolve({
        value: 'response-secret',
        source: 'keychain',
      })),
      fetch: vi.fn(() => Promise.resolve({
        status: 500,
        ok: false,
        body: {
          cancel,
        },
      } as unknown as Response)),
    })

    const result = await credentialFetch('https://mcp.example.test')
    expect(result.status).toBe(500)
    expect(await result.text()).toBe('')
    expect(JSON.stringify(result)).not.toContain('response-secret')
  })

  it('blocks credential-backed redirects before a second origin receives the secret', async () => {
    let targetAuthorization: string | undefined
    const target = await listen((request, response) => {
      targetAuthorization = request.headers.authorization
      response.writeHead(204)
      response.end()
    })
    const redirect = await listen((_request, response) => {
      response.writeHead(302, { location: `${target.url}/stolen` })
      response.end()
    })
    const credentialFetch = createCredentialResolvingFetch({
      headers: {},
      credentialHeaders: {
        Authorization: { ref: credentialRef('MCP_API_KEY'), prefix: 'Bearer ' },
      },
      resolve: vi.fn(() => Promise.resolve({
        value: 'redirect-secret',
        source: 'keychain',
      })),
    })

    try {
      await expect(credentialFetch(`${redirect.url}/start`, { redirect: 'follow' }))
        .rejects.toThrow(/credential-backed request redirect was blocked/)
      expect(targetAuthorization).toBeUndefined()
    } finally {
      await redirect.close()
      await target.close()
    }
  })

  it('keeps redirect errors secret-safe when response cleanup fails', async () => {
    const credentialFetch = createCredentialResolvingFetch({
      headers: {},
      credentialHeaders: {
        Authorization: { ref: credentialRef('MCP_API_KEY'), prefix: 'Bearer ' },
      },
      resolve: vi.fn(() => Promise.resolve({
        value: 'redirect-secret',
        source: 'keychain',
      })),
      fetch: vi.fn(() => Promise.resolve({
        status: 302,
        body: {
          cancel: () => Promise.reject(new Error('redirect-secret')),
        },
      } as unknown as Response)),
    })

    const failure = await credentialFetch('https://mcp.example.test')
      .then(() => undefined, (error: unknown) => error)
    expect(failure).toBeInstanceOf(Error)
    expect((failure as Error).message).toMatch(/credential-backed request redirect was blocked/)
    expect((failure as Error).message).not.toContain('redirect-secret')
  })

  it('rejects invalid, duplicated, or protocol-owned credential header names', () => {
    expect(() => {
      validateCredentialHeaders(
        { Authorization: 'literal' },
        { authorization: { ref: 'MCP_API_KEY' } },
      )
    }).toThrow(/duplicates a literal header/)
    expect(() => {
      validateCredentialHeaders({}, { 'bad header': { ref: 'MCP_API_KEY' } })
    }).toThrow(/invalid HTTP header name/)
    expect(() => {
      validateCredentialHeaders({}, { 'content-type': { ref: 'MCP_API_KEY' } })
    }).toThrow(/reserved MCP header/)
    const privateReference = 'sk-live-mcp-header-P1/secret'
    let invalidReferenceError: unknown
    try {
      validateCredentialHeaders({}, { Authorization: { ref: privateReference } })
    } catch (error) {
      invalidReferenceError = error
    }
    expect(invalidReferenceError).toBeInstanceOf(TypeError)
    expect((invalidReferenceError as Error).message)
      .toBe('mcp-client: invalid credential reference')
    expect(Object.hasOwn(invalidReferenceError as object, 'cause')).toBe(false)
    const evidence = inspect(invalidReferenceError, { depth: null, showHidden: true })
    expect(evidence).not.toContain(privateReference)
    expect(evidence).not.toContain('sk-live-mcp-header-P1')
  })

  it('fails closed for an absent or unsafe credential value without dispatching', async () => {
    const dispatch = vi.fn<typeof globalThis.fetch>(() => Promise.resolve(new Response()))
    const config = {
      headers: {},
      credentialHeaders: {
        Authorization: { ref: credentialRef('MCP_API_KEY'), prefix: 'Bearer ' },
      },
      fetch: dispatch,
    } as const

    const absent = createCredentialResolvingFetch({
      ...config,
      resolve: vi.fn(() => Promise.resolve(undefined)),
    })
    await expect(absent('https://mcp.example.test')).rejects.toThrow(/configured credential is not available/)

    const newline = createCredentialResolvingFetch({
      ...config,
      resolve: vi.fn(() => Promise.resolve({
        value: 'secret\r\nx-injected: yes',
        source: 'keychain',
      })),
    })
    await expect(newline('https://mcp.example.test')).rejects.toThrow(/unsafe HTTP header value/)
    await expect(newline('https://mcp.example.test')).rejects.not.toThrow(/MCP_API_KEY|secret/)
    expect(dispatch).not.toHaveBeenCalled()
  })
})
