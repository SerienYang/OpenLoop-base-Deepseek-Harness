/** Version of the stable Openloop adapter contract exposed by this package. */
export const OPENLOOP_ADAPTER_CONTRACT_VERSION = 1 as const

/** Current stable Openloop adapter contract version. */
export type OpenloopAdapterContractVersion =
  typeof OPENLOOP_ADAPTER_CONTRACT_VERSION

/** Marker shared by every translated Openloop contract. */
export interface VersionedOpenloopContract {
  readonly contractVersion: OpenloopAdapterContractVersion
}
