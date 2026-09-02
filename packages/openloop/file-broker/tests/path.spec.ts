import { describe, expect, it } from 'vitest'
import {
  WorkspaceFileBroker,
  type WorkspaceFileBrokerPort,
} from '../src/index.ts'
import {
  MAX_FILE_CHUNK_BYTES,
  normalizeRelativePath,
} from '../src/path.ts'

describe('Workspace broker relative paths', () => {
  it.each([
    'src/index.ts',
    'README.md',
    '目录/文件.txt',
    'literal%20name.txt',
  ])('accepts an already-normalized relative path: %s', (path) => {
    expect(normalizeRelativePath(path)).toBe(path)
  })

  it.each([
    '',
    '.',
    '..',
    '/etc/passwd',
    '//server/share',
    String.raw`C:\Windows\system.ini`,
    'C:/Windows/system.ini',
    String.raw`\\server\share`,
    'dir/',
    'dir//file',
    './file',
    'dir/./file',
    '../file',
    'dir/../file',
    String.raw`dir\..\file`,
    'dir\u0000file',
    '%2e%2e/secret',
    '%2E%2E/secret',
    '%252e%252e/secret',
    'dir%2ffile',
    'dir%5cfile',
    'file:///etc/passwd',
  ])('rejects an unsafe or non-normalized path: %s', (path) => {
    expect(() => normalizeRelativePath(path)).toThrow(/relative path/i)
  })

  it('keeps one decoded bridge chunk comfortably below the 64 KiB frame', () => {
    expect(MAX_FILE_CHUNK_BYTES).toBe(32 * 1024)
    expect(Math.ceil(MAX_FILE_CHUNK_BYTES / 3) * 4).toBeLessThan(64 * 1024)
  })
})

describe('Workspace file broker Host facade', () => {
  it('normalizes paths before forwarding only workspace ids and relative paths', async () => {
    const calls: unknown[] = []
    const port = {
      openWorkspaceFile: async (workspaceId: string, relativePath: string, mode: string) => {
        calls.push({ workspaceId, relativePath, mode })
        return { handleId: 'opaque', kind: 'regular' as const, version: 'v1' }
      },
    } as WorkspaceFileBrokerPort
    const broker = new WorkspaceFileBroker(port)

    await expect(broker.open('workspace-1', 'src/index.ts')).resolves.toMatchObject({
      handleId: 'opaque',
    })
    await expect(broker.open('workspace-1', '../secret')).rejects.toThrow(/relative path/i)
    expect(calls).toEqual([{
      workspaceId: 'workspace-1',
      relativePath: 'src/index.ts',
      mode: 'read',
    }])
  })

  it('uses the internal root marker only through openRoot', async () => {
    const paths: string[] = []
    const port = {
      openWorkspaceRoot: async (workspaceId: string) => {
        paths.push(workspaceId)
        return { handleId: 'root', kind: 'directory' as const }
      },
    } as WorkspaceFileBrokerPort
    const broker = new WorkspaceFileBroker(port)

    await expect(broker.openRoot('workspace-1')).resolves.toMatchObject({
      handleId: 'root',
    })
    expect(paths).toEqual(['workspace-1'])
    expect(() => normalizeRelativePath('.')).toThrow()
  })

  it('rejects oversized write chunks before they reach the bridge', async () => {
    let calls = 0
    const port = {
      writeWorkspaceFileChunk: async () => { calls += 1 },
    } as unknown as WorkspaceFileBrokerPort
    const broker = new WorkspaceFileBroker(port)

    await expect(broker.writeChunk(
      '00000000-0000-4000-8000-000000000000',
      new Uint8Array(MAX_FILE_CHUNK_BYTES + 1),
    )).rejects.toThrow(/chunk/i)
    expect(calls).toBe(0)
  })
})
