import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import {
  chmod,
  copyFile,
  cp,
  lstat,
  mkdir,
  readlink,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { parseArgs } from 'node:util'

const TARGET = 'aarch64-apple-darwin'
const PKG_TARGET = 'node24-macos-arm64'
const PKG_SPEC = '@yao-pkg/pkg@6.21.0'
const DEPLOY_ROOT_NAME = 'openloop-runtime-pkg'
const RUNTIME_PACKAGE_NAME = '@openloop/runtime'
const STAGING_RELATIVE = 'dist-openloop/runtime-staging'
const CORE_MANIFEST_RELATIVE = 'dist-openloop/openloop-core.json'
const RUNTIME_MANIFEST_RELATIVE = 'runtime/openloop/package.json'
const TAURI_BINARIES_RELATIVE = 'apps/openloop-desktop/src-tauri/binaries'
const DEPLOY_WORKSPACE_RELATIVE = 'dist-openloop/runtime-deploy-workspace'
const ENTRY_BIN = 'node_modules/@openloop/runtime/lib/bin.js'

export const OUTPUT_BASENAME = 'openloop-runtime-aarch64-apple-darwin'
export const HELPER_BASENAME = 'openloop-runtime-spawn-helper-aarch64-apple-darwin'

export const ASSET_GLOBS = [
  'package.json',
  'node_modules/**/*.js',
  'node_modules/**/*.cjs',
  'node_modules/**/*.mjs',
  'node_modules/**/*.json',
  'node_modules/**/*.yml',
  'node_modules/**/*.yaml',
  'node_modules/**/package.json',
  'node_modules/**/*.node',
  'node_modules/**/*.dylib',
  'node_modules/**/*.wasm',
  'node_modules/@deepseek-ai/dsh-web-frontend/dist/**/*',
  'node_modules/@deepseek-ai/dsh/config/**/*',
  'node_modules/@openloop/runtime/openloop-core.json',
  '!node_modules/**/test/**/*',
  '!node_modules/**/tests/**/*',
  '!node_modules/**/__tests__/**/*',
  '!node_modules/**/fixture/**/*',
  '!node_modules/**/fixtures/**/*',
  '!node_modules/**/*.{test,spec}.{js,cjs,mjs}',
] as const

export interface PackageManifest {
  name?: string
  version?: string
  private?: boolean
  type?: string
  dependencies?: Record<string, string>
  optionalDependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
  peerDependenciesMeta?: Record<string, { optional?: boolean }>
  bin?: unknown
  pkg?: unknown
}

export interface WorkspaceManifest {
  path: string
  manifest: PackageManifest
}

export interface RuntimeDeployManifest extends PackageManifest {
  name: 'openloop-runtime-pkg'
  description: string
  version: '0.0.1'
  private: true
  type: 'module'
  dependencies: Record<string, string>
}

/**
 * Compute the deploy root from one runtime package. Workspace dependencies
 * and optional dependencies are traversed recursively; required workspace
 * peers are promoted to the root and themselves traversed until fixed point.
 */
export function computeRuntimeManifest(
  workspace: ReadonlyMap<string, WorkspaceManifest>,
  seedName: string,
): RuntimeDeployManifest {
  if (!workspace.has(seedName)) throw new Error(`Openloop runtime closure seed is missing: ${seedName}`)
  const closure = new Set<string>()
  const queue = [seedName]
  for (let index = 0; index < queue.length; index += 1) {
    const name = queue[index]
    if (name === undefined || closure.has(name)) continue
    const current = workspace.get(name)
    if (current === undefined) {
      throw new Error(`Openloop runtime closure references undeclared workspace package ${name}`)
    }
    closure.add(name)
    const runtimeEdges = {
      ...current.manifest.dependencies,
      ...current.manifest.optionalDependencies,
    }
    for (const dependency of Object.keys(runtimeEdges).sort()) {
      if (workspace.has(dependency) && !closure.has(dependency)) queue.push(dependency)
    }
    for (const peer of Object.keys(current.manifest.peerDependencies ?? {}).sort()) {
      if (current.manifest.peerDependenciesMeta?.[peer]?.optional === true) continue
      if (workspace.has(peer) && !closure.has(peer)) queue.push(peer)
    }
  }
  return {
    name: DEPLOY_ROOT_NAME,
    description: 'Generated dependency-only deploy root for the Openloop desktop Web runtime.',
    version: '0.0.1',
    private: true,
    type: 'module',
    dependencies: Object.fromEntries([...closure].sort().map(name => [name, 'workspace:^'])),
  }
}

function renderRuntimeManifest(manifest: RuntimeDeployManifest): string {
  return `${JSON.stringify(manifest, undefined, 2)}\n`
}

async function loadWorkspace(root: string): Promise<Map<string, WorkspaceManifest>> {
  const candidates = [
    ...await findNamedFiles(join(root, 'apps'), 'package.json', 2),
    ...await findNamedFiles(join(root, 'packages'), 'package.json', 3),
    ...await findNamedFiles(join(root, 'vendor'), 'package.json', 2),
  ].sort()
  const workspace = new Map<string, WorkspaceManifest>()
  for (const path of candidates) {
    const manifest = JSON.parse(await readFile(path, 'utf8')) as PackageManifest
    if (manifest.name === undefined) continue
    workspace.set(manifest.name, {
      path: relative(root, path),
      manifest,
    })
  }
  return workspace
}

async function findNamedFiles(directory: string, filename: string, depth: number): Promise<string[]> {
  if (!existsSync(directory) || depth < 0) return []
  const found: string[] = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isFile() && entry.name === filename) found.push(path)
    else if (entry.isDirectory() && depth > 0) found.push(...await findNamedFiles(path, filename, depth - 1))
  }
  return found
}

