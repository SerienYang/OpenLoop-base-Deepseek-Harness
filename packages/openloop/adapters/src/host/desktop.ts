import {
  OPENLOOP_ADAPTER_CONTRACT_VERSION,
  type VersionedOpenloopContract,
} from '../version.ts'

/** Current or historical desktop description accepted at the DSH boundary. */
export interface OpenloopDesktopDescriptionInput {
  readonly version: string
  readonly cwd: string
  readonly provider?: string
  readonly model?: string
  readonly attachedSessions: number
  readonly canOpenPath?: boolean
}

/** Stable desktop facts exposed to Openloop packages. */
export interface OpenloopDesktopDescription extends VersionedOpenloopContract {
  readonly dshVersion: string
  readonly cwd: string
  readonly defaultModel?: {
    readonly provider?: string
    readonly model?: string
  }
  readonly attachedSessions: number
  readonly canOpenPath: boolean
}

/** Translate public DSH host facts with conservative defaults for old hosts. */
export function adaptDesktopDescription(
  source: OpenloopDesktopDescriptionInput,
): OpenloopDesktopDescription {
  const hasDefaultModel = source.provider !== undefined || source.model !== undefined
  return {
    contractVersion: OPENLOOP_ADAPTER_CONTRACT_VERSION,
    dshVersion: source.version,
    cwd: source.cwd,
    ...(hasDefaultModel
      ? {
        defaultModel: {
          ...source.provider === undefined ? {} : { provider: source.provider },
          ...source.model === undefined ? {} : { model: source.model },
        },
      }
      : {}),
    attachedSessions: source.attachedSessions,
    canOpenPath: source.canOpenPath ?? false,
  }
}
