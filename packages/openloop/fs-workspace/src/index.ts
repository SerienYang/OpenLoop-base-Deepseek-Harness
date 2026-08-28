/**
 * Workspace-grant-backed implementation of the DSH filesystem service.
 * @module @openloop/fs-workspace
 */

import { randomUUID } from 'node:crypto'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import {
  FileSystem,
  FsError,
  FsTargetKey,
  FsVersion,
} from '@deepseek-ai/dsh-fs'
import type {
  FsDirEntry,
  FsEditOutcome,
  FsEditRequest,
  FsInfo,
  FsPathInfo,
  FsTarget,
  FsWriteIntent,
  FsWriteOutcome,
} from '@deepseek-ai/dsh-fs'
import type { SandboxExecutionPolicy, SandboxMode } from '@deepseek-ai/dsh-sandbox'
import type { SandboxPolicyService } from '@deepseek-ai/dsh-sandbox-policy'
import type { Workspace, WorkspaceRegistry } from '@deepseek-ai/dsh-workspace'
import {
  MAX_FILE_CHUNK_BYTES,
  normalizeRelativePath,
  type WorkspaceFileBroker,
} from '@openloop/file-broker'

const CAPABILITY_KEY = /^openloop-workspace:v1:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
const BINARY_SAMPLE_BYTES = 8192
const DIFF_BASIS_MAX_BYTES = 10 * 1024 * 1024

type BrokerEntryKind = 'regular' | 'directory' | 'symlink' | 'other'

interface BrokerDirectoryEntry {
  readonly name: string
  readonly kind: BrokerEntryKind
  readonly size: number
  readonly version: string
}

interface WorkspaceBroker {
  open(
    workspaceId: string,
    relativePath: string,
    mode?: 'read' | 'list',
    signal?: AbortSignal,
  ): ReturnType<WorkspaceFileBroker['open']>
  openRoot(workspaceId: string, signal?: AbortSignal): ReturnType<WorkspaceFileBroker['openRoot']>
  stat(handleId: string, signal?: AbortSignal): ReturnType<WorkspaceFileBroker['stat']>
  list(
    handleId: string,
    offset?: number,
    maxEntries?: number,
    signal?: AbortSignal,
  ): Promise<{
    readonly entries: readonly BrokerDirectoryEntry[]
    readonly nextOffset: number
    readonly eof: boolean
  }>
  read(
    handleId: string,
    offset: number,
    maxBytes?: number,
    signal?: AbortSignal,
  ): ReturnType<WorkspaceFileBroker['read']>
  beginAtomicWrite(
    workspaceId: string,
    relativePath: string,
    options?: { readonly createIfAbsent?: boolean; readonly expectedVersion?: string },
    signal?: AbortSignal,
  ): ReturnType<WorkspaceFileBroker['beginAtomicWrite']>
  writeChunk(
    handleId: string,
    bytes: Uint8Array,
    signal?: AbortSignal,
  ): ReturnType<WorkspaceFileBroker['writeChunk']>
  commitAtomicWrite(
    handleId: string,
    signal?: AbortSignal,
  ): ReturnType<WorkspaceFileBroker['commitAtomicWrite']>
  close(handleId: string, signal?: AbortSignal): ReturnType<WorkspaceFileBroker['close']>
}

interface TargetRecord {
  readonly target: FsTarget
  readonly workspaceId: string
  readonly relativePath: string
}

interface RoutedPath {
  readonly workspace: Workspace
  readonly relativePath: string
}

export const name = 'fs-workspace'
export const inject = ['fileBroker', 'workspaceRegistry', 'sandboxPolicy']

function aborted(signal: AbortSignal | undefined, operation: string): void {
  if (signal?.aborted === true) {
    throw new FsError(`${operation} aborted`, 'FS_ABORTED')
  }
}

function normalizedStorageText(content: string): string {
  return content.replace(/\r\n?/gu, '\n')
}