async function syncRuntimeManifest(root: string, check: boolean): Promise<void> {
  const workspace = await loadWorkspace(root)
  const rendered = renderRuntimeManifest(computeRuntimeManifest(workspace, RUNTIME_PACKAGE_NAME))
  const path = join(root, RUNTIME_MANIFEST_RELATIVE)
  if (check) {
    const current = await readFile(path, 'utf8').catch(() => '')
    if (current !== rendered) {
      throw new Error(
        `Openloop runtime deploy manifest drifted: ${RUNTIME_MANIFEST_RELATIVE}; run with --sync-manifest`,
      )
    }
    return
  }
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, rendered)
}

export interface RuntimeBuildArgs {
  target: typeof TARGET
  skipBuild: boolean
  syncManifest: boolean
  checkManifest: boolean
}

/** Parse the single supported Tauri target and maintenance modes. */
export function parseRuntimeBuildArgs(argv: readonly string[]): RuntimeBuildArgs {
  const parsed = parseArgs({
    args: [...argv],
    options: {
      target: { type: 'string', default: TARGET },
      'skip-build': { type: 'boolean', default: false },
      'sync-manifest': { type: 'boolean', default: false },
      'check-manifest': { type: 'boolean', default: false },
    },
    strict: true,
  }).values
  if (parsed.target !== TARGET) {
    throw new Error(`build-runtime-exe: only --target ${TARGET} is supported`)
  }
  if (parsed['sync-manifest'] && parsed['check-manifest']) {
    throw new Error('build-runtime-exe: --sync-manifest and --check-manifest are mutually exclusive')
  }
  return {
    target: TARGET,
    skipBuild: parsed['skip-build'],
    syncManifest: parsed['sync-manifest'],
    checkManifest: parsed['check-manifest'],
  }
}

export interface BuildCommand {
  command: string
  args: string[]
  cwd: string
}

export interface RuntimeBuildRunner {
  run(command: BuildCommand): Promise<void>
}

