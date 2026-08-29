import { Context } from '@deepseek-ai/cordis'
import { CallId } from '@deepseek-ai/dsh-llm'
import * as FsPolicy from '@deepseek-ai/dsh-fs-observation-policy'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as ToolFs from '@deepseek-ai/dsh-tool-fs'
import { WorkspaceFileBroker } from '@openloop/file-broker'
import { describe, expect, it, vi } from 'vitest'
import WorkspaceFileSystem from '../src/index.ts'

const WORKSPACE_ID = 'workspace-1'
const WORKSPACE_PATH = '/Users/private/Project'
const signal = new AbortController().signal
const modelAgent = { session: { header: { cwd: WORKSPACE_PATH } } } as never

type Entry = {
  kind: 'regular' | 'directory' | 'symlink' | 'other'
  bytes?: Uint8Array
  version?: string
}

function text(value: string): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(value)
}

function bridgeError(code: string, message: string): Error {
  return new Error(`desktop bridge ${code}: ${message}`)
}

function harness(initial: Record<string, Entry> = {}) {
  const entries = new Map<string, Entry>([
    ['.', { kind: 'directory' }],
    ...Object.entries(initial),
  ])
  const handles = new Map<string, { path: string; write?: number[]; expectedVersion?: string; createIfAbsent?: boolean }>()
  const calls: Array<{ method: string; args: unknown[] }> = []
  let nextHandle = 0
  let nextVersion = 10

  const record = <T>(method: string, args: unknown[], value: T): Promise<T> => {
    calls.push({ method, args })
    return Promise.resolve(value)
  }
  const openHandle = (path: string) => {
    const entry = entries.get(path)
    if (entry === undefined) throw new Error('not found')
    const handleId = `handle-${++nextHandle}`
    handles.set(handleId, { path })
    return {
      handleId,
      kind: entry.kind === 'directory' ? 'directory' as const : 'regular' as const,
      ...entry.version === undefined ? {} : { version: entry.version },
    }
  }
  const broker = {
    openRoot: vi.fn(async (workspaceId: string) => {
      if (workspaceId !== WORKSPACE_ID) throw new Error('grant unavailable')
      return record('openRoot', [workspaceId], openHandle('.'))
    }),
    open: vi.fn(async (workspaceId: string, path: string, mode: 'read' | 'list') => {
      if (workspaceId !== WORKSPACE_ID) throw new Error('grant unavailable')
      const handle = openHandle(path)
      const expectedKind = mode === 'list' ? 'directory' : 'regular'
      if (handle.kind !== expectedKind) throw new Error('wrong kind')
      return record('open', [workspaceId, path, mode], handle)
    }),
    stat: vi.fn(async (handleId: string) => {
      const handle = handles.get(handleId)
      if (handle === undefined) throw new Error('invalid handle')
      const entry = entries.get(handle.path)
      if (entry === undefined) throw new Error('not found')
      return record('stat', [handleId], {
        kind: entry.kind === 'directory' ? 'directory' as const : 'regular' as const,
        size: entry.bytes?.byteLength ?? 0,
        version: entry.version,
      })
    }),
    list: vi.fn(async (handleId: string, offset: number) => {
      const handle = handles.get(handleId)
      if (handle === undefined) throw new Error('invalid handle')
      const prefix = handle.path === '.' ? '' : `${handle.path}/`
      const children = [...entries]
        .filter(([path]) => path !== '.' && path.startsWith(prefix))
        .filter(([path]) => !path.slice(prefix.length).includes('/'))
        .map(([path, entry]) => ({
          name: path.slice(prefix.length),
          kind: entry.kind,
          size: entry.bytes?.byteLength ?? 0,
          version: entry.version,
        }))
        .sort((left, right) => left.name.localeCompare(right.name))
      return record('list', [handleId, offset], {
        entries: children.slice(offset),
        nextOffset: children.length,
        eof: true,
      })
    }),
    read: vi.fn(async (handleId: string, offset: number, maxBytes: number) => {
      const handle = handles.get(handleId)
      if (handle === undefined) throw new Error('invalid handle')
      const bytes = entries.get(handle.path)?.bytes ?? new Uint8Array()
      const chunk = bytes.slice(offset, offset + Math.min(maxBytes, 3))
      return record('read', [handleId, offset, maxBytes], {
        bytes: chunk,
        nextOffset: offset + chunk.byteLength,
        eof: offset + chunk.byteLength >= bytes.byteLength,
      })
    }),
    beginAtomicWrite: vi.fn(async (
      workspaceId: string,
      path: string,
      options: { createIfAbsent?: boolean; expectedVersion?: string },
    ) => {
      if (workspaceId !== WORKSPACE_ID) throw new Error('grant unavailable')
      const current = entries.get(path)
      if (options.createIfAbsent === true && current !== undefined) throw new Error('already exists')
      if (options.createIfAbsent !== true
        && (current === undefined
          || (options.expectedVersion !== undefined && current.version !== options.expectedVersion))) {
        throw new Error('version changed')
      }
      const handleId = `write-${++nextHandle}`
      handles.set(handleId, {
        path,
        write: [],
        ...options.expectedVersion === undefined
          ? {}
          : { expectedVersion: options.expectedVersion },
        ...options.createIfAbsent === undefined
          ? {}
          : { createIfAbsent: options.createIfAbsent },
      })
      return record('beginAtomicWrite', [workspaceId, path, options], {
        handleId,
        kind: 'regular' as const,
        version: 'staging',
      })
    }),
    writeChunk: vi.fn(async (handleId: string, bytes: Uint8Array) => {
      const handle = handles.get(handleId)
      if (handle?.write === undefined) throw new Error('invalid write handle')
      handle.write.push(...bytes)
      await record('writeChunk', [handleId, bytes], undefined)
    }),
    commitAtomicWrite: vi.fn(async (handleId: string) => {
      const handle = handles.get(handleId)
      if (handle?.write === undefined) throw new Error('invalid write handle')
      const current = entries.get(handle.path)
      if (handle.createIfAbsent === true && current !== undefined) throw new Error('already exists')
      if (handle.expectedVersion !== undefined && current?.version !== handle.expectedVersion) {
        throw new Error('version changed')
      }
      const version = `v${++nextVersion}`
      entries.set(handle.path, {
        kind: 'regular',
        bytes: Uint8Array.from(handle.write),
        version,
      })
      handles.delete(handleId)
      return record('commitAtomicWrite', [handleId], { version })
    }),
    close: vi.fn(async (handleId: string) => {
      handles.delete(handleId)
      await record('close', [handleId], undefined)
    }),
  }
  const registry = {
    resolveByPath: vi.fn(async (path: string) => path === WORKSPACE_PATH
      ? { id: WORKSPACE_ID, path: WORKSPACE_PATH }
      : undefined),
    list: vi.fn(() => [{ id: WORKSPACE_ID, path: WORKSPACE_PATH }]),
  }
  const ctx = new Context()
  ctx.provide('fileBroker', { broker } as never)
  ctx.provide('workspaceRegistry', registry as never)
  ctx.provide('sandboxPolicy', {
    defaultMode: 'workspace-write',
    resolve: () => ({ mode: 'workspace-write', workspaceRoot: WORKSPACE_PATH }),
  } as never)
  const filesystem = new WorkspaceFileSystem(ctx)
  return { broker, calls, ctx, entries, filesystem }
}

