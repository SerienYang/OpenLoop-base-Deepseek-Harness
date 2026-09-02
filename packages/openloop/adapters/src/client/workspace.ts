import {
  OPENLOOP_ADAPTER_CONTRACT_VERSION,
  type VersionedOpenloopContract,
} from '../version.ts'

/** Minimal Workspace row accepted at the DSH boundary. */
export interface OpenloopWorkspaceInput {
  readonly workspaceId: string
  readonly path: string
  readonly title: string
  readonly sessionIds: readonly string[]
  readonly createdAt: string
  readonly updatedAt: string
}

/** Current or historical Workspace list input accepted by the adapter. */
export interface OpenloopWorkspaceListInput {
  readonly items: readonly OpenloopWorkspaceInput[]
  readonly archivedSessionIds?: readonly string[]
}

/** Stable Workspace row exposed to Openloop packages. */
export interface OpenloopWorkspace {
  readonly id: string
  readonly path: string
  readonly title: string
  readonly sessionIds: readonly string[]
  readonly createdAt: string
  readonly updatedAt: string
}

/** Stable Workspace list snapshot. */
export interface OpenloopWorkspaceList extends VersionedOpenloopContract {
  readonly items: readonly OpenloopWorkspace[]
  readonly archivedSessionIds: readonly string[]
}

/**
 * Translate a DSH Workspace list response into a detached Openloop snapshot.
 */
export function adaptWorkspaceList(
  source: OpenloopWorkspaceListInput,
): OpenloopWorkspaceList {
  return {
    contractVersion: OPENLOOP_ADAPTER_CONTRACT_VERSION,
    items: source.items.map(workspace => ({
      id: workspace.workspaceId,
      path: workspace.path,
      title: workspace.title,
      sessionIds: [...workspace.sessionIds],
      createdAt: workspace.createdAt,
      updatedAt: workspace.updatedAt,
    })),
    archivedSessionIds: [
      ...(source.archivedSessionIds ?? []),
    ],
  }
}