function applyEdit(content: string, edit: FsEditRequest, displayPath: string): string {
  if (edit.oldString.length === 0) {
    throw new FsError('old_string must be a non-empty string', 'FS_EDIT_NOT_FOUND')
  }
  const before = normalizedStorageText(content)
  const oldString = normalizedStorageText(edit.oldString)
  const newString = normalizedStorageText(edit.newString)
  let count = 0
  let offset = 0
  while ((offset = before.indexOf(oldString, offset)) !== -1) {
    count += 1
    offset += oldString.length
  }
  if (count === 0) {
    throw new FsError(`old_string was not found in "${displayPath}"`, 'FS_EDIT_NOT_FOUND')
  }
  if (!edit.replaceAll && count !== 1) {
    throw new FsError(
      `old_string matched ${String(count)} times in "${displayPath}"`,
      'FS_AMBIGUOUS_EDIT',
    )
  }
  return edit.replaceAll
    ? before.split(oldString).join(newString)
    : before.replace(oldString, newString)
}

function storedLineEndings(original: string, normalized: string): string {
  return original.includes('\r\n') ? normalized.replaceAll('\n', '\r\n') : normalized
}

function fsType(kind: BrokerEntryKind): FsInfo['type'] {
  if (kind === 'regular') return 'file'
  if (kind === 'directory') return 'directory'
  return 'other'
}

function lstatType(kind: BrokerEntryKind): FsPathInfo['type'] {
  if (kind === 'regular') return 'file'
  return kind
}

function joinRelative(parent: string, name: string): string {
  return parent === '.' ? name : `${parent}/${name}`
}

function parentAndName(path: string): { parent: string; name: string } {
  const at = path.lastIndexOf('/')
  return at === -1
    ? { parent: '.', name: path }
    : { parent: path.slice(0, at), name: path.slice(at + 1) }
}

function mapBrokerError(
  error: unknown,
  operation: string,
  displayPath: string,
  signal?: AbortSignal,
): FsError {
  if (error instanceof FsError) return error
  if (signal?.aborted === true) {
    return new FsError(`${operation} aborted`, 'FS_ABORTED', { cause: error })
  }
  const message = error instanceof Error ? error.message : String(error)
  if (/grant unavailable|workspace_failure/iu.test(message)) {
    return new FsError(
      `cannot ${operation} "${displayPath}": Workspace grant is not ready`,
      'FS_PERMISSION_DENIED',
      { cause: error },
    )
  }
  if (/not found/iu.test(message)) {
    return new FsError(`cannot ${operation} "${displayPath}": not found`, 'FS_NOT_FOUND', {
      cause: error,
    })
  }
  return new FsError(`cannot ${operation} "${displayPath}": Workspace broker failed`, 'FS_IO_ERROR', {
    cause: error,
  })
}

/** Host-only filesystem provider; every file effect is delegated to broker handles. */
export class WorkspaceFileSystem extends FileSystem {
  static inject = inject

  private readonly broker: WorkspaceBroker
  private readonly registry: WorkspaceRegistry
  private readonly sandboxPolicy: SandboxPolicyService
  private readonly targets = new Map<string, TargetRecord>()
  private readonly keys = new Map<string, FsTarget>()
  private readonly locks = new Map<string, Promise<unknown>>()

  constructor(ctx: Context) {
    super(ctx)
    this.broker = ctx.fileBroker.broker
    this.registry = ctx.workspaceRegistry
    this.sandboxPolicy = ctx.sandboxPolicy
  }

  override get sandboxMode(): SandboxMode {
    return this.sandboxPolicy.defaultMode
  }

  override async resolve(
    path: string,
    opts?: { cwd?: string; signal?: AbortSignal },
  ): Promise<FsTarget> {
    aborted(opts?.signal, 'resolve')
    const routed = await this.route(path, opts?.cwd)
    await this.assertReady(routed.workspace.id, opts?.signal)
    aborted(opts?.signal, 'resolve')
    return this.target(routed.workspace.id, routed.relativePath)
  }