export interface RuntimeBuildFileSystem {
  exists(path: string): boolean
  clearStaging?(root: string, staging: string): Promise<void>
  synchronizeClosure(root: string): Promise<void>
  prepareDeploymentWorkspace(root: string): Promise<string>
  cleanupDeploymentWorkspace(workspace: string): Promise<void>
  prepareStaging(root: string, staging: string): Promise<void>
  injectCoreManifest(root: string, staging: string): Promise<void>
  patchPkgManifest(root: string, staging: string): Promise<void>
  copyProducts(root: string, staging: string, executable: string): Promise<void>
  writeSbom(root: string, staging: string): Promise<void>
}

function assertInside(path: string, boundary: string, label: string): void {
  const normalizedPath = resolve(path)
  const normalizedBoundary = resolve(boundary)
  if (normalizedPath === normalizedBoundary || normalizedPath.startsWith(normalizedBoundary + sep)) return
  throw new Error(`build-runtime-exe: ${label} ${normalizedPath} is outside boundary ${normalizedBoundary}`)
}

async function assertSafeRepositoryPath(root: string, path: string, label: string): Promise<void> {
  const repositoryRoot = resolve(root)
  const target = resolve(path)
  assertInside(target, repositoryRoot, label)
  const rootMetadata = await lstat(repositoryRoot)
  if (rootMetadata.isSymbolicLink() || !rootMetadata.isDirectory()) {
    throw new Error(`build-runtime-exe: repository root must be a real directory: ${repositoryRoot}`)
  }
  const canonicalRoot = await realpath(repositoryRoot)
  const components = relative(repositoryRoot, target).split(sep).filter(Boolean)
  let current = repositoryRoot
  for (const [index, component] of components.entries()) {
    current = join(current, component)
    if (!existsSync(current)) return
    const metadata = await lstat(current)
    if (metadata.isSymbolicLink()) {
      throw new Error(`build-runtime-exe: ${label} path contains symlink: ${current}`)
    }
    if (index < components.length - 1 && !metadata.isDirectory()) {
      throw new Error(`build-runtime-exe: ${label} ancestor is not a directory: ${current}`)
    }
    assertInside(await realpath(current), canonicalRoot, `canonical ${label}`)
  }
}

async function copyWithoutNestedModules(source: string, destination: string): Promise<void> {
  const metadata = await stat(source)
  if (metadata.isFile()) {
    await mkdir(dirname(destination), { recursive: true })
    await copyFile(source, destination)
    return
  }
  if (!metadata.isDirectory()) {
    throw new Error(`build-runtime-exe: symlink target must be a regular file or directory: ${source}`)
  }
  const nested = join(source, 'node_modules')
  await cp(source, destination, {
    recursive: true,
    dereference: true,
    filter: path => path !== nested && !path.startsWith(nested + sep),
  })
}

const DEPLOY_WORKSPACE_ENTRIES = [
  'package.json',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  'apps',
  'examples',
  'native',
  'packages',
  'patches',
  'python',
  'runtime',
  'vendor',
] as const

function deployWorkspaceCopyFilter(sourceRoot: string, path: string): boolean {
  const relativePath = relative(sourceRoot, path)
  if (relativePath === '') return true
  const segments = relativePath.split(sep)
  if (segments.some(segment =>
    segment === '.git' || segment === 'node_modules' || segment === 'target')) {
    return false
  }
  const normalized = relativePath.split(sep).join('/')
  return !normalized.startsWith('apps/openloop-desktop/src-tauri/binaries/')
    && normalized !== 'apps/openloop-desktop/src-tauri/binaries'
}

/**
 * Copy the workspace inputs legacy deploy needs into an ignored nested
 * workspace. Legacy `pnpm deploy --prod` is allowed to prune only this copy.
 */
