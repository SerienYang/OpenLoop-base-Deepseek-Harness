#!/usr/bin/env node

import { createHash } from 'node:crypto'
import {
  closeSync,
  constants,
  fstatSync,
  ftruncateSync,
  openSync,
  readFileSync,
  writeFileSync,
} from 'node:fs'
import { join, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import type { PatchOptions } from '@deepseek-ai/cordis-plugin-include'
import type { EntryOptions } from '@deepseek-ai/cordis-plugin-loader'
import {
  boot,
  composeEntries,
  healProfilesModuleFallback,
  installFailLoud,
  loadLayeredEnv,
  loadProfile,
  watchUserPatches,
  type Profile,
} from '@deepseek-ai/dsh-app-boot'
import { provideCmdline, type CmdlineHost } from '@deepseek-ai/dsh-cmdline'
import {
  DSH_LAUNCH_ENVIRONMENT_KEY,
  type LaunchEnvironmentSnapshot,
} from '@deepseek-ai/dsh-launch-environment'
import {
  parseOpenloopBuildManifest,
  type OpenloopBuildManifest,
} from '@openloop/build-contract'
import {
  ensureOpenloopProfile,
  OPENLOOP_PROFILE_BUNDLES,
} from '@openloop/bundle'

const BIN_NAME = 'openloop-runtime'
const PROFILE = 'openloop'
const HOST = '127.0.0.1'
const SHUTDOWN_TIMEOUT_MS = 5_000
const REQUIRED_WEB_ROWS = ['web-startup', 'webserver', 'web-runtime'] as const
const EMPTY_ROOT = '[]\n'

/** Exact core bytes and their parsed identity. */
export interface LoadedCoreManifest {
  bytes: Buffer
  manifest: OpenloopBuildManifest
  sha256: string
}

/** The one line the desktop Host recognizes as runtime readiness. */
export interface RuntimeReadiness {
  type: 'openloop.runtime.ready'
  version: 1
  profile: 'openloop'
  host: '127.0.0.1'
  port: number
  origin: string
  coreManifestSha256: string
  healthSmoke: {
    method: 'GET'
    path: '/'
    status: 200
  }
}

interface RuntimeProcess {
  argv: string[]
  env: NodeJS.ProcessEnv
  stdout: { write(chunk: string): unknown }
  stderr: { write(chunk: string): unknown }
  on(event: 'SIGTERM' | 'SIGINT', handler: () => void): unknown
  on(event: 'unhandledRejection', handler: (error: unknown) => void): unknown
  off(event: 'SIGTERM' | 'SIGINT', handler: () => void): unknown
  off(event: 'unhandledRejection', handler: (error: unknown) => void): unknown
  emit(event: 'SIGTERM' | 'SIGINT'): boolean
  exit(code: number): void
}

interface HealthResponse {
  status: number
  contentType: string
}

type RuntimeProfile = Pick<Profile, 'name' | 'dir' | 'layers' | 'patchPath' | 'patches'>

/** Injectable public-package and process boundary used by focused tests. */
export interface RuntimeDependencies {
  process: RuntimeProcess
  installAnchor: string
  moduleBaseUrl: string
  coreManifestPath: string
  loadCoreManifest(path: string): LoadedCoreManifest
  ensureOpenloopProfile(home?: string): string
  healProfilesModuleFallback(anchor: string, home?: string): void
  loadProfile(
    binName: string,
    name: string,
    anchor: string,
    home?: string,
    options?: { userLayer?: boolean },
  ): RuntimeProfile
  composeEntries(layers: readonly PatchOptions[][]): EntryOptions[]
  loadLayeredEnv(binName: string): LaunchEnvironmentSnapshot
  provideCmdline(ctx: Context, host: CmdlineHost): void
  boot(
    binName: string,
    rootConfig: string,
    patches?: PatchOptions[],
    prepare?: (ctx: Context) => Promise<void> | void,
    bareModuleBaseUrl?: string,
  ): Promise<Context>
  watchUserPatches(
    ctx: Context,
    options: {
      binName: string
      filename: string
      compose?: (patches: PatchOptions[]) => PatchOptions[]
    },
  ): Promise<() => Promise<void>>
  installFailLoud?: (
    binName: string,
    proc: Parameters<typeof installFailLoud>[1],
    release?: () => Promise<void> | void,
  ) => () => void
  healthRequest(origin: string): Promise<HealthResponse>
  setTimeout(handler: () => void, timeout: number): ReturnType<typeof setTimeout>
  clearTimeout(timer: ReturnType<typeof setTimeout>): void
}

/** Launcher mode after its only accepted flag is parsed. */
export interface RuntimeOptions {
  healthSmoke: boolean
  home?: string
}

/**
 * Validate the embedded core manifest and hash the exact bytes, including
 * whitespace and the trailing newline.
 */
export function readCoreManifest(path: string): LoadedCoreManifest {
  const bytes = readFileSync(path)
  const value: unknown = JSON.parse(bytes.toString('utf8'))
  return {
    bytes,
    manifest: parseOpenloopBuildManifest(value),
    sha256: createHash('sha256').update(bytes).digest('hex'),
  }
}

/**
 * Create or reset the launcher's empty Include root through one no-follow file
 * descriptor. A link, directory, fifo, or device is never truncated.
 */
export function ensureEmptyRootConfig(path: string): void {
  let descriptor: number
  try {
    descriptor = openSync(
      path,
      constants.O_CREAT
      | constants.O_RDWR
      | constants.O_NOFOLLOW
      | constants.O_NONBLOCK,
      0o600,
    )
  } catch (error) {
    throw new Error(`${BIN_NAME}: root config must be a regular file, not a symbolic link or special file: ${path}`, {
      cause: error,
    })
  }
  try {
    const stat = fstatSync(descriptor)
    if (!stat.isFile()) {
      throw new Error(`${BIN_NAME}: root config must be a regular file, not a symbolic link or special file: ${path}`)
    }
    ftruncateSync(descriptor, 0)
    writeFileSync(descriptor, EMPTY_ROOT)
  } finally {
    closeSync(descriptor)
  }
}

/** Accept no application arguments other than the launcher's smoke switch. */
export function parseRuntimeArgs(argv: readonly string[]): RuntimeOptions {
  if (argv.length === 0) return { healthSmoke: false }
  if (argv.length === 1 && argv[0] === '--health-smoke') return { healthSmoke: true }
  throw new Error(`${BIN_NAME}: usage: ${BIN_NAME} [--health-smoke]`)
}

function profilePatches(profile: RuntimeProfile): PatchOptions[] {
  return [
    ...profile.layers.flatMap(layer => layer.patches),
    ...profile.patches,
  ]
}

function assertWebRows(rows: readonly EntryOptions[]): void {
  const present = new Set(rows.map(row => row.id).filter((id): id is string => typeof id === 'string'))
  const missing = REQUIRED_WEB_ROWS.filter(id => !present.has(id))
  if (missing.length > 0) {
    throw new Error(`${BIN_NAME}: Openloop profile is missing required Web rows: ${missing.join(', ')}`)
  }
}

async function ensurePatchWatcherServices(context: Context, profileDir: string): Promise<void> {
  const loader = context.get('loader')
  if (loader === undefined) {
    throw new Error(`${BIN_NAME}: Loader service is missing after settled boot`)
  }
  if (context.get('timer') === undefined) {
    await loader.create({ name: '@deepseek-ai/cordis-plugin-timer' })
  }
  if (context.get('hmr') === undefined) {
    await loader.create({
      name: '@deepseek-ai/cordis-plugin-hmr',
      config: {
        base: pathToFileURL(profileDir + sep).href,
        root: [],
      },
    })
  }
}

class RuntimeTeardownTimeoutError extends Error {
  constructor() {
    super(`${BIN_NAME}: runtime teardown exceeded ${String(SHUTDOWN_TIMEOUT_MS)}ms`)
    this.name = 'RuntimeTeardownTimeoutError'
  }
}

async function stopWithinLimit(
  action: () => Promise<void>,
  dependencies: RuntimeDependencies,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      action(),
      new Promise<never>((_resolve, reject) => {
        timer = dependencies.setTimeout(() => {
          reject(new RuntimeTeardownTimeoutError())
        }, SHUTDOWN_TIMEOUT_MS)
      }),
    ])
  } finally {
    if (timer !== undefined) dependencies.clearTimeout(timer)
  }
}

