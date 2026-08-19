import { randomUUID } from 'node:crypto'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import {
  initProfile,
  resolveProfileDir,
} from '@deepseek-ai/dsh-app-boot'

/** Ordered DSH bundle layers for the OpenLoop desktop profile. */
export const OPENLOOP_PROFILE_BUNDLES = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', '@openloop/bundle'] as const

const PROFILE_INIT_LOCK_DIRECTORY = '.openloop.init.lock'
const PROFILE_INIT_LOCK_OWNER = 'owner.json'
const PROFILE_INIT_LOCK_TIMEOUT_MS = 5_000
const PROFILE_INIT_LOCK_POLL_MS = 25
const lockWaitState = new Int32Array(new SharedArrayBuffer(4))

interface ProfileInitLockOwner {
  readonly pid: number
  readonly createdAt: number
  readonly token: string
}

interface ProfileInitLock {
  readonly path: string
  readonly owner: ProfileInitLockOwner
}

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | null)?.code
}

function waitForLockPoll(): void {
  Atomics.wait(lockWaitState, 0, 0, PROFILE_INIT_LOCK_POLL_MS)
}

function readLockOwner(lockPath: string): ProfileInitLockOwner | undefined {
  try {
    const stat = lstatSync(lockPath)
    if (!stat.isDirectory() || stat.isSymbolicLink()) return undefined
    const value = JSON.parse(readFileSync(join(lockPath, PROFILE_INIT_LOCK_OWNER), 'utf8')) as Partial<ProfileInitLockOwner>
    const { pid, createdAt, token } = value
    if (typeof pid !== 'number' || !Number.isSafeInteger(pid) || pid <= 0
      || typeof createdAt !== 'number' || !Number.isSafeInteger(createdAt) || createdAt < 0
      || typeof token !== 'string' || token === '') {
      return undefined
    }
    return { pid, createdAt, token }
  } catch {
    return undefined
  }
}

function lockOwnerDiagnostic(lockPath: string): string {
  const owner = readLockOwner(lockPath)
  return owner === undefined
    ? 'owner metadata is missing, invalid, or unsafe'
    : `owner pid ${owner.pid}, createdAt ${owner.createdAt}`
}

function acquireProfileInitLock(profileDir: string): ProfileInitLock {
  const profileParent = dirname(profileDir)
  const lockPath = join(profileParent, PROFILE_INIT_LOCK_DIRECTORY)
  mkdirSync(profileParent, { recursive: true, mode: 0o700 })
  assertDirectoryIsNotSymlink(profileParent, 'OpenLoop profile parent')
  const deadline = Date.now() + PROFILE_INIT_LOCK_TIMEOUT_MS

  for (;;) {
    try {
      mkdirSync(lockPath, { mode: 0o700 })
    } catch (error) {
      if (errorCode(error) !== 'EEXIST') throw error
      if (Date.now() >= deadline) {
        throw new Error(
          `OpenLoop profile initialization timed out after ${PROFILE_INIT_LOCK_TIMEOUT_MS}ms `
          + `waiting for ${lockPath} (${lockOwnerDiagnostic(lockPath)}); `
          + 'the existing lock was left untouched',
        )
      }
      waitForLockPoll()
      continue
    }

    const owner: ProfileInitLockOwner = {
      pid: process.pid,
      createdAt: Date.now(),
      token: randomUUID(),
    }
    try {
      writeFileSync(
        join(lockPath, PROFILE_INIT_LOCK_OWNER),
        `${JSON.stringify(owner)}\n`,
        { encoding: 'utf8', flag: 'wx', mode: 0o600 },
      )
    } catch (error) {
      rmSync(lockPath, { recursive: true, force: true })
      throw error
    }
    return { path: lockPath, owner }
  }
}

function releaseProfileInitLock(lock: ProfileInitLock): void {
  const current = readLockOwner(lock.path)
  if (current?.token !== lock.owner.token) {
    throw new Error(
      `OpenLoop profile initialization lock ownership changed at ${lock.path}; `
      + 'refusing to remove a lock owned by another process',
    )
  }
  rmSync(lock.path, { recursive: true })
}

function assertDirectoryIsNotSymlink(path: string, label: string): void {
  try {
    if (lstatSync(path).isSymbolicLink()) {
      throw new Error(`${label} must not be a symbolic link: ${path}`)
    }
  } catch (error) {
    if (errorCode(error) !== 'ENOENT') throw error
  }
}

/**
 * Resolve and, when absent, initialize the OpenLoop profile.
 * An existing manifest makes the whole profile user-owned and read-only here.
 * @param home - optional DSH home override.
 * @returns the absolute OpenLoop profile directory.
 */
export function ensureOpenloopProfile(home?: string): string {
  const dir = resolveProfileDir('openloop', home)
  const manifestPath = join(dir, 'package.json')
  if (existsSync(manifestPath)) return dir

  const lock = acquireProfileInitLock(dir)
  try {
    if (existsSync(manifestPath)) return dir
    assertDirectoryIsNotSymlink(dir, 'OpenLoop profile directory')
    initProfile(dir, OPENLOOP_PROFILE_BUNDLES)
  } finally {
    releaseProfileInitLock(lock)
  }
  return dir
}
