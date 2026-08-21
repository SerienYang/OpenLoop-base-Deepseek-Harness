#!/usr/bin/env node

import { createHash, randomUUID } from 'node:crypto'
import { spawn as nodeSpawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import {
  lstat,
  mkdir,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises'
import { dirname, join, relative, resolve, sep } from 'node:path'
import {
  generateArtifactManifest,
  hashArtifact,
} from './generate-artifact-manifest.mjs'
import {
  generateBuildManifest,
} from './generate-build-manifest.mjs'
import {
  assertTauriUpdaterPublicKey,
  verifyTauriUpdaterSignature,
} from './verify-tauri-updater-signature.mjs'
import {
  parseOpenloopArtifactManifest,
  parseOpenloopBuildManifest,
} from '../../packages/openloop/build-contract/src/index.ts'

const supportedChannels = new Set(['test', 'stable'])
const supportedTargets = new Set(['aarch64-apple-darwin'])
const supportedBundles = new Set(['none', 'app', 'dmg', 'all'])
const optionFields = new Map([
  ['--channel', 'channel'],
  ['--target', 'target'],
  ['--bundle', 'bundle'],
])

function optionValue(args, index, option) {
  const value = args[index + 1]
  if (value === undefined || value.startsWith('--')) {
    throw new Error(`${option} requires a value`)
  }
  return value
}

/** Parse the complete and intentionally narrow desktop build CLI. */
export function parseDesktopBuildArguments(args) {
  const normalized = args[0] === '--' ? args.slice(1) : args
  const options = {}
  for (let index = 0; index < normalized.length; index += 1) {
    const option = normalized[index]
    const field = optionFields.get(option)
    if (field === undefined) throw new Error(`unknown option ${option}`)
    if (options[field] !== undefined) throw new Error(`${option} may be specified only once`)
    options[field] = optionValue(normalized, index, option)
    index += 1
  }
  for (const [option, field] of optionFields) {
    if (options[field] === undefined) throw new Error(`${option} is required`)
  }
  if (!supportedChannels.has(options.channel)) {
    throw new Error('--channel must be test or stable')
  }
  if (!supportedTargets.has(options.target)) {
    throw new Error('--target must be aarch64-apple-darwin')
  }
  if (!supportedBundles.has(options.bundle)) {
    throw new Error('--bundle must be none, app, dmg, or all')
  }
  return options
}

function identifierForChannel(channel) {
  return channel === 'stable' ? 'ai.openloop.desktop' : 'ai.openloop.desktop.test'
}

function updateChannelFor(channel) {
  if (channel === 'stable') {
    return {
      keyEnvironment: 'OPENLOOP_STABLE_UPDATER_PUBLIC_KEY',
      endpoint: 'https://github.com/SerienYang/OpenLoop-base-Deepseek-Harness/releases/download/openloop-stable-rolling/latest-stable-k1.json',
    }
  }
  return {
    keyEnvironment: 'OPENLOOP_UPDATER_PUBLIC_KEY',
    endpoint: 'https://github.com/SerienYang/OpenLoop-base-Deepseek-Harness/releases/download/openloop-test-rolling/latest-test-k1.json',
  }
}

function tauriBundleArguments(bundle) {
  if (bundle === 'none') return ['--no-bundle']
  if (bundle === 'all') return ['--bundles', 'app,dmg']
  return ['--bundles', bundle]
}

export function createProcessRunner(spawn = nodeSpawn) {
  return {
    run: ({ command, args, cwd, capture = false, env }) =>
      new Promise((resolvePromise, reject) => {
        const child = spawn(command, args, {
          cwd,
          env: { ...process.env, CI: 'true', ...env },
          shell: false,
          stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
        })
        const stdout = []
        const stderr = []
        if (capture) {
          child.stdout.on('data', chunk => stdout.push(Buffer.from(chunk)))
          child.stderr.on('data', chunk => stderr.push(Buffer.from(chunk)))
        }
        child.once('error', error => reject(new Error(
          `build-desktop: failed to spawn ${command}: ${error.message}`,
        )))
        child.once('exit', (code, signal) => {
          if (code === 0) {
            resolvePromise({
              stdout: Buffer.concat(stdout).toString('utf8'),
              stderr: Buffer.concat(stderr).toString('utf8'),
            })
            return
          }
          reject(new Error(
            `build-desktop: ${command} failed with ${
              code === null ? `signal ${String(signal)}` : `exit ${String(code)}`
            }`,
          ))
        })
      }),
  }
}

async function assertTreeContainsNoSymlinks(path) {
  const metadata = await lstat(path)
  if (metadata.isSymbolicLink()) {
    throw new Error(`build-desktop: deletion path contains symlink: ${path}`)
  }
  if (!metadata.isDirectory()) return
  for (const entry of await readdir(path)) {
    await assertTreeContainsNoSymlinks(join(path, entry))
  }
}

async function cleanDist(root, requestedDist, runner) {
  const repositoryRoot = resolve(root)
  const dist = resolve(requestedDist)
  const expected = join(repositoryRoot, 'dist-openloop')
  if (dist !== expected) {
    throw new Error(`build-desktop: deletion target must be exactly the fixed dist-openloop path ${expected}`)
  }
  const rootMetadata = await lstat(repositoryRoot)
  if (rootMetadata.isSymbolicLink() || !rootMetadata.isDirectory()) {
    throw new Error(`build-desktop: repository root must be a real directory, not a symlink: ${repositoryRoot}`)
  }
  const canonicalRoot = await realpath(repositoryRoot)
  if (existsSync(dist)) {
    const distMetadata = await lstat(dist)
    if (distMetadata.isSymbolicLink() || !distMetadata.isDirectory()) {
      throw new Error('build-desktop: dist-openloop deletion target must be a real directory, not a symlink or regular file')
    }
    await assertTreeContainsNoSymlinks(dist)
    const canonicalDist = await realpath(dist)
    if (canonicalDist !== join(canonicalRoot, 'dist-openloop')) {
      throw new Error(`build-desktop: dist-openloop realpath escapes repository root: ${canonicalDist}`)
    }
  }
  await runner.run({
    command: 'git',
    args: ['check-ignore', '-q', '--', 'dist-openloop/'],
    cwd: repositoryRoot,
  })
  await rm(dist, { recursive: true, force: true })
}

async function collectBundleFiles(directory, webRoot) {
  const files = []
  const entries = await readdir(directory, { withFileTypes: true })
  entries.sort((left, right) =>
    Buffer.compare(Buffer.from(left.name), Buffer.from(right.name)))
  for (const entry of entries) {
    const path = join(directory, entry.name)
    const metadata = await lstat(path)
    if (metadata.isSymbolicLink()) {
      throw new Error(`build-desktop: Web bundle contains symlink: ${path}`)
    }
    if (metadata.isDirectory()) {
      files.push(...await collectBundleFiles(path, webRoot))
      continue
    }
    if (!metadata.isFile()) {
      throw new Error(`build-desktop: Web bundle contains non-file entry: ${path}`)
    }
    const bytes = await readFile(path)
    files.push({
      path: relative(webRoot, path).split(sep).join('/'),
      size: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    })
  }
  return files
}

async function generateBundleGraph(root, requestedWeb, requestedGraph) {
  const repositoryRoot = resolve(root)
  const web = resolve(requestedWeb)
  const graph = resolve(requestedGraph)
  const expectedWeb = join(repositoryRoot, 'apps/web/dist')
  const expectedGraph = join(repositoryRoot, 'dist-openloop/openloop-web-bundle-graph.json')
  if (web !== expectedWeb || graph !== expectedGraph) {
    throw new Error('build-desktop: fixed Web and bundle graph paths must match exactly')
  }
  const rootMetadata = await lstat(repositoryRoot)
  if (rootMetadata.isSymbolicLink() || !rootMetadata.isDirectory()) {
    throw new Error(`build-desktop: repository root must be a real directory: ${repositoryRoot}`)
  }
  const canonicalRoot = await realpath(repositoryRoot)
  await assertTreeContainsNoSymlinks(web)
  if (await realpath(web) !== join(canonicalRoot, 'apps/web/dist')) {
    throw new Error(`build-desktop: Web bundle realpath escapes repository root: ${web}`)
  }
  const bytes = `${JSON.stringify({
    version: 1,
    root: 'apps/web/dist',
    files: await collectBundleFiles(web, web),
  }, null, 2)}\n`
  await mkdir(dirname(graph), { recursive: true })
  const parentMetadata = await lstat(dirname(graph))
  if (parentMetadata.isSymbolicLink() || !parentMetadata.isDirectory()) {
    throw new Error(`build-desktop: bundle graph parent must be a real directory: ${dirname(graph)}`)
  }
  if (existsSync(graph)) {
    const metadata = await lstat(graph)
    if (metadata.isSymbolicLink() || !metadata.isFile()) {
      throw new Error(`build-desktop: bundle graph must be a regular file: ${graph}`)
    }
    if ((await readFile(graph)).equals(Buffer.from(bytes))) return
  }
  const temporary = join(dirname(graph), `.bundle-graph.${process.pid}.${randomUUID()}.tmp`)
  try {
    await writeFile(temporary, bytes, { flag: 'wx', mode: 0o600 })
    await rename(temporary, graph)
  } finally {
    await rm(temporary, { force: true })
  }
}

function canonicalJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`
}

async function readCanonicalManifest(path, parser, label) {
  const bytes = await readFile(path)
  let value
  try {
    value = JSON.parse(bytes.toString('utf8'))
  } catch (error) {
    throw new Error(
      `build-desktop: ${label} is not valid JSON: ${
        error instanceof Error ? error.message : String(error)
      }`,
    )
  }
  const parsed = parser(value)
  if (!bytes.equals(Buffer.from(canonicalJson(parsed)))) {
    throw new Error(`build-desktop: ${label} is not canonical JSON`)
  }
  return { bytes, manifest: parsed }
}

function assertFixedVerificationPaths(context) {
  const root = resolve(context.root)
  const dist = join(root, 'dist-openloop')
  const release = join(
    root,
    'apps/openloop-desktop/src-tauri/target',
    context.options.target,
    'release',
  )
  const expected = {
    core: join(dist, 'openloop-core.json'),
    sidecar: join(dist, 'openloop-runtime-aarch64-apple-darwin'),
    runtimeSbom: join(dist, 'openloop-runtime-sbom-inputs.json'),
    web: join(root, 'apps/web/dist'),
    bundleGraph: join(dist, 'openloop-web-bundle-graph.json'),
    artifacts: join(dist, 'openloop-artifacts.json'),
    release,
  }
  for (const [label, path] of Object.entries(expected)) {
    if (resolve(context[label]) !== path) {
      throw new Error(`build-desktop: ${label} must use fixed path ${path}`)
    }
  }
  const expectedApp = join(release, 'bundle/macos/Openloop.app')
  if (context.app !== undefined && resolve(context.app) !== expectedApp) {
    throw new Error(`build-desktop: App must use fixed path ${expectedApp}`)
  }
  const expectedUpdater = join(release, 'bundle/macos/Openloop.app.tar.gz')
  if (context.updater !== undefined && resolve(context.updater) !== expectedUpdater) {
    throw new Error(`build-desktop: updater must use fixed path ${expectedUpdater}`)
  }
  const expectedUpdaterSignature = `${expectedUpdater}.sig`
  if (context.updaterSignature !== undefined
    && resolve(context.updaterSignature) !== expectedUpdaterSignature) {
    throw new Error(
      `build-desktop: updater signature must use fixed path ${expectedUpdaterSignature}`,
    )
  }
  return {
    root,
    release,
    app: expectedApp,
    updater: expectedUpdater,
    updaterSignature: expectedUpdaterSignature,
  }
}

async function assertExecutable(path) {
  const metadata = await lstat(path)
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    throw new Error(`build-desktop: executable must be a regular file: ${path}`)
  }
  if ((metadata.mode & 0o111) === 0) {
    throw new Error(`build-desktop: executable is not executable: ${path}`)
  }
}

async function verifyMachO(path, runner, requireHardenedRuntime = true) {
  await assertExecutable(path)
  const architecture = await runner.run({
    command: 'lipo',
    args: ['-archs', path],
    capture: true,
  })
  if (architecture.stdout.trim() !== 'arm64') {
    throw new Error(`build-desktop: ${path} must be thin arm64, got ${architecture.stdout.trim()}`)
  }
  await runner.run({
    command: 'codesign',
    args: ['--verify', '--strict', path],
    capture: true,
  })
  const signature = await runner.run({
    command: 'codesign',
    args: ['-d', '--verbose=4', path],
    capture: true,
  })
  const details = `${signature.stdout}\n${signature.stderr}`
  if (!/Signature=adhoc/u.test(details)) {
    throw new Error(`build-desktop: ${path} must use an ad-hoc signature`)
  }
  if (requireHardenedRuntime && !/flags=.*\bruntime\b/u.test(details)) {
    throw new Error(`build-desktop: ${path} must enable hardened runtime`)
  }
}

function hasExactObjectKeys(value, expectedKeys) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const actualKeys = Object.keys(value)
  return actualKeys.length === expectedKeys.length
    && actualKeys.every(key => expectedKeys.includes(key))
}

/** Verify the final external manifest and every executable desktop product. */
export async function verifyDesktopBuild(context, runner) {
  const fixed = assertFixedVerificationPaths(context)
  const core = await readCanonicalManifest(
    context.core,
    parseOpenloopBuildManifest,
    'core manifest',
  )
  if (core.manifest.channel !== context.options.channel) {
    throw new Error('build-desktop: core manifest channel does not match requested channel')
  }
  if (typeof context.desktopVersion !== 'string'
    || context.desktopVersion !== core.manifest.appVersion) {
    throw new Error('build-desktop: desktop package version does not match core appVersion')
  }
  if (context.dmg !== undefined) {
    const expectedDmg = join(
      fixed.release,
      `bundle/dmg/Openloop_${context.desktopVersion}_aarch64.dmg`,
    )
    if (resolve(context.dmg) !== expectedDmg) {
      throw new Error(`build-desktop: DMG filename must match desktop version at ${expectedDmg}`)
    }
  }
  const final = await readCanonicalManifest(
    context.artifacts,
    parseOpenloopArtifactManifest,
    'artifact manifest',
  )
  const coreSha256 = createHash('sha256').update(core.bytes).digest('hex')
  if (final.manifest.coreManifestSha256 !== coreSha256) {
    throw new Error('build-desktop: final core manifest hash does not match exact core bytes')
  }

  const paths = {
    sidecar: context.sidecar,
    runtimeSbom: context.runtimeSbom,
    web: context.web,
    bundleGraph: context.bundleGraph,
    ...(context.app === undefined ? {} : { app: context.app }),
    ...(context.dmg === undefined ? {} : { dmg: context.dmg }),
    ...(context.updater === undefined ? {} : { updater: context.updater }),
  }
  const expectedKeys = Object.keys(paths)
  const actualKeys = Object.keys(final.manifest.artifacts)
  if (JSON.stringify(actualKeys) !== JSON.stringify(expectedKeys)) {
    throw new Error(
      `build-desktop: final artifact keys ${actualKeys.join(',')} do not match ${expectedKeys.join(',')}`,
    )
  }
  for (const [label, path] of Object.entries(paths)) {
    const actual = hashArtifact(path, { trustedRoot: fixed.root })
    if (final.manifest.artifacts[label] !== actual) {
      throw new Error(`build-desktop: ${label} hash does not match artifact bytes`)
    }
  }
  if (context.updater !== undefined) {
    if (context.updaterSignature === undefined) {
      throw new Error('build-desktop: updater signature path is required')
    }
    const signatureMetadata = await lstat(context.updaterSignature)
    if (signatureMetadata.isSymbolicLink() || !signatureMetadata.isFile()) {
      throw new Error('build-desktop: updater signature must be a regular file')
    }
    const signature = await readFile(context.updaterSignature, 'utf8')
    if (signature.trim() === '') {
      throw new Error('build-desktop: updater signature must not be empty')
    }
    verifyTauriUpdaterSignature({
      artifactBytes: await readFile(context.updater),
      signature,
      publicKey: context.updaterPublicKey,
    })
  }

  if (context.app === undefined) {
    await verifyMachO(join(fixed.release, 'openloop-desktop'), runner, false)
    return
  }

  const macOS = join(context.app, 'Contents/MacOS')
  const main = join(macOS, 'openloop-desktop')
  const sidecar = join(macOS, 'openloop-runtime')
  const helper = join(macOS, 'openloop-runtime-spawn-helper')
  const baseManifest = {
    coreManifestSha256: final.manifest.coreManifestSha256,
    artifacts: {
      sidecar: final.manifest.artifacts.sidecar,
      runtimeSbom: final.manifest.artifacts.runtimeSbom,
      web: final.manifest.artifacts.web,
      bundleGraph: final.manifest.artifacts.bundleGraph,
    },
  }
  if (!(await readFile(main)).includes(Buffer.from(canonicalJson(baseManifest)))) {
    throw new Error('build-desktop: App main executable does not embed exact base artifact manifest')
  }
  for (const executable of [main, sidecar, helper]) {
    await verifyMachO(executable, runner)
  }
  await runner.run({
    command: 'codesign',
    args: ['--verify', '--deep', '--strict', context.app],
    capture: true,
  })
  const infoPlist = join(context.app, 'Contents/Info.plist')
  const readPlistValue = async key => {
    const result = await runner.run({
      command: 'plutil',
      args: ['-extract', key, 'raw', '-o', '-', infoPlist],
      capture: true,
    })
    return result.stdout.trim()
  }
  if (await readPlistValue('CFBundleIdentifier')
    !== identifierForChannel(context.options.channel)) {
    throw new Error('build-desktop: App bundle identifier does not match requested channel')
  }
  for (const key of ['CFBundleShortVersionString', 'CFBundleVersion']) {
    if (await readPlistValue(key) !== context.desktopVersion) {
      throw new Error(`build-desktop: Info.plist ${key} does not match desktop version`)
    }
  }
  const health = await runner.run({
    command: sidecar,
    args: ['--health-smoke'],
    capture: true,
  })
  if (health.stderr !== '') {
    throw new Error('build-desktop: sidecar health smoke stderr must be empty')
  }
  if (!/^[^\n]+\n$/u.test(health.stdout)) {
    throw new Error('build-desktop: sidecar health smoke must emit exactly one JSON line')
  }
  let readiness
  try {
    readiness = JSON.parse(health.stdout)
  } catch (error) {
    throw new Error(
      `build-desktop: sidecar health smoke is not JSON: ${
        error instanceof Error ? error.message : String(error)
      }`,
    )
  }
  const readinessKeys = [
    'type',
    'version',
    'profile',
    'host',
    'port',
    'origin',
    'coreManifestSha256',
    'healthSmoke',
  ]
  const healthSmokeKeys = ['method', 'path', 'status']
  const validPort = Number.isSafeInteger(readiness?.port)
    && readiness.port >= 1
    && readiness.port <= 65535
  if (!hasExactObjectKeys(readiness, readinessKeys)
    || !hasExactObjectKeys(readiness.healthSmoke, healthSmokeKeys)
    || readiness.type !== 'openloop.runtime.ready'
    || readiness.version !== 1
    || readiness.profile !== 'openloop'
    || readiness.host !== '127.0.0.1'
    || !validPort
    || readiness.origin !== `http://127.0.0.1:${String(readiness.port)}`
    || readiness.coreManifestSha256 !== coreSha256
    || readiness.healthSmoke.method !== 'GET'
    || readiness.healthSmoke.path !== '/'
    || readiness.healthSmoke.status !== 200) {
    throw new Error('build-desktop: sidecar health smoke readiness contract is invalid')
  }
}

