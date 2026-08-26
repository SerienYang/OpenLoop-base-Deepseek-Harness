import { credentialRef } from '@deepseek-ai/dsh-credentials'
import {
  createCredentialResolvingFetch,
  validateCredentialHeaders,
} from '@deepseek-ai/dsh-mcp-client/src/transport.ts'
import { describe, expect, it, vi } from 'vitest'

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
    }).toThrow(/credential ref/)
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