export async function prepareDeploymentWorkspace(root: string): Promise<string> {
  const workspace = join(root, DEPLOY_WORKSPACE_RELATIVE)
  await assertSafeRepositoryPath(root, workspace, 'deployment workspace')
  await rm(workspace, { recursive: true, force: true })
  await assertSafeRepositoryPath(root, workspace, 'deployment workspace')
  await mkdir(workspace, { recursive: true })
  for (const entry of DEPLOY_WORKSPACE_ENTRIES) {
    const source = join(root, entry)
    if (!existsSync(source)) continue
    const destination = join(workspace, entry)
    const metadata = await lstat(source)
    if (metadata.isDirectory()) {
      await cp(source, destination, {
        recursive: true,
        dereference: false,
        filter: path => deployWorkspaceCopyFilter(root, path),
      })
    } else {
      await copyFile(source, destination)
    }
  }
  return workspace
}

async function firstSymlink(directory: string): Promise<string | undefined> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    const metadata = await lstat(path)
    if (metadata.isSymbolicLink()) return path
    if (metadata.isDirectory()) {
      const nested = await firstSymlink(path)
      if (nested !== undefined) return nested
    }
  }
  return undefined
}

function canonicalTrustedPath(path: string, root: string, canonicalRoot: string): string {
  const absolute = resolve(path)
  try {
    assertInside(absolute, root, 'symlink target')
    return resolve(canonicalRoot, relative(resolve(root), absolute))
  } catch {
    assertInside(absolute, canonicalRoot, 'symlink target')
    return absolute
  }
}

async function assertTrustedTraversal(
  path: string,
  root: string,
  canonicalRoot: string,
  visited = new Set<string>(),
): Promise<void> {
  const trustedPath = canonicalTrustedPath(path, root, canonicalRoot)
  const child = relative(canonicalRoot, trustedPath)
  let current = canonicalRoot
  for (const component of child === '' ? [] : child.split(sep)) {
    current = join(current, component)
    const metadata = await lstat(current)
    if (!metadata.isSymbolicLink()) continue
    if (visited.has(current)) {
      throw new Error(`build-runtime-exe: symlink target chain contains a cycle: ${current}`)
    }
    visited.add(current)
    const target = resolve(dirname(current), await readlink(current))
    canonicalTrustedPath(target, root, canonicalRoot)
    await assertTrustedTraversal(target, root, canonicalRoot, visited)
    current = await realpath(current)
    assertInside(current, canonicalRoot, 'canonical symlink target')
  }
}

/** Replace every staged link with the bytes at its resolved target. */
export async function materializeSymlinks(staging: string, root: string): Promise<void> {
  const trustedRoot = await realpath(root)
  const canonicalStaging = await realpath(staging)
  assertInside(canonicalStaging, trustedRoot, 'canonical staging path')
  let link = await firstSymlink(staging)
  while (link !== undefined) {
    const target = resolve(dirname(link), await readlink(link))
    await assertTrustedTraversal(target, root, trustedRoot)
    const source = await realpath(link)
    assertInside(source, trustedRoot, 'canonical symlink target')
    const metadata = await stat(source)
    if (!metadata.isFile() && !metadata.isDirectory()) {
      throw new Error(`build-runtime-exe: symlink target must be a regular file or directory: ${source}`)
    }
    await rm(link, { recursive: true, force: true })
    await copyWithoutNestedModules(source, link)
    link = await firstSymlink(staging)
  }
}

async function restoreLegacyHoists(root: string, staging: string): Promise<void> {
  const manifest = JSON.parse(await readFile(join(staging, 'package.json'), 'utf8')) as PackageManifest
  const sourceModules = join(root, 'runtime/openloop/node_modules')
  for (const dependency of Object.keys(manifest.dependencies ?? {}).sort()) {
    const destination = join(staging, 'node_modules', dependency)
    if (existsSync(destination)) continue
    const source = join(sourceModules, dependency)
    if (!existsSync(source)) {
      throw new Error(
        `build-runtime-exe: deployed dependency ${dependency} is missing from staging and ${sourceModules}`,
      )
    }
    await copyWithoutNestedModules(source, destination)
  }
}

