import { randomBytes, timingSafeEqual } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'

export const RUNTIME_BOOTSTRAP_SERVICE = 'runtimeBootstrap'

export interface RuntimeLaunchSecrets {
  readonly launchId: string
  readonly bootstrapToken: Uint8Array
  readonly bridgeSecret: Uint8Array
  readonly socketPath: string
}

export interface RuntimeBuildIdentity {
  readonly manifest: Readonly<Record<string, unknown>>
  readonly sha256: string
}

export type BootstrapTokenResult = 'consumed' | 'invalid' | 'expired'

/**
 * Host-only service for one-time launch-secret handoff, bootstrap-session validation, and runtime build identity.
 * Its Cordis inspect entry documents an internal Host contract, not a public Plugin API;
 * Plugins must never receive raw bootstrap tokens or bridge secrets.
 */
export interface RuntimeBootstrap {
  readonly launchId: () => string
  readonly getLaunchId: () => string
  readonly socketPath: () => string
  readonly getSocketPath: () => string
  readonly consumeBootstrapToken: () => Uint8Array | undefined
  readonly consumeBootstrapTokenIfMatches: (actual: Uint8Array) => BootstrapTokenResult
  readonly consumeBridgeSecret: () => Uint8Array | undefined
  readonly issueBootstrapSession: () => string
  readonly validateBootstrapSession: (value: string) => boolean
  readonly coreManifest: () => Readonly<Record<string, unknown>> | undefined
  readonly coreManifestSha256: () => string | undefined
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    readonly runtimeBootstrap: RuntimeBootstrap
  }
}

/**
 * Install the private Host-only launch handoff. Secret bytes live in closures,
 * so Cordis reflection and JSON serialization cannot discover or transport them.
 */
export function installRuntimeBootstrap(
  ctx: Context,
  secrets: RuntimeLaunchSecrets,
  identity?: RuntimeBuildIdentity,
): () => void {
  let active = true
  let bootstrapToken: Uint8Array | undefined = Uint8Array.from(secrets.bootstrapToken)
  let bridgeSecret: Uint8Array | undefined = Uint8Array.from(secrets.bridgeSecret)
  let bootstrapSession: Uint8Array | undefined
  const requireActive = (): void => {
    if (!active) throw new Error('runtime bootstrap service is disposed')
  }
  const service: RuntimeBootstrap = {
    launchId: () => {
      requireActive()
      return secrets.launchId
    },
    getLaunchId: () => service.launchId(),
    socketPath: () => {
      requireActive()
      return secrets.socketPath
    },
    getSocketPath: () => service.socketPath(),
    consumeBootstrapToken: () => {
      requireActive()
      const value = bootstrapToken
      bootstrapToken = undefined
      return value
    },
    consumeBootstrapTokenIfMatches: (actual) => {
      requireActive()
      const expected = bootstrapToken
      if (expected === undefined) return 'expired'
      if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return 'invalid'
      bootstrapToken = undefined
      expected.fill(0)
      return 'consumed'
    },
    consumeBridgeSecret: () => {
      requireActive()
      const value = bridgeSecret
      bridgeSecret = undefined
      return value
    },
    issueBootstrapSession: () => {
      requireActive()
      bootstrapSession?.fill(0)
      bootstrapSession = randomBytes(32)
      return Buffer.from(bootstrapSession).toString('hex')
    },
    validateBootstrapSession: (value) => {
      requireActive()
      if (bootstrapSession === undefined || !/^[0-9a-f]{64}$/u.test(value)) return false
      return timingSafeEqual(bootstrapSession, Buffer.from(value, 'hex'))
    },
    coreManifest: () => {
      requireActive()
      return identity?.manifest
    },
    coreManifestSha256: () => {
      requireActive()
      return identity?.sha256
    },
  }
  const remove = ctx.provide(RUNTIME_BOOTSTRAP_SERVICE, service)
  return () => {
    if (!active) return
    active = false
    bootstrapToken?.fill(0)
    bridgeSecret?.fill(0)
    bootstrapSession?.fill(0)
    bootstrapToken = undefined
    bridgeSecret = undefined
    bootstrapSession = undefined
    remove()
  }
}
