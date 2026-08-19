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
  initFailure: false,
  manifestConflict: false,
  openedPaths: new Map<number, string>(),
  partialWriteFailure: undefined as string | undefined,
  publishFailure: undefined as string | undefined,
  stagingDirs: [] as string[],
}))

function isProfileFile(path: unknown, filename: string): boolean {
  return normalize(String(path)).endsWith(normalize(join('profiles', 'openloop', filename)))
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
      if (state.manifestConflict && isProfileFile(path, 'package.json')) {
        actual.writeFileSync(path, '{"name":"user-race-winner"}\n', { encoding: 'utf8', flag: 'wx' })
        throw Object.assign(new Error('injected user manifest race'), { code: 'EEXIST' })
      }
      const descriptor = actual.openSync(path, flags, mode)
      state.openedPaths.set(descriptor, String(path))
      return descriptor
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
      fs.writeFileSync(join(dir, 'pnpm-workspace.yaml'), 'packages:\n  - .\n')
      if (state.initFailure) throw new Error('injected staging initialization failure')
    },
  }
})

const tmp = (): string => mkdtempSync(join(tmpdir(), 'openloop-profile-publish-'))

beforeEach(() => {
  state.initFailure = false
  state.manifestConflict = false
  state.openedPaths.clear()
  state.partialWriteFailure = undefined
  state.publishFailure = undefined
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
    state.manifestConflict = true

    expect(ensureOpenloopProfile(home)).toBe(profileDir)

    expect(readFileSync(join(profileDir, 'package.json'), 'utf8'))
      .toBe('{"name":"user-race-winner"}\n')
    expect(existsSync(join(profileDir, 'cordis.patch.yml'))).toBe(false)
    expect(existsSync(join(profileDir, 'pnpm-workspace.yaml'))).toBe(false)
  })
})
