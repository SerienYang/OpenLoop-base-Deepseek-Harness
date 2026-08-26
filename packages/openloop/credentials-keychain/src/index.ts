/**
 * Openloop credential provider: inherited environment, then macOS Keychain
 * through the authenticated desktop bridge, then an optional legacy source.
 * @module @openloop/credentials-keychain
 */

import { Context } from '@deepseek-ai/cordis'
import {
  CredentialProvider,
  type CredentialInfo,
  type CredentialRef,
  type ResolvedCredential,
} from '@deepseek-ai/dsh-credentials'
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment'
import type {} from '@openloop/desktop-bridge-host'
import {
  CredentialConsumerRegistry,
  type CredentialConsumerRegistryLike,
} from './consumer-registry.ts'
import {
  OpenloopCredentialOperations,
  type CredentialBrowserOperations,
  type KeychainCredentialBridge,
} from './remote.ts'
import {
  MAX_OPENLOOP_SECRET_BYTES,
  openloopCredentialRef,
} from './limits.ts'

export * from './consumer-registry.ts'
export * from './limits.ts'
export * from './remote.ts'

/** Cordis service key for the Host-only consumer registry. */
export const CREDENTIAL_CONSUMERS_SERVICE = 'credentialConsumers'
/** Cordis service key for browser-safe credential operations. */
export const CREDENTIAL_OPERATIONS_SERVICE = 'openloopCredentialOperations'

/** Read-only fallback used only after an incomplete legacy migration. */
export interface LegacyCredentialSource {
  resolve(reference: CredentialRef): Promise<string | ResolvedCredential | undefined>
  describe(reference: CredentialRef): Promise<CredentialInfo>
}

/** Provider construction options; runtime composition normally supplies none. */
export interface Config {
  /** Test/migration injection; runtime composition uses ctx.desktopBridge. */
  readonly bridge?: KeychainCredentialBridge
  /** Present only while a failed migration requires read-only compatibility. */
  readonly legacy?: LegacyCredentialSource
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    readonly credentialConsumers?: CredentialConsumerRegistryLike
    readonly openloopCredentialOperations?: CredentialBrowserOperations
  }
}

/** Host-only Keychain-backed implementation of the DSH credential seam. */
export class KeychainCredentialProvider extends CredentialProvider {
  static inject = ['desktopBridge']

  readonly #bridge: KeychainCredentialBridge
  readonly #legacy: LegacyCredentialSource | undefined

  constructor(ctx: Context, config: Config = {}) {
    super(ctx)
    const bridge = config.bridge
      ?? ctx.get('desktopBridge')
    if (bridge === undefined) throw new Error('desktop bridge service is required')
    this.#bridge = bridge
    this.#legacy = config.legacy

    const consumers = new CredentialConsumerRegistry()
    const removeConsumers = ctx.provide(CREDENTIAL_CONSUMERS_SERVICE, consumers)
    const operations = new OpenloopCredentialOperations(this, consumers, bridge)
    const removeOperations = ctx.provide(CREDENTIAL_OPERATIONS_SERVICE, operations)
    ctx.effect(() => () => {
      removeOperations()
      removeConsumers()
    }, 'credentials-keychain: Host services')
  }

  /**
   * Resolve a credential from the fixed source precedence on every call.
   * @param reference - Credential reference to resolve.
   * @returns Value and source, or `undefined` when absent.
   */
  override async resolve(reference: CredentialRef): Promise<ResolvedCredential | undefined> {
    const ref = openloopCredentialRef(reference)
    const inherited = this.#inherited(ref)
    if (inherited !== undefined) {
      return { value: inherited, source: 'environment' }
    }

    const bytes = await this.#bridge.resolveCredential(ref)
    if (bytes !== undefined) {
      try {
        const value = decodeSecret(bytes)
        if (value.length > 0) return { value, source: 'keychain' }
      } finally {
        bytes.fill(0)
      }
    }

    const legacy = await this.#legacy?.resolve(ref)
    const value = typeof legacy === 'string' ? legacy : legacy?.value
    return value === undefined || value.length === 0
      ? undefined
      : { value, source: 'legacy-file' }
  }

  /**
   * Describe the winning source without exposing its value.
   * @param reference - Credential reference to inspect.
   * @returns Value-free source and writability facts.
   */
  override async describe(reference: CredentialRef): Promise<CredentialInfo> {
    const ref = openloopCredentialRef(reference)
    if (this.#inherited(ref) !== undefined) {
      return { configured: true, source: 'environment', writable: false }
    }
    const keychain = await this.#bridge.describeCredential(ref)
    if (keychain.configured) {
      return { configured: true, source: 'keychain', writable: false }
    }
    const legacy = await this.#legacy?.describe(ref)
    if (legacy?.configured === true) {
      return { configured: true, source: 'legacy-file', writable: false }
    }
    return { configured: false, writable: false }
  }

  /**
   * Reject direct writes; the native-confirmed facade owns mutation.
   * @param reference - Credential reference targeted by the rejected write.
   * @param _value - Secret value that is deliberately not inspected.
   * @returns Rejected promise.
   */
  override set(reference: CredentialRef, _value: string): Promise<void> {
    return this.#rejectMutation(reference)
  }

  /**
   * Reject direct deletion; the native-confirmed facade owns mutation.
   * @param reference - Credential reference targeted by the rejected deletion.
   * @returns Rejected promise.
   */
  override unset(reference: CredentialRef): Promise<void> {
    return this.#rejectMutation(reference)
  }

  #inherited(reference: CredentialRef): string | undefined {
    const entry = launchEnvironmentOf(this.ctx).getFrom(reference, ['process'])
    return entry !== undefined && entry.value.length > 0 ? entry.value : undefined
  }

  #mutationError(reference: CredentialRef): Error {
    if (this.#inherited(reference) !== undefined) {
      return new Error('credential is shadowed by the read-only environment')
    }
    return new Error('credential mutation requires the native-confirmed Openloop facade')
  }

  #rejectMutation(reference: CredentialRef): Promise<never> {
    try {
      return Promise.reject(this.#mutationError(openloopCredentialRef(reference)))
    } catch {
      return Promise.reject(new TypeError('credential reference is invalid'))
    }
  }
}

function decodeSecret(bytes: readonly number[]): string {
  if (bytes.length === 0
    || bytes.length > MAX_OPENLOOP_SECRET_BYTES
    || bytes.some(byte => !Number.isInteger(byte) || byte < 0 || byte > 255)) {
    throw new Error('Keychain returned an invalid credential payload')
  }
  const copy = Uint8Array.from(bytes)
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(copy)
  } catch {
    throw new Error('Keychain returned an invalid credential payload')
  } finally {
    copy.fill(0)
  }
}

export default KeychainCredentialProvider
