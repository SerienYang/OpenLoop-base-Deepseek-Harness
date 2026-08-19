import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, normalize } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ensureOpenloopProfile } from '../src/profile.ts'

const state = vi.hoisted(() => ({
  captureOnRollbackRename: undefined as {
    readonly filename: string
    readonly content: string
    readonly occupant?: string
  } | undefined,
  initFailure: false,
  manifestConflict: undefined as string | undefined,
  openedPaths: new Map<number, string>(),
  partialWriteFailure: undefined as string | undefined,
  publishFailure: undefined as string | undefined,
  quarantinePaths: [] as string[],
  replaceAfterRollbackRead: undefined as {
    readonly filename: string
    readonly content: string
    reads: number
  } | undefined,
  stagingDirs: [] as string[],
}))

function isProfileFile(path: unknown, filename: string): boolean {
  return normalize(String(path)).endsWith(normalize(join('profiles', 'openloop', filename)))
}

function isRollbackQuarantine(path: unknown, filename: string): boolean {
  const normalized = normalize(String(path))
  const marker = `${normalize(join('profiles', 'openloop', filename))}.quarantine-`
  return normalized.includes(marker)
}

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return {
    ...actual,
    openSync(
      path: Parameters<typeof actual.openSync>[0],
      flags: Parameters<typeof actual.openSync>[1],
      mode?: Parameters<typeof actual.openSync>[2],
    ): number {
      if (state.publishFailure !== undefined && isProfileFile(path, state.publishFailure)) {
        throw Object.assign(new Error(`injected publish failure for ${state.publishFailure}`), { code: 'EACCES' })
      }
      if (state.manifestConflict !== undefined && isProfileFile(path, 'package.json')) {
        actual.writeFileSync(path, state.manifestConflict, { encoding: 'utf8', flag: 'wx' })
        throw Object.assign(new Error('injected user manifest race'), { code: 'EEXIST' })
      }
      const descriptor = actual.openSync(path, flags, mode)
      state.openedPaths.set(descriptor, String(path))
      return descriptor
    },
    readFileSync(path: Parameters<typeof actual.readFileSync>[0], options?: Parameters<typeof actual.readFileSync>[1]) {
      const result = actual.readFileSync(path, options as never)
      const replacement = state.replaceAfterRollbackRead
      if (replacement !== undefined
        && (isProfileFile(path, replacement.filename) || isRollbackQuarantine(path, replacement.filename))) {
        replacement.reads += 1
        if (replacement.reads === 2) {
          const readPath = String(path)
          const marker = '.quarantine-'
          const originalPath = readPath.includes(marker)
            ? readPath.slice(0, readPath.indexOf(marker))
            : readPath
          const replacementPath = `${originalPath}.user-race`
          actual.writeFileSync(replacementPath, replacement.content, { encoding: 'utf8', flag: 'wx' })
          actual.renameSync(replacementPath, originalPath)
          state.replaceAfterRollbackRead = undefined
        }
      }
      return result
    },
    renameSync(oldPath: Parameters<typeof actual.renameSync>[0], newPath: Parameters<typeof actual.renameSync>[1]): void {
      const capture = state.captureOnRollbackRename
      if (capture !== undefined
        && isProfileFile(oldPath, capture.filename)
        && isRollbackQuarantine(newPath, capture.filename)) {
        const replacementPath = `${String(oldPath)}.captured-race`
        actual.writeFileSync(replacementPath, capture.content, { encoding: 'utf8', flag: 'wx' })
        actual.renameSync(replacementPath, oldPath)
        actual.renameSync(oldPath, newPath)
        state.quarantinePaths.push(String(newPath))
        if (capture.occupant !== undefined) {
          actual.writeFileSync(oldPath, capture.occupant, { encoding: 'utf8', flag: 'wx' })
        }
        state.captureOnRollbackRename = undefined
        return
      }
      actual.renameSync(oldPath, newPath)
    },
    writeFileSync(
      path: Parameters<typeof actual.writeFileSync>[0],
      data: Parameters<typeof actual.writeFileSync>[1],
      options?: Parameters<typeof actual.writeFileSync>[2],
    ): void {
      const openedPath = typeof path === 'number' ? state.openedPaths.get(path) : undefined
      if (openedPath !== undefined && state.partialWriteFailure !== undefined
        && isProfileFile(openedPath, state.partialWriteFailure)) {
        actual.writeFileSync(path, Buffer.from('partial'))
        throw Object.assign(new Error(`injected partial write for ${state.partialWriteFailure}`), { code: 'EIO' })
      }
      actual.writeFileSync(path, data, options)
    },
  }
})