class RuntimeShutdown {
  private context: Context | undefined
  private stopWatcher: (() => Promise<void>) | undefined
  private releaseTask?: Promise<void>
  private requested = false
  private readonly doneResolve: () => void
  readonly done: Promise<void>

  constructor(private readonly dependencies: RuntimeDependencies) {
    let resolveDone!: () => void
    this.done = new Promise<void>((resolve) => { resolveDone = resolve })
    this.doneResolve = resolveDone
  }

  setContext(context: Context): void {
    this.context = context
  }

  setWatcher(stopWatcher: () => Promise<void>): void {
    this.stopWatcher = stopWatcher
  }

  async release(): Promise<void> {
    this.releaseTask ??= (async () => {
      const stopWatcher = this.stopWatcher
      const context = this.context
      this.stopWatcher = undefined
      this.context = undefined
      await stopWatcher?.()
      await context?.fiber.dispose()
    })()
    await this.releaseTask
  }

  request(code: number): void {
    if (this.requested) {
      this.dependencies.process.exit(code)
      return
    }
    this.requested = true
    void stopWithinLimit(async () => {
      await this.release()
    }, this.dependencies).catch(() => {}).finally(() => {
      this.doneResolve()
      this.dependencies.process.exit(code)
    })
  }
}

function installSignals(shutdown: RuntimeShutdown, proc: RuntimeProcess): () => void {
  const terminate = (): void => { shutdown.request(0) }
  const interrupt = (): void => { shutdown.request(130) }
  proc.on('SIGTERM', terminate)
  proc.on('SIGINT', interrupt)
  return () => {
    proc.off('SIGTERM', terminate)
    proc.off('SIGINT', interrupt)
  }
}