  override processPath(target: FsTarget): string {
    const record = this.record(target)
    const suffix = record.relativePath === '.'
      ? ''
      : `/${record.relativePath.split('/').map(encodeURIComponent).join('/')}`
    return `/__openloop_workspace__/${encodeURIComponent(record.workspaceId)}${suffix}`
  }

  override fileUrl(target: FsTarget): string {
    return `file://${this.processPath(target)}`
  }

  override contains(parent: FsTarget, child: FsTarget): boolean {
    const parentRecord = this.record(parent)
    const childRecord = this.record(child)
    if (parentRecord.workspaceId !== childRecord.workspaceId) return false
    if (parentRecord.relativePath === '.') return true
    return childRecord.relativePath === parentRecord.relativePath
      || childRecord.relativePath.startsWith(`${parentRecord.relativePath}/`)
  }

  override async stat(target: FsTarget, signal?: AbortSignal): Promise<FsInfo | undefined> {
    const record = this.record(target)
    const info = await this.pathInfo(record, signal)
    return info === undefined
      ? undefined
      : {
        type: fsType(info.kind),
        size: info.size,
        version: FsVersion(info.version),
      }
  }

  override async lstat(
    path: string,
    opts?: { cwd?: string },
    signal?: AbortSignal,
  ): Promise<FsPathInfo | undefined> {
    aborted(signal, 'lstat')
    const routed = await this.route(path, opts?.cwd)
    await this.assertReady(routed.workspace.id, signal)
    const target = this.target(routed.workspace.id, routed.relativePath)
    const info = await this.pathInfo(this.record(target), signal)
    return info === undefined
      ? undefined
      : {
        type: lstatType(info.kind),
        size: info.size,
        version: FsVersion(info.version),
      }
  }

  override async readText(target: FsTarget, signal?: AbortSignal): Promise<string> {
    let result = ''
    for await (const chunk of await this.streamText(target, signal)) result += chunk
    return result
  }

  override streamText(
    target: FsTarget,
    signal?: AbortSignal,
  ): Promise<AsyncIterable<string>> {
    const record = this.record(target)
    const broker = this.broker
    const displayPath = record.target.displayPath
    return Promise.resolve((async function* (): AsyncIterable<string> {
      aborted(signal, 'read')
      let handleId: string | undefined
      try {
        const handle = record.relativePath === '.'
          ? await broker.openRoot(record.workspaceId, signal)
          : await broker.open(record.workspaceId, record.relativePath, 'read', signal)
        handleId = handle.handleId
        if (handle.kind !== 'regular') {
          throw new FsError(
            `cannot read "${displayPath}": not a regular file`,
            'FS_NOT_REGULAR_FILE',
          )
        }
        const decoder = new TextDecoder('utf-8', { fatal: true })
        const pending: Uint8Array[] = []
        let sampled = 0
        let offset = 0
        let ready = false
        while (true) {
          aborted(signal, 'read')
          const chunk = await broker.read(handleId, offset, MAX_FILE_CHUNK_BYTES, signal)
          if (chunk.nextOffset < offset || (!chunk.eof && chunk.nextOffset === offset)) {
            throw new FsError(`cannot read "${displayPath}": broker made no progress`, 'FS_IO_ERROR')
          }
          if (!ready) {
            pending.push(chunk.bytes)
            const sample = chunk.bytes.subarray(0, Math.max(0, BINARY_SAMPLE_BYTES - sampled))
            if (sample.includes(0)) {
              throw new FsError(`cannot read "${displayPath}": binary file`, 'FS_NOT_TEXT')
            }
            sampled += sample.byteLength
            ready = sampled >= BINARY_SAMPLE_BYTES || chunk.eof
            if (ready) {
              for (const bytes of pending) yield decoder.decode(bytes, { stream: true })
              pending.length = 0
            }
          } else {
            yield decoder.decode(chunk.bytes, { stream: true })
          }
          offset = chunk.nextOffset
          if (chunk.eof) break
        }
        yield decoder.decode()
      } catch (error) {
        if (error instanceof TypeError) {
          throw new FsError(`cannot read "${displayPath}": invalid UTF-8 text`, 'FS_NOT_TEXT', {
            cause: error,
          })
        }
        throw mapBrokerError(error, 'read', displayPath, signal)
      } finally {
        if (handleId !== undefined) {
          await broker.close(handleId).catch(() => {})
        }
      }
    })())
  }

