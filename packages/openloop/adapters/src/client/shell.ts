import {
  OPENLOOP_ADAPTER_CONTRACT_VERSION,
  type VersionedOpenloopContract,
} from '../version.ts'

/** Minimal shell input accepted at the DSH boundary. */
export interface OpenloopShellInput<RenderResult = unknown> {
  readonly renderApp: () => RenderResult
}

/** Versioned shell surface consumed by Openloop product packages. */
export interface OpenloopShellContract<RenderResult = unknown>
  extends VersionedOpenloopContract {
  readonly renderApp: () => RenderResult
}

/**
 * Translate the public DSH app-shell surface without retaining shell state.
 */
export function adaptShell<RenderResult>(
  source: OpenloopShellInput<RenderResult>,
): OpenloopShellContract<RenderResult> {
  return {
    contractVersion: OPENLOOP_ADAPTER_CONTRACT_VERSION,
    renderApp: () => source.renderApp(),
  }
}
