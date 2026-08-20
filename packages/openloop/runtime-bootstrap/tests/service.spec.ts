import { Context } from '@deepseek-ai/cordis'
import { describe, expect, test } from 'vitest'
import { installRuntimeBootstrap } from '../src/index.ts'

describe('runtime bootstrap Host service', () => {
  test('provides process-internal identity and atomically consumes the bootstrap token', () => {
    const ctx = new Context()
    const token = Uint8Array.from([1, 2, 3])
    const bridge = Uint8Array.from([4, 5, 6])

    const dispose = installRuntimeBootstrap(ctx, {
      launchId: '8f5d7e17-9b2b-4b2c-9c2a-1f3e6b2a4d90',
      bootstrapToken: token,
      bridgeSecret: bridge,
      socketPath: '/tmp/openloop-runtime.sock',
    })

    expect(ctx.runtimeBootstrap.launchId()).toBe('8f5d7e17-9b2b-4b2c-9c2a-1f3e6b2a4d90')
    expect(ctx.runtimeBootstrap.socketPath()).toBe('/tmp/openloop-runtime.sock')
    expect(ctx.runtimeBootstrap.consumeBootstrapToken()).toEqual(token)
    expect(ctx.runtimeBootstrap.consumeBootstrapToken()).toBeUndefined()
    expect(ctx.runtimeBootstrap.consumeBridgeSecret()).toEqual(bridge)
    expect(JSON.stringify(ctx.runtimeBootstrap)).not.toContain('1,2,3')
    expect(JSON.stringify(ctx.runtimeBootstrap)).not.toContain('4,5,6')
    expect((ctx.runtimeBootstrap as unknown as Record<string, unknown>).toJSON).toBeUndefined()

    dispose()
    expect(() => ctx.runtimeBootstrap.launchId()).toThrow()
  })

  test('does not expose a Typert Remote or Browser-facing package surface', async () => {
    const packageJson = await import('../package.json', { with: { type: 'json' } })
    const manifest = packageJson.default as unknown as {
      openloop: unknown
      exports: Record<string, unknown>
      dependencies?: unknown
    }
    expect(manifest.openloop).toEqual({ face: 'host' })
    expect(manifest.exports['./remote']).toBeUndefined()
    expect(manifest.dependencies).toBeUndefined()
  })
})
