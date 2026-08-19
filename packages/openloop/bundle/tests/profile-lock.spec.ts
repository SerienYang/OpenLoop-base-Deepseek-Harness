import { fork, type ChildProcess } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ensureOpenloopProfile } from '../src/profile.ts'

interface LockOwner {
  readonly pid: number
  readonly createdAt: number
  readonly token: string
}

const state = vi.hoisted(() => ({
  changeTokenAfterQuarantine: false,
  manifestOnContentionAt: undefined as string | undefined,
}))

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return {
    ...actual,
    mkdirSync(path: Parameters<typeof actual.mkdirSync>[0], options?: Parameters<typeof actual.mkdirSync>[1]) {
      const text = normalize(String(path))
      if (state.manifestOnContentionAt !== undefined && text === normalize(state.manifestOnContentionAt)) {
        state.manifestOnContentionAt = undefined
        actual.mkdirSync(join(text, '..', 'openloop'), { recursive: true })
        actual.writeFileSync(join(text, '..', 'openloop', 'package.json'), '{"name":"winner"}\n')
      }
      return actual.mkdirSync(path, options as never)
    },
    renameSync(oldPath: Parameters<typeof actual.renameSync>[0], newPath: Parameters<typeof actual.renameSync>[1]): void {
      actual.renameSync(oldPath, newPath)
      if (state.changeTokenAfterQuarantine
        && normalize(String(oldPath)).endsWith(normalize(join('profiles', '.openloop.init.lock')))) {
        state.changeTokenAfterQuarantine = false
        const ownerPath = join(String(newPath), 'owner.json')
        const owner = JSON.parse(actual.readFileSync(ownerPath, 'utf8')) as LockOwner
        actual.writeFileSync(ownerPath, `${JSON.stringify({ ...owner, token: 'changed-owner-token' })}\n`)
      }
    },
  }
})

const children = new Set<ChildProcess>()
const tmp = (): string => mkdtempSync(join(tmpdir(), 'openloop-profile-lock-'))
const lockPath = (home: string): string => join(home, 'profiles', '.openloop.init.lock')

function writeLock(home: string, owner: LockOwner): string {
  const path = lockPath(home)
  mkdirSync(path, { recursive: true })
  writeFileSync(join(path, 'owner.json'), `${JSON.stringify(owner)}\n`)
  return path
}

function waitForMessage(child: ChildProcess, type: string): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const onMessage = (message: unknown): void => {
      if (typeof message !== 'object' || message === null
        || (message as Record<string, unknown>)['type'] !== type) return
      cleanup()
      resolve(message as Record<string, unknown>)
    }
    const onError = (error: Error): void => {
      cleanup()
      reject(error)
    }
    const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
      cleanup()
      reject(new Error(`lock holder exited before ${type}: code=${String(code)} signal=${String(signal)}`))
    }
    const cleanup = (): void => {
      child.off('message', onMessage)
      child.off('error', onError)
      child.off('exit', onExit)
    }
    child.on('message', onMessage)
    child.on('error', onError)
    child.on('exit', onExit)
  })
}

beforeEach(() => {
  state.changeTokenAfterQuarantine = false
  state.manifestOnContentionAt = undefined
})

afterEach(() => {
  vi.restoreAllMocks()
  for (const child of children) child.kill()
  children.clear()
})

describe('OpenLoop profile initialization lock', () => {
  it('recovers a conservatively stale lock only when its owner is definitely dead', () => {
    const home = tmp()
    const owner = { pid: 41_041, createdAt: 1, token: 'dead-owner' }
    const path = writeLock(home, owner)
    vi.spyOn(process, 'kill').mockImplementation((pid) => {
      expect(pid).toBe(owner.pid)
      throw Object.assign(new Error('no such process'), { code: 'ESRCH' })
    })

    expect(ensureOpenloopProfile(home)).toBe(join(home, 'profiles', 'openloop'))

    expect(existsSync(join(home, 'profiles', 'openloop', 'package.json'))).toBe(true)
    expect(existsSync(path)).toBe(false)
  })

  it('reuses a manifest published between lock contention and the required recheck', () => {
    const home = tmp()
    const owner = { pid: process.pid, createdAt: Date.now(), token: 'live-owner' }
    const path = writeLock(home, owner)
    state.manifestOnContentionAt = path

    expect(ensureOpenloopProfile(home)).toBe(join(home, 'profiles', 'openloop'))

    expect(readFileSync(join(path, 'owner.json'), 'utf8'))
      .toBe(`${JSON.stringify(owner)}\n`)
  })

  it('fails immediately on a live lock without blocking an event-loop timer', async () => {
    const home = tmp()
    const owner = { pid: process.pid, createdAt: Date.now(), token: 'live-owner' }
    const path = writeLock(home, owner)
    let timerFired = false
    const timer = new Promise<void>((resolve) => {
      setTimeout(() => {
        timerFired = true
        resolve()
      }, 0)
    })
    const startedAt = performance.now()

    expect(() => ensureOpenloopProfile(home))
      .toThrow(/already in progress.*live-owner/i)

    expect(performance.now() - startedAt).toBeLessThan(500)
    await timer
    expect(timerFired).toBe(true)
    expect(readFileSync(join(path, 'owner.json'), 'utf8'))
      .toBe(`${JSON.stringify(owner)}\n`)
  })

  it('does not delete a quarantined lock when its owner token changes', () => {
    const home = tmp()
    const owner = { pid: 41_042, createdAt: 1, token: 'observed-owner' }
    const path = writeLock(home, owner)
    state.changeTokenAfterQuarantine = true
    vi.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('no such process'), { code: 'ESRCH' })
    })

    expect(() => ensureOpenloopProfile(home))
      .toThrow(/ownership changed.*refusing to remove/i)

    expect(existsSync(path)).toBe(true)
    expect(JSON.parse(readFileSync(join(path, 'owner.json'), 'utf8'))).toMatchObject({
      pid: owner.pid,
      token: 'changed-owner-token',
    })
  })

  it('fails immediately and preserves a live lock held by an independent process', async () => {
    const home = tmp()
    const child = fork(
      fileURLToPath(new URL('./fixtures/profile-lock-holder.ts', import.meta.url)),
      [home],
      {
        execArgv: ['--import', 'tsx/esm'],
        stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
      },
    )
    children.add(child)
    const ready = await waitForMessage(child, 'ready')
    const expectedLockPath = normalize(lockPath(home))
    expect(normalize(String(ready['lockPath']))).toBe(expectedLockPath)
    const ownerBefore = readFileSync(join(expectedLockPath, 'owner.json'), 'utf8')
    const startedAt = performance.now()

    expect(() => ensureOpenloopProfile(home))
      .toThrow(new RegExp(`already in progress.*${child.pid}`, 'i'))

    expect(performance.now() - startedAt).toBeLessThan(500)
    expect(readFileSync(join(expectedLockPath, 'owner.json'), 'utf8')).toBe(ownerBefore)
    const released = waitForMessage(child, 'released')
    child.send({ type: 'release' })
    await released
    children.delete(child)
  })
})