/**
 * Boot the Openloop Web profile and either stop after the smoke or remain
 * alive until a process signal owns bounded teardown.
 */
export async function runOpenloopRuntime(
  options: RuntimeOptions,
  dependencies: RuntimeDependencies = defaultDependencies,
): Promise<RuntimeReadiness> {
  const core = dependencies.loadCoreManifest(dependencies.coreManifestPath)
  const profileDir = dependencies.ensureOpenloopProfile(options.home)
  const rootConfig = join(profileDir, 'cordis.yml')
  ensureEmptyRootConfig(rootConfig)
  dependencies.healProfilesModuleFallback(dependencies.installAnchor, options.home)
  const profile = dependencies.loadProfile(
    BIN_NAME,
    PROFILE,
    dependencies.installAnchor,
    options.home,
  )
  if (profile.name !== PROFILE || profile.dir !== profileDir) {
    throw new Error(`${BIN_NAME}: resolved profile identity does not match ${PROFILE}`)
  }
  const patches = profilePatches(profile)
  assertWebRows(dependencies.composeEntries([patches]))
  const environment = dependencies.loadLayeredEnv(BIN_NAME)
  const shutdown = new RuntimeShutdown(dependencies)
  const removeSignals = installSignals(shutdown, dependencies.process)
  const uninstallFailLoud = dependencies.installFailLoud?.(
    BIN_NAME,
    dependencies.process,
    () => shutdown.release(),
  )

  try {
    const context = await dependencies.boot(
      BIN_NAME,
      rootConfig,
      structuredClone(patches),
      (hostContext) => {
        shutdown.setContext(hostContext)
        hostContext.provide(DSH_LAUNCH_ENVIRONMENT_KEY, environment)
        dependencies.provideCmdline(hostContext, {
          args: ['--host', HOST, '--port', '0'],
          exit: (code) => { shutdown.request(code) },
        })
      },
      dependencies.moduleBaseUrl,
    )
    shutdown.setContext(context)
    await ensurePatchWatcherServices(context, profile.dir)
    const stopWatcher = await dependencies.watchUserPatches(context, {
      binName: BIN_NAME,
      filename: profile.patchPath,
      compose: userPatches => structuredClone([
        ...profile.layers.flatMap(layer => layer.patches),
        ...userPatches,
      ]),
    })
    shutdown.setWatcher(stopWatcher)

    const webServer = context.get('webServer') as { host?: unknown; port?: unknown } | undefined
    if (webServer?.host !== HOST || typeof webServer.port !== 'number' || webServer.port <= 0) {
      throw new Error(`${BIN_NAME}: settled Web server did not publish ${HOST} with a bound port`)
    }
    const origin = `http://${HOST}:${String(webServer.port)}`
    const health = await dependencies.healthRequest(origin)
    if (health.status !== 200 || !/^text\/html(?:\s*;|$)/iu.test(health.contentType)) {
      throw new Error(
        `${BIN_NAME}: health GET ${origin}/ returned ${String(health.status)} ${health.contentType || '(no content-type)'}`,
      )
    }
    const readiness: RuntimeReadiness = {
      type: 'openloop.runtime.ready',
      version: 1,
      profile: PROFILE,
      host: HOST,
      port: webServer.port,
      origin,
      coreManifestSha256: core.sha256,
      healthSmoke: {
        method: 'GET',
        path: '/',
        status: 200,
      },
    }
    dependencies.process.stdout.write(`${JSON.stringify(readiness)}\n`)

    if (options.healthSmoke) {
      await stopWithinLimit(() => shutdown.release(), dependencies)
    } else {
      await shutdown.done
    }
    return readiness
  } catch (error) {
    if (error instanceof RuntimeTeardownTimeoutError) throw error
    try {
      await stopWithinLimit(() => shutdown.release(), dependencies)
    } catch (releaseError) {
      throw new AggregateError(
        [error, releaseError],
        `${BIN_NAME}: runtime failure and teardown failure`,
      )
    }
    throw error
  } finally {
    uninstallFailLoud?.()
    removeSignals()
  }
}

