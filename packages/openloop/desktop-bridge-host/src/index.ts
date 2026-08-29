/** OpenLoop Host owner for the browser-reachable API policy. */

import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { Context, Service } from '@deepseek-ai/cordis'
import type { BrowserApiPolicy } from '@deepseek-ai/dsh-client-connection'
import type { RuntimeBootstrap } from '@openloop/runtime-bootstrap'
import {
  createBrowserApiPolicy,
  parseBrowserApiPolicyManifest,
  type BrowserApiPolicyManifest,
} from './api-policy.ts'
import {
  bridgeClientFromRuntimeBootstrap,
  type DesktopBridgeClient,
} from './client.ts'
import {
  OpenloopDesktopHostClient,
  OpenloopDesktopRemoteService,
} from './remote.ts'

export {
  createBrowserApiPolicy,
  parseBrowserApiPolicyManifest,
  type BrowserApiPolicy,
  type BrowserApiPolicyManifest,
}
export {
  MAX_BRIDGE_FRAME_BYTES,
  type BridgeRequest,
} from './protocol.ts'
export type * from './types.ts'
export {
  BROWSER_SAFE_METHODS,
  HOST_ONLY_METHODS,
  OpenloopDesktopHostClient,
  OpenloopDesktopRemoteService,
} from './remote.ts'

/** Stable Cordis service key. */
export const BROWSER_API_POLICY_SERVICE = 'browserApiPolicy'
export const DESKTOP_BRIDGE_SERVICE = 'desktopBridge'

declare module '@deepseek-ai/cordis' {
  interface Context {
    readonly runtimeBootstrap: RuntimeBootstrap
    readonly desktopBridge: OpenloopDesktopHostClient
  }
}

/** Validated source of truth shipped with the OpenLoop desktop runtime. */
export const openloopBrowserApiManifest: BrowserApiPolicyManifest =
  parseBrowserApiPolicyManifest(JSON.parse(readFileSync(
    createRequire(import.meta.url).resolve(
      '@openloop/desktop-bridge-host/openloop-browser-api.json',
    ),
    'utf8',
  )) as unknown)

/**
 * Sole lifecycle owner for the browser API policy in the OpenLoop profile.
 * Base DSH does not mount this service and retains its existing behavior.
 */
export class OpenloopBrowserApiPolicyService extends Service implements BrowserApiPolicy {
  static inject = ['runtimeBootstrap']
  readonly version = 1 as const
  private readonly policy = createBrowserApiPolicy(openloopBrowserApiManifest)

  constructor(ctx: Context) {
    const runtime = ctx.get('runtimeBootstrap')
    if (runtime === undefined) throw new Error('runtime bootstrap service is required')
    super(ctx, BROWSER_API_POLICY_SERVICE)
    const bridge: DesktopBridgeClient = bridgeClientFromRuntimeBootstrap(runtime)
    let removeHost: (() => void) | undefined
    try {
      const host = new OpenloopDesktopHostClient(bridge)
      removeHost = ctx.provide(DESKTOP_BRIDGE_SERVICE, host)
      new OpenloopDesktopRemoteService(ctx, bridge)
      ctx.effect(() => () => {
        removeHost?.()
        bridge.close()
      }, 'openloop-desktop-bridge: secret and socket lifecycle')
    } catch (error) {
      removeHost?.()
      bridge.close()
      throw error
    }
  }

  /** Admit an exact target before a carrier reads its request body. */
  allowsTarget(method: string): boolean {
    return this.policy.allowsTarget?.(method) ?? false
  }

  /** Decide one exact legacy, Typert, or physical-route target. */
  allows(method: string, payload: unknown): boolean {
    return this.policy.allows(method, payload)
  }

  /** Require a live, identity-valid Host grant before DSH creates a session. */
  async allowsInvocation(
    method: string,
    payload: unknown,
    signal: AbortSignal,
  ): Promise<boolean> {
    if (method !== 'session.create') return true
    if (typeof payload !== 'object' || payload === null
      || !Object.hasOwn(payload, 'workspaceId')
      || typeof (payload as { workspaceId?: unknown }).workspaceId !== 'string') {
      return false
    }
    const authority = this.ctx.get('workspaceAuthority') as
      | { isReady(workspaceId: string, signal: AbortSignal): Promise<boolean> }
      | undefined
    if (authority === undefined) return false
    try {
      return await authority.isReady(
        (payload as { workspaceId: string }).workspaceId,
        signal,
      )
    } catch {
      return false
    }
  }
}

export default OpenloopBrowserApiPolicyService
