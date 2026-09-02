/**
 * Credential-reference validation local to the MCP trust boundary.
 * @module
 */

import { credentialRef, type CredentialRef } from '@deepseek-ai/dsh-credentials'

/** Validate an untrusted reference without retaining its value in the failure. */
export function safeCredentialRef(reference: string): CredentialRef {
  try {
    return credentialRef(reference)
  } catch {
    throw new TypeError('mcp-client: invalid credential reference')
  }
}
