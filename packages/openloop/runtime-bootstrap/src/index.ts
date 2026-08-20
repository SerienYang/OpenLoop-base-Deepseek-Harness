import type { Context } from '@deepseek-ai/cordis'

export const RUNTIME_BOOTSTRAP_SERVICE = 'runtimeBootstrap'

export interface RuntimeLaunchSecrets {
  readonly launchId: string
  readonly bootstrapToken: Uint8Array
  readonly bridgeSecret: Uint8Array
  readonly socketPath: string
}

export interface RuntimeBootstrap {
  readonly launchId: () => string
  readonly getLaunchId: () => string
  readonly socketPath: () => string
  readonly getSocketPath: () => string
  readonly consumeBootstrapToken: () => Uint8Array | undefined
  readonly consumeBridgeSecret: () => Uint8Array | undefined
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
export function installRuntimeBootstrap(ctx: Context, secrets: RuntimeLaunchSecrets): () => void {
  let active = true
  let bootstrapToken: Uint8Array | undefined = Uint8Array.from(secrets.bootstrapToken)
  let bridgeSecret: Uint8Array | undefined = Uint8Array.from(secrets.bridgeSecret)
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
    consumeBridgeSecret: () => {
      requireActive()
      const value = bridgeSecret
      bridgeSecret = undefined
      return value
    },
  }
  const remove = ctx.provide(RUNTIME_BOOTSTRAP_SERVICE, service)
  return () => {
    if (!active) return
    active = false
    bootstrapToken?.fill(0)
    bridgeSecret?.fill(0)
    bootstrapToken = undefined
    bridgeSecret = undefined
    remove()
  }
}
