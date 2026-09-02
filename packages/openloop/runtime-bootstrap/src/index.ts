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

export type BootstrapTokenClaimResult =
  | { readonly status: 'claimed'; readonly claimId: string }
  | { readonly status: 'invalid' | 'expired' }
export type BootstrapCompletionState = 'pending' | 'local-committed' | 'native-acknowledged'
export type BootstrapCompletionClaimResult =
  | 'claimed'
  | 'local-committed'
  | 'busy'
  | 'invalid'
  | 'completed'

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
  readonly claimBootstrapTokenIfMatches: (actual: Uint8Array) => BootstrapTokenClaimResult
  readonly consumeBridgeSecret: () => Uint8Array | undefined
  readonly issueBootstrapSession: (claimId: string) => string | undefined
  readonly validateBootstrapSession: (value: string) => boolean
  readonly bootstrapCompletionState: (session: string) => BootstrapCompletionState | 'invalid'
  readonly claimBootstrapCompletion: (session: string) => BootstrapCompletionClaimResult
  readonly releaseBootstrapCompletion: (session: string) => void
  readonly commitBootstrapCompletion: (session: string) => boolean
  readonly markBootstrapCompletionAcknowledged: (session: string) => boolean
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
  let bootstrapClaim: { readonly id: string } | undefined
  let bootstrapSession: Uint8Array | undefined
  let completionClaimed = false
  let completionState: BootstrapCompletionState = 'pending'
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
    claimBootstrapTokenIfMatches: (actual) => {
      requireActive()
      const expected = bootstrapToken
      if (expected === undefined) return { status: 'expired' }
      if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
        return { status: 'invalid' }
      }
      bootstrapClaim ??= { id: randomBytes(32).toString('hex') }
      return { status: 'claimed', claimId: bootstrapClaim.id }
    },
    consumeBridgeSecret: () => {
      requireActive()
      const value = bridgeSecret
      bridgeSecret = undefined
      return value
    },
    issueBootstrapSession: (claimId) => {
      requireActive()
      if (bootstrapClaim?.id !== claimId || completionState !== 'pending') return undefined
      bootstrapSession ??= randomBytes(32)
      return Buffer.from(bootstrapSession).toString('hex')
    },
    validateBootstrapSession: (value) => {
      requireActive()
      if (bootstrapSession === undefined || !/^[0-9a-f]{64}$/u.test(value)) return false
      return timingSafeEqual(bootstrapSession, Buffer.from(value, 'hex'))
    },
    bootstrapCompletionState: (session) => {
      requireActive()
      return service.validateBootstrapSession(session) ? completionState : 'invalid'
    },
    claimBootstrapCompletion: (session) => {
      requireActive()
      if (!service.validateBootstrapSession(session)) return 'invalid'
      if (completionState === 'native-acknowledged') return 'completed'
      if (completionClaimed) return 'busy'
      completionClaimed = true
      return completionState === 'local-committed' ? 'local-committed' : 'claimed'
    },
    releaseBootstrapCompletion: (session) => {
      requireActive()
      if (service.validateBootstrapSession(session)
        && completionState !== 'native-acknowledged') {
        completionClaimed = false
      }
    },
    commitBootstrapCompletion: (session) => {
      requireActive()
      if (!service.validateBootstrapSession(session)
        || !completionClaimed
        || completionState !== 'pending'
        || bootstrapToken === undefined) {
        return false
      }
      bootstrapToken.fill(0)
      bootstrapToken = undefined
      bootstrapClaim = undefined
      completionState = 'local-committed'
      return true
    },
    markBootstrapCompletionAcknowledged: (session) => {
      requireActive()
      if (!service.validateBootstrapSession(session)
        || !completionClaimed
        || completionState !== 'local-committed') {
        return false
      }
      completionClaimed = false
      completionState = 'native-acknowledged'
      return true
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
    bootstrapClaim = undefined
    bridgeSecret = undefined
    bootstrapSession = undefined
    completionClaimed = false
    completionState = 'pending'
    remove()
  }
}
