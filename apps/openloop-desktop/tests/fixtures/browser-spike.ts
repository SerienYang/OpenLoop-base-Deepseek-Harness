export const BROWSER_SPIKE_SCENARIOS = [
  'public-navigation',
  'loopback-fetch',
  'private-subresource',
  'websocket-upgrade',
  'public-to-private-redirect',
  'dns-rebinding',
] as const

export type BrowserSpikeScenario = typeof BROWSER_SPIKE_SCENARIOS[number]

export function browserSpikeFixtureUrl(
  scenario: BrowserSpikeScenario,
  origin = 'https://example.com',
): string {
  return `${origin}/openloop-browser-spike/${scenario}`
}
