import { Context } from '@deepseek-ai/cordis'
import { CallId } from '@deepseek-ai/dsh-llm'
import * as FsPolicy from '@deepseek-ai/dsh-fs-observation-policy'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as ToolFs from '@deepseek-ai/dsh-tool-fs'
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

function text(value: string): Uint8Array {
  return new TextEncoder().encode(value)
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
    broker.openRoot.mockRejectedValueOnce(new Error('grant unavailable'))

    await expect(filesystem.resolve('src/index.ts', { cwd: WORKSPACE_PATH }))
      .rejects.toMatchObject({ code: 'FS_PERMISSION_DENIED' })
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
