/**
 * Workspace package invariant checks for package-manager-independent quality
 * gates.
 *
 * Run: `tsx scripts/check-workspace-constraints.ts`.
 */

import { existsSync, globSync, readdirSync, readFileSync, realpathSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  applyEntryPatches,
  entryListSchema,
  type PatchOptions,
} from '@deepseek-ai/cordis-plugin-include'
import type { EntryOptions } from '@deepseek-ai/cordis-plugin-loader'
import * as yaml from 'js-yaml'
import ts from 'typescript'
import { hasTypertRemoteNavigation, isForbiddenPublicationFile } from './publication-payload.ts'
import { collectProjectReferenceFaceViolations } from './project-reference-faces.ts'
import {
  collectDshWorkspaceNamingViolations,
  collectOpenLoopWorkspaceViolations,
  OPENLOOP_FORBIDDEN_PROCESS_PACKAGES,
} from './openloop/workspace-conventions.ts'

const root = resolve(import.meta.dirname, '..')
// vendor/* is single-level; packages/<group>/<pkg> nests one level deeper
// (the group dirs — core/llm/shell/… — are pure containers with no manifest).
const workspaceGlobs = [
  { dir: 'vendor', depth: 1 },
  { dir: 'packages', depth: 2 },
  { dir: 'native', depth: 1 },
  { dir: 'native/landlock-run/packages', depth: 1 },
  { dir: 'apps', depth: 1 },
] as const
const vendoredPackages = new Set([
  '@deepseek-ai/cordis',
  '@deepseek-ai/cosmokit',
  '@deepseek-ai/schemastery',
  '@deepseek-ai/cordis-plugin-loader',
  '@deepseek-ai/cordis-plugin-include',
  '@deepseek-ai/cordis-plugin-group',
  '@deepseek-ai/cordis-plugin-timer',
  '@deepseek-ai/cordis-plugin-hmr',
  '@deepseek-ai/cordis-plugin-logger-console',
])
const publicLandlockPackages = new Set([
  '@deepseek-ai/node-addon-landlock-run',
  '@deepseek-ai/node-addon-landlock-run-linux-arm64',
  '@deepseek-ai/node-addon-landlock-run-linux-x64',
])
/** Deliberate source payloads whose exact bytes are part of the package's audit surface. */
const publicationSourceAllowlist: Readonly<Record<string, readonly string[]>> = {
  '@deepseek-ai/node-addon-landlock-run': ['src/main.c'],
}
const repositoryUrl = 'git+https://github.com/deepseek-harness/deepseek-harness.git'
/**
 * Source home the published packages point consumers at. It differs from
 * {@link repositoryUrl}, which the Landlock packages keep because npm resolves
 * their trusted publishing against the repository that runs the workflow.
 */
const publishedRepositoryUrl = 'git+https://github.com/deepseek-ai/deepseek-harness.git'
/** Directories whose packages this repository publishes: one release member each. */
const releaseMemberDirectory = /^(?:packages\/[^/]+\/[^/]+|apps\/[^/]+|vendor\/[^/]+)$/

const localArtifactDirs = new Set(['node_modules'])
const appPackageFiles: Readonly<Record<string, readonly string[]>> = {
  '@deepseek-ai/dsh': ['lib/*.js', 'config'],
  // The Web build emits sourcemaps for browser debugging; publishing them is
  // what the payload policy forbids, so the bundle ships without them.
  '@deepseek-ai/dsh-web-frontend': ['dist', '!dist/**/*.map'],
}

type PackageExportTarget =
  | string
  | null
  | PackageExportTarget[]
  | PackageExportConditions

interface PackageExportConditions {
  [condition: string]: PackageExportTarget | undefined
}

function isExportConditions(
  target: PackageExportTarget | undefined,
): target is PackageExportConditions {
  return typeof target === 'object' && target !== null && !Array.isArray(target)
}

/** The subset of package.json fields this constraint check cares about. */
interface PackageManifest {
  name?: string
  version?: string
  private?: boolean
  type?: string
  main?: string
  types?: string
  bin?: string | Record<string, string>
  exports?: PackageExportTarget
  imports?: PackageExportConditions
  files?: string[]
  publishConfig?: { access?: string }
  repository?: { type?: string; url?: string; directory?: string }
  peerDependencies?: Record<string, string>
  devDependencies?: Record<string, string>
  dependencies?: Record<string, string>
  optionalDependencies?: Record<string, string>
}

/** One workspace manifest and its repo-relative path. */
interface WorkspaceManifest {
  dir: string
  manifest: PackageManifest
}

function readJson(path: string): PackageManifest {
  return JSON.parse(readFileSync(path, 'utf8')) as PackageManifest
}

const rootManifest = readJson(join(root, 'package.json'))
const repositoryVersion = rootManifest.version
const landlockWorkspaceManifest = readJson(join(root, 'native/landlock-run/package.json'))
const landlockVersion = landlockWorkspaceManifest.version

