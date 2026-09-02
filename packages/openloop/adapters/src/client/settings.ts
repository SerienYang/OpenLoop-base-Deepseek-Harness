import {
  OPENLOOP_ADAPTER_CONTRACT_VERSION,
  type VersionedOpenloopContract,
} from '../version.ts'

/** Minimal secret metadata accepted at the DSH boundary. */
export interface OpenloopSettingsSecretInput {
  readonly path: readonly string[]
  readonly set: boolean
}

/** Minimal settings namespace accepted at the DSH boundary. */
export interface OpenloopSettingsNamespaceInput {
  readonly ns: string
  readonly schema: unknown
  readonly value: unknown
  readonly base?: unknown
  readonly user?: unknown
  readonly applies: 'live' | 'restart'
  readonly secrets: readonly OpenloopSettingsSecretInput[]
  readonly revision: number
}

/** Current or historical settings description accepted by the adapter. */
export interface OpenloopSettingsDescriptionInput {
  readonly writable: boolean
  readonly hasDocument?: boolean
  readonly documentPath?: string
  readonly namespaces: readonly OpenloopSettingsNamespaceInput[]
}

/** Stable, detached namespace view exposed to Openloop packages. */
export interface OpenloopSettingsNamespace {
  readonly ns: string
  readonly schema: unknown
  readonly value: unknown
  readonly base?: unknown
  readonly user?: unknown
  readonly applies: 'live' | 'restart'
  readonly secrets: ReadonlyArray<{
    readonly path: readonly string[]
    readonly set: boolean
  }>
  readonly revision: number
}

/** Stable, path-free settings description exposed to Openloop packages. */
export interface OpenloopSettingsDescription extends VersionedOpenloopContract {
  readonly writable: boolean
  readonly hasDocument: boolean
  readonly namespaces: readonly OpenloopSettingsNamespace[]
}

/**
 * Normalize DSH settings metadata while ensuring a legacy Host path never
 * crosses the Openloop contract.
 */
export function adaptSettingsDescription(
  source: OpenloopSettingsDescriptionInput,
): OpenloopSettingsDescription {
  return {
    contractVersion: OPENLOOP_ADAPTER_CONTRACT_VERSION,
    writable: source.writable,
    hasDocument: source.hasDocument ?? source.documentPath !== undefined,
    namespaces: source.namespaces.map(namespace => ({
      ns: namespace.ns,
      schema: structuredClone(namespace.schema),
      value: structuredClone(namespace.value),
      ...('base' in namespace ? { base: structuredClone(namespace.base) } : {}),
      ...('user' in namespace ? { user: structuredClone(namespace.user) } : {}),
      applies: namespace.applies,
      secrets: namespace.secrets.map(secret => ({
        path: [...secret.path],
        set: secret.set,
      })),
      revision: namespace.revision,
    })),
  }
}