  override async readBytes(
    target: FsTarget,
    signal: AbortSignal | undefined,
    maxBytes: number,
  ): Promise<Uint8Array> {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
      throw new TypeError('maxBytes must be a non-negative safe integer')
    }
    const record = this.record(target)
    aborted(signal, 'read')
    let handleId: string | undefined
    try {
      const handle = record.relativePath === '.'
        ? await this.broker.openRoot(record.workspaceId, signal)
        : await this.broker.open(record.workspaceId, record.relativePath, 'read', signal)
      handleId = handle.handleId
      if (handle.kind !== 'regular') {
        throw new FsError(
          `cannot read "${record.target.displayPath}": not a regular file`,
          'FS_NOT_REGULAR_FILE',
        )
      }
      const info = await this.broker.stat(handleId, signal)
      if (info.size > maxBytes) {
        throw new FsError(
          `cannot read "${record.target.displayPath}": ${String(info.size)} bytes exceeds the ${String(maxBytes)}-byte limit`,
          'FS_TOO_LARGE',
        )
      }
      const result = new Uint8Array(info.size)
      let offset = 0
      while (offset < info.size) {
        const chunk = await this.broker.read(
          handleId,
          offset,
          Math.min(MAX_FILE_CHUNK_BYTES, info.size - offset),
          signal,
        )
        if (chunk.nextOffset !== offset + chunk.bytes.byteLength || chunk.nextOffset <= offset) {
          throw new FsError(
            `cannot read "${record.target.displayPath}": broker made no progress`,
            'FS_IO_ERROR',
          )
        }
        result.set(chunk.bytes, offset)
        offset = chunk.nextOffset
        if (chunk.eof && offset !== info.size) {
          throw new FsError(
            `cannot read "${record.target.displayPath}": file changed during read`,
            'FS_IO_ERROR',
          )
        }
      }
      aborted(signal, 'read')
      return result
    } catch (error) {
      throw mapBrokerError(error, 'read', record.target.displayPath, signal)
    } finally {
      if (handleId !== undefined) await this.broker.close(handleId).catch(() => {})
    }
  }

  override async listDir(target: FsTarget, signal?: AbortSignal): Promise<FsDirEntry[]> {
    const record = this.record(target)
    aborted(signal, 'list')
    let handleId: string | undefined
    try {
      const handle = record.relativePath === '.'
        ? await this.broker.openRoot(record.workspaceId, signal)
        : await this.broker.open(record.workspaceId, record.relativePath, 'list', signal)
      handleId = handle.handleId
      if (handle.kind !== 'directory') {
        throw new FsError(
          `cannot list "${record.target.displayPath}": not a directory`,
          'FS_NOT_DIRECTORY',
        )
      }
      const entries = await this.list(handleId, signal)
      return entries
        .map((entry): FsDirEntry => ({
          name: entry.name,
          type: fsType(entry.kind),
          target: this.target(record.workspaceId, joinRelative(record.relativePath, entry.name)),
          version: FsVersion(entry.version),
          ...(entry.kind === 'regular' ? { size: entry.size } : {}),
        }))
        .sort((left, right) => left.name.localeCompare(right.name))
    } catch (error) {
      throw mapBrokerError(error, 'list', record.target.displayPath, signal)
    } finally {
      if (handleId !== undefined) await this.broker.close(handleId).catch(() => {})
    }
  }

  override writeText(
    target: FsTarget,
    content: string,
    expected?: FsWriteIntent,
    signal?: AbortSignal,
    sandboxPolicy?: SandboxExecutionPolicy,
  ): Promise<FsWriteOutcome> {
    const record = this.record(target)
    return this.withLock(record.target.targetKey, async () => {
      await this.assertMutationAllowed(record, sandboxPolicy)
      const existing = await this.stat(record.target, signal)
      if (existing !== undefined && existing.type !== 'file') {
        throw new FsError(
          `cannot write "${record.target.displayPath}": not a regular file`,
          'FS_NOT_REGULAR_FILE',
        )
      }
      if (expected?.kind === 'replaceIfVersion'
        && existing?.version !== expected.version) {
        throw new FsError(
          `cannot write "${record.target.displayPath}": file changed since it was read`,
          'FS_STALE_VERSION',
        )
      }
      if (expected?.kind === 'createIfAbsent' && existing !== undefined) {
        throw new FsError(
          `cannot overwrite existing "${record.target.displayPath}" without reading it first`,
          'FS_NOT_OBSERVED',
        )
      }
      const before = existing?.size !== undefined && existing.size < DIFF_BASIS_MAX_BYTES
        ? await this.readDiffBasis(record.target, signal)
        : null
      const version = await this.atomicWrite(
        record,
        content,
        {
          createIfAbsent: expected?.kind === 'createIfAbsent' || existing === undefined,
          ...(expected?.kind === 'replaceIfVersion'
            ? { expectedVersion: expected.version }
            : existing === undefined
              ? {}
              : { expectedVersion: existing.version }),
        },
        expected,
        signal,
      )
      return {
        operation: existing === undefined ? 'create' : 'update',
        version,
        before,
        after: normalizedStorageText(content),
      }
    })
  }

  override editText(
    target: FsTarget,
    edit: FsEditRequest,
    expected?: { version: FsVersion },
    signal?: AbortSignal,
    sandboxPolicy?: SandboxExecutionPolicy,
  ): Promise<FsEditOutcome> {
    const record = this.record(target)
    return this.withLock(record.target.targetKey, async () => {
      await this.assertMutationAllowed(record, sandboxPolicy)
      const existing = await this.stat(record.target, signal)
      if (existing === undefined || (expected !== undefined && existing.version !== expected.version)) {
        throw new FsError(
          `cannot edit "${record.target.displayPath}": file changed since it was read`,
          'FS_STALE_VERSION',
        )
      }
      if (existing.type !== 'file') {
        throw new FsError(
          `cannot edit "${record.target.displayPath}": not a regular file`,
          'FS_NOT_REGULAR_FILE',
        )
      }
      const original = await this.readText(record.target, signal)
      const before = normalizedStorageText(original)
      const after = applyEdit(original, edit, record.target.displayPath)
      const version = await this.atomicWrite(
        record,
        storedLineEndings(original, after),
        { expectedVersion: existing.version },
        expected,
        signal,
      )
      return { version, before, after }
    })
  }

  private async route(path: string, cwd?: string): Promise<RoutedPath> {
    if (path.trim().length === 0) {
      throw new FsError('file_path must be a non-empty string', 'FS_NOT_FOUND')
    }
    let workspace: Workspace | undefined
    let absolutePath: string
    if (cwd !== undefined) {
      try {
        workspace = await this.registry.resolveByPath(cwd)
      } catch (error) {
        throw new FsError('session cwd is not a registered Workspace', 'FS_PERMISSION_DENIED', {
          cause: error,
        })
      }
      absolutePath = resolve(cwd, path)
    } else {
      if (!isAbsolute(path)) {
        throw new FsError('relative paths require a registered session cwd', 'FS_PERMISSION_DENIED')
      }
      absolutePath = resolve(path)
      workspace = [...this.registry.list()]
        .sort((left, right) => right.path.length - left.path.length)
        .find(candidate => this.relativeInside(candidate.path, absolutePath) !== undefined)
    }
    if (workspace === undefined) {
      throw new FsError('path is not owned by a registered Workspace', 'FS_PERMISSION_DENIED')
    }
    const relativePath = this.relativeInside(workspace.path, absolutePath)
    if (relativePath === undefined) {
      throw new FsError('path escapes its registered Workspace', 'FS_PERMISSION_DENIED')
    }
    return { workspace, relativePath }
  }

  private relativeInside(root: string, path: string): string | undefined {
    const child = relative(resolve(root), path)
    if (child === '') return '.'
    if (child === '..' || child.startsWith(`..${sep}`) || isAbsolute(child)) return undefined
    try {
      return normalizeRelativePath(child.split(sep).join('/'))
    } catch {
      return undefined
    }
  }

  private target(workspaceId: string, relativePath: string): FsTarget {
    const location = `${workspaceId}\u0000${relativePath}`
    const existing = this.keys.get(location)
    if (existing !== undefined) return existing
    const target = Object.freeze({
      targetKey: FsTargetKey(`openloop-workspace:v1:${randomUUID()}`),
      displayPath: relativePath,
    })
    const record = { target, workspaceId, relativePath }
    this.keys.set(location, target)
    this.targets.set(target.targetKey, record)
    return target
  }

  private record(target: FsTarget): TargetRecord {
    const key = String(target.targetKey)
    const record = CAPABILITY_KEY.test(key) ? this.targets.get(key) : undefined
    if (record === undefined || record.target !== target || record.target.displayPath !== target.displayPath) {
      throw new FsError('Workspace target capability is invalid', 'FS_PERMISSION_DENIED')
    }
    return record
  }

  private async assertReady(workspaceId: string, signal?: AbortSignal): Promise<void> {
    let handleId: string | undefined
    try {
      const handle = await this.broker.openRoot(workspaceId, signal)
      handleId = handle.handleId
      if (handle.kind !== 'directory') throw new Error('Workspace root is not a directory')
    } catch (error) {
      throw mapBrokerError(error, 'access', '.', signal)
    } finally {
      if (handleId !== undefined) await this.broker.close(handleId).catch(() => {})
    }
  }

  private async pathInfo(
    record: TargetRecord,
    signal?: AbortSignal,
  ): Promise<BrokerDirectoryEntry | undefined> {
    aborted(signal, 'stat')
    if (record.relativePath === '.') {
      let handleId: string | undefined
      try {
        const handle = await this.broker.openRoot(record.workspaceId, signal)
        handleId = handle.handleId
        const info = await this.broker.stat(handleId, signal)
        return {
          name: '.',
          kind: info.kind,
          size: info.size,
          version: info.version ?? `directory:${record.workspaceId}`,
        }
      } catch (error) {
        throw mapBrokerError(error, 'stat', record.target.displayPath, signal)
      } finally {
        if (handleId !== undefined) await this.broker.close(handleId).catch(() => {})
      }
    }

    await this.assertReady(record.workspaceId, signal)
    const { parent, name } = parentAndName(record.relativePath)
    let handleId: string | undefined
    try {
      const handle = parent === '.'
        ? await this.broker.openRoot(record.workspaceId, signal)
        : await this.broker.open(record.workspaceId, parent, 'list', signal)
      handleId = handle.handleId
      return (await this.list(handleId, signal)).find(entry => entry.name === name)
    } catch (error) {
      const mapped = mapBrokerError(error, 'stat', record.target.displayPath, signal)
      if (mapped.code === 'FS_NOT_FOUND' || mapped.code === 'FS_IO_ERROR') return undefined
      throw mapped
    } finally {
      if (handleId !== undefined) await this.broker.close(handleId).catch(() => {})
    }
  }

  private async list(handleId: string, signal?: AbortSignal): Promise<BrokerDirectoryEntry[]> {
    const entries: BrokerDirectoryEntry[] = []
    let offset = 0
    while (true) {
      aborted(signal, 'list')
      const chunk = await this.broker.list(handleId, offset, undefined, signal)
      entries.push(...chunk.entries)
      if (chunk.eof) return entries
      if (chunk.nextOffset <= offset) {
        throw new FsError('Workspace directory broker made no progress', 'FS_IO_ERROR')
      }
      offset = chunk.nextOffset
    }
  }

  private async assertMutationAllowed(
    record: TargetRecord,
    supplied?: SandboxExecutionPolicy,
  ): Promise<void> {
    const policy = supplied ?? this.sandboxPolicy.resolve()
    if (policy.mode === 'read-only') {
      throw new FsError(
        `cannot write "${record.target.displayPath}": file access denied under read-only mode`,
        'FS_SANDBOX_DENIED',
      )
    }
    if (policy.mode === 'workspace-write') {
      let workspace: Workspace | undefined
      try {
        workspace = await this.registry.resolveByPath(policy.workspaceRoot)
      } catch {
        workspace = undefined
      }
      if (workspace?.id !== record.workspaceId) {
        throw new FsError(
          `cannot write "${record.target.displayPath}": file access denied outside the session Workspace`,
          'FS_SANDBOX_DENIED',
        )
      }
    }
    await this.assertReady(record.workspaceId)
  }

  private async readDiffBasis(target: FsTarget, signal?: AbortSignal): Promise<string | null> {
    try {
      return normalizedStorageText(await this.readText(target, signal))
    } catch (error) {
      if (error instanceof FsError && error.code === 'FS_NOT_TEXT') return null
      throw error
    }
  }

  private async atomicWrite(
    record: TargetRecord,
    content: string,
    options: { readonly createIfAbsent?: boolean; readonly expectedVersion?: string },
    callerIntent: FsWriteIntent | { readonly version: FsVersion } | undefined,
    signal?: AbortSignal,
  ): Promise<FsVersion> {
    aborted(signal, 'write')
    let handleId: string | undefined
    try {
      const handle = await this.broker.beginAtomicWrite(
        record.workspaceId,
        record.relativePath,
        options,
        signal,
      )
      handleId = handle.handleId
      const bytes = new TextEncoder().encode(content)
      for (let offset = 0; offset < bytes.byteLength; offset += MAX_FILE_CHUNK_BYTES) {
        aborted(signal, 'write')
        await this.broker.writeChunk(
          handleId,
          bytes.subarray(offset, offset + MAX_FILE_CHUNK_BYTES),
          signal,
        )
      }
      const committed = await this.broker.commitAtomicWrite(handleId, signal)
      handleId = undefined
      return FsVersion(committed.version)
    } catch (error) {
      if (signal?.aborted === true) {
        throw new FsError('write aborted', 'FS_ABORTED', { cause: error })
      }
      const message = error instanceof Error ? error.message : String(error)
      if ('kind' in (callerIntent ?? {}) && (callerIntent as FsWriteIntent).kind === 'createIfAbsent') {
        throw new FsError(
          `cannot overwrite existing "${record.target.displayPath}" without reading it first`,
          'FS_NOT_OBSERVED',
          { cause: error },
        )
      }
      if (callerIntent !== undefined || /version changed|version conflict/iu.test(message)) {
        throw new FsError(
          `cannot write "${record.target.displayPath}": file changed since it was read`,
          'FS_STALE_VERSION',
          { cause: error },
        )
      }
      throw mapBrokerError(error, 'write', record.target.displayPath, signal)
    } finally {
      if (handleId !== undefined) await this.broker.close(handleId).catch(() => {})
    }
  }

  private async withLock<T>(targetKey: string, operation: () => Promise<T>): Promise<T> {
    const prior = this.locks.get(targetKey) ?? Promise.resolve()
    const run = prior.then(operation, operation)
    const tail = run.then(() => undefined, () => undefined)
    this.locks.set(targetKey, tail)
    try {
      return await run
    } finally {
      if (this.locks.get(targetKey) === tail) this.locks.delete(targetKey)
    }
  }
}

export default WorkspaceFileSystem
