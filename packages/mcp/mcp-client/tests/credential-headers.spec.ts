import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http'
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

  it('preserves Request headers while preventing caller overrides of credential headers', async () => {
    const dispatch = vi.fn<typeof globalThis.fetch>(
      () => Promise.resolve(new Response(null, { status: 204 })),
    )
    const credentialFetch = createCredentialResolvingFetch({
      headers: { 'x-configured': 'configured' },
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
      },
    })

    await credentialFetch(request)

    const headers = new Headers(dispatch.mock.calls[0]?.[1]?.headers)
    expect(headers.get('authorization')).toBe('Bearer keychain-token')
    expect(headers.get('x-request')).toBe('preserved')
    expect(headers.get('x-configured')).toBe('configured')
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
    expect(() => {
      validateCredentialHeaders({}, { Authorization: { ref: 'not-a-reference' } })
    }).toThrow(/invalid credential reference/)
    expect(() => {
      validateCredentialHeaders({}, { Authorization: { ref: 'not-a-reference' } })
    }).not.toThrow(/not-a-reference/)
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
