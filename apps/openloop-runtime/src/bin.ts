#!/usr/bin/env node

import { createHash, randomBytes, randomUUID } from 'node:crypto'
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
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
  resolveBundleDir,
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
import {
  installRuntimeBootstrap,
  type RuntimeLaunchSecrets,
} from '@openloop/runtime-bootstrap'
import { readLaunchSecretsFromFd, type LaunchSecrets } from './launch-secrets.ts'
import {
  assertOpenloopProfileSecurity,
  validateOpenloopUserPatches,
} from './profile-policy.ts'

const BIN_NAME = 'openloop-runtime'
const PROFILE = 'openloop'
const HOST = '127.0.0.1'
const SHUTDOWN_TIMEOUT_MS = 5_000
const AGENT_PRESETS_ROW = 'agent-presets'
const DSH_PACKAGE = '@deepseek-ai/dsh'
const EMPTY_ROOT = '[]\n'
const OPENLOOP_AGENT_PRESET_PATCHES: PatchOptions[] = [
  { id: 'tool-fs-search', disabled: true },
  { id: 'filesystem', isolate: null },
  { id: 'fs-local', disabled: true },
]

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
  launchId?: string
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
  candidateHealth?: {
    webAsset: true
    bootstrapExchange: true
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

interface CandidateHealthResponse {
  webAsset: boolean
  bootstrapExchange: boolean
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
  candidateHealthRequest(
    origin: string,
    launchId: string,
    bootstrapTokenHex: string,
  ): Promise<CandidateHealthResponse>
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
 * Resolve one config below a trusted parent without following path links.
 */
function canonicalRootConfigPath(path: string, trustedParent: string): string {
  const root = resolve(trustedParent)
  const target = resolve(path)
  const child = relative(root, target)
  if (child === '' || child === '..' || child.startsWith(`..${sep}`) || isAbsolute(child)) {
    throw new Error(`${BIN_NAME}: root config must stay below its trusted parent: ${path}`)
  }
  const rootMetadata = lstatSync(root)
  if (rootMetadata.isSymbolicLink() || !rootMetadata.isDirectory()) {
    throw new Error(`${BIN_NAME}: root config trusted parent must be a real directory: ${root}`)
  }
  const canonicalRoot = realpathSync(root)
  const components = child.split(sep)
  let current = root
  for (const component of components.slice(0, -1)) {
    current = join(current, component)
    if (!existsSync(current)) {
      throw new Error(`${BIN_NAME}: root config parent is missing: ${current}`)
    }
    const metadata = lstatSync(current)
    if (metadata.isSymbolicLink()) {
      throw new Error(`${BIN_NAME}: root config path contains a symbolic link: ${current}`)
    }
    if (!metadata.isDirectory()) {
      throw new Error(`${BIN_NAME}: root config parent must be a directory: ${current}`)
    }
    const canonical = realpathSync(current)
    const canonicalChild = relative(canonicalRoot, canonical)
    if (canonicalChild === '..'
      || canonicalChild.startsWith(`..${sep}`)
      || isAbsolute(canonicalChild)) {
      throw new Error(`${BIN_NAME}: root config canonical parent escaped its trusted parent: ${current}`)
    }
  }
  return join(realpathSync(current), components.at(-1) as string)
}

/**
 * Create the launcher's empty Include root once, or validate exact existing
 * bytes. Existing files are never truncated or rewritten.
 */
export function ensureEmptyRootConfig(path: string, trustedParent = dirname(path)): void {
  const target = canonicalRootConfigPath(path, trustedParent)
  let descriptor: number
  let created = false
  try {
    descriptor = openSync(
      target,
      constants.O_CREAT
      | constants.O_EXCL
      | constants.O_WRONLY
      | constants.O_NOFOLLOW
      | constants.O_NONBLOCK,
      0o600,
    )
    created = true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
      throw new Error(`${BIN_NAME}: root config must be a regular file, not a symbolic link or special file: ${path}`, {
        cause: error,
      })
    }
    try {
      descriptor = openSync(
        target,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      )
    } catch (openError) {
      throw new Error(`${BIN_NAME}: root config must be a regular file, not a symbolic link or special file: ${path}`, {
        cause: openError,
      })
    }
  }
  try {
    const stat = fstatSync(descriptor)
    if (!stat.isFile()) {
      throw new Error(`${BIN_NAME}: root config must be a regular file, not a symbolic link or special file: ${path}`)
    }
    if (stat.nlink !== 1) {
      throw new Error(`${BIN_NAME}: root config must have a single link, not a hardlink: ${path}`)
    }
    if (created) {
      writeFileSync(descriptor, EMPTY_ROOT)
    } else if (!readFileSync(descriptor).equals(Buffer.from(EMPTY_ROOT))) {
      throw new Error(`${BIN_NAME}: root config has unexpected content; expected the exact empty root: ${path}`)
    }
  } finally {
    closeSync(descriptor)
  }
}

/** Accept no application arguments other than the launcher's smoke switch. */
function parseRuntimeArgs(argv: readonly string[]): RuntimeOptions {
  if (argv.length === 0) return { healthSmoke: false }
  if (argv.length === 1 && argv[0] === '--health-smoke') return { healthSmoke: true }
  throw new Error(`${BIN_NAME}: usage: ${BIN_NAME} [--health-smoke]`)
}

export function readLaunchSecretsForRuntime(
  _options: RuntimeOptions,
  read: () => LaunchSecrets = readLaunchSecretsFromFd,
): LaunchSecrets | undefined {
  return read()
}

function filterHostBootstrapPatches(
  patches: readonly PatchOptions[],
  includeHostBootstrap: boolean,
): PatchOptions[] {
  if (includeHostBootstrap) return [...patches]
  return patches.flatMap((patch) => {
    if (patch.insert === undefined) return [patch]
    const insert = patch.insert.filter(entry => entry.id !== 'openloop-bootstrap')
    if (insert.length === 0) return []
    return [{ ...patch, insert }]
  })
}

/**
 * Pin the system preset root to the DSH package from this runtime
 * installation. Openloop owns its profile boot instead of using the CLI's
 * launcher, so it must apply the same installation-derived overlay itself.
 */
function withShippedAgentPresetRoot(
  patches: readonly PatchOptions[],
  installAnchor: string,
  profileDir: string,
): PatchOptions[] {
  const row = composeEntries([[...patches]]).find(entry => entry.id === AGENT_PRESETS_ROW)
  if (row === undefined) return [...patches]

  const presetRoot = join(
    resolveBundleDir(BIN_NAME, DSH_PACKAGE, installAnchor, profileDir),
    'config',
    'agent-presets',
  )
  if (!existsSync(join(presetRoot, 'standard', 'agent.cordis.yml'))) {
    throw new Error(`${BIN_NAME}: installed DSH package is missing the standard agent preset at ${presetRoot}`)
  }
  return [
    ...patches,
    {
      id: AGENT_PRESETS_ROW,
      config: {
        ...(row.config ?? {}) as Record<string, unknown>,
        patches: structuredClone(OPENLOOP_AGENT_PRESET_PATCHES),
        roots: [{ path: presetRoot, trust: 'system' }],
      },
    },
  ]
}

function zeroizeLaunchSecrets(secrets: RuntimeLaunchSecrets): void {
  secrets.bootstrapToken.fill(0)
  secrets.bridgeSecret.fill(0)
}

function assertSignedProfileLayers(profile: RuntimeProfile): void {
  const actual = profile.layers.map(layer => layer.packageName)
  if (actual.length !== OPENLOOP_PROFILE_BUNDLES.length
    || actual.some((name, index) => name !== OPENLOOP_PROFILE_BUNDLES[index])) {
    throw new Error(
      `${BIN_NAME}: Openloop profile bundle layers must match the signed bundle tuple`,
    )
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
  private disposeBootstrap: (() => void) | undefined
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

  setBootstrapDisposer(dispose: () => void): void {
    this.disposeBootstrap = dispose
  }

  async release(): Promise<void> {
    this.releaseTask ??= (async () => {
      const stopWatcher = this.stopWatcher
      const context = this.context
      const disposeBootstrap = this.disposeBootstrap
      this.stopWatcher = undefined
      this.context = undefined
      this.disposeBootstrap = undefined
      await stopWatcher?.()
      disposeBootstrap?.()
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
  launchSecrets?: RuntimeLaunchSecrets,
): Promise<RuntimeReadiness> {
  const candidateLaunch = options.healthSmoke && launchSecrets !== undefined
    ? {
      launchId: launchSecrets.launchId,
      bootstrapTokenHex: Buffer.from(launchSecrets.bootstrapToken).toString('hex'),
    }
    : undefined
  const core = dependencies.loadCoreManifest(dependencies.coreManifestPath)
  const profileDir = dependencies.ensureOpenloopProfile(options.home)
  const rootConfig = join(profileDir, 'cordis.yml')
  ensureEmptyRootConfig(rootConfig, profileDir)
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
  assertSignedProfileLayers(profile)
  const includeHostBootstrap = launchSecrets !== undefined
  const signedLayerPatches = profile.layers.flatMap(layer => layer.patches)
  const signedPatches = withShippedAgentPresetRoot(
    filterHostBootstrapPatches(signedLayerPatches, includeHostBootstrap),
    dependencies.installAnchor,
    profile.dir,
  )
  const signedRows = dependencies.composeEntries([signedPatches])
  assertOpenloopProfileSecurity(signedRows, signedRows, includeHostBootstrap)
  const composeRuntimePatches = (userPatches: readonly PatchOptions[]): PatchOptions[] => {
    const validated = validateOpenloopUserPatches(userPatches, signedRows)
    const patches = withShippedAgentPresetRoot(
      filterHostBootstrapPatches([...signedLayerPatches, ...validated], includeHostBootstrap),
      dependencies.installAnchor,
      profile.dir,
    )
    assertOpenloopProfileSecurity(
      signedRows,
      dependencies.composeEntries([patches]),
      includeHostBootstrap,
    )
    return patches
  }
  const patches = composeRuntimePatches(profile.patches)
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
        if (launchSecrets !== undefined) {
          try {
            shutdown.setBootstrapDisposer(installRuntimeBootstrap(hostContext, launchSecrets, {
              manifest: core.manifest as unknown as Readonly<Record<string, unknown>>,
              sha256: core.sha256,
            }))
          } finally {
            zeroizeLaunchSecrets(launchSecrets)
          }
        } else if (options.healthSmoke) {
          const smokeSecrets: RuntimeLaunchSecrets = {
            launchId: randomUUID(),
            bootstrapToken: randomBytes(32),
            bridgeSecret: randomBytes(32),
            socketPath: join(profile.dir, '.openloop-health-smoke-bridge.sock'),
          }
          try {
            shutdown.setBootstrapDisposer(installRuntimeBootstrap(hostContext, smokeSecrets, {
              manifest: core.manifest as unknown as Readonly<Record<string, unknown>>,
              sha256: core.sha256,
            }))
          } finally {
            zeroizeLaunchSecrets(smokeSecrets)
          }
        }
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
      compose: (userPatches) => {
        try {
          return structuredClone(composeRuntimePatches(userPatches))
        } catch (error) {
          shutdown.request(1)
          throw error
        }
      },
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
    let candidateHealth: RuntimeReadiness['candidateHealth']
    if (candidateLaunch !== undefined) {
      const checked = await dependencies.candidateHealthRequest(
        origin,
        candidateLaunch.launchId,
        candidateLaunch.bootstrapTokenHex,
      )
      if (!checked.webAsset || !checked.bootstrapExchange) {
        throw new Error(`${BIN_NAME}: candidate Web asset or bootstrap exchange is unhealthy`)
      }
      candidateHealth = {
        webAsset: true,
        bootstrapExchange: true,
      }
    }
    const readiness: RuntimeReadiness = {
      type: 'openloop.runtime.ready',
      version: 1,
      ...(launchSecrets === undefined ? {} : { launchId: launchSecrets.launchId }),
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
      ...(candidateHealth === undefined ? {} : { candidateHealth }),
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
  candidateHealthRequest: async (origin, launchId, bootstrapTokenHex) => {
    const index = await fetch(`${origin}/`, {
      method: 'GET',
      cache: 'no-store',
      signal: AbortSignal.timeout(5_000),
    })
    const html = await index.text()
    const webAsset = index.status === 200
      && /^text\/html(?:\s*;|$)/iu.test(index.headers.get('content-type') ?? '')
      && html.includes('__DSH_PREBOOT__')
      && html.includes('/api/openloop/bootstrap')
    const bootstrap = await fetch(`${origin}/api/openloop/bootstrap`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      cache: 'no-store',
      body: JSON.stringify({ launchId, token: bootstrapTokenHex }),
      signal: AbortSignal.timeout(5_000),
    })
    let bootstrapExchange = false
    if (bootstrap.ok) {
      const value: unknown = await bootstrap.json()
      bootstrapExchange = typeof value === 'object'
        && value !== null
        && !Array.isArray(value)
        && (value as Record<string, unknown>).launchId === launchId
    }
    return { webAsset, bootstrapExchange }
  },
  setTimeout,
  clearTimeout,
}

async function main(): Promise<void> {
  try {
    const options = parseRuntimeArgs(process.argv.slice(2))
    await runOpenloopRuntime(
      options,
      defaultDependencies,
      readLaunchSecretsForRuntime(options),
    )
  } catch (error) {
    process.stderr.write(`${BIN_NAME}: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`)
    process.exit(1)
  }
}

if (process.env.VITEST === undefined) await main()