function call(ctx: Context, name: string, args: unknown) {
  return ctx.tools.execute({
    signal,
    callId: CallId(`call-${name}`),
    name,
    arguments: args,
    agent: modelAgent,
  })
}

describe('Workspace FileSystem capability boundary', () => {
  it('uses commitAtomicWrite entry as the point of no return and never forwards its signal', async () => {
    const preCancelled = new AbortController()
    const preCancelledReason = new Error('cancel before commit admission')
    preCancelled.abort(preCancelledReason)
    const commitWorkspaceAtomicWrite = vi.fn(async (
      _handleId: string,
      commitSignal?: AbortSignal,
    ) => {
      if (commitSignal?.aborted === true) throw commitSignal.reason
      return { version: 'v2' }
    })
    const broker = new WorkspaceFileBroker({ commitWorkspaceAtomicWrite } as never)

    await expect(broker.commitAtomicWrite('pre-cancelled', preCancelled.signal))
      .rejects.toBe(preCancelledReason)
    expect(commitWorkspaceAtomicWrite).not.toHaveBeenCalled()

    const admitted = new AbortController()
    commitWorkspaceAtomicWrite.mockImplementationOnce(async (
      _handleId: string,
      commitSignal?: AbortSignal,
    ) => {
      admitted.abort(new Error('cancel after commit admission'))
      if (commitSignal?.aborted === true) throw commitSignal.reason
      return { version: 'v3' }
    })

    await expect(broker.commitAtomicWrite('admitted', admitted.signal))
      .resolves.toEqual({ version: 'v3' })
    expect(commitWorkspaceAtomicWrite).toHaveBeenLastCalledWith('admitted')
  })

  it('maps only the thrown abort reason or AbortError to FS_ABORTED', async () => {
    const genericHarness = harness({
      'generic.txt': { kind: 'regular', bytes: text('value'), version: 'v1' },
    })
    const genericTarget = await genericHarness.filesystem.resolve('generic.txt', {
      cwd: WORKSPACE_PATH,
    })
    const genericController = new AbortController()
    genericHarness.broker.open.mockImplementationOnce(async () => {
      genericController.abort(new Error('late cancellation'))
      throw bridgeError('file_failure', 'desktop Workspace file operation failed')
    })

    await expect(genericHarness.filesystem.readText(
      genericTarget,
      genericController.signal,
    )).rejects.toMatchObject({ code: 'FS_IO_ERROR' })

    const abortedHarness = harness({
      'aborted.txt': { kind: 'regular', bytes: text('value'), version: 'v1' },
    })
    const abortedTarget = await abortedHarness.filesystem.resolve('aborted.txt', {
      cwd: WORKSPACE_PATH,
    })
    const abortedController = new AbortController()
    const abortReason = new Error('broker operation aborted')
    abortedHarness.broker.open.mockImplementationOnce(async () => {
      abortedController.abort(abortReason)
      throw abortReason
    })

    await expect(abortedHarness.filesystem.readText(
      abortedTarget,
      abortedController.signal,
    )).rejects.toMatchObject({ code: 'FS_ABORTED', cause: abortReason })

    const abortErrorHarness = harness({
      'abort-error.txt': { kind: 'regular', bytes: text('value'), version: 'v1' },
    })
    const abortErrorTarget = await abortErrorHarness.filesystem.resolve('abort-error.txt', {
      cwd: WORKSPACE_PATH,
    })
    const abortError = new DOMException('operation aborted', 'AbortError')
    abortErrorHarness.broker.open.mockRejectedValueOnce(abortError)

    await expect(abortErrorHarness.filesystem.readText(abortErrorTarget))
      .rejects.toMatchObject({ code: 'FS_ABORTED', cause: abortError })
  })

  it('maps a thrown TypeError abort reason to FS_ABORTED', async () => {
    const { broker, filesystem } = harness({
      'aborted.txt': { kind: 'regular', bytes: text('value'), version: 'v1' },
    })
    const target = await filesystem.resolve('aborted.txt', { cwd: WORKSPACE_PATH })
    const controller = new AbortController()
    const abortReason = new TypeError('broker operation aborted')
    broker.open.mockImplementationOnce(async () => {
      controller.abort(abortReason)
      throw abortReason
    })

    await expect(filesystem.readText(target, controller.signal))
      .rejects.toMatchObject({ code: 'FS_ABORTED', cause: abortReason })
  })

  it('maps trusted cwd paths to stable opaque targets and rejects escapes and forgeries', async () => {
    const { broker, filesystem } = harness()

    const relative = await filesystem.resolve('src/index.ts', { cwd: WORKSPACE_PATH })
    const absolute = await filesystem.resolve(`${WORKSPACE_PATH}/src/index.ts`, {
      cwd: WORKSPACE_PATH,
    })

    expect(relative).toEqual(absolute)
    expect(relative.displayPath).toBe('src/index.ts')
    expect(String(relative.targetKey)).toMatch(/^openloop-workspace:v1:[0-9a-f-]{36}$/u)
    expect(JSON.stringify(relative)).not.toContain(WORKSPACE_PATH)
    await expect(filesystem.resolve('../outside', { cwd: WORKSPACE_PATH }))
      .rejects.toMatchObject({ code: 'FS_PERMISSION_DENIED' })
    await expect(filesystem.resolve('/etc/passwd', { cwd: WORKSPACE_PATH }))
      .rejects.toMatchObject({ code: 'FS_PERMISSION_DENIED' })
    await expect(filesystem.stat({
      targetKey: 'openloop-workspace:v1:00000000-0000-4000-8000-000000000000' as never,
      displayPath: 'src/index.ts',
    })).rejects.toMatchObject({ code: 'FS_PERMISSION_DENIED' })
    expect(broker.openRoot).toHaveBeenCalledTimes(2)
  })

  it('rejects resolution when the workspace has no ready native grant', async () => {
    const { broker, filesystem } = harness()
    broker.openRoot.mockRejectedValueOnce(bridgeError(
      'file_grant_unavailable',
      'desktop Workspace file grant is unavailable',
    ))

    await expect(filesystem.resolve('src/index.ts', { cwd: WORKSPACE_PATH }))
      .rejects.toMatchObject({ code: 'FS_PERMISSION_DENIED' })
  })

  it('maps stable native file broker errors without treating caller intent as an error code', async () => {
    const missingHarness = harness()
    const missing = await missingHarness.filesystem.resolve('missing.txt', {
      cwd: WORKSPACE_PATH,
    })
    missingHarness.broker.open.mockRejectedValueOnce(bridgeError(
      'file_not_found',
      'desktop Workspace file was not found',
    ))
    await expect(missingHarness.filesystem.readText(missing))
      .rejects.toMatchObject({ code: 'FS_NOT_FOUND' })

    const createHarness = harness()
    const create = await createHarness.filesystem.resolve('new.txt', {
      cwd: WORKSPACE_PATH,
    })
    createHarness.broker.beginAtomicWrite.mockRejectedValueOnce(bridgeError(
      'file_already_exists',
      'desktop Workspace file already exists',
    ))
    await expect(createHarness.filesystem.writeText(
      create,
      'new',
      { kind: 'createIfAbsent' },
      signal,
      { mode: 'workspace-write', workspaceRoot: WORKSPACE_PATH },
    )).rejects.toMatchObject({ code: 'FS_NOT_OBSERVED' })

    const staleHarness = harness({
      'stale.txt': { kind: 'regular', bytes: text('before'), version: 'v1' },
    })
    const stale = await staleHarness.filesystem.resolve('stale.txt', {
      cwd: WORKSPACE_PATH,
    })
    staleHarness.broker.commitAtomicWrite.mockRejectedValueOnce(bridgeError(
      'file_version_conflict',
      'desktop Workspace file version changed',
    ))
    await expect(staleHarness.filesystem.writeText(
      stale,
      'after',
      undefined,
      signal,
      { mode: 'workspace-write', workspaceRoot: WORKSPACE_PATH },
    )).rejects.toMatchObject({ code: 'FS_STALE_VERSION' })

    const ioHarness = harness({
      'io.txt': { kind: 'regular', bytes: text('before'), version: 'v1' },
    })
    const io = await ioHarness.filesystem.resolve('io.txt', { cwd: WORKSPACE_PATH })
    ioHarness.broker.writeChunk.mockRejectedValueOnce(bridgeError(
      'file_failure',
      'desktop Workspace file operation failed',
    ))
    await expect(ioHarness.filesystem.writeText(
      io,
      'after',
      { kind: 'replaceIfVersion', version: 'v1' as never },
      signal,
      { mode: 'workspace-write', workspaceRoot: WORKSPACE_PATH },
    )).rejects.toMatchObject({ code: 'FS_IO_ERROR' })
  })

  it('maps already-exists to not-observed only for explicit create intent', async () => {
    const { broker, filesystem } = harness()
    const target = await filesystem.resolve('new.txt', { cwd: WORKSPACE_PATH })
    broker.beginAtomicWrite.mockRejectedValueOnce(bridgeError(
      'file_already_exists',
      'desktop Workspace file already exists',
    ))

    await expect(filesystem.writeText(
      target,
      'new',
      undefined,
      signal,
      { mode: 'workspace-write', workspaceRoot: WORKSPACE_PATH },
    )).rejects.toMatchObject({ code: 'FS_IO_ERROR' })
  })

  it('implements stat, lstat, and stable listing only through broker handles', async () => {
    const { calls, filesystem } = harness({
      src: { kind: 'directory' },
      'src/b.ts': { kind: 'regular', bytes: text('b'), version: 'v-b' },
      'src/a.ts': { kind: 'regular', bytes: text('aa'), version: 'v-a' },
      'src/link': { kind: 'symlink', version: 'v-link' },
    })
    const target = await filesystem.resolve('src/a.ts', { cwd: WORKSPACE_PATH })

    await expect(filesystem.stat(target)).resolves.toEqual({
      type: 'file',
      size: 2,
      version: 'v-a',
    })
    await expect(filesystem.lstat('src/link', { cwd: WORKSPACE_PATH })).resolves.toEqual({
      type: 'symlink',
      size: 0,
      version: 'v-link',
    })
    const listed = await filesystem.listDir(
      await filesystem.resolve('src', { cwd: WORKSPACE_PATH }),
    )
    expect(listed.map(entry => [entry.name, entry.type, entry.target.displayPath]))
      .toEqual([
        ['a.ts', 'file', 'src/a.ts'],
        ['b.ts', 'file', 'src/b.ts'],
        ['link', 'other', 'src/link'],
      ])
    expect(calls.some(call => call.method === 'list')).toBe(true)
    expect(calls.every(call => !JSON.stringify(call.args).includes(WORKSPACE_PATH)))
      .toBe(true)
  })

  it('reads text, streams UTF-8 boundaries, and enforces raw byte limits through broker reads', async () => {
    const { broker, filesystem } = harness({
      'unicode.txt': { kind: 'regular', bytes: text('A\u20acB'), version: 'v1' },
    })
    const target = await filesystem.resolve('unicode.txt', { cwd: WORKSPACE_PATH })

    await expect(filesystem.readText(target)).resolves.toBe('A\u20acB')
    const streamed: string[] = []
    for await (const chunk of await filesystem.streamText(target)) streamed.push(chunk)
    expect(streamed.join('')).toBe('A\u20acB')
    await expect(filesystem.readBytes(target, undefined, 4))
      .rejects.toMatchObject({ code: 'FS_TOO_LARGE' })
    expect(broker.read).toHaveBeenCalled()
  })

  it('rejects a raw byte read when the file grows past its initial size', async () => {
    const { broker, filesystem } = harness({
      'growing.bin': { kind: 'regular', bytes: text('old'), version: 'v1' },
    })
    const target = await filesystem.resolve('growing.bin', { cwd: WORKSPACE_PATH })
    broker.stat
      .mockResolvedValueOnce({ kind: 'regular', size: 3, version: 'v1' })
      .mockResolvedValueOnce({ kind: 'regular', size: 4, version: 'v2' })
    broker.read.mockResolvedValueOnce({
      bytes: text('old'),
      nextOffset: 3,
      eof: false,
    })

    await expect(filesystem.readBytes(target, undefined, 10))
      .rejects.toMatchObject({
        code: 'FS_IO_ERROR',
        message: 'cannot read "growing.bin": file changed during read',
      })
  })

  it('rejects a mixed raw byte result when the version changes without a size change', async () => {
    const { broker, filesystem } = harness({
      'replaced.bin': { kind: 'regular', bytes: text('abcdef'), version: 'v1' },
    })
    const target = await filesystem.resolve('replaced.bin', { cwd: WORKSPACE_PATH })
    broker.stat
      .mockResolvedValueOnce({ kind: 'regular', size: 6, version: 'v1' })
      .mockResolvedValueOnce({ kind: 'regular', size: 6, version: 'v2' })
    broker.read
      .mockResolvedValueOnce({ bytes: text('abc'), nextOffset: 3, eof: false })
      .mockResolvedValueOnce({ bytes: text('XYZ'), nextOffset: 6, eof: true })

    await expect(filesystem.readBytes(target, undefined, 10))
      .rejects.toMatchObject({
        code: 'FS_IO_ERROR',
        message: 'cannot read "replaced.bin": file changed during read',
      })
  })

  it('returns a stable raw byte result after validating its final stat', async () => {
    const { broker, filesystem } = harness({
      'stable.bin': { kind: 'regular', bytes: text('stable'), version: 'v1' },
    })
    const target = await filesystem.resolve('stable.bin', { cwd: WORKSPACE_PATH })

    await expect(filesystem.readBytes(target, undefined, 10)).resolves.toEqual(text('stable'))
    expect(broker.stat).toHaveBeenCalledTimes(2)
  })

  it('validates the final stat before returning an empty raw byte result', async () => {
    const { broker, filesystem } = harness({
      'empty.bin': { kind: 'regular', bytes: new Uint8Array(), version: 'v1' },
    })
    const target = await filesystem.resolve('empty.bin', { cwd: WORKSPACE_PATH })

    await expect(filesystem.readBytes(target, undefined, 0)).resolves.toEqual(new Uint8Array())
    expect(broker.read).not.toHaveBeenCalled()
    expect(broker.stat).toHaveBeenCalledTimes(2)
  })

  it('routes model-facing read, write, and edit through the broker and preserves stale guards', async () => {
    const { broker, ctx, entries, filesystem } = harness({
      'note.txt': { kind: 'regular', bytes: text('old text'), version: 'v1' },
    })
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(FsPolicy)
    await ctx.plugin(ToolFs)

    const read = await call(ctx, 'read', { file_path: 'note.txt' })
    expect(read.isError).toBe(false)
    const write = await call(ctx, 'write', { file_path: 'note.txt', content: 'new text' })
    if (write.isError) throw new Error(JSON.stringify(write))
    expect(write.isError).toBe(false)
    const reread = await call(ctx, 'read', { file_path: 'note.txt' })
    expect(reread.isError).toBe(false)
    const edit = await call(ctx, 'edit', {
      file_path: 'note.txt',
      old_string: 'new',
      new_string: 'final',
    })
    expect(edit.isError).toBe(false)
    expect(new TextDecoder().decode(entries.get('note.txt')?.bytes)).toBe('final text')
    expect(broker.open).toHaveBeenCalled()
    expect(broker.read).toHaveBeenCalled()
    expect(broker.beginAtomicWrite).toHaveBeenCalled()
    expect(broker.writeChunk).toHaveBeenCalled()
    expect(broker.commitAtomicWrite).toHaveBeenCalled()

    const stale = await filesystem.resolve('note.txt', { cwd: WORKSPACE_PATH })
    await expect(filesystem.writeText(
      stale,
      'lost update',
      { kind: 'replaceIfVersion', version: 'v1' as never },
      signal,
      { mode: 'workspace-write', workspaceRoot: WORKSPACE_PATH },
    )).rejects.toMatchObject({ code: 'FS_STALE_VERSION' })
  })

  it('rejects read-only writes before opening an atomic broker handle', async () => {
    const { broker, filesystem } = harness()
    const target = await filesystem.resolve('new.txt', { cwd: WORKSPACE_PATH })

    await expect(filesystem.writeText(
      target,
      'blocked',
      undefined,
      signal,
      { mode: 'read-only', workspaceRoot: WORKSPACE_PATH },
    )).rejects.toMatchObject({ code: 'FS_SANDBOX_DENIED' })
    expect(broker.beginAtomicWrite).not.toHaveBeenCalled()
  })
})