async function nodePrepareStaging(root: string, staging: string): Promise<void> {
  await assertSafeRepositoryPath(root, staging, 'staging path')
  await restoreLegacyHoists(root, staging)
  await materializeSymlinks(staging, root)
  const remaining = await firstSymlink(staging)
  if (remaining !== undefined) throw new Error(`build-runtime-exe: staged symlink remains: ${remaining}`)
}

async function nodeInjectCoreManifest(root: string, staging: string): Promise<void> {
  await assertSafeRepositoryPath(root, staging, 'staging path')
  const source = join(root, CORE_MANIFEST_RELATIVE)
  const destination = join(staging, 'node_modules/@openloop/runtime/openloop-core.json')
  if (!existsSync(source)) {
    throw new Error(`build-runtime-exe: core manifest is missing: ${source}`)
  }
  if (!existsSync(dirname(destination))) {
    throw new Error(`build-runtime-exe: runtime package is missing from staging: ${dirname(destination)}`)
  }
  await copyFile(source, destination)
}

async function nodePatchPkgManifest(root: string, staging: string): Promise<void> {
  await assertSafeRepositoryPath(root, staging, 'staging path')
  const path = join(staging, 'package.json')
  if (!existsSync(join(staging, ENTRY_BIN))) {
    throw new Error(`build-runtime-exe: built runtime entry is missing: ${join(staging, ENTRY_BIN)}`)
  }
  const manifest = JSON.parse(await readFile(path, 'utf8')) as PackageManifest
  await writeFile(path, `${JSON.stringify({
    ...manifest,
    bin: ENTRY_BIN,
    pkg: { assets: [...ASSET_GLOBS] },
  }, undefined, 2)}\n`)
}

async function nodeCopyProducts(root: string, staging: string, executable: string): Promise<void> {
  await assertSafeRepositoryPath(root, staging, 'staging path')
  await assertSafeRepositoryPath(root, executable, 'executable path')
  const helper = join(
    staging,
    'node_modules/node-pty/prebuilds/darwin-arm64/spawn-helper',
  )
  if (!existsSync(executable)) throw new Error(`build-runtime-exe: executable is missing: ${executable}`)
  if (!existsSync(helper)) throw new Error(`build-runtime-exe: node-pty spawn helper is missing: ${helper}`)
  const binaries = join(root, TAURI_BINARIES_RELATIVE)
  await assertSafeRepositoryPath(root, binaries, 'Tauri binaries path')
  const mainDestination = join(binaries, OUTPUT_BASENAME)
  const helperDestination = join(binaries, HELPER_BASENAME)
  await mkdir(binaries, { recursive: true })
  await copyFile(executable, mainDestination)
  await copyFile(helper, helperDestination)
  await Promise.all([
    chmod(executable, 0o755),
    chmod(mainDestination, 0o755),
    chmod(helperDestination, 0o755),
  ])
}

export interface SbomInput {
  path: string
  sha256: string
}

async function allFiles(directory: string): Promise<string[]> {
  if (!existsSync(directory)) return []
  const files: string[] = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) files.push(...await allFiles(path))
    else if (entry.isFile()) files.push(path)
  }
  return files
}

