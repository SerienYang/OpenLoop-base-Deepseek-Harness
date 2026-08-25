/** OpenLoop Host owner for the browser-reachable API policy. */

import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { Context, Service } from '@deepseek-ai/cordis'
import type { BrowserApiPolicy } from '@deepseek-ai/dsh-client-connection'
import {
  createBrowserApiPolicy,
  parseBrowserApiPolicyManifest,
  type BrowserApiPolicyManifest,
} from './api-policy.ts'

export {
  createBrowserApiPolicy,
  parseBrowserApiPolicyManifest,
  type BrowserApiPolicy,
  type BrowserApiPolicyManifest,
}

/** Stable Cordis service key. */
export const BROWSER_API_POLICY_SERVICE = 'browserApiPolicy'

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
  readonly version = 1 as const
  private readonly policy = createBrowserApiPolicy(openloopBrowserApiManifest)

  constructor(ctx: Context) {
    super(ctx, BROWSER_API_POLICY_SERVICE)
  }

  /** Admit an exact target before a carrier reads its request body. */
  allowsTarget(method: string): boolean {
    return this.policy.allowsTarget?.(method) ?? false
  }

  /** Decide one exact legacy, Typert, or physical-route target. */
  allows(method: string, payload: unknown): boolean {
    return this.policy.allows(method, payload)
  }
}

export default OpenloopBrowserApiPolicyService