vi.mock('@deepseek-ai/dsh-app-boot', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@deepseek-ai/dsh-app-boot')>()
  const fs = await import('node:fs')
  return {
    ...actual,
    initProfile(dir: string): void {
      state.stagingDirs.push(dir)
      mkdirSync(dir, { recursive: true })
      fs.writeFileSync(join(dir, 'package.json'), '{"name":"staged-openloop"}\n')
      fs.writeFileSync(join(dir, 'cordis.patch.yml'), '[]\n')
      fs.writeFileSync(
        join(dir, 'pnpm-workspace.yaml'),
        'packages:\n  - .\nnodeLinker: hoisted\nautoInstallPeers: false\n',
      )
      if (state.initFailure) throw new Error('injected staging initialization failure')
    },
  }
})

const tmp = (): string => mkdtempSync(join(tmpdir(), 'openloop-profile-publish-'))

beforeEach(() => {
  state.captureOnRollbackRename = undefined
  state.initFailure = false
  state.manifestConflict = undefined
  state.openedPaths.clear()
  state.partialWriteFailure = undefined
  state.publishFailure = undefined
  state.quarantinePaths = []
  state.replaceAfterRollbackRead = undefined
  state.stagingDirs = []
})

describe('OpenLoop profile atomic publication', () => {
  it('leaves no profile fragments when DSH staging initialization fails', () => {
    const home = tmp()
    const profileDir = join(home, 'profiles', 'openloop')
    state.initFailure = true

    expect(() => ensureOpenloopProfile(home))
      .toThrow('injected staging initialization failure')

    for (const filename of ['package.json', 'cordis.patch.yml', 'pnpm-workspace.yaml']) {
      expect(existsSync(join(profileDir, filename)), filename).toBe(false)
    }
    expect(state.stagingDirs).toHaveLength(1)
    expect(normalize(state.stagingDirs[0]!)).not.toBe(normalize(profileDir))
    expect(readdirSync(join(home, 'profiles')).every(name => name === 'openloop')).toBe(true)
  })

  it('publishes no manifest and rolls back its supporting files when support publication fails', () => {
    const home = tmp()
    const profileDir = join(home, 'profiles', 'openloop')
    state.publishFailure = 'pnpm-workspace.yaml'

    expect(() => ensureOpenloopProfile(home))
      .toThrow('injected publish failure for pnpm-workspace.yaml')

    expect(existsSync(join(profileDir, 'package.json'))).toBe(false)
    expect(existsSync(join(profileDir, 'cordis.patch.yml'))).toBe(false)
    expect(existsSync(join(profileDir, 'pnpm-workspace.yaml'))).toBe(false)
  })

  it('removes an unchanged partial file after an exclusive write fails', () => {
    const home = tmp()
    const profileDir = join(home, 'profiles', 'openloop')
    state.partialWriteFailure = 'cordis.patch.yml'

    expect(() => ensureOpenloopProfile(home))
      .toThrow('injected partial write for cordis.patch.yml')

    expect(existsSync(join(profileDir, 'package.json'))).toBe(false)
    expect(existsSync(join(profileDir, 'cordis.patch.yml'))).toBe(false)
    expect(existsSync(join(profileDir, 'pnpm-workspace.yaml'))).toBe(false)
  })

  it('preserves a user file atomically replacing a rollback candidate after its validation read', () => {
    const home = tmp()
    const profileDir = join(home, 'profiles', 'openloop')
    const patchPath = join(profileDir, 'cordis.patch.yml')
    state.partialWriteFailure = 'cordis.patch.yml'
    state.replaceAfterRollbackRead = {
      filename: 'cordis.patch.yml',
      content: '# user replacement after validation\n',
      reads: 0,
    }

    expect(() => ensureOpenloopProfile(home))
      .toThrow('injected partial write for cordis.patch.yml')

    expect(readFileSync(patchPath, 'utf8')).toBe('# user replacement after validation\n')
  })

  it('restores a non-owned regular file captured by rollback quarantine', () => {
    const home = tmp()
    const profileDir = join(home, 'profiles', 'openloop')
    const patchPath = join(profileDir, 'cordis.patch.yml')
    state.partialWriteFailure = 'cordis.patch.yml'
    state.captureOnRollbackRename = {
      filename: 'cordis.patch.yml',
      content: '# user file captured by quarantine\n',
    }

    expect(() => ensureOpenloopProfile(home))
      .toThrow('injected partial write for cordis.patch.yml')

    expect(readFileSync(patchPath, 'utf8')).toBe('# user file captured by quarantine\n')
    expect(state.quarantinePaths).toHaveLength(1)
    expect(existsSync(state.quarantinePaths[0]!)).toBe(false)
  })

  it('keeps quarantine and fails loud when the original path is occupied during restore', () => {
    const home = tmp()
    const profileDir = join(home, 'profiles', 'openloop')
    const patchPath = join(profileDir, 'cordis.patch.yml')
    state.partialWriteFailure = 'cordis.patch.yml'
    state.captureOnRollbackRename = {
      filename: 'cordis.patch.yml',
      content: '# user file held in quarantine\n',
      occupant: '# concurrent path occupant\n',
    }

    let failure: unknown
    try {
      ensureOpenloopProfile(home)
    } catch (error) {
      failure = error
    }

    expect(state.quarantinePaths).toHaveLength(1)
    const quarantinePath = state.quarantinePaths[0]!
    expect(failure).toEqual(expect.objectContaining({
      message: expect.stringContaining(patchPath),
    }))
    expect((failure as Error).message).toContain(quarantinePath)
    expect(readFileSync(patchPath, 'utf8')).toBe('# concurrent path occupant\n')
    expect(readFileSync(quarantinePath, 'utf8')).toBe('# user file held in quarantine\n')
  })

  it('preserves existing supporting files while committing a new manifest last', () => {
    const home = tmp()
    const profileDir = join(home, 'profiles', 'openloop')
    mkdirSync(profileDir, { recursive: true })
    const userPatch = '# user-owned\n[]\n'
    writeFileSync(join(profileDir, 'cordis.patch.yml'), userPatch)

    ensureOpenloopProfile(home)

    expect(readFileSync(join(profileDir, 'cordis.patch.yml'), 'utf8')).toBe(userPatch)
    expect(existsSync(join(profileDir, 'pnpm-workspace.yaml'))).toBe(true)
    expect(existsSync(join(profileDir, 'package.json'))).toBe(true)
  })

  it('rolls back only its supporting files when a user manifest wins the final O_EXCL race', () => {
    const home = tmp()
    const profileDir = join(home, 'profiles', 'openloop')
    state.manifestConflict = '{"name":"user-race-winner"}\n'

    expect(ensureOpenloopProfile(home)).toBe(profileDir)

    expect(readFileSync(join(profileDir, 'package.json'), 'utf8'))
      .toBe('{"name":"user-race-winner"}\n')
    expect(existsSync(join(profileDir, 'cordis.patch.yml'))).toBe(false)
    expect(existsSync(join(profileDir, 'pnpm-workspace.yaml'))).toBe(false)
  })

  it('rejects an invalid manifest that wins the final O_EXCL race and rolls back its supporting files', () => {
    const home = tmp()
    const profileDir = join(home, 'profiles', 'openloop')
    state.manifestConflict = 'partial'

    expect(() => ensureOpenloopProfile(home))
      .toThrow(/package\.json.*parseable JSON/i)

    expect(readFileSync(join(profileDir, 'package.json'), 'utf8')).toBe('partial')
    expect(existsSync(join(profileDir, 'cordis.patch.yml'))).toBe(false)
    expect(existsSync(join(profileDir, 'pnpm-workspace.yaml'))).toBe(false)
  })
})