/** Gather stable, repository-relative provenance inputs for the runtime SBOM. */
export async function collectSbomInputs(root: string, staging: string): Promise<SbomInput[]> {
  const fixed = [
    'package.json',
    'pnpm-lock.yaml',
    'pnpm-workspace.yaml',
    'apps/openloop-runtime/package.json',
    'apps/openloop-runtime/tsdown.config.ts',
    RUNTIME_MANIFEST_RELATIVE,
    CORE_MANIFEST_RELATIVE,
    'scripts/openloop/build-runtime-exe.ts',
    'scripts/openloop/upstream-baseline.json',
    'tsconfig.host.json',
    'tsdown.config.ts',
  ].map(path => join(root, path))
  const staged = await allFiles(staging)
  const patches = await allFiles(join(root, 'patches'))
  const products = [
    join(root, TAURI_BINARIES_RELATIVE, OUTPUT_BASENAME),
    join(root, TAURI_BINARIES_RELATIVE, HELPER_BASENAME),
  ]
  const candidates = [...fixed, ...staged, ...patches, ...products]
    .filter(path => existsSync(path))
    .map(path => resolve(path))
  const unique = [...new Set(candidates)].sort((left, right) =>
    relative(root, left).localeCompare(relative(root, right)))
  return Promise.all(unique.map(async (path) => {
    assertInside(path, root, 'SBOM input')
    return {
      path: relative(root, path).split(sep).join('/'),
      sha256: createHash('sha256').update(await readFile(path)).digest('hex'),
    }
  }))
}

async function nodeWriteSbom(root: string, staging: string): Promise<void> {
  await assertSafeRepositoryPath(root, staging, 'staging path')
  await assertSafeRepositoryPath(
    root,
    join(root, 'dist-openloop/openloop-runtime-sbom-inputs.json'),
    'runtime SBOM path',
  )
  const document = {
    version: 1,
    packageBuilder: PKG_SPEC,
    nodeTarget: PKG_TARGET,
    inputs: await collectSbomInputs(root, staging),
  }
  await writeFile(
    join(root, 'dist-openloop/openloop-runtime-sbom-inputs.json'),
    `${JSON.stringify(document, undefined, 2)}\n`,
  )
}

const nodeFileSystem: RuntimeBuildFileSystem = {
  exists: existsSync,
  clearStaging: async (root, staging) => {
    await assertSafeRepositoryPath(root, staging, 'staging path')
    await rm(staging, { recursive: true, force: true })
  },
  synchronizeClosure: async (root) => {
    await syncRuntimeManifest(root, false)
    await syncRuntimeManifest(root, true)
  },
  prepareDeploymentWorkspace,
  cleanupDeploymentWorkspace: async workspace =>
    rm(workspace, { recursive: true, force: true }),
  prepareStaging: nodePrepareStaging,
  injectCoreManifest: nodeInjectCoreManifest,
  patchPkgManifest: nodePatchPkgManifest,
  copyProducts: nodeCopyProducts,
  writeSbom: nodeWriteSbom,
}

const processRunner: RuntimeBuildRunner = {
  run: async ({ command, args, cwd }) => {
    await new Promise<void>((resolvePromise, reject) => {
      const child = spawn(command, args, {
        cwd,
        stdio: 'inherit',
        env: { ...process.env, CI: 'true' },
      })
      child.once('error', (error) => {
        reject(new Error(
          `build-runtime-exe: failed to spawn ${command}: ${error.message}`,
        ))
      })
      child.once('exit', (code, signal) => {
        if (code === 0) resolvePromise()
        else reject(new Error(
          `build-runtime-exe: ${command} failed with ${code === null ? `signal ${String(signal)}` : `exit ${String(code)}`}`,
        ))
      })
    })
  },
}

export interface RuntimeExeBuilderOptions {
  root: string
  target: string
  skipBuild: boolean
  staging?: string
  runner: RuntimeBuildRunner
  files: RuntimeBuildFileSystem
}

/** Ordered, testable single-executable build pipeline. */
export class RuntimeExeBuilder {
  static readonly nodeFileSystem = nodeFileSystem
  readonly root: string
  readonly staging: string
  readonly executable: string

  constructor(private readonly options: RuntimeExeBuilderOptions) {
    this.root = resolve(options.root)
    if (options.target !== TARGET) throw new Error(`build-runtime-exe: only ${TARGET} is supported`)
    this.staging = resolve(options.staging ?? join(this.root, STAGING_RELATIVE))
    this.executable = join(this.root, 'dist-openloop', OUTPUT_BASENAME)
    assertInside(this.staging, join(this.root, 'dist-openloop'), 'staging path')
    assertInside(this.executable, join(this.root, 'dist-openloop'), 'executable path')
  }

