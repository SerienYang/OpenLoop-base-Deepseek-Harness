import type { CredentialInfo, CredentialProvider } from '@deepseek-ai/dsh-credentials'
import type {
  CredentialStatus,
  ResolvedSecretBytes,
} from '@openloop/desktop-bridge-host/types'
import type {
  CredentialDeletionPlan,
  CredentialConsumerRegistry,
} from './consumer-registry.ts'
import { openloopCredentialRef } from './limits.ts'

/** Authenticated Host-only bridge methods required by this package. */
export interface KeychainCredentialBridge {
  resolveCredential(reference: string, signal?: AbortSignal): Promise<ResolvedSecretBytes | undefined>
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
  /**
   * Describe a registered reference without returning plaintext.
   * @param reference - Browser-supplied credential reference.
   * @param signal - Optional request cancellation signal.
   * @returns Value-free credential status.
   */
  describeCredential(reference: string, signal?: AbortSignal): Promise<CredentialInfo>
  /**
   * Open native replacement UI for a registered, writable reference.
   * @param reference - Browser-supplied credential reference.
   * @param signal - Optional request cancellation signal.
   * @returns Native sheet outcome.
   */
  openCredentialReplacement(
    reference: string,
    signal?: AbortSignal,
  ): Promise<'saved' | 'cancelled'>
  /**
   * Ask native confirmation to delete a registered, writable reference.
   * @param reference - Browser-supplied credential reference.
   * @param signal - Optional request cancellation signal.
   * @returns Native confirmation outcome.
   */
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
  async describeCredential(reference: string, signal?: AbortSignal): Promise<CredentialInfo> {
    const ref = this.#requiredPlan(reference).reference
    const providerInfo = await abortablePreflight(
      () => this.provider.describe(ref),
      signal,
    )
    if (providerInfo.source === 'environment' || providerInfo.source === 'legacy-file') {
      return providerInfo
    }
    const nativeInfo = await abortablePreflight(
      () => this.bridge.describeCredential(ref, signal),
      signal,
    )
    return nativeInfo.configured
      ? {
        configured: true,
        source: nativeInfo.source === 'legacy-file' ? 'legacy-file' : 'keychain',
        writable: nativeInfo.writable,
      }
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
    await this.#assertWritable(plan.reference, signal)
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
    await this.#assertWritable(plan.reference, signal)
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

  async #assertWritable(
    reference: CredentialDeletionPlan['reference'],
    signal?: AbortSignal,
  ): Promise<void> {
    const info = await abortablePreflight(
      () => this.provider.describe(reference),
      signal,
    )
    if (info.source !== 'environment' && info.source !== 'legacy-file') {
      const nativeInfo = await abortablePreflight(
        () => this.bridge.describeCredential(reference, signal),
        signal,
      )
      if (nativeInfo.writable) return
    }
    throw new Error(
      info.source === 'environment'
        ? 'credential is shadowed by the read-only environment'
        : 'credential source is read-only',
    )
  }
}

/**
 * Race one non-secret preflight against cancellation without abandoning the
 * underlying promise's rejection handler.
 */
function abortablePreflight<T>(
  start: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  if (signal?.aborted === true) return Promise.reject(credentialAbortError())
  if (signal === undefined) return Promise.resolve().then(start)
  return new Promise<T>((resolve, reject) => {
    let settled = false
    const finish = (settle: (value: T) => void, value: T): void => {
      if (settled) return
      settled = true
      signal.removeEventListener('abort', onAbort)
      settle(value)
    }
    const fail = (error: unknown): void => {
      if (settled) return
      settled = true
      signal.removeEventListener('abort', onAbort)
      reject(error instanceof Error ? error : new Error('credential preflight failed'))
    }
    const onAbort = (): void => { fail(credentialAbortError()) }
    signal.addEventListener('abort', onAbort, { once: true })
    if (signal.aborted) {
      onAbort()
      return
    }
    Promise.resolve().then(start).then(
      (value) => { finish(resolve, value) },
      (error: unknown) => { fail(error) },
    )
  })
}

function credentialAbortError(): DOMException {
  return new DOMException('Credential operation aborted', 'AbortError')
}
