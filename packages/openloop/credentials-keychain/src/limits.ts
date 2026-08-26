import { credentialRef, type CredentialRef } from '@deepseek-ai/dsh-credentials'

/** Native-compatible maximum for one Openloop credential reference. */
export const MAX_OPENLOOP_CREDENTIAL_REFERENCE_BYTES = 128
/** Bridge-safe maximum plaintext credential size. */
export const MAX_OPENLOOP_SECRET_BYTES = 8 * 1024
/** Registry ceiling kept strictly below the native 256-consumer limit. */
export const MAX_CREDENTIAL_CONSUMERS = 255
/** Native-compatible UTF-8 byte ceiling for one consumer label field. */
export const MAX_CREDENTIAL_CONSUMER_FIELD_BYTES = 256
/** Leaves 8 KiB of the 64 KiB bridge frame for the authenticated request envelope. */
export const MAX_CREDENTIAL_DELETION_PLAN_BYTES = 56 * 1024

const OPENLOOP_CREDENTIAL_REFERENCE = /^[A-Za-z_][A-Za-z0-9_]*$/u
const utf8Encoder = new TextEncoder()

/**
 * Validate a credential reference against Openloop's native account boundary.
 * Base DSH intentionally retains its existing unbounded reference contract.
 * @param value - Candidate reference from configuration or a Host operation.
 * @returns The validated base DSH credential-reference brand.
 */
export function openloopCredentialRef(value: string): CredentialRef {
  if (utf8Encoder.encode(value).byteLength > MAX_OPENLOOP_CREDENTIAL_REFERENCE_BYTES
    || !OPENLOOP_CREDENTIAL_REFERENCE.test(value)) {
    throw new TypeError('credential reference is invalid')
  }
  return credentialRef(value)
}