export const nodeFileSystem = {
  cleanDist,
  generateBundleGraph,
  readDesktopPackage: async desktopRoot =>
    JSON.parse(await readFile(join(desktopRoot, 'package.json'), 'utf8')),
  verify: verifyDesktopBuild,
}

/** Testable eight-stage desktop build pipeline. */
export class DesktopBuilder {
  constructor(dependencies) {
    this.dependencies = dependencies
    this.root = resolve(dependencies.root)
  }

  async build() {
    const {
      options,
      runner,
      files,
      createRuntimeBuilder,
      generateBuildManifest,
      generateArtifactManifest,
    } = this.dependencies
    const updateChannel = updateChannelFor(options.channel)
    const updaterPublicKey = this.dependencies.updaterPublicKey ?? ''
    try {
      assertTauriUpdaterPublicKey(updaterPublicKey)
    } catch (error) {
      throw new Error(
        `build-desktop: ${updateChannel.keyEnvironment} must contain a valid Tauri updater public key: ${
          error instanceof Error ? error.message : String(error)
        }`,
      )
    }
    const dist = join(this.root, 'dist-openloop')
    const core = join(dist, 'openloop-core.json')
    const artifacts = join(dist, 'openloop-artifacts.json')
    const sidecar = join(dist, 'openloop-runtime-aarch64-apple-darwin')
    const runtimeSbom = join(dist, 'openloop-runtime-sbom-inputs.json')
    const web = join(this.root, 'apps/web/dist')
    const bundleGraph = join(dist, 'openloop-web-bundle-graph.json')
    const desktopRoot = join(this.root, 'apps/openloop-desktop')
    const release = join(
      desktopRoot,
      'src-tauri/target',
      options.target,
      'release',
    )
    const app = join(release, 'bundle/macos/Openloop.app')
    const updater = join(release, 'bundle/macos/Openloop.app.tar.gz')
    const updaterSignature = `${updater}.sig`

    await files.cleanDist(this.root, dist, runner)
    const desktopPackage = await files.readDesktopPackage(desktopRoot)
    const dmg = join(
      release,
      `bundle/dmg/Openloop_${desktopPackage.version}_aarch64.dmg`,
    )
    generateBuildManifest({
      channel: options.channel,
      appVersion: desktopPackage.version,
      out: core,
    })
    await runner.run({
      command: 'pnpm',
      args: ['run', 'build'],
      cwd: this.root,
    })
    const runtimeBuilder = createRuntimeBuilder({
      root: this.root,
      target: options.target,
      skipBuild: true,
      runner,
    })
    await runtimeBuilder.build()
    await files.generateBundleGraph?.(this.root, web, bundleGraph)
    const baseInputs = {
      core,
      sidecar,
      runtimeSbom,
      web,
      bundleGraph,
      out: artifacts,
    }
    generateArtifactManifest(baseInputs)
    await runner.run({
      command: 'pnpm',
      args: [
        'exec',
        'tauri',
        'build',
        '--target',
        options.target,
        ...tauriBundleArguments(options.bundle),
        '--config',
        JSON.stringify({
          identifier: identifierForChannel(options.channel),
          version: desktopPackage.version,
          bundle: { createUpdaterArtifacts: options.bundle === 'all' },
          plugins: {
            updater: {
              pubkey: updaterPublicKey,
              endpoints: [updateChannel.endpoint],
            },
          },
        }),
        '--ci',
      ],
      cwd: desktopRoot,
      env: {
        [updateChannel.keyEnvironment]: updaterPublicKey,
      },
    })
    const releaseInputs = { ...baseInputs }
    if (options.bundle !== 'none') releaseInputs.app = app
    if (options.bundle === 'dmg' || options.bundle === 'all') releaseInputs.dmg = dmg
    if (options.bundle === 'all') releaseInputs.updater = updater
    generateArtifactManifest(releaseInputs)
    await files.verify({
      root: this.root,
      ...baseInputs,
      app: options.bundle === 'none' ? undefined : app,
      dmg: options.bundle === 'dmg' || options.bundle === 'all' ? dmg : undefined,
      updater: options.bundle === 'all' ? updater : undefined,
      updaterSignature: options.bundle === 'all' ? updaterSignature : undefined,
      updaterPublicKey,
      desktopVersion: desktopPackage.version,
      artifacts,
      options,
      release,
    }, runner)
  }
}

