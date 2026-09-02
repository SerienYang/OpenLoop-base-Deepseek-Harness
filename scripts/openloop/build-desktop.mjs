#!/usr/bin/env node

import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { spawn as nodeSpawn } from 'node:child_process'
import { createServer } from 'node:net'
import {
  closeSync,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import {
  chmod,
  lstat,
  mkdtemp,
  mkdir,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { finished } from 'node:stream/promises'
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
import {
  authenticateBridgeResponse,
  decodeBridgeFrame,
  encodeBridgeFrame,
  MAX_BRIDGE_FRAME_BYTES,
  NonceReplayGuard,
  verifyBridgeRequest,
} from '../../packages/openloop/desktop-bridge-host/src/protocol.ts'

const supportedChannels = new Set(['test', 'stable'])
const supportedTargets = new Set(['aarch64-apple-darwin'])
const supportedBundles = new Set(['none', 'app', 'dmg', 'all'])
const DESKTOP_BUILD_LOCK = 'openloop-desktop-build.lock'
const HEALTH_SMOKE_TIMEOUT_MS = 30_000
const PROCESS_TERMINATE_WAIT_MS = 2_000
const PROCESS_KILL_WAIT_MS = 2_000
const LAUNCH_SECRETS_MAGIC = Buffer.from('OLSP')
const LAUNCH_SECRETS_PROTOCOL_VERSION = 1
const LAUNCH_SECRETS_HEADER_BYTES = 10
const optionFields = new Map([
  ['--channel', 'channel'],
  ['--target', 'target'],
  ['--bundle', 'bundle'],
])

function errorCode(error) {
  return typeof error === 'object' && error !== null && 'code' in error
    ? error.code
    : undefined
}

function buildLockOwnershipChangedError(lockPath) {
  return new Error(
    `build-desktop: desktop build lock ownership changed at ${lockPath}; refusing to remove it`,
  )
}

function lockOwnerIsAlive(owner) {
  try {
    process.kill(owner, 0)
    return true
  } catch (error) {
    if (errorCode(error) === 'ESRCH') return false
    if (errorCode(error) === 'EPERM') return true
    throw error
  }
}

function releaseDesktopBuildLock(lockPath, ownedRecord, ownedStat) {
  let current
  try {
    current = lstatSync(lockPath)
  } catch (error) {
    if (errorCode(error) === 'ENOENT') throw buildLockOwnershipChangedError(lockPath)
    throw error
  }
  if (
    !current.isFile()
    || current.isSymbolicLink()
    || current.nlink !== 1
    || current.dev !== ownedStat.dev
    || current.ino !== ownedStat.ino
    || readFileSync(lockPath, 'utf8') !== ownedRecord
  ) {
    throw buildLockOwnershipChangedError(lockPath)
  }
  try {
    unlinkSync(lockPath)
  } catch (error) {
    if (errorCode(error) === 'ENOENT') throw buildLockOwnershipChangedError(lockPath)
    throw error
  }
}

export function acquireDesktopBuildLock(root) {
  const repositoryRoot = resolve(root)
  const rootMetadata = lstatSync(repositoryRoot)
  if (rootMetadata.isSymbolicLink() || !rootMetadata.isDirectory()) {
    throw new Error(
      `build-desktop: repository root must be a real directory: ${repositoryRoot}`,
    )
  }
  const artifacts = join(repositoryRoot, '.artifacts')
  mkdirSync(artifacts, { recursive: true, mode: 0o700 })
  const artifactsMetadata = lstatSync(artifacts)
  if (artifactsMetadata.isSymbolicLink()
    || !artifactsMetadata.isDirectory()
    || realpathSync(artifacts) !== join(realpathSync(repositoryRoot), '.artifacts')) {
    throw new Error(
      `build-desktop: build lock directory must be a real repository directory: ${artifacts}`,
    )
  }

  const lockPath = join(artifacts, DESKTOP_BUILD_LOCK)
  const ownedRecord = `${String(process.pid)} ${randomUUID()}\n`
  let handle
  let ownedStat
  try {
    handle = openSync(lockPath, 'wx', 0o600)
    ownedStat = fstatSync(handle)
    writeFileSync(handle, ownedRecord)
    fsyncSync(handle)
  } catch (error) {
    if (handle !== undefined) {
      closeSync(handle)
      handle = undefined
      if (ownedStat !== undefined) {
        const current = lstatSync(lockPath)
        if (current.dev === ownedStat.dev && current.ino === ownedStat.ino) {
          unlinkSync(lockPath)
        }
      }
    }
    if (errorCode(error) !== 'EEXIST') throw error
    const metadata = lstatSync(lockPath)
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1) {
      throw new Error(
        `build-desktop: invalid desktop build lock at ${lockPath}; remove it manually`,
      )
    }
    const record = readFileSync(lockPath, 'utf8')
    const match = /^([1-9]\d*) ([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\n$/iu
      .exec(record)
    if (match?.[1] === undefined) {
      throw new Error(
        `build-desktop: invalid or initializing desktop build lock at ${lockPath}; retry only after confirming no build is running`,
      )
    }
    const owner = Number(match[1])
    if (!Number.isSafeInteger(owner) || !lockOwnerIsAlive(owner)) {
      throw new Error(
        `build-desktop: stale desktop build lock at ${lockPath}; confirm no build is running, remove it manually, and retry`,
      )
    }
    throw new Error(
      `build-desktop: desktop build lock is held by process ${String(owner)} at ${lockPath}`,
    )
  } finally {
    if (handle !== undefined) closeSync(handle)
  }

  const published = lstatSync(lockPath)
  if (
    ownedStat === undefined
    || !published.isFile()
    || published.isSymbolicLink()
    || published.nlink !== 1
    || published.dev !== ownedStat.dev
    || published.ino !== ownedStat.ino
  ) {
    throw buildLockOwnershipChangedError(lockPath)
  }
  return () => releaseDesktopBuildLock(lockPath, ownedRecord, ownedStat)
}

export async function withDesktopBuildLock(root, operation) {
  const release = acquireDesktopBuildLock(root)
  try {
    return await operation()
  } finally {
    release()
  }
}

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

export function createProcessRunner(
  spawn = nodeSpawn,
  {
    terminateWaitMs = PROCESS_TERMINATE_WAIT_MS,
    killWaitMs = PROCESS_KILL_WAIT_MS,
  } = {},
) {
  return {
    run: async ({ command, args, cwd, capture = false, env, fd3Input, timeoutMs }) => {
      if (fd3Input !== undefined
        && (!capture || !Number.isSafeInteger(timeoutMs) || timeoutMs <= 0)) {
        throw new Error(
          'build-desktop: fd3 input requires captured output and a positive timeout',
        )
      }
      const input = fd3Input === undefined ? undefined : Buffer.from(fd3Input)
      let child
      let timeout
      let childSettled = false
      let markChildSettled
      const childSettlement = new Promise(resolvePromise => {
        markChildSettled = resolvePromise
      })
      const waitForChild = async (waitMs) => {
        if (childSettled) return true
        let waitTimeout
        try {
          return await Promise.race([
            childSettlement.then(() => true),
            new Promise(resolvePromise => {
              waitTimeout = setTimeout(() => resolvePromise(false), waitMs)
            }),
          ])
        } finally {
          if (waitTimeout !== undefined) clearTimeout(waitTimeout)
        }
      }
      const terminateAndReap = async () => {
        if (child === undefined || childSettled) return
        try { child.kill('SIGTERM') } catch {}
        if (await waitForChild(terminateWaitMs)) return
        try { child.kill('SIGKILL') } catch {}
        await waitForChild(killWaitMs)
      }
      try {
        child = spawn(command, args, {
          cwd,
          env: { ...process.env, CI: 'true', ...env },
          shell: false,
          stdio: input === undefined
            ? (capture ? ['ignore', 'pipe', 'pipe'] : 'inherit')
            : ['ignore', 'pipe', 'pipe', 'pipe'],
        })
        const stdout = []
        const stderr = []
        if (capture) {
          child.stdout.on('data', chunk => stdout.push(Buffer.from(chunk)))
          child.stderr.on('data', chunk => stderr.push(Buffer.from(chunk)))
        }
        const exited = new Promise((resolvePromise, reject) => {
          child.once('error', error => {
            childSettled = true
            markChildSettled()
            reject(new Error(
              `build-desktop: failed to spawn ${command}: ${error.message}`,
            ))
          })
          child.once('exit', (code, signal) => {
            childSettled = true
            markChildSettled()
            if (code === 0) {
              resolvePromise({
                stdout: Buffer.concat(stdout).toString('utf8'),
                stderr: Buffer.concat(stderr).toString('utf8'),
              })
            } else {
              reject(new Error(
                `build-desktop: ${command} failed with ${
                  code === null ? `signal ${String(signal)}` : `exit ${String(code)}`
                }`,
              ))
            }
          })
        })
        if (input === undefined) return await exited
        const fd3 = child.stdio?.[3]
        if (fd3 === undefined || fd3 === null || typeof fd3.end !== 'function') {
          throw new Error(`build-desktop: failed to open fd3 for ${command}`)
        }
        const wroteFd3 = finished(fd3, { cleanup: true }).catch(error => {
          throw new Error(`build-desktop: failed to write fd3 input for ${command}`, {
            cause: error,
          })
        })
        try {
          fd3.end(input)
        } catch (error) {
          throw new Error(`build-desktop: failed to write fd3 input for ${command}`, {
            cause: error,
          })
        }
        const timedOut = new Promise((_, reject) => {
          timeout = setTimeout(() => reject(new Error(
            `build-desktop: ${command} timed out after ${String(timeoutMs)} ms`,
          )), timeoutMs)
        })
        return await Promise.race([
          Promise.all([exited, wroteFd3]).then(([result]) => result),
          timedOut,
        ])
      } catch (error) {
        await terminateAndReap()
        throw error
      } finally {
        if (timeout !== undefined) clearTimeout(timeout)
        input?.fill(0)
        fd3Input?.fill(0)
      }
    },
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

function encodeVerifierLaunchSecretsFrame({
  launchId,
  bootstrapToken,
  bridgeSecret,
  socketPath,
}) {
  const fields = [
    Buffer.from(launchId.replaceAll('-', ''), 'hex'),
    bootstrapToken,
    bridgeSecret,
    Buffer.from(socketPath, 'utf8'),
  ]
  const payloadBytes = fields.reduce((total, field) => total + 4 + field.length, 0)
  const frame = Buffer.alloc(LAUNCH_SECRETS_HEADER_BYTES + payloadBytes)
  LAUNCH_SECRETS_MAGIC.copy(frame, 0)
  frame.writeUInt16BE(LAUNCH_SECRETS_PROTOCOL_VERSION, 4)
  frame.writeUInt32BE(payloadBytes, 6)
  let offset = LAUNCH_SECRETS_HEADER_BYTES
  for (const field of fields) {
    frame.writeUInt32BE(field.length, offset)
    offset += 4
    field.copy(frame, offset)
    offset += field.length
  }
  return frame
}

export async function createVerifierBridge(
  { launchId, bridgeSecret, socketPath },
  {
    createServer: createBridgeServer = createServer,
    chmod: chmodSocket = chmod,
  } = {},
) {
  const secret = Uint8Array.from(bridgeSecret)
  const nonces = new NonceReplayGuard()
  const sockets = new Set()
  const server = createBridgeServer({ allowHalfOpen: true }, async (socket) => {
    sockets.add(socket)
    socket.once('close', () => sockets.delete(socket))
    socket.setTimeout(HEALTH_SMOKE_TIMEOUT_MS, () => socket.destroy())
    const chunks = []
    let received = 0
    let frame
    let nonce
    let response
    try {
      frame = await new Promise((resolvePromise, reject) => {
        socket.on('data', (chunk) => {
          received += chunk.length
          if (received > MAX_BRIDGE_FRAME_BYTES + 4) {
            reject(new Error('build-desktop: verifier bridge request is oversized'))
            return
          }
          chunks.push(chunk)
        })
        socket.once('end', () => resolvePromise(Buffer.concat(chunks, received)))
        socket.once('error', reject)
      })
      const envelope = decodeBridgeFrame(frame)
      const request = verifyBridgeRequest(envelope, { launchId, secret, nonces })
      if (request.method !== 'readWorkspaceTransaction' || request.payload !== null) {
        throw new Error('build-desktop: verifier bridge received an unexpected method')
      }
      nonce = Buffer.from(envelope.nonce, 'hex')
      response = Buffer.from(encodeBridgeFrame(authenticateBridgeResponse({
        version: 1,
        requestId: request.requestId,
        ok: true,
        result: null,
      }, nonce, secret)))
      await new Promise((resolvePromise, reject) => {
        socket.once('error', reject)
        socket.end(response, resolvePromise)
      })
    } catch {
      socket.destroy()
    } finally {
      frame?.fill(0)
      nonce?.fill(0)
      response?.fill(0)
      for (const chunk of chunks) chunk.fill(0)
    }
  })
  let listening = false
  const closeServer = async () => {
    for (const socket of sockets) socket.destroy()
    if (!listening) return
    await new Promise((resolvePromise, reject) => {
      server.close(error => {
        listening = false
        if (error === undefined) resolvePromise()
        else reject(error)
      })
    })
  }
  try {
    await new Promise((resolvePromise, reject) => {
      const onError = error => reject(error)
      server.once('error', onError)
      server.listen(socketPath, () => {
        listening = true
        server.off('error', onError)
        resolvePromise()
      })
    })
    await chmodSocket(socketPath, 0o600)
  } catch (error) {
    try {
      await closeServer()
    } catch {
      // Preserve the initialization error that made the bridge unusable.
    } finally {
      secret.fill(0)
    }
    throw error
  }
  return async () => {
    try {
      await closeServer()
    } finally {
      secret.fill(0)
    }
  }
}

async function createVerifierLaunch() {
  const directory = await mkdtemp(join(tmpdir(), 'olh-'))
  let frame
  let closeBridge
  try {
    await chmod(directory, 0o700)
    const launchId = randomUUID()
    const bootstrapToken = randomBytes(32)
    const bridgeSecret = randomBytes(32)
    const socketPath = join(directory, 'bridge.sock')
    try {
      frame = encodeVerifierLaunchSecretsFrame({
        launchId,
        bootstrapToken,
        bridgeSecret,
        socketPath,
      })
      closeBridge = await createVerifierBridge({
        launchId,
        bridgeSecret,
        socketPath,
      })
      return {
        directory,
        launchId,
        frame,
        closeBridge,
      }
    } finally {
      bootstrapToken.fill(0)
      bridgeSecret.fill(0)
    }
  } catch (error) {
    frame?.fill(0)
    try {
      await closeBridge?.()
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
    throw error
  }
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
  const healthLaunch = await createVerifierLaunch()
  let health
  try {
    health = await runner.run({
      command: sidecar,
      args: ['--health-smoke'],
      capture: true,
      fd3Input: healthLaunch.frame,
      timeoutMs: HEALTH_SMOKE_TIMEOUT_MS,
    })
  } finally {
    healthLaunch.frame.fill(0)
    try {
      await healthLaunch.closeBridge()
    } finally {
      await rm(healthLaunch.directory, { recursive: true, force: true })
    }
  }
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
    'launchId',
    'profile',
    'host',
    'port',
    'origin',
    'coreManifestSha256',
    'healthSmoke',
    'candidateHealth',
  ]
  const healthSmokeKeys = ['method', 'path', 'status']
  const candidateHealthKeys = ['webAsset', 'bootstrapExchange']
  const validPort = Number.isSafeInteger(readiness?.port)
    && readiness.port >= 1
    && readiness.port <= 65535
  if (!hasExactObjectKeys(readiness, readinessKeys)
    || !hasExactObjectKeys(readiness.healthSmoke, healthSmokeKeys)
    || !hasExactObjectKeys(readiness.candidateHealth, candidateHealthKeys)
    || readiness.type !== 'openloop.runtime.ready'
    || readiness.version !== 1
    || readiness.launchId !== healthLaunch.launchId
    || readiness.profile !== 'openloop'
    || readiness.host !== '127.0.0.1'
    || !validPort
    || readiness.origin !== `http://127.0.0.1:${String(readiness.port)}`
    || readiness.coreManifestSha256 !== coreSha256
    || readiness.healthSmoke.method !== 'GET'
    || readiness.healthSmoke.path !== '/'
    || readiness.healthSmoke.status !== 200
    || readiness.candidateHealth.webAsset !== true
    || readiness.candidateHealth.bootstrapExchange !== true) {
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
    this.dependencies = {
      withBuildLock: withDesktopBuildLock,
      ...dependencies,
    }
    this.root = resolve(dependencies.root)
  }

  async build() {
    return await this.dependencies.withBuildLock(
      this.root,
      async () => await this.buildLocked(),
    )
  }

  async buildLocked() {
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
