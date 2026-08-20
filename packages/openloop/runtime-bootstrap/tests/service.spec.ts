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
    }, {
      manifest: { appVersion: '0.1.0', channel: 'test' },
      sha256: 'a'.repeat(64),
    })

    expect(ctx.runtimeBootstrap.launchId()).toBe('8f5d7e17-9b2b-4b2c-9c2a-1f3e6b2a4d90')
    expect(ctx.runtimeBootstrap.socketPath()).toBe('/tmp/openloop-runtime.sock')
    expect(ctx.runtimeBootstrap.consumeBootstrapTokenIfMatches(Uint8Array.from([9, 9, 9]))).toBe('invalid')
    expect(ctx.runtimeBootstrap.consumeBootstrapTokenIfMatches(token)).toBe('consumed')
    expect(ctx.runtimeBootstrap.consumeBootstrapTokenIfMatches(token)).toBe('expired')
    expect(ctx.runtimeBootstrap.consumeBridgeSecret()).toEqual(bridge)
    const session = ctx.runtimeBootstrap.issueBootstrapSession()
    expect(session).toMatch(/^[0-9a-f]{64}$/u)
    expect(ctx.runtimeBootstrap.validateBootstrapSession(session)).toBe(true)
    expect(ctx.runtimeBootstrap.validateBootstrapSession('0'.repeat(64))).toBe(false)
    expect(ctx.runtimeBootstrap.coreManifest()).toEqual({ appVersion: '0.1.0', channel: 'test' })
    expect(ctx.runtimeBootstrap.coreManifestSha256()).toBe('a'.repeat(64))
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
