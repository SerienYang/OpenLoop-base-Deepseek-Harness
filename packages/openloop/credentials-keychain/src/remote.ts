import type { CredentialInfo, CredentialProvider } from '@deepseek-ai/dsh-credentials'
import type { CredentialStatus } from '@openloop/desktop-bridge-host/types'
import type {
  CredentialDeletionPlan,
  CredentialConsumerRegistry,
} from './consumer-registry.ts'
import { openloopCredentialRef } from './limits.ts'

/** Authenticated Host-only bridge methods required by this package. */
export interface KeychainCredentialBridge {
  resolveCredential(reference: string, signal?: AbortSignal): Promise<number[] | undefined>
  describeCredential(reference: string, signal?: AbortSignal): Promise<CredentialStatus>
  openCredentialReplacement(
    reference: string,
    signal?: AbortSignal,
  ): Promise<'saved' | 'cancelled'>
  deleteCredentialWithConfirmation(
    plan: CredentialDeletionPlan,
    signal?: AbortSignal,
  ): Promise<'deleted' | 'cancelled'>
}

/** Operations exposed indirectly through the browser-safe desktop facade. */
export interface CredentialBrowserOperations {
  describeCredential(reference: string, signal?: AbortSignal): Promise<CredentialInfo>
  openCredentialReplacement(
    reference: string,
    signal?: AbortSignal,
  ): Promise<'saved' | 'cancelled'>
  deleteCredential(reference: string, signal?: AbortSignal): Promise<'deleted' | 'cancelled'>
}

/**
 * Browser-safe credential facade. Its mutation methods take only a reference:
 * consumer labels always come from the Host registry.
 */
export class OpenloopCredentialOperations implements CredentialBrowserOperations {
  constructor(
    private readonly provider: CredentialProvider,
    private readonly consumers: CredentialConsumerRegistry,
    private readonly bridge: KeychainCredentialBridge,
  ) {}

  /**
   * Describe a registered reference without returning plaintext.
   * @param reference - Browser-supplied credential reference.
   * @returns Value-free credential status.
   */
  async describeCredential(reference: string): Promise<CredentialInfo> {
    const ref = this.#requiredPlan(reference).reference
    const providerInfo = await this.provider.describe(ref)
    if (providerInfo.source === 'environment' || providerInfo.source === 'legacy-file') {
      return providerInfo
    }
    const nativeInfo = await this.bridge.describeCredential(ref)
    return nativeInfo.configured
      ? { configured: true, source: 'keychain', writable: nativeInfo.writable }
      : { configured: false, writable: nativeInfo.writable }
  }

  /**
   * Open native replacement UI for a registered, writable reference.
   * @param reference - Browser-supplied credential reference.
   * @param signal - Request cancellation signal.
   * @returns Native sheet outcome.
   */
  async openCredentialReplacement(
    reference: string,
    signal?: AbortSignal,
  ): Promise<'saved' | 'cancelled'> {
    const plan = this.#requiredPlan(reference)
    await this.#assertWritable(plan.reference)
    return this.bridge.openCredentialReplacement(plan.reference, signal)
  }

  /**
   * Ask native confirmation to delete a registered, writable reference.
   * @param reference - Browser-supplied credential reference.
   * @param signal - Request cancellation signal.
   * @returns Native confirmation outcome.
   */
  async deleteCredential(
    reference: string,
    signal?: AbortSignal,
  ): Promise<'deleted' | 'cancelled'> {
    const plan = this.#requiredPlan(reference)
    await this.#assertWritable(plan.reference)
    return this.bridge.deleteCredentialWithConfirmation(plan, signal)
  }

  #requiredPlan(reference: string): CredentialDeletionPlan {
    const ref = openloopCredentialRef(reference)
    const plan = this.consumers.planDeletion(ref)
    if (plan.consumers.length === 0) {
      throw new Error('credential reference is not registered by a built-in Host consumer')
    }
    return plan
  }

  async #assertWritable(reference: CredentialDeletionPlan['reference']): Promise<void> {
    const info = await this.provider.describe(reference)
    if (info.source !== 'environment' && info.source !== 'legacy-file') {
      const nativeInfo = await this.bridge.describeCredential(reference)
      if (nativeInfo.writable) return
    }
    throw new Error(
      info.source === 'environment'
        ? 'credential is shadowed by the read-only environment'
        : 'credential source is read-only',
    )
  }
}