/** Repo-relative dirs holding a package.json, walked to the configured depth. */
function packageDirs(base: string, depth: number): string[] {
  if (depth === 1) {
    return readdirSync(join(root, base), { withFileTypes: true })
      .filter(entry => entry.isDirectory())
      .filter(entry => !localArtifactDirs.has(entry.name))
      .filter(entry => existsSync(join(root, base, entry.name, 'package.json')))
      .map(entry => `${base}/${entry.name}`)
  }
  return readdirSync(join(root, base), { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .filter(entry => !localArtifactDirs.has(entry.name))
    .flatMap(group => packageDirs(`${base}/${group.name}`, depth - 1))
}

function workspaceManifests(): WorkspaceManifest[] {
  const manifests: WorkspaceManifest[] = [
    { dir: '.', manifest: rootManifest },
  ]

  for (const { dir: base, depth } of workspaceGlobs) {
    for (const dir of packageDirs(base, depth)) {
      manifests.push({ dir, manifest: readJson(join(root, dir, 'package.json')) })
    }
  }

  return manifests
}

const packageFileExtras: Readonly<Record<string, readonly string[]>> = {
  // Profile bundles publish their dsh.bundle.patch layer beside the lib.
  '@deepseek-ai/dsh-base': ['cordis.patch.yml'],
  '@deepseek-ai/dsh-web-app': ['cordis.patch.yml'],
  '@deepseek-ai/dsh-headless': ['cordis.patch.yml'],
  '@deepseek-ai/dsh-client-ui-theme': ['lib/styles'],
  // The Python runtime uses a distinct closed-resolution bin; the public CLI
  // keeps config-owned bare-package resolution through lib/bin.js.
  '@deepseek-ai/dsh-sdk-jsonrpc-demo': ['lib/packaged-bin.js'],
  // The argv-prefix runner entry ships beside the lib as its own bundle;
  // sandbox-local resolves it through the package's ./runner export. tsdown
  // also shares its generated FFI code through a hashed runtime chunk.
  '@deepseek-ai/dsh-sandbox-windows-acl': ['lib/runner.js', 'lib/types-*.js'],
  '@deepseek-ai/dsh-skill-badge': ['assets'],
  '@deepseek-ai/dsh-subprocess-local': ['scripts/ensure-spawn-helper.mjs'],
}

function sameStringList(actual: readonly string[] | undefined, expected: readonly string[]): boolean {
  return !!actual && actual.length === expected.length && actual.every((value, index) => value === expected[index])
}

function expectedDshPackageFiles(manifest: PackageManifest): readonly string[] {
  const extras = manifest.name ? packageFileExtras[manifest.name] ?? [] : []
  return [
    'lib/index.js',
    // Every package publishes its invariant ownership companion as a separate
    // bundle; the package-invariant gate validates the companion itself.
    'lib/invariant.js',
    ...manifest.bin ? ['lib/bin.js'] : [],
    ...exportEntry(manifest, './worker') ? ['lib/worker.cjs'] : [],
    // UI plugin packages ship their browser bundle beside the node lib
    // (single-artifact ruling: dist/ retired, ./client resolves lib/client.js).
    // Keyed on the artifact path, not the subpath name: apiproxy's ./client is
    // a browser-safe source channel, not a bundle.
    ...exportDefault(manifest, './client') === './lib/client.js' ? ['lib/client.js'] : [],
    // runtime's shell-held loader subpath ships as its own bundle beside the client half.
    ...exportDefault(manifest, './loader') === './lib/loader.js' ? ['lib/loader.js'] : [],
    // web-react's store subpath ships its own bundle (single-entry builds; no shared chunk).
    ...exportDefault(manifest, './store') === './lib/store/index.js' ? ['lib/store/index.js'] : [],
    // A surface bundle's startup row is its own bundle: the Loader imports it
    // as a row module, so it cannot ride inside the package entry.
    ...exportDefault(manifest, './startup') === './lib/startup.js' ? ['lib/startup.js'] : [],
    ...extras,
    // Subpaths whose runtime default is the tsc-emitted tree (lib/types/*.js —
    // browser-safe source channels rehomed off src so plain Node can import
    // them without type stripping) publish the emitted JS alongside the
    // declarations.
    ...usesEmittedTreeDefaults(manifest) ? ['lib/types/**/*.js'] : [],
    'lib/types/**/*.d.ts',
    ...hasExportPair(manifest, './typert', './lib/typert.host.d.ts', './lib/typert.host.js')
      ? ['lib/typert.host.js', 'lib/typert.host.d.ts']
      : [],
    ...hasExportPair(manifest, './client/typert', './lib/typert.client.d.ts', './lib/typert.client.js')
      ? ['lib/typert.client.js', 'lib/typert.client.d.ts']
      : [],
    ...hasTypertRemoteNavigation(manifest)
      ? ['lib/typert.remote-client.js', 'lib/typert.remote-client.d.ts']
      : [],
  ]
}

function exportEntry(
  manifest: PackageManifest,
  subpath: string,
): PackageExportTarget | undefined {
  const exports = manifest.exports
  if (!isExportConditions(exports)) return undefined
  if (Object.keys(exports).some(key => !key.startsWith('.'))) return undefined
  return exports[subpath]
}

/** Whether one conditional export exactly names the generated runtime and declaration pair. */
function hasExportPair(
  manifest: PackageManifest,
  subpath: string,
  types: string,
  runtime: string,
): boolean {
  const entry = exportEntry(manifest, subpath)
  return isExportConditions(entry)
    && entry.types === types
    && entry.default === runtime
}

/** Runtime target of an export entry: conditional `default`, or the bare-string shorthand. */
function exportDefault(manifest: PackageManifest, subpath: string): string | undefined {
  const entry = exportEntry(manifest, subpath)
  if (typeof entry === 'string') return entry
  if (isExportConditions(entry)) {
    const defaultTarget = entry.default
    return typeof defaultTarget === 'string' ? defaultTarget : undefined
  }
  return undefined
}

/** Whether any export's runtime default points into the tsc-emitted lib/types tree. */
function usesEmittedTreeDefaults(manifest: PackageManifest): boolean {
  const exports = isExportConditions(manifest.exports) ? manifest.exports : {}
  return Object.keys(exports).some(subpath =>
    exportDefault(manifest, subpath)?.startsWith('./lib/types/') === true)
}

function checkWorkspace({ dir, manifest }: WorkspaceManifest): string[] {
  const errors: string[] = []
  const label = manifest.name ?? dir
  const isLandlockPackageDir = dir.startsWith('native/landlock-run/packages/')
  const isOpenLoopPackageDir = dir.startsWith('packages/openloop/')
  const isOpenLoopAppDir = /^apps\/openloop-[^/]+$/u.test(dir)
  const isPublicLandlockPackage = isLandlockPackageDir
    && manifest.name !== undefined
    && publicLandlockPackages.has(manifest.name)

  if (isPublicLandlockPackage) {
    if (manifest.private === true) {
      errors.push(`${label}: published Landlock package must not set "private": true`)
    }
    if (manifest.publishConfig?.access !== 'public') {
      errors.push(`${label}: published Landlock package must set publishConfig.access to "public"`)
    }
    const expectedDirectory = dir
    if (manifest.repository?.type !== 'git'
      || manifest.repository.url !== repositoryUrl
      || manifest.repository.directory !== expectedDirectory) {
      errors.push(`${label}: published Landlock package repository must use ${repositoryUrl} with directory ${expectedDirectory} for trusted publishing`)
    }
  } else if (isOpenLoopPackageDir) {
    // Product-owned @openloop packages are a narrow private namespace
    // exception. Their naming, privacy, face, and Cordis rules are checked by
    // collectOpenLoopWorkspaceViolations below.
  } else if (isOpenLoopAppDir) {
    const expectedName = `@openloop/${dir.slice('apps/openloop-'.length)}`
    if (manifest.name !== expectedName) {
      errors.push(`${label}: OpenLoop app package name must be ${expectedName}`)
    }
    if (manifest.private !== true) {
      errors.push(`${label}: OpenLoop app packages must set "private": true`)
    }
  } else if (releaseMemberDirectory.test(dir)) {
    // Release members state that they are publishable: npm refuses a private
    // package, and the repository field is how a consumer finds the source of
    // the package it installed.
    //
    // Access is per release sequence, not per scope: the vendored framework and
    // the Landlock packages publish publicly because outside consumers install
    // them, while the dsh family stays restricted until its own sequence goes
    // public. A mixed scope is why no publish path passes `--access`; each
    // packed manifest decides.
    if (manifest.private === true) {
      errors.push(`${label}: release member must not set "private": true`)
    }
    if (manifest.publishConfig?.access !== 'public') {
      errors.push(`${label}: release member must set publishConfig.access to "public"`)
    }
    if (manifest.repository?.type !== 'git'
      || manifest.repository.url !== publishedRepositoryUrl
      || manifest.repository.directory !== dir) {
      errors.push(`${label}: release member repository must use ${publishedRepositoryUrl} with directory ${dir}`)
    }
  } else if (manifest.private !== true) {
    errors.push(`${label}: package.json must set "private": true`)
  }

  if (manifest.name && vendoredPackages.has(manifest.name)) {
    return errors
  }

  if (manifest.name?.startsWith('@deepseek-ai/')) {
    const allowedSources = publicationSourceAllowlist[manifest.name] ?? []
    for (const file of manifest.files ?? []) {
      if (isForbiddenPublicationFile(file) && !allowedSources.includes(file)) {
        errors.push(`${label}: package.json files must not publish ${JSON.stringify(file)}`)
      }
    }
  }

  if (dir.startsWith('apps/') && manifest.name?.startsWith('@deepseek-ai/')) {
    const expectedFiles = appPackageFiles[manifest.name]
    if (expectedFiles === undefined) {
      errors.push(`${label}: app package has no publication files policy`)
    } else if (!sameStringList(manifest.files, expectedFiles)) {
      errors.push(`${label}: package.json files must be ${JSON.stringify(expectedFiles)}`)
    }
  }

  if (isLandlockPackageDir) {
    if (!isPublicLandlockPackage) {
      errors.push(`${label}: unexpected package in the public Landlock package family`)
    }
    if (manifest.version !== landlockVersion) {
      errors.push(`${label}: package.json version must match Landlock workspace version ${landlockVersion ?? '(missing)'}`)
    }
  }

  if (dir.startsWith('packages/') && manifest.name?.startsWith('@deepseek-ai/dsh-')) {
    const peer = manifest.peerDependencies?.['@deepseek-ai/cordis']
    const dev = manifest.devDependencies?.['@deepseek-ai/cordis']

    if (!peer) errors.push(`${label}: @deepseek-ai/cordis must be a peerDependency`)
    if (!dev) errors.push(`${label}: @deepseek-ai/cordis must also be a devDependency`)
    if (peer && dev && peer !== dev) {
      errors.push(`${label}: @deepseek-ai/cordis peer (${peer}) and dev (${dev}) ranges must match`)
    }
    if (manifest.version !== repositoryVersion) {
      errors.push(`${label}: package.json version must match root version ${repositoryVersion ?? '(missing)'}`)
    }
    if (manifest.type !== 'module') {
      errors.push(`${label}: package.json must set "type": "module"`)
    }
    if (manifest.main !== 'lib/index.js') {
      errors.push(`${label}: package.json must set "main": "lib/index.js"`)
    }
    if (manifest.types !== 'lib/types/index.d.ts') {
      errors.push(`${label}: package.json must set "types": "lib/types/index.d.ts"`)
    }
    const rootExport = exportEntry(manifest, '.')
    const rootEntry = isExportConditions(rootExport) ? rootExport : undefined
    if (rootEntry?.types !== './lib/types/index.d.ts') {
      errors.push(`${label}: package.json exports["."].types must be "./lib/types/index.d.ts"`)
    }
    if (rootEntry?.default !== './lib/index.js') {
      errors.push(`${label}: package.json exports["."].default must be "./lib/index.js"`)
    }
    const invariantRaw = exportEntry(manifest, './invariant')
    const invariantExport = isExportConditions(invariantRaw) ? invariantRaw : undefined
    if (invariantExport?.types !== undefined && invariantExport.types !== './lib/types/invariant.d.ts') {
      errors.push(`${label}: package.json exports["./invariant"].types must be "./lib/types/invariant.d.ts"`)
    }
    if (invariantExport?.default !== undefined && invariantExport.default !== './lib/invariant.js') {
      errors.push(`${label}: package.json exports["./invariant"].default must be "./lib/invariant.js"`)
    }
    if (invariantExport && (invariantExport.types === undefined || invariantExport.default === undefined)) {
      errors.push(`${label}: package.json exports["./invariant"] must declare both types and default targets`)
    }
    const expectedFiles = expectedDshPackageFiles(manifest)
    if (!sameStringList(manifest.files, expectedFiles)) {
      errors.push(`${label}: package.json files must be ${JSON.stringify(expectedFiles)}`)
    }
  }

  return errors.map(error => `${relative(root, join(root, dir, 'package.json'))}: ${error}`)
}

/**
 * Enforce `packages/<group>/<pkg>`: groups are open-named containers without a
 * package.json, and packages may be neither flat nor more deeply nested.
 */
function checkHierarchyShape(): string[] {
  const errors: string[] = []
  const packagesRoot = join(root, 'packages')
  for (const group of readdirSync(packagesRoot, { withFileTypes: true })) {
    if (!group.isDirectory()) continue
    const groupRel = join('packages', group.name)
    if (existsSync(join(packagesRoot, group.name, 'package.json'))) {
      errors.push(`${groupRel}: a group dir must not contain a package.json — packages live at packages/<group>/<pkg>, not directly under packages/`)
      continue
    }
    for (const pkg of readdirSync(join(packagesRoot, group.name), { withFileTypes: true })) {
      if (!pkg.isDirectory()) continue
      if (localArtifactDirs.has(pkg.name)) continue
      const pkgRel = join(groupRel, pkg.name)
      if (!existsSync(join(packagesRoot, group.name, pkg.name, 'package.json'))) {
        errors.push(`${pkgRel}: expected a package here (no package.json found) — the hierarchy is exactly packages/<group>/<pkg>, no deeper nesting`)
      }
    }
  }
  return errors
}

function checkRepositoryVersion(): string[] {
  // The root carries the dsh release family's version, so a prerelease such as
  // 0.0.1-rc.1 is a valid state between `release:dsh` and its publication.
  if (repositoryVersion && /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(repositoryVersion)) return []
  return ['package.json: version must be X.Y.Z with an optional prerelease segment']
}

/** Dependency sections whose ranges reach a published tarball or a local install. */
const dependencySections = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'] as const

/**
 * Require the `workspace:` protocol for every reference to a workspace member.
 *
 * A hand-written range says nothing about the version the workspace actually
 * carries, and `pnpm pack` leaves it alone: `^0.0.1` published from version
 * `0.0.2` names a version that does not exist. The protocol makes pack
 * substitute the member's real version, so no release step rewrites ranges.
 * @param manifests - every workspace manifest.
 * @returns One error per reference that names a workspace member without the protocol.
 */
function checkWorkspaceProtocol(manifests: readonly WorkspaceManifest[]): string[] {
  const members = new Set(manifests.map(entry => entry.manifest.name).filter(name => name !== undefined))
  const errors: string[] = []
  for (const { dir, manifest } of manifests) {
    for (const section of dependencySections) {
      for (const [name, range] of Object.entries(manifest[section] ?? {})) {
        if (!members.has(name) || range.startsWith('workspace:')) continue
        errors.push(`${manifest.name ?? dir}: ${section}.${name} must use the workspace: protocol, got ${range}`)
      }
    }
  }
  return errors
}

const sourceExtensions = /\.(?:[cm]?[jt]sx?)$/u
const excludedOpenLoopInputDirectories = new Set([
  'build',
  'coverage',
  'dist',
  'fixtures',
  'generated',
  'lib',
  'node_modules',
  'out',
  'output',
  'target',
  'test',
  'tests',
])

function staticStringLiterals(path: string): ReadonlyArray<{ value: string; line: number }> {
  const sourceFile = ts.createSourceFile(
    path,
    readFileSync(path, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
  )
  const literals: Array<{ value: string; line: number }> = []

  function collect(node: ts.Node): void {
    if (ts.isStringLiteralLike(node)) {
      const line = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1
      literals.push({ value: node.text, line })
    }
    for (const child of node.getChildren(sourceFile)) collect(child)
  }

  collect(sourceFile)
  return literals
}

function exportedSubpath(manifest: PackageManifest, subpath: string): boolean {
  if (manifest.exports === undefined) return subpath === ''
  const exports = manifest.exports
  if (!isExportConditions(exports)) {
    return subpath === '' && hasExportTarget(exports)
  }
  const keys = Object.keys(exports)
  const hasSubpathKeys = keys.some(key => key.startsWith('.'))
  const hasConditionKeys = keys.some(key => !key.startsWith('.'))
  if (hasSubpathKeys && hasConditionKeys) return false
  if (!hasSubpathKeys) return subpath === '' && hasExportTarget(exports)

  const key = subpath === '' ? '.' : `./${subpath}`
  if (Object.prototype.hasOwnProperty.call(exports, key)) {
    return hasExportTarget(exports[key])
  }
  const patterns = Object.entries(exports)
    .filter(([pattern]) => pattern.includes('*'))
    .filter(([pattern]) => {
      const [prefix = '', suffix = ''] = pattern.split('*')
      return key.length >= prefix.length + suffix.length
        && key.startsWith(prefix)
        && key.endsWith(suffix)
    })
    .sort(([left], [right]) => {
      const leftStar = left.indexOf('*')
      const rightStar = right.indexOf('*')
      if (leftStar !== rightStar) return rightStar - leftStar
      return right.length - left.length
    })
  return hasExportTarget(patterns[0]?.[1])
}

function hasExportTarget(target: PackageExportTarget | undefined): boolean {
  if (typeof target === 'string') return true
  if (target == null) return false
  if (Array.isArray(target)) return target.some(hasExportTarget)
  if (Object.keys(target).some(key => key.startsWith('.'))) return false
  return Object.values(target).some(hasExportTarget)
}

function normalizedPackageSubpath(subpath: string): string | undefined {
  let decoded: string
  try {
    decoded = decodeURIComponent(subpath)
  } catch {
    return undefined
  }

  const segments: string[] = []
  for (const segment of decoded.replaceAll('\\', '/').split('/')) {
    if (segment === '' || segment === '.') continue
    if (segment === '..') {
      if (segments.length === 0) return undefined
      segments.pop()
    } else {
      segments.push(segment)
    }
  }
  return segments.join('/')
}

function isPrivateImplementationSubpath(subpath: string): boolean {
  const [firstSegment] = subpath.split('/')
  return firstSegment === 'src' || firstSegment === 'lib'
}

interface DshPackage {
  readonly directory: string
  readonly manifest: PackageManifest
}

interface DshPackageSpecifier {
  readonly name: string
  readonly pkg: DshPackage
  readonly subpath: string
}

interface DshResolvedTarget {
  readonly name: string
  readonly pkg: DshPackage
  readonly path: string
}

interface OpenLoopCompilerInput {
  readonly path: string
  readonly compilerOptions: readonly ts.CompilerOptions[]
}

interface OpenLoopCompilerInputs {
  readonly inputs: readonly OpenLoopCompilerInput[]
  readonly violations: readonly string[]
}

function canonicalPath(path: string): string {
  let ancestor = path
  while (!existsSync(ancestor)) {
    const parent = dirname(ancestor)
    if (parent === ancestor) return resolve(path)
    ancestor = parent
  }
  return resolve(realpathSync.native(ancestor), relative(ancestor, path))
}

function dshPackages(scanRoot: string): ReadonlyMap<string, DshPackage> {
  const packages = new Map<string, DshPackage>()
  const workspacePath = join(scanRoot, 'pnpm-workspace.yaml')
  if (!existsSync(workspacePath)) return packages
  const declared = (yaml.load(readFileSync(workspacePath, 'utf8')) as { packages?: unknown }).packages
  if (!Array.isArray(declared)) return packages

  const members = declared.filter((member): member is string => typeof member === 'string')
  const include = members
    .filter(member => !member.startsWith('!'))
    .map(member => `${member.replace(/\/+$/u, '')}/package.json`)
  const exclude = [
    ...members
      .filter(member => member.startsWith('!'))
      .map(member => `${member.slice(1).replace(/\/+$/u, '')}/package.json`),
    '**/node_modules/**',
    '**/fixtures/**',
    '**/.turbo/**',
    '**/dist/**',
    '**/lib/**',
    '**/build/**',
    '**/out/**',
    '**/output/**',
    '**/coverage/**',
    '**/target/**',
  ]
  for (const manifestPath of globSync(include, { cwd: scanRoot, exclude }).sort()) {
    const manifest = readJson(join(scanRoot, manifestPath))
    if (manifest.name?.startsWith('@deepseek-ai/') !== true) continue
    packages.set(manifest.name, {
      directory: canonicalPath(dirname(join(scanRoot, manifestPath))),
      manifest,
    })
  }
  return packages
}

function isInsideDirectory(directory: string, path: string): boolean {
  const child = relative(directory, path)
  return child === ''
    || (child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolute(child))
}

function pathSegments(path: string): readonly string[] {
  return resolve(path).split(sep)
}

function nearestPackageDirectory(path: string): string | undefined {
  let directory = dirname(path)
  while (true) {
    if (existsSync(join(directory, 'package.json'))) return directory
    const parent = dirname(directory)
    if (parent === directory) return undefined
    directory = parent
  }
}

function isGeneratedDeclaration(path: string): boolean {
  if (!/\.d\.[cm]?ts$/u.test(path)) return false
  const packageDirectory = nearestPackageDirectory(path)
  if (packageDirectory === undefined) return false
  const [rootDirectory] = relative(packageDirectory, path).split(sep)
  return rootDirectory !== undefined
    && excludedOpenLoopInputDirectories.has(rootDirectory)
}

function isGloballyExcludedOpenLoopInput(path: string, canonical: string): boolean {
  if (!sourceExtensions.test(canonical)) return true
  if (pathSegments(path).includes('node_modules')
    || pathSegments(canonical).includes('node_modules')) return true
  const typeScriptLib = canonicalPath(dirname(ts.getDefaultLibFilePath({})))
  if (isInsideDirectory(typeScriptLib, canonical)) return true
  return isGeneratedDeclaration(path) || isGeneratedDeclaration(canonical)
}

function isExcludedPackageLocalInput(packageDirectory: string, path: string): boolean {
  if (!isInsideDirectory(packageDirectory, path)) return false
  const [rootDirectory] = relative(packageDirectory, path).split(sep)
  return rootDirectory !== undefined
    && excludedOpenLoopInputDirectories.has(rootDirectory)
}

function isDshPrivateCompilerInput(
  packages: ReadonlyMap<string, DshPackage>,
  path: string,
): boolean {
  for (const { directory } of packages.values()) {
    if (!isInsideDirectory(directory, path)) continue
    const [firstSegment] = relative(directory, path).split(sep)
    return firstSegment === 'src' || firstSegment === 'lib'
  }
  return false
}

function repositoryPath(scanRoot: string, path: string): string {
  return relative(scanRoot, path).split(sep).join('/')
}

function formatConfigDiagnostic(scanRoot: string, configPath: string, diagnostic: ts.Diagnostic): Error {
  const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')
  return new Error(`${relative(scanRoot, configPath).split(sep).join('/')}: ${message}`)
}

/**
 * Parse every package-owned TypeScript config's direct compiler inputs.
 * Project references remain graph edges and are not flattened into the owning
 * Openloop package. A file can participate in multiple configs, so retain each
 * compiler option set for module resolution.
 */
function openLoopCompilerInputs(
  scanRoot: string,
  packageDirectory: string,
  packages: ReadonlyMap<string, DshPackage>,
): OpenLoopCompilerInputs {
  const configPaths = readdirSync(packageDirectory, { withFileTypes: true })
    .filter(entry => entry.isFile() && /^tsconfig(?:\..+)?\.json$/u.test(entry.name))
    .map(entry => join(packageDirectory, entry.name))
    .sort()
  const inputs = new Map<string, { path: string; compilerOptions: ts.CompilerOptions[] }>()
  const violations = new Set<string>()
  const canonicalScanRoot = canonicalPath(scanRoot)
  const canonicalPackageDirectory = canonicalPath(packageDirectory)

  for (const configPath of configPaths) {
    const loaded = ts.readConfigFile(configPath, file => ts.sys.readFile(file))
    if (loaded.error !== undefined) {
      throw formatConfigDiagnostic(scanRoot, configPath, loaded.error)
    }
    const parsed = ts.parseJsonConfigFileContent(
      loaded.config,
      ts.sys,
      dirname(configPath),
      undefined,
      configPath,
    )
    const error = parsed.errors.find(diagnostic =>
      diagnostic.category === ts.DiagnosticCategory.Error && diagnostic.code !== 18003)
    if (error !== undefined) throw formatConfigDiagnostic(scanRoot, configPath, error)

    for (const path of parsed.fileNames) {
      const absolutePath = resolve(path)
      const canonical = canonicalPath(absolutePath)
      const configLabel = repositoryPath(scanRoot, configPath)
      const inputLabel = repositoryPath(canonicalScanRoot, canonical)
      const isPackageLocal = isInsideDirectory(canonicalPackageDirectory, canonical)
      if (!isPackageLocal && isDshPrivateCompilerInput(packages, canonical)) {
        violations.add(
          `${configLabel}: Openloop package compiler input ${inputLabel} must not include private DSH source`,
        )
        continue
      }
      if (isGloballyExcludedOpenLoopInput(absolutePath, canonical)
        || isExcludedPackageLocalInput(packageDirectory, absolutePath)
        || isExcludedPackageLocalInput(canonicalPackageDirectory, canonical)) continue

      if (!isPackageLocal && isInsideDirectory(canonicalScanRoot, canonical)) {
        violations.add(
          `${configLabel}: Openloop package compiler input ${inputLabel} must stay within ${repositoryPath(canonicalScanRoot, canonicalPackageDirectory)}`,
        )
      } else if (!isPackageLocal) {
        continue
      }

      const key = canonical
      const input = inputs.get(key) ?? {
        path: canonical,
        compilerOptions: [],
      }
      input.compilerOptions.push(parsed.options)
      inputs.set(key, input)
    }
  }

  return {
    inputs: [...inputs.values()]
      .sort((left, right) => left.path.localeCompare(right.path)),
    violations: [...violations],
  }
}

function isInsideDshPackage(
  packages: ReadonlyMap<string, DshPackage>,
  target: string,
): boolean {
  const canonicalTarget = canonicalPath(target)
  return [...packages.values()]
    .some(({ directory }) => isInsideDirectory(directory, canonicalTarget))
}

function isDshPrivatePathLiteral(
  scanRoot: string,
  packages: ReadonlyMap<string, DshPackage>,
  importerPath: string,
  value: string,
): boolean {
  let target: string
  if (value.startsWith('.')) {
    target = resolve(dirname(importerPath), value)
  } else if (isAbsolute(value)) {
    target = resolve(value)
  } else {
    let parsedUrl: URL | undefined
    try {
      parsedUrl = new URL(value)
    } catch {
      const colon = value.indexOf(':')
      if (colon > 0 && value.slice(0, colon).toLowerCase() === 'file') return true
    }
    if (parsedUrl?.protocol.toLowerCase() === 'file:') {
      try {
        target = fileURLToPath(parsedUrl)
      } catch {
        return true
      }
    } else if (parsedUrl !== undefined) {
      return false
    } else {
      target = resolve(scanRoot, value)
    }
  }

  return isInsideDshPackage(packages, target)
}

function dshPackageSpecifierPrivacy(
  packages: ReadonlyMap<string, DshPackage>,
  value: string,
): boolean | undefined {
  const specifier = dshPackageSpecifier(packages, value)
  if (specifier === undefined) return undefined
  if (isPrivateImplementationSubpath(specifier.subpath)) return true
  return !exportedSubpath(specifier.pkg.manifest, specifier.subpath)
}

function dshPackageSpecifier(
  packages: ReadonlyMap<string, DshPackage>,
  value: string,
): DshPackageSpecifier | undefined {
  for (const [packageName, pkg] of packages) {
    if (value === packageName) return { name: packageName, pkg, subpath: '' }
    if (!value.startsWith(`${packageName}/`)) continue
    const subpath = normalizedPackageSubpath(value.slice(packageName.length + 1))
    return subpath === undefined
      ? undefined
      : { name: packageName, pkg, subpath }
  }
  return undefined
}

function isDshPrivatePackageSpecifier(
  packages: ReadonlyMap<string, DshPackage>,
  value: string,
): boolean {
  return dshPackageSpecifierPrivacy(packages, value) === true
}

function propertyName(property: ts.PropertyName): string | undefined {
  return ts.isIdentifier(property) || ts.isStringLiteralLike(property)
    || ts.isNumericLiteral(property)
    ? property.text
    : undefined
}

function packageImportTargetLiterals(
  manifestPath: string,
): ReadonlyArray<{ value: string; line: number }> {
  const sourceFile = ts.parseJsonText(manifestPath, readFileSync(manifestPath, 'utf8'))
  const statement = sourceFile.statements[0]
  if (statement === undefined
    || !ts.isExpressionStatement(statement)
    || !ts.isObjectLiteralExpression(statement.expression)) return []
  const importsProperty = statement.expression.properties.find(property =>
    ts.isPropertyAssignment(property) && propertyName(property.name) === 'imports')
  if (importsProperty === undefined
    || !ts.isPropertyAssignment(importsProperty)
    || !ts.isObjectLiteralExpression(importsProperty.initializer)) return []

  const literals: Array<{ value: string; line: number }> = []
  function collectTarget(node: ts.Node): void {
    if (ts.isStringLiteralLike(node)) {
      const line = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1
      literals.push({ value: node.text, line })
      return
    }
    if (ts.isArrayLiteralExpression(node)) {
      for (const element of node.elements) collectTarget(element)
      return
    }
    if (ts.isObjectLiteralExpression(node)) {
      for (const property of node.properties) {
        if (ts.isPropertyAssignment(property)) collectTarget(property.initializer)
      }
    }
  }

  for (const property of importsProperty.initializer.properties) {
    if (ts.isPropertyAssignment(property)) collectTarget(property.initializer)
  }
  return literals
}

function matchingPackageImportTarget(
  imports: PackageExportConditions | undefined,
  specifier: string,
): { target: PackageExportTarget | undefined; wildcard: string } | undefined {
  if (imports === undefined) return undefined
  if (Object.prototype.hasOwnProperty.call(imports, specifier)) {
    return { target: imports[specifier], wildcard: '' }
  }
  const matches = Object.entries(imports)
    .filter(([key]) => key.includes('*'))
    .map(([key, target]) => {
      const [prefix = '', suffix = ''] = key.split('*')
      if (specifier.length < prefix.length + suffix.length
        || !specifier.startsWith(prefix)
        || !specifier.endsWith(suffix)) return undefined
      return {
        key,
        prefix,
        target,
        wildcard: specifier.slice(prefix.length, specifier.length - suffix.length),
      }
    })
    .filter(match => match !== undefined)
    .sort((left, right) => {
      if (left.prefix.length !== right.prefix.length) {
        return right.prefix.length - left.prefix.length
      }
      return right.key.length - left.key.length
    })
  const match = matches[0]
  return match === undefined
    ? undefined
    : { target: match.target, wildcard: match.wildcard }
}

function packageImportTargetStrings(
  target: PackageExportTarget | undefined,
  wildcard: string,
): readonly string[] {
  if (typeof target === 'string') return [target.replaceAll('*', wildcard)]
  if (target == null) return []
  if (Array.isArray(target)) {
    return target.flatMap(value => packageImportTargetStrings(value, wildcard))
  }
  return Object.values(target)
    .flatMap(value => packageImportTargetStrings(value, wildcard))
}

function packageExportTargetStrings(
  manifest: PackageManifest,
  subpath: string,
): readonly string[] {
  const exports = manifest.exports
  if (exports === undefined) {
    if (subpath !== '') return []
    return [manifest.types, manifest.main]
      .filter((target): target is string => target !== undefined)
  }
  if (!isExportConditions(exports)) {
    return subpath === '' ? packageImportTargetStrings(exports, '') : []
  }
  const keys = Object.keys(exports)
  const hasSubpathKeys = keys.some(key => key.startsWith('.'))
  const hasConditionKeys = keys.some(key => !key.startsWith('.'))
  if (hasSubpathKeys && hasConditionKeys) return []
  if (!hasSubpathKeys) {
    return subpath === '' ? packageImportTargetStrings(exports, '') : []
  }

  const key = subpath === '' ? '.' : `./${subpath}`
  if (Object.prototype.hasOwnProperty.call(exports, key)) {
    return packageImportTargetStrings(exports[key], '')
  }
  const matches = Object.entries(exports)
    .filter(([pattern]) => pattern.includes('*'))
    .map(([pattern, target]) => {
      const [prefix = '', suffix = ''] = pattern.split('*')
      if (key.length < prefix.length + suffix.length
        || !key.startsWith(prefix)
        || !key.endsWith(suffix)) return undefined
      return {
        pattern,
        prefix,
        target,
        wildcard: key.slice(prefix.length, key.length - suffix.length),
      }
    })
    .filter(match => match !== undefined)
    .sort((left, right) => {
      if (left.prefix.length !== right.prefix.length) {
        return right.prefix.length - left.prefix.length
      }
      return right.pattern.length - left.pattern.length
    })
  const match = matches[0]
  return match === undefined
    ? []
    : packageImportTargetStrings(match.target, match.wildcard)
}

function packageImplementationKey(path: string): string | undefined {
  const normalized = normalizedPackageSubpath(path)
  if (normalized === undefined) return undefined
  const [rootDirectory, ...packagePath] = normalized.split('/')
  const segments = rootDirectory === 'src'
    ? packagePath
    : rootDirectory === 'lib'
      ? packagePath[0] === 'types' && packagePath.length > 1
        ? packagePath.slice(1)
        : packagePath
      : [rootDirectory ?? '', ...packagePath]
  const last = segments.at(-1)
  if (last !== undefined) {
    segments[segments.length - 1] = last.replace(/(?:\.d)?\.[cm]?[jt]sx?$/u, '')
  }
  if (segments.at(-1) === 'index') segments.pop()
  return segments.join('/')
}

function dshResolvedTarget(
  packages: ReadonlyMap<string, DshPackage>,
  target: string,
): DshResolvedTarget | undefined {
  const canonicalTarget = canonicalPath(target)
  for (const [name, pkg] of packages) {
    if (!isInsideDirectory(pkg.directory, canonicalTarget)) continue
    return {
      name,
      pkg,
      path: relative(pkg.directory, canonicalTarget).split(sep).join('/'),
    }
  }
  return undefined
}

function isPublicDshSpecifierResolution(
  packages: ReadonlyMap<string, DshPackage>,
  specifierValue: string,
  target: DshResolvedTarget,
): boolean {
  const specifier = dshPackageSpecifier(packages, specifierValue)
  if (specifier === undefined
    || specifier.name !== target.name
    || dshPackageSpecifierPrivacy(packages, specifierValue) !== false) return false
  const targetKey = packageImplementationKey(target.path)
  if (targetKey === undefined) return false
  const exportTargets = packageExportTargetStrings(specifier.pkg.manifest, specifier.subpath)
  if (exportTargets.length === 0) return specifier.subpath === '' && targetKey === ''
  return exportTargets.some(exportTarget => packageImplementationKey(exportTarget) === targetKey)
}

function packageImportAliasTargets(
  manifest: PackageManifest,
  specifier: string,
  seen = new Set<string>(),
): readonly string[] {
  if (seen.has(specifier)) return []
  const match = matchingPackageImportTarget(manifest.imports, specifier)
  if (match === undefined) return []
  seen.add(specifier)
  return packageImportTargetStrings(match.target, match.wildcard)
    .flatMap(target => target.startsWith('#')
      ? packageImportAliasTargets(manifest, target, seen)
      : [target])
}

function isPublicWorkspacePackageResolution(
  packages: ReadonlyMap<string, DshPackage>,
  manifest: PackageManifest,
  value: string,
  target: DshResolvedTarget,
): boolean {
  const specifiers = value.startsWith('#')
    ? packageImportAliasTargets(manifest, value)
    : [value]
  return specifiers.some(specifier =>
    isPublicDshSpecifierResolution(packages, specifier, target))
}

function packageImportAliasPrivacy(
  scanRoot: string,
  packages: ReadonlyMap<string, DshPackage>,
  packageDirectory: string,
  manifest: PackageManifest,
  specifier: string,
  seen = new Set<string>(),
): boolean | undefined {
  if (seen.has(specifier)) return undefined
  const match = matchingPackageImportTarget(manifest.imports, specifier)
  if (match === undefined) return undefined
  seen.add(specifier)

  for (const target of packageImportTargetStrings(match.target, match.wildcard)) {
    const packagePrivacy = dshPackageSpecifierPrivacy(packages, target)
    if (packagePrivacy === true) return true
    if (target.startsWith('#')) {
      if (packageImportAliasPrivacy(
        scanRoot,
        packages,
        packageDirectory,
        manifest,
        target,
        seen,
      ) === true) return true
      continue
    }
    if (packagePrivacy === undefined
      && isDshPrivatePathLiteral(
        scanRoot,
        packages,
        join(packageDirectory, 'package.json'),
        target,
      )) return true
  }
  return false
}

function resolvesToDshPrivatePath(
  packages: ReadonlyMap<string, DshPackage>,
  manifest: PackageManifest,
  importerPath: string,
  value: string,
  compilerOptions: readonly ts.CompilerOptions[],
): boolean {
  return compilerOptions.some((options) => {
    const resolvedModule = ts.resolveModuleName(value, importerPath, options, ts.sys).resolvedModule
    if (resolvedModule === undefined) return false
    const target = dshResolvedTarget(packages, resolvedModule.resolvedFileName)
    return target !== undefined
      && !isPublicWorkspacePackageResolution(packages, manifest, value, target)
  })
}

function isPrivateImportLiteral(
  scanRoot: string,
  packages: ReadonlyMap<string, DshPackage>,
  packageDirectory: string,
  manifest: PackageManifest,
  input: OpenLoopCompilerInput,
  value: string,
): boolean {
  if (isDshPrivatePathLiteral(scanRoot, packages, input.path, value)) return true
  if (resolvesToDshPrivatePath(
    packages,
    manifest,
    input.path,
    value,
    input.compilerOptions,
  )) return true
  const packagePrivacy = dshPackageSpecifierPrivacy(packages, value)
  if (packagePrivacy !== undefined) return packagePrivacy

  const importPrivacy = value.startsWith('#')
    ? packageImportAliasPrivacy(scanRoot, packages, packageDirectory, manifest, value)
    : undefined
  if (importPrivacy === false) return false
  return importPrivacy === true
}

/**
 * Reject static string literals that resolve to a DSH package's private
 * surface. The scan is intentionally independent of import or loader syntax.
 */
export function collectOpenLoopDshPrivateImportViolations(scanRoot: string): string[] {
  const packagesRoot = join(scanRoot, 'packages', 'openloop')
  if (!existsSync(packagesRoot)) return []
  const packages = dshPackages(scanRoot)
  const errors: string[] = []

  for (const entry of readdirSync(packagesRoot, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .sort((left, right) => left.name.localeCompare(right.name))) {
    const packageDirectory = join(packagesRoot, entry.name)
    const manifestPath = join(packageDirectory, 'package.json')
    if (!existsSync(manifestPath)) continue
    const manifest = readJson(manifestPath)
    for (const literal of packageImportTargetLiterals(manifestPath)) {
      if (!isDshPrivatePathLiteral(scanRoot, packages, manifestPath, literal.value)
        && !isDshPrivatePackageSpecifier(packages, literal.value)) continue
      errors.push(
        `${relative(scanRoot, manifestPath).split('\\').join('/')}:${String(literal.line)}: `
        + 'Openloop packages may import DSH only through public package exports; '
        + `${JSON.stringify(literal.value)} is private`,
      )
    }
    const compilerInputs = openLoopCompilerInputs(scanRoot, packageDirectory, packages)
    errors.push(...compilerInputs.violations)
    for (const input of compilerInputs.inputs) {
      for (const literal of staticStringLiterals(input.path)) {
        if (!isPrivateImportLiteral(
          scanRoot,
          packages,
          packageDirectory,
          manifest,
          input,
          literal.value,
        )) continue
        errors.push(
          `${repositoryPath(canonicalPath(scanRoot), input.path)}:${String(literal.line)}: `
          + 'Openloop packages may import DSH only through public package exports; '
          + `${JSON.stringify(literal.value)} is private`,
        )
      }
    }
  }

  return errors
}

function readEntryPatches(path: string): PatchOptions[] {
  const parsed = yaml.load(readFileSync(path, 'utf8'), { schema: entryListSchema })
  if (!Array.isArray(parsed)) throw new Error(`${path}: expected a patch list`)
  return parsed as PatchOptions[]
}

function nestedEntries(entries: readonly EntryOptions[]): EntryOptions[] {
  return entries.flatMap(entry => [
    entry,
    ...entry.group === true && Array.isArray(entry.config)
      ? nestedEntries(entry.config as EntryOptions[])
      : [],
  ])
}

function processRowViolation(row: EntryOptions, label: string): string | undefined {
  if (typeof row.name !== 'string' || !OPENLOOP_FORBIDDEN_PROCESS_PACKAGES.has(row.name)) return undefined
  if (row.name === '@deepseek-ai/dsh-mcp-client'
    && (row.config as Readonly<Record<string, unknown>> | undefined)?.['transport'] === 'streamable-http') {
    return undefined
  }
  if (row.disabled === true) return undefined
  return `${label}: process row ${JSON.stringify(row.id)} (${row.name}) must be disabled`
}

/**
 * Compose the checked-in Openloop profile and every exposed system preset,
 * then reject any enabled local-process provider or model-facing bypass.
 */
export function collectOpenLoopProcessProfileViolations(scanRoot: string): string[] {
  const patchPaths = [
    'packages/bundle/base/cordis.patch.yml',
    'packages/bundle/web-app/cordis.patch.yml',
    'packages/openloop/bundle/cordis.patch.yml',
  ]
  const missingPatches = patchPaths.filter(path => !existsSync(join(scanRoot, path)))
  if (missingPatches.length > 0) {
    return missingPatches.map(path =>
      `${path}: required Openloop process-policy input is missing`)
  }
  const patches = patchPaths.flatMap(path => readEntryPatches(join(scanRoot, path)))
  const profile = applyEntryPatches([], structuredClone(patches), () => {})
  const errors = nestedEntries(profile)
    .flatMap(row => processRowViolation(row, 'Openloop profile') ?? [])

  const presetRow = profile.find(row => row.id === 'agent-presets')
  const config = presetRow?.config as Readonly<Record<string, unknown>> | undefined
  if (config?.['includeUserRoot'] !== false) {
    errors.push('Openloop profile: agent preset user root must remain disabled')
  }
  const allowed = config?.['allowedPresetIds']
  if (!Array.isArray(allowed)
    || allowed.length === 0
    || allowed.some(id => typeof id !== 'string' || id.length === 0)) {
    errors.push('Openloop profile: agent presets must declare a non-empty allowedPresetIds list')
    return errors
  }
  if (!allowed.includes(config?.['default'])) {
    errors.push('Openloop profile: default agent preset must be present in allowedPresetIds')
  }
  const presetPatches = config?.['patches']
  if (!Array.isArray(presetPatches)) {
    errors.push('Openloop profile: agent presets must declare deployment-owned process patches')
    return errors
  }

  for (const id of allowed as string[]) {
    const path = join(scanRoot, 'apps', 'cli', 'config', 'agent-presets', id, 'agent.cordis.yml')
    if (!existsSync(path)) {
      errors.push(`Openloop profile: allowed agent preset ${JSON.stringify(id)} is missing`)
      continue
    }
    const entries = applyEntryPatches(
      readEntryPatches(path) as EntryOptions[],
      structuredClone(presetPatches) as PatchOptions[],
      () => {},
    )
    errors.push(...nestedEntries(entries)
      .flatMap(row => processRowViolation(row, `Openloop preset ${JSON.stringify(id)}`) ?? []))
  }
  return errors
}

const isMain = process.argv[1] !== undefined
  && resolve(process.argv[1]) === fileURLToPath(import.meta.url)

if (isMain) {
  const manifests = workspaceManifests()
  const errors = [
    ...checkRepositoryVersion(),
    ...manifests.flatMap(checkWorkspace),
    ...checkWorkspaceProtocol(manifests),
    ...checkHierarchyShape(),
    ...collectProjectReferenceFaceViolations(root),
    ...collectDshWorkspaceNamingViolations(root),
    ...collectOpenLoopWorkspaceViolations(root),
    ...collectOpenLoopDshPrivateImportViolations(root),
    ...collectOpenLoopProcessProfileViolations(root),
  ]
  if (errors.length > 0) {
    console.error(errors.join('\n'))
    process.exitCode = 1
  }
}
