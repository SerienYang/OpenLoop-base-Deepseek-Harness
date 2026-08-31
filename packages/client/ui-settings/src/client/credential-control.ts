import type { ReactNode } from 'react'

/** Value-free credential state safe to retain in browser memory. */
export interface CredentialControlStatus {
  /** Whether some trusted Host source currently supplies the reference. */
  configured: boolean
  /** Source layer, when configured. Never contains a credential value. */
  source?: string
  /** Whether the Host permits replacement or deletion. */
  writable: boolean
}

/** Props passed to a product-owned credential renderer. */
export interface CredentialControlRenderProps {
  /** Credential reference. This is an identifier, never a secret value. */
  reference: string
  /** Human-facing field label supplied by the feature. */
  label: string
  /** Additional feature-level write restriction. */
  disabled?: boolean
  /** Value-free owner snapshot marker that requests a fresh describe. */
  refreshToken?: string | number
  /** Called after the Host confirms a mutation so the owner can refresh its snapshot. */
  onChanged?: () => void | Promise<void>
}

/**
 * Optional product adapter for credential UI.
 *
 * Its absence is the default DSH profile: feature packages keep their current
 * write-only inputs and legacy credentials transport. Products that provide
 * it own rendering, value-free reads, and profile lifecycle policy.
 */
export interface CredentialControlAdapter {
  /**
   * Read value-free state through the product's trusted facade.
   * @param reference - Credential identifier to describe.
   * @returns Current value-free state from the trusted product facade.
   */
  describe(reference: string): Promise<CredentialControlStatus>
  /**
   * Render the product-owned control without receiving a credential value.
   * @param props - Reference, label, write restriction, and refresh callback.
   * @returns Product-owned credential controls.
   */
  render(props: CredentialControlRenderProps): ReactNode
  /** Whether new provider profiles must name their derived credential reference. */
  readonly materializeApiKeyEnv: boolean
  /** Whether deleting a provider profile should also invoke legacy credential deletion. */
  readonly deleteCredentialWithProfile: boolean
}
