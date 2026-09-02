import { Context } from '@deepseek-ai/cordis'
import { describe, expect, test } from 'vitest'
import { installRuntimeBootstrap } from '../src/index.ts'

describe('runtime bootstrap Host service', () => {
  test('claims transactionally so failed completion retries and committed completion rejects replay', () => {
    const ctx = new Context()
    const token = Uint8Array.from([1, 2, 3])
    installRuntimeBootstrap(ctx, {
      launchId: '8f5d7e17-9b2b-4b2c-9c2a-1f3e6b2a4d90',
      bootstrapToken: token,
      bridgeSecret: Uint8Array.from([4, 5, 6]),
      socketPath: '/tmp/openloop-runtime.sock',
    })

    expect(ctx.runtimeBootstrap.claimBootstrapTokenIfMatches(Uint8Array.from([9, 9, 9])))
      .toEqual({ status: 'invalid' })
    const first = ctx.runtimeBootstrap.claimBootstrapTokenIfMatches(token)
    expect(first.status).toBe('claimed')
    if (first.status !== 'claimed') throw new Error('bootstrap token was not claimed')
    expect(first.claimId).toMatch(/^[0-9a-f]{64}$/u)
    expect(ctx.runtimeBootstrap.claimBootstrapTokenIfMatches(token)).toEqual(first)

    const session = ctx.runtimeBootstrap.issueBootstrapSession(first.claimId)
    expect(session).toMatch(/^[0-9a-f]{64}$/u)
    if (session === undefined) throw new Error('bootstrap session was not issued')
    expect(ctx.runtimeBootstrap.issueBootstrapSession(first.claimId)).toBe(session)
    expect(ctx.runtimeBootstrap.bootstrapCompletionState(session)).toBe('pending')
    expect(ctx.runtimeBootstrap.claimBootstrapCompletion(session)).toBe('claimed')
    ctx.runtimeBootstrap.releaseBootstrapCompletion(session)
    expect(ctx.runtimeBootstrap.claimBootstrapCompletion(session)).toBe('claimed')
    expect(ctx.runtimeBootstrap.commitBootstrapCompletion(session)).toBe(true)
    expect(ctx.runtimeBootstrap.bootstrapCompletionState(session)).toBe('local-committed')
    ctx.runtimeBootstrap.releaseBootstrapCompletion(session)
    expect(ctx.runtimeBootstrap.claimBootstrapCompletion(session)).toBe('local-committed')
    expect(ctx.runtimeBootstrap.claimBootstrapTokenIfMatches(token)).toEqual({ status: 'expired' })
    expect(ctx.runtimeBootstrap.markBootstrapCompletionAcknowledged(session)).toBe(true)
    expect(ctx.runtimeBootstrap.bootstrapCompletionState(session)).toBe('native-acknowledged')
    expect(ctx.runtimeBootstrap.claimBootstrapCompletion(session)).toBe('completed')
  })

  test('provides process-internal identity and consumes only the bridge secret directly', () => {
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
    expect(ctx.runtimeBootstrap.consumeBridgeSecret()).toEqual(bridge)
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
