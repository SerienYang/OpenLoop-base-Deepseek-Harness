import { randomUUID } from 'node:crypto'
import {
  closeSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import {
  initProfile,
  loadOverlayPatches,
  resolveProfileDir,
} from '@deepseek-ai/dsh-app-boot'
import { load as loadYaml } from 'js-yaml'

/** Ordered DSH bundle layers for the OpenLoop desktop profile. */
export const OPENLOOP_PROFILE_BUNDLES = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', '@openloop/bundle'] as const

const PROFILE_INIT_LOCK_DIRECTORY = '.openloop.init.lock'
const PROFILE_INIT_LOCK_OWNER = 'owner.json'
const PROFILE_INIT_LOCK_STALE_MS = 5 * 60_000
const PROFILE_STAGE_PREFIX = '.openloop.profile-stage-'
const PROFILE_MANIFEST = 'package.json'
const PROFILE_SUPPORT_FILES = ['cordis.patch.yml', 'pnpm-workspace.yaml'] as const

interface ProfileInitLockOwner {
  readonly pid: number
  readonly createdAt: number
  readonly token: string
}

interface ProfileInitLock {
  readonly path: string
  readonly owner: ProfileInitLockOwner
}

interface CreatedProfileFile {
  readonly path: string
  readonly content: Buffer
  readonly dev: number
  readonly ino: number
}

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | null)?.code
}

function readRegularProfileFile(path: string): Buffer {
  const stat = lstatSync(path)
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`OpenLoop profile path ${path} must be a regular file, not a symbolic link or special file`)
  }
  try {
    return readFileSync(path)
  } catch (error) {
    throw new Error(`OpenLoop profile file must be readable: ${path}: ${String(error)}`)
  }
}

function assertProfileManifest(path: string): void {
  const content = readRegularProfileFile(path)
  let parsed: unknown
  try {
    parsed = JSON.parse(content.toString('utf8'))
  } catch (error) {
    throw new Error(`OpenLoop profile manifest ${path} must contain parseable JSON: ${String(error)}`)
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`OpenLoop profile manifest ${path} must contain a JSON object`)
  }
}

function hasValidProfileManifest(path: string): boolean {
  try {
    lstatSync(path)
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return false
    throw error
  }
  assertProfileManifest(path)
  return true
}

function assertProfilePatch(path: string): void {
  readRegularProfileFile(path)
  loadOverlayPatches('OpenLoop profile', path)
}

function assertProfileWorkspace(path: string): void {
  let parsed: unknown
  try {
    parsed = loadYaml(readRegularProfileFile(path).toString('utf8'))
  } catch (error) {
    throw new Error(`OpenLoop profile workspace ${path} must contain a parseable YAML object: ${String(error)}`)
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`OpenLoop profile workspace ${path} must contain a YAML object`)
  }
  const workspace = parsed as Record<string, unknown>
  if (!Array.isArray(workspace.packages) || !workspace.packages.includes('.')) {
    throw new Error(`OpenLoop profile workspace ${path} packages must contain "."`)
  }
  if (workspace.nodeLinker !== 'hoisted') {
    throw new Error(`OpenLoop profile workspace ${path} nodeLinker must equal "hoisted"`)
  }
  if (workspace.autoInstallPeers !== false) {
    throw new Error(`OpenLoop profile workspace ${path} autoInstallPeers must equal false`)
  }
}

