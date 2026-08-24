/** Stable, side-effect-free translations over public DSH contracts. */
export {
  adaptShell,
  type OpenloopShellContract,
  type OpenloopShellInput,
} from './client/shell.ts'
export {
  adaptSettingsDescription,
  type OpenloopSettingsDescription,
  type OpenloopSettingsDescriptionInput,
  type OpenloopSettingsNamespace,
  type OpenloopSettingsNamespaceInput,
  type OpenloopSettingsSecretInput,
} from './client/settings.ts'
export {
  adaptWorkspaceList,
  type OpenloopWorkspace,
  type OpenloopWorkspaceInput,
  type OpenloopWorkspaceList,
  type OpenloopWorkspaceListInput,
} from './client/workspace.ts'
export {
  adaptDesktopDescription,
  type OpenloopDesktopDescription,
  type OpenloopDesktopDescriptionInput,
} from './host/desktop.ts'
export {
  OPENLOOP_ADAPTER_CONTRACT_VERSION,
  type OpenloopAdapterContractVersion,
  type VersionedOpenloopContract,
} from './version.ts'
