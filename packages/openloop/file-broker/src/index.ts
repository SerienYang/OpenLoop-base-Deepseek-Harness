import { Context, Service } from '@deepseek-ai/cordis'
import type {
  WorkspaceDirectoryChunk,
  WorkspaceFileHandle,
  WorkspaceFileStat,
  WorkspaceFileVersion,
} from '@openloop/desktop-bridge-host'
import { MAX_FILE_CHUNK_BYTES, normalizeRelativePath } from './path.ts'

export {
  MAX_FILE_CHUNK_BYTES,
  normalizeRelativePath,
  type NormalizedRelativePath,
} from './path.ts'

const MAX_DIRECTORY_ENTRIES = 128

export interface WorkspaceReadChunk {
  readonly bytes: Uint8Array
  readonly nextOffset: number
  readonly eof: boolean
}

export interface AtomicWriteOptions {
  readonly createIfAbsent?: boolean
  readonly expectedVersion?: string
}

/** Narrow native contract used by the Host-only broker facade. */
export interface WorkspaceFileBrokerPort {
  openWorkspaceFile(
    workspaceId: string,
    relativePath: string,
    mode: 'read' | 'list',
    signal?: AbortSignal,
  ): Promise<WorkspaceFileHandle>
  openWorkspaceRoot(workspaceId: string, signal?: AbortSignal): Promise<WorkspaceFileHandle>
  statWorkspaceFile(handleId: string, signal?: AbortSignal): Promise<WorkspaceFileStat>
  listWorkspaceFiles(
    handleId: string,
    offset: number,
    maxEntries: number,
    signal?: AbortSignal,
  ): Promise<WorkspaceDirectoryChunk>
  readWorkspaceFile(
    handleId: string,
    offset: number,
    maxBytes: number,
    signal?: AbortSignal,
  ): Promise<{ readonly bytes: string; readonly nextOffset: number; readonly eof: boolean }>
  createWorkspaceFile(
    workspaceId: string,
    relativePath: string,
    signal?: AbortSignal,
  ): Promise<WorkspaceFileHandle>
  beginWorkspaceAtomicWrite(
    workspaceId: string,
    relativePath: string,
    createIfAbsent: boolean,
    expectedVersion?: string,
    signal?: AbortSignal,
  ): Promise<WorkspaceFileHandle>
  writeWorkspaceFileChunk(
    handleId: string,
    bytes: string,
    signal?: AbortSignal,
  ): Promise<void>
  commitWorkspaceAtomicWrite(
    handleId: string,
    signal?: AbortSignal,
  ): Promise<WorkspaceFileVersion>
  closeWorkspaceFile(handleId: string, signal?: AbortSignal): Promise<void>
}

function workspaceId(value: string): string {
  if (value.length === 0) throw new TypeError('Workspace id is required')
  return value
}

function boundedInteger(value: number, maximum: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > maximum) {
    throw new TypeError(`${label} is outside the supported range`)
  }
  return value
}

/** Host-only typed facade over the authenticated native file broker methods. */
export class WorkspaceFileBroker {
  constructor(private readonly port: WorkspaceFileBrokerPort) {}

  async open(
    id: string,
    relativePath: string,
    mode: 'read' | 'list' = 'read',
    signal?: AbortSignal,
  ): Promise<WorkspaceFileHandle> {
    return await this.port.openWorkspaceFile(
      workspaceId(id),
      normalizeRelativePath(relativePath),
      mode,
      signal,
    )
  }

  openRoot(id: string, signal?: AbortSignal): Promise<WorkspaceFileHandle> {
    return this.port.openWorkspaceRoot(workspaceId(id), signal)
  }

  stat(handleId: string, signal?: AbortSignal): Promise<WorkspaceFileStat> {
    return this.port.statWorkspaceFile(handleId, signal)
  }

  list(
    handleId: string,
    offset = 0,
    maxEntries = MAX_DIRECTORY_ENTRIES,
    signal?: AbortSignal,
  ): Promise<WorkspaceDirectoryChunk> {
    return this.port.listWorkspaceFiles(
      handleId,
      boundedInteger(offset, Number.MAX_SAFE_INTEGER, 'Workspace list offset'),
      boundedInteger(maxEntries, MAX_DIRECTORY_ENTRIES, 'Workspace list size'),
      signal,
    )
  }

  async read(
    handleId: string,
    offset: number,
    maxBytes = MAX_FILE_CHUNK_BYTES,
    signal?: AbortSignal,
  ): Promise<WorkspaceReadChunk> {
    const result = await this.port.readWorkspaceFile(
      handleId,
      boundedInteger(offset, Number.MAX_SAFE_INTEGER, 'Workspace read offset'),
      boundedInteger(maxBytes, MAX_FILE_CHUNK_BYTES, 'Workspace read chunk'),
      signal,
    )
    const bytes = Buffer.from(result.bytes, 'base64')
    if (bytes.length > maxBytes || bytes.toString('base64') !== result.bytes) {
      throw new Error('Workspace file broker returned an invalid chunk')
    }
    return {
      bytes: Uint8Array.from(bytes),
      nextOffset: result.nextOffset,
      eof: result.eof,
    }
  }

  async create(
    id: string,
    relativePath: string,
    signal?: AbortSignal,
  ): Promise<WorkspaceFileHandle> {
    return await this.port.createWorkspaceFile(
      workspaceId(id),
      normalizeRelativePath(relativePath),
      signal,
    )
  }

  async beginAtomicWrite(
    id: string,
    relativePath: string,
    options: AtomicWriteOptions = {},
    signal?: AbortSignal,
  ): Promise<WorkspaceFileHandle> {
    return await this.port.beginWorkspaceAtomicWrite(
      workspaceId(id),
      normalizeRelativePath(relativePath),
      options.createIfAbsent ?? false,
      options.expectedVersion,
      signal,
    )
  }

  writeChunk(handleId: string, bytes: Uint8Array, signal?: AbortSignal): Promise<void> {
    if (bytes.byteLength > MAX_FILE_CHUNK_BYTES) {
      return Promise.reject(new TypeError('Workspace write chunk exceeds its limit'))
    }
    return this.port.writeWorkspaceFileChunk(
      handleId,
      Buffer.from(bytes).toString('base64'),
      signal,
    )
  }

  commitAtomicWrite(
    handleId: string,
    signal?: AbortSignal,
  ): Promise<WorkspaceFileVersion> {
    return this.port.commitWorkspaceAtomicWrite(handleId, signal)
  }

  close(handleId: string, signal?: AbortSignal): Promise<void> {
    return this.port.closeWorkspaceFile(handleId, signal)
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    readonly fileBroker: FileBrokerService
  }
}

export const name = 'fileBroker'
export const inject = ['desktopBridge']

/** Production Cordis owner for Workspace file access. */
export class FileBrokerService extends Service {
  static inject = inject
  readonly broker: WorkspaceFileBroker

  constructor(ctx: Context) {
    super(ctx, name)
    this.broker = new WorkspaceFileBroker(ctx.desktopBridge)
  }
}

export default FileBrokerService
