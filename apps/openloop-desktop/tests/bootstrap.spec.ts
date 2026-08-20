import { describe, expect, test, vi } from 'vitest'
import {
  bootstrapFromLocation,
  parseBootstrapFragment,
  type BootstrapResponse,
} from '../src/bootstrap.ts'

const response: BootstrapResponse = {
  launchId: '8f5d7e17-9b2b-4b2c-9c2a-1f3e6b2a4d90',
  coreManifest: {
    appVersion: '0.1.0',
    channel: 'test',
  },
  coreManifestSha256: 'a'.repeat(64),
}

describe('Openloop Web bootstrap', () => {
  test('parses only the launch-bound fragment fields', () => {
    expect(parseBootstrapFragment('#bootstrap=secret-token&launch=launch-id')).toEqual({
      bootstrapToken: 'secret-token',
      launchId: 'launch-id',
    })
    expect(parseBootstrapFragment('')).toBeUndefined()
    expect(() => parseBootstrapFragment('#bootstrap=secret-token')).toThrow(/launch/iu)
    expect(() => parseBootstrapFragment('#launch=launch-id')).toThrow(/bootstrap/iu)
  })

  test('exchanges the fragment through a POST body and clears the visible history', async () => {
    const fetcher = vi.fn<typeof fetch>(async (input, init) => {
      expect(String(input)).toBe('/api/openloop/bootstrap')
      expect(String(input)).not.toContain('secret-token')
      expect(init?.method).toBe('POST')
      expect(init?.headers).toEqual({ 'content-type': 'application/json' })
      expect(String(init?.body)).toContain('secret-token')
      return new Response(JSON.stringify(response), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    })
    const history = { replaceState: vi.fn() }
    const location = {
      hash: `#bootstrap=secret-token&launch=${response.launchId}`,
      pathname: '/',
      search: '?ready=1',
    }

    await expect(bootstrapFromLocation({ fetcher, history, location })).resolves.toEqual(response)
    expect(history.replaceState).toHaveBeenCalledWith(null, '', '/?ready=1')
  })

  test('rejects a failed exchange without accepting a URL-supplied manifest', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response(
      JSON.stringify({ coreManifest: { appVersion: 'attacker' } }),
      { status: 401 },
    ))
    const history = { replaceState: vi.fn() }
    const location = {
      hash: '#bootstrap=secret-token&launch=launch-id',
      pathname: '/',
      search: '',
    }

    await expect(bootstrapFromLocation({ fetcher, history, location })).rejects.toThrow(/bootstrap exchange/iu)
    expect(history.replaceState).toHaveBeenCalledWith(null, '', '/')
  })

  test('refreshes without a fragment through the authenticated session cookie', async () => {
    const fetcher = vi.fn<typeof fetch>(async (input, init) => {
      expect(String(input)).toBe('/api/openloop/bootstrap')
      expect(init?.method).toBe('GET')
      expect(init?.credentials).toBe('same-origin')
      return new Response(JSON.stringify(response), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    })
    const history = { replaceState: vi.fn() }
    const location = { hash: '#foo=bar', pathname: '/', search: '' }

    await expect(bootstrapFromLocation({ fetcher, history, location })).resolves.toEqual(response)
    expect(history.replaceState).not.toHaveBeenCalled()
  })
})
