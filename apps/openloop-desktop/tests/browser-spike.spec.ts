import { describe, expect, test } from 'vitest'
import {
  BROWSER_SPIKE_SCENARIOS,
  browserSpikeFixtureUrl,
} from './fixtures/browser-spike.ts'

describe('Openloop browser spike fixtures', () => {
  test('keeps the security regression scenario set stable', () => {
    expect(BROWSER_SPIKE_SCENARIOS).toEqual([
      'public-navigation',
      'loopback-fetch',
      'private-subresource',
      'websocket-upgrade',
      'public-to-private-redirect',
      'dns-rebinding',
    ])
  })

  test('builds stable fixture URLs from the default and supplied origins', () => {
    expect(browserSpikeFixtureUrl('dns-rebinding')).toBe(
      'https://example.com/openloop-browser-spike/dns-rebinding',
    )
    expect(browserSpikeFixtureUrl('loopback-fetch', 'http://127.0.0.1:1420')).toBe(
      'http://127.0.0.1:1420/openloop-browser-spike/loopback-fetch',
    )
  })
})