  private command(command: string, args: string[], cwd: string = this.root): Promise<void> {
    return this.options.runner.run({ command, args, cwd })
  }

  private async validateDestinations(): Promise<void> {
    await assertSafeRepositoryPath(this.root, this.staging, 'staging path')
    await assertSafeRepositoryPath(this.root, this.executable, 'executable path')
    await assertSafeRepositoryPath(
      this.root,
      join(this.root, DEPLOY_WORKSPACE_RELATIVE),
      'deployment workspace',
    )
    await assertSafeRepositoryPath(
      this.root,
      join(this.root, TAURI_BINARIES_RELATIVE),
      'Tauri binaries path',
    )
  }

  async copyProducts(): Promise<void> {
    await this.validateDestinations()
    const helper = join(
      this.staging,
      'node_modules/node-pty/prebuilds/darwin-arm64/spawn-helper',
    )
    if (!this.options.files.exists(this.executable)) {
      throw new Error(`build-runtime-exe: executable is missing: ${this.executable}`)
    }
    if (!this.options.files.exists(helper)) {
      throw new Error(`build-runtime-exe: node-pty spawn helper is missing: ${helper}`)
    }
    await this.options.files.copyProducts(this.root, this.staging, this.executable)
  }

  async build(): Promise<void> {
    await this.validateDestinations()
    if (!this.options.skipBuild) await this.command('pnpm', ['run', 'build'])
    await this.options.files.synchronizeClosure(this.root)
    await this.validateDestinations()
    await this.options.files.clearStaging?.(this.root, this.staging)
    const deploymentWorkspace = await this.options.files.prepareDeploymentWorkspace(this.root)
    try {
      await this.command('pnpm', [
        '--filter',
        DEPLOY_ROOT_NAME,
        'deploy',
        '--legacy',
        '--prod',
        '--ignore-scripts',
        '--config.node-linker=hoisted',
        '--config.auto-install-peers=false',
        '--config.link-workspace-packages=true',
        this.staging,
      ], deploymentWorkspace)
      await this.options.files.prepareStaging(this.root, this.staging)
    } finally {
      await this.options.files.cleanupDeploymentWorkspace(deploymentWorkspace)
    }
    await this.options.files.injectCoreManifest(this.root, this.staging)
    await this.options.files.patchPkgManifest(this.root, this.staging)
    await this.validateDestinations()
    const pkg = join(this.root, 'node_modules/.bin/pkg')
    if (!this.options.files.exists(pkg)) {
      throw new Error(`build-runtime-exe: lockfile-pinned pkg executable is missing: ${pkg}`)
    }
    await this.command(pkg, [
      this.staging,
      '--sea',
      '--targets',
      PKG_TARGET,
      '--output',
      this.executable,
    ])
    await this.copyProducts()
    await this.options.files.writeSbom(this.root, this.staging)
  }
}

async function main(): Promise<void> {
  const root = resolve(import.meta.dirname, '../..')
  try {
    const options = parseRuntimeBuildArgs(process.argv.slice(2))
    if (options.syncManifest || options.checkManifest) {
      await syncRuntimeManifest(root, options.checkManifest)
      console.log(
        `build-runtime-exe: ${options.checkManifest ? 'checked' : 'synchronized'} ${RUNTIME_MANIFEST_RELATIVE}`,
      )
      return
    }
    const builder = new RuntimeExeBuilder({
      root,
      target: options.target,
      skipBuild: options.skipBuild,
      runner: processRunner,
      files: nodeFileSystem,
    })
    await builder.build()
    console.log(`build-runtime-exe: produced ${relative(root, builder.executable)}`)
  } catch (error) {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error))
    process.exit(1)
  }
}

if (process.env.VITEST === undefined) await main()
