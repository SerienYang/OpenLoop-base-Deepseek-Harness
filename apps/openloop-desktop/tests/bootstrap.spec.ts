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
    brand: {
      productName: 'Openloop',
      documentSuffix: 'Openloop',
      markAsset: 'data:image/svg+xml;base64,PHN2Zy8+',
      heroTitle: 'Openloop',
      previewLabel: 'Preview',
      attribution: 'Built on DeepSeek Harness',
    },
  },
  coreManifestSha256: 'a'.repeat(64),
}

function requestUrl(input: string | URL | Request): string {
  if (typeof input === 'string') return input
  return input instanceof URL ? input.href : input.url
}

function requestBody(body: BodyInit | null | undefined): string {
  if (typeof body !== 'string') throw new TypeError('bootstrap request body must be a string')
  return body
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
      const url = requestUrl(input)
      expect(url).toBe('/api/openloop/bootstrap')
      expect(url).not.toContain('secret-token')
      expect(init?.method).toBe('POST')
      expect(init?.headers).toEqual({ 'content-type': 'application/json' })
      expect(requestBody(init?.body)).toContain('secret-token')
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

    const result = await bootstrapFromLocation({ fetcher, history, location })
    expect(result).toEqual(response)
    expect(Object.isFrozen(result)).toBe(true)
    expect(Object.isFrozen(result?.coreManifest)).toBe(true)
    expect(Object.isFrozen(result?.coreManifest.brand)).toBe(true)
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
      expect(requestUrl(input)).toBe('/api/openloop/bootstrap')
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

  test('rejects a mutable or open-ended brand payload from the Host response', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({
      ...response,
      coreManifest: {
        ...response.coreManifest,
        brand: { ...response.coreManifest.brand, source: 'query' },
      },
    }), { status: 200 }))

    await expect(bootstrapFromLocation({
      fetcher,
      history: { replaceState: vi.fn() },
      location: { hash: '', pathname: '/', search: '' },
    })).rejects.toThrow(/verified|brand/iu)
  })
})
