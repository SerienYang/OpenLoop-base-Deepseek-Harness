import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = resolve(import.meta.dirname, '../../../..')
const read = (path: string): string => readFileSync(resolve(root, path), 'utf8')

describe('chat zoom package contract', () => {
  it('is one immediate private Client plugin with the required browser edges', () => {
    const manifest = JSON.parse(read('packages/openloop/chat-zoom/package.json')) as {
      private: boolean
      openloop: { face: string; cordisPlugin: boolean }
      dsh: { client: { inject: string[]; platform: string; immediately: boolean } }
    }
    expect(manifest.private).toBe(true)
    expect(manifest.openloop).toEqual({ face: 'client', cordisPlugin: true })
    expect(manifest.dsh.client).toEqual({
      inject: [
        '@deepseek-ai/dsh-client-connection',
        '@deepseek-ai/dsh-client-runtime',
        '@deepseek-ai/dsh-client-ui-settings',
        '@deepseek-ai/dsh-api-remotes',
      ],
      platform: 'web',
      immediately: true,
    })
  })

  it('is registered exactly once in the Openloop bundle and Client aggregate', () => {
    const patch = read('packages/openloop/bundle/cordis.patch.yml')
    const aggregate = read('tsconfig.client.json')
    expect(patch.match(/id: chat-zoom/gu)).toHaveLength(1)
    expect(patch).toContain("name: '@openloop/chat-zoom'")
    expect(aggregate.match(/packages\/openloop\/chat-zoom/gu)).toHaveLength(1)
  })
})