const defaultDependencies: RuntimeDependencies = {
  process,
  installAnchor: fileURLToPath(new URL('../package.json', import.meta.url)),
  moduleBaseUrl: import.meta.url,
  coreManifestPath: fileURLToPath(new URL('../openloop-core.json', import.meta.url)),
  loadCoreManifest: readCoreManifest,
  ensureOpenloopProfile,
  healProfilesModuleFallback,
  loadProfile,
  composeEntries,
  loadLayeredEnv,
  provideCmdline,
  boot,
  watchUserPatches,
  installFailLoud,
  healthRequest: async (origin) => {
    const response = await fetch(`${origin}/`, {
      method: 'GET',
      signal: AbortSignal.timeout(5_000),
    })
    return {
      status: response.status,
      contentType: response.headers.get('content-type') ?? '',
    }
  },
  setTimeout,
  clearTimeout,
}

async function main(): Promise<void> {
  try {
    const options = parseRuntimeArgs(process.argv.slice(2))
    await runOpenloopRuntime(options)
  } catch (error) {
    process.stderr.write(`${BIN_NAME}: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`)
    process.exit(1)
  }
}

if (process.env.VITEST === undefined) await main()

// Keep the shipped tuple referenced by the launcher contract and visible to
// static closure checks without reproducing it.
void OPENLOOP_PROFILE_BUNDLES