function runtimeBuilderFor({ root, target, skipBuild, runner }) {
  return {
    build: () => runner.run({
      command: 'pnpm',
      args: [
        'exec',
        'tsx',
        'scripts/openloop/build-runtime-exe.ts',
        '--target',
        target,
        ...(skipBuild ? ['--skip-build'] : []),
      ],
      cwd: root,
    }),
  }
}

/** Bind production dependencies while keeping the pipeline independently testable. */
export function createDesktopBuilder({
  root = resolve(import.meta.dirname, '../..'),
  runner = createProcessRunner(),
  options,
} = {}) {
  const repositoryRoot = resolve(root)
  return new DesktopBuilder({
    root: repositoryRoot,
    options,
    updaterPublicKey: options?.channel === 'stable'
      ? process.env.OPENLOOP_STABLE_UPDATER_PUBLIC_KEY
      : process.env.OPENLOOP_UPDATER_PUBLIC_KEY,
    runner,
    files: nodeFileSystem,
    createRuntimeBuilder: runtimeBuilderFor,
    generateBuildManifest: manifestOptions => generateBuildManifest(
      manifestOptions,
      { trustedRoot: repositoryRoot },
    ),
    generateArtifactManifest: artifactOptions => generateArtifactManifest(
      artifactOptions,
      { trustedRoot: repositoryRoot },
    ),
  })
}

const isMain = process.argv[1] !== undefined
  && resolve(process.argv[1]) === resolve(import.meta.filename)

if (isMain) {
  try {
    const options = parseDesktopBuildArguments(process.argv.slice(2))
    await createDesktopBuilder({ options }).build()
    process.stdout.write(
      `build-desktop: verified ${options.channel} ${options.target} ${options.bundle}\n`,
    )
  } catch (error) {
    process.stderr.write(
      `build-desktop: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`,
    )
    process.exitCode = 1
  }
}