function assertProfileSupportFiles(profileDir: string): void {
  assertProfilePatch(join(profileDir, 'cordis.patch.yml'))
  assertProfileWorkspace(join(profileDir, 'pnpm-workspace.yaml'))
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

function lockOwnerDiagnostic(owner: ProfileInitLockOwner | undefined): string {
  return owner === undefined
    ? 'owner metadata is missing, invalid, or unsafe'
    : `owner pid ${owner.pid}, createdAt ${owner.createdAt}, token ${owner.token}`
}

function restoreQuarantinedLock(quarantinePath: string, lockPath: string): void {
  try {
    renameSync(quarantinePath, lockPath)
  } catch (error) {
    throw new Error(
      `OpenLoop profile initialization lock ownership changed after quarantine at ${quarantinePath}; `
      + `refusing to remove it and failed to restore ${lockPath}: ${String(error)}`,
    )
  }
}

function quarantinePathFor(lockPath: string): string {
  return `${lockPath}.quarantine-${process.pid}-${randomUUID()}`
}

function recoverStaleProfileInitLock(lockPath: string, observed: ProfileInitLockOwner | undefined): boolean {
  if (observed === undefined
    || Date.now() - observed.createdAt <= PROFILE_INIT_LOCK_STALE_MS) {
    return false
  }

  try {
    process.kill(observed.pid, 0)
    return false
  } catch (error) {
    if (errorCode(error) !== 'ESRCH') return false
  }

  const quarantinePath = quarantinePathFor(lockPath)
  try {
    renameSync(lockPath, quarantinePath)
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return true
    throw error
  }

  const quarantined = readLockOwner(quarantinePath)
  if (quarantined?.token !== observed.token) {
    restoreQuarantinedLock(quarantinePath, lockPath)
    throw new Error(
      `OpenLoop profile initialization lock ownership changed at ${lockPath}; `
      + 'refusing to remove the quarantined lock',
    )
  }
  rmSync(quarantinePath, { recursive: true })
  return true
}

function acquireProfileInitLock(profileDir: string, manifestPath: string): ProfileInitLock | undefined {
  const profileParent = dirname(profileDir)
  const lockPath = join(profileParent, PROFILE_INIT_LOCK_DIRECTORY)
  mkdirSync(profileParent, { recursive: true, mode: 0o700 })
  assertDirectoryIsNotSymlink(profileParent, 'OpenLoop profile parent')

  for (;;) {
    try {
      mkdirSync(lockPath, { mode: 0o700 })
    } catch (error) {
      if (errorCode(error) !== 'EEXIST') throw error
      assertDirectoryIsNotSymlink(profileParent, 'OpenLoop profile parent')
      assertDirectoryIsNotSymlink(profileDir, 'OpenLoop profile directory')
      if (hasValidProfileManifest(manifestPath)) return undefined
      const owner = readLockOwner(lockPath)
      if (recoverStaleProfileInitLock(lockPath, owner)) continue
      throw new Error(
        `OpenLoop profile initialization is already in progress at ${lockPath} `
        + `(${lockOwnerDiagnostic(owner)}); the existing lock was left untouched`,
      )
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
  const quarantinePath = quarantinePathFor(lock.path)
  renameSync(lock.path, quarantinePath)
  const quarantined = readLockOwner(quarantinePath)
  if (quarantined?.token !== lock.owner.token) {
    restoreQuarantinedLock(quarantinePath, lock.path)
    throw new Error(
      `OpenLoop profile initialization lock ownership changed at ${lock.path}; `
      + 'refusing to remove a lock owned by another process',
    )
  }
  rmSync(quarantinePath, { recursive: true })
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

function rollbackCreatedFile(file: CreatedProfileFile): void {
  try {
    const stat = lstatSync(file.path)
    if (!stat.isFile() || stat.isSymbolicLink()
      || stat.dev !== file.dev || stat.ino !== file.ino
      || !readFileSync(file.path).equals(file.content)) {
      return
    }
    unlinkSync(file.path)
  } catch (error) {
    if (errorCode(error) !== 'ENOENT') throw error
  }
}

function rollbackCreatedFiles(files: readonly CreatedProfileFile[]): void {
  for (const file of [...files].reverse()) rollbackCreatedFile(file)
}

function createProfileFile(path: string, content: Buffer): CreatedProfileFile | undefined {
  let descriptor: number
  try {
    descriptor = openSync(path, 'wx', 0o600)
  } catch (error) {
    if (errorCode(error) === 'EEXIST') return undefined
    throw error
  }

  const stat = fstatSync(descriptor)
  const created = { path, content, dev: stat.dev, ino: stat.ino }
  try {
    writeFileSync(descriptor, content)
  } catch (error) {
    const partial = { ...created, content: readFileSync(path) }
    closeSync(descriptor)
    rollbackCreatedFile(partial)
    throw error
  }
  closeSync(descriptor)
  return created
}

function stagedFile(staged: ReadonlyMap<string, Buffer>, filename: string): Buffer {
  const content = staged.get(filename)
  if (content === undefined) {
    throw new Error(`OpenLoop staged profile is missing ${filename}`)
  }
  return content
}

function publishStagedProfile(profileDir: string, stagingDir: string): void {
  const staged = new Map<string, Buffer>()
  for (const filename of [...PROFILE_SUPPORT_FILES, PROFILE_MANIFEST]) {
    const path = join(stagingDir, filename)
    const stat = lstatSync(path)
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error(`OpenLoop staged profile file must be a regular file: ${path}`)
    }
    staged.set(filename, readFileSync(path))
  }
  assertProfileManifest(join(stagingDir, PROFILE_MANIFEST))

  try {
    mkdirSync(profileDir, { mode: 0o700 })
  } catch (error) {
    if (errorCode(error) !== 'EEXIST') throw error
  }
  assertDirectoryIsNotSymlink(profileDir, 'OpenLoop profile directory')

  const createdSupportFiles: CreatedProfileFile[] = []
  let createdManifest: CreatedProfileFile | undefined
  try {
    for (const filename of PROFILE_SUPPORT_FILES) {
      const created = createProfileFile(join(profileDir, filename), stagedFile(staged, filename))
      if (created !== undefined) createdSupportFiles.push(created)
    }
    assertProfileSupportFiles(profileDir)
    createdManifest = createProfileFile(
      join(profileDir, PROFILE_MANIFEST),
      stagedFile(staged, PROFILE_MANIFEST),
    )
    assertProfileManifest(join(profileDir, PROFILE_MANIFEST))
    if (createdManifest === undefined) rollbackCreatedFiles(createdSupportFiles)
  } catch (error) {
    if (createdManifest !== undefined) rollbackCreatedFile(createdManifest)
    rollbackCreatedFiles(createdSupportFiles)
    throw error
  }
}

function initializeAndPublishProfile(profileDir: string): void {
  const profileParent = dirname(profileDir)
  const stagingRoot = mkdtempSync(join(profileParent, PROFILE_STAGE_PREFIX))
  const stagingDir = join(stagingRoot, 'openloop')
  try {
    initProfile(stagingDir, OPENLOOP_PROFILE_BUNDLES)
    publishStagedProfile(profileDir, stagingDir)
  } finally {
    rmSync(stagingRoot, { recursive: true, force: true })
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
  const profileParent = dirname(dir)
  const manifestPath = join(dir, PROFILE_MANIFEST)
  assertDirectoryIsNotSymlink(profileParent, 'OpenLoop profile parent')
  assertDirectoryIsNotSymlink(dir, 'OpenLoop profile directory')
  if (hasValidProfileManifest(manifestPath)) return dir

  const lock = acquireProfileInitLock(dir, manifestPath)
  if (lock === undefined) return dir
  try {
    assertDirectoryIsNotSymlink(profileParent, 'OpenLoop profile parent')
    assertDirectoryIsNotSymlink(dir, 'OpenLoop profile directory')
    if (hasValidProfileManifest(manifestPath)) return dir
    initializeAndPublishProfile(dir)
  } finally {
    releaseProfileInitLock(lock)
  }
  return dir
}
