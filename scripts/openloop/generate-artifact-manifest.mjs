#!/usr/bin/env node

import { createHash, randomUUID } from 'node:crypto'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  parseOpenloopArtifactManifest,
  parseOpenloopBuildManifest,
} from '../../packages/openloop/build-contract/src/index.ts'

const repositoryRoot = fileURLToPath(new URL('../../', import.meta.url))
const requiredOptions = new Map([
  ['--core', 'core'],
  ['--sidecar', 'sidecar'],
  ['--web', 'web'],
  ['--bundle-graph', 'bundleGraph'],
  ['--out', 'out'],
])
const optionalOptions = new Map([
  ['--app', 'app'],
  ['--dmg', 'dmg'],
  ['--updater', 'updater'],
  ['--ffmpeg', 'ffmpeg'],
  ['--ffprobe', 'ffprobe'],
])
const artifactOrder = [
  'sidecar',
  'web',
  'bundleGraph',
  'app',
  'dmg',
  'updater',
  'ffmpeg',
  'ffprobe',
]
const artifactHashDomain = Buffer.from('openloop-artifact-sha256\0v1\0')

function optionValue(args, index, option) {
  const value = args[index + 1]
  if (value === undefined || value.startsWith('--')) {
    throw new Error(`${option} requires a value`)
  }
  return value
}

function assertNoSymlinkComponents(path, trustedRoot, label, allowMissing = false) {
  const absolute = resolve(path)
  const root = resolve(trustedRoot)
  if (!isWithin(root, absolute)) {
    throw new Error(`${label} must stay inside its trusted root: ${path}`)
  }
  if (lstatSync(root).isSymbolicLink()) {
    throw new Error(`${label} trusted root must not be a symlink: ${trustedRoot}`)
  }
  const child = relative(root, absolute)
  let current = root
  for (const component of child === '' ? [] : child.split(sep)) {
    current = join(current, component)
    if (!existsSync(current)) {
      if (allowMissing) return
      continue
    }
    if (lstatSync(current).isSymbolicLink()) {
      throw new Error(`${label} path contains symlink: ${current}`)
    }
  }
}

/** Parse required and optional artifact paths without accepting caller hashes. */
export function parseArtifactManifestArguments(args) {
  const normalized = args[0] === '--' ? args.slice(1) : args
  const options = {}
  for (let index = 0; index < normalized.length; index += 1) {
    const option = normalized[index]
    const field = requiredOptions.get(option) ?? optionalOptions.get(option)
    if (field === undefined) throw new Error(`unknown option ${option}`)
    if (options[field] !== undefined) throw new Error(`${option} may be specified only once`)
    options[field] = optionValue(normalized, index, option)
    index += 1
  }
  for (const [option, field] of requiredOptions) {
    if (options[field] === undefined) throw new Error(`${option} is required`)
  }
  return options
}

function existingInput(path, label, allowDirectory, trustedRoot) {
  const absolute = resolve(path)
  assertNoSymlinkComponents(absolute, trustedRoot, `${label} input`)
  if (!existsSync(absolute)) throw new Error(`${label} input is missing: ${path}`)
  const stat = lstatSync(absolute)
  if (!stat.isFile() && !(allowDirectory && stat.isDirectory())) {
    const expected = allowDirectory ? 'a regular file or directory' : 'a regular file'
    throw new Error(`${label} input must be ${expected}: ${path}`)
  }
  const real = realpathSync(absolute)
  if (!isWithin(realpathSync(trustedRoot), real)) {
    throw new Error(`${label} input must resolve inside its trusted root: ${path}`)
  }
  return real
}

function sortedDirectoryEntries(directory) {
  return readdirSync(directory, { withFileTypes: true })
    .sort((left, right) => Buffer.compare(Buffer.from(left.name), Buffer.from(right.name)))
}

function lengthBytes(value) {
  const bytes = Buffer.allocUnsafe(8)
  bytes.writeBigUInt64BE(BigInt(value))
  return bytes
}

function hashArtifactNode(hash, root, path) {
  const stat = lstatSync(path)
  if (stat.isSymbolicLink()) throw new Error(`artifact directory contains symlink: ${path}`)
  const relativePath = path === root ? '' : relative(root, path).split(sep).join('/')
  const pathBytes = Buffer.from(relativePath)
  if (stat.isFile()) {
    const content = readFileSync(path)
    hash.update('F')
    hash.update(lengthBytes(pathBytes.length))
    hash.update(pathBytes)
    hash.update(lengthBytes(content.length))
    hash.update(content)
    return
  }
  if (!stat.isDirectory()) {
    throw new Error(`artifact directory contains a non-file entry: ${path}`)
  }
  const entries = sortedDirectoryEntries(path)
  hash.update('D')
  hash.update(lengthBytes(pathBytes.length))
  hash.update(pathBytes)
  hash.update(lengthBytes(entries.length))
  for (const entry of entries) hashArtifactNode(hash, root, join(path, entry.name))
}

/** Hash one regular file or a deterministic relative-path directory stream. */
export function hashArtifact(path, dependencies = {}) {
  const trustedRoot = dependencies.trustedRoot ?? repositoryRoot
  const real = existingInput(path, 'artifact', true, trustedRoot)
  const hash = createHash('sha256').update(artifactHashDomain)
  hashArtifactNode(hash, real, real)
  return hash.digest('hex')
}

function isWithin(parent, candidate) {
  const child = relative(parent, candidate)
  return child === '' || (child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolute(child))
}

function sameFileIdentity(left, right) {
  if (!existsSync(left) || !existsSync(right)) return false
  const leftStat = lstatSync(left)
  const rightStat = lstatSync(right)
  return leftStat.dev === rightStat.dev && leftStat.ino === rightStat.ino
}

function assertNoInputOverlap(target, inputs, path) {
  const resolvedTarget = existsSync(target) ? realpathSync(target) : target
  for (const input of inputs) {
    const stat = lstatSync(input)
    if ((stat.isDirectory() && isWithin(input, resolvedTarget))
      || sameFileIdentity(input, target)) {
      throw new Error(`output must not overlap an artifact input: ${path}`)
    }
  }
}

function targetBeforeCreate(path) {
  if (existsSync(path)) return realpathSync(path)
  let ancestor = dirname(path)
  const suffix = [basename(path)]
  while (!existsSync(ancestor)) {
    suffix.unshift(basename(ancestor))
    const parent = dirname(ancestor)
    if (parent === ancestor) break
    ancestor = parent
  }
  return resolve(realpathSync(ancestor), ...suffix)
}

function outputTarget(path, inputs, trustedRoot) {
  const absolute = resolve(path)
  assertNoSymlinkComponents(dirname(absolute), trustedRoot, 'output', true)
  assertNoInputOverlap(targetBeforeCreate(absolute), inputs, path)
  mkdirSync(dirname(absolute), { recursive: true })
  assertNoSymlinkComponents(dirname(absolute), trustedRoot, 'output')
  const parent = realpathSync(dirname(absolute))
  if (!isWithin(realpathSync(trustedRoot), parent)) {
    throw new Error(`output parent must resolve inside its trusted root: ${path}`)
  }
  const target = join(parent, basename(absolute))
  assertNoInputOverlap(target, inputs, path)
  if (existsSync(target)) {
    const stat = lstatSync(target)
    if (stat.isSymbolicLink()) throw new Error(`output must not be a symlink: ${path}`)
    if (!stat.isFile()) throw new Error(`output must be a file path: ${path}`)
  }
  return target
}

function atomicWrite(target, content) {
  if (existsSync(target) && readFileSync(target).equals(Buffer.from(content))) return
  const temporary = join(dirname(target), `.${basename(target)}.${process.pid}.${randomUUID()}.tmp`)
  try {
    writeFileSync(temporary, content, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
    renameSync(temporary, target)
  } finally {
    rmSync(temporary, { force: true })
  }
}

function canonicalJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`
}

/** Validate inputs, hash artifacts, and atomically write a canonical manifest. */
export function generateArtifactManifest(options, dependencies = {}) {
  const trustedRoot = dependencies.trustedRoot ?? repositoryRoot
  const core = existingInput(options.core, 'core', false, trustedRoot)
  const sidecar = existingInput(options.sidecar, 'sidecar', false, trustedRoot)
  const web = existingInput(options.web, 'web', true, trustedRoot)
  const bundleGraph = existingInput(options.bundleGraph, 'bundle graph', false, trustedRoot)
  const paths = { sidecar, web, bundleGraph }
  for (const name of artifactOrder.slice(3)) {
    if (options[name] !== undefined) {
      paths[name] = existingInput(options[name], name, true, trustedRoot)
    }
  }

  const coreBytes = readFileSync(core)
  let coreValue
  try {
    coreValue = JSON.parse(coreBytes.toString('utf8'))
  } catch (error) {
    throw new Error(`core manifest is not valid JSON: ${error instanceof Error ? error.message : String(error)}`)
  }
  parseOpenloopBuildManifest(coreValue)

  const artifacts = {}
  const realTrustedRoot = realpathSync(trustedRoot)
  for (const name of artifactOrder) {
    const path = paths[name]
    if (path !== undefined) artifacts[name] = hashArtifact(path, { trustedRoot: realTrustedRoot })
  }
  const manifest = parseOpenloopArtifactManifest({
    coreManifestSha256: createHash('sha256').update(coreBytes).digest('hex'),
    artifacts,
  })
  const bytes = canonicalJson(manifest)
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  const target = outputTarget(options.out, [core, ...Object.values(paths)], trustedRoot)
  atomicWrite(target, bytes)
  return { manifest, bytes, sha256 }
}

const isMain = process.argv[1] !== undefined
  && resolve(process.argv[1]) === fileURLToPath(import.meta.url)

if (isMain) {
  try {
    const result = generateArtifactManifest(parseArtifactManifestArguments(process.argv.slice(2)))
    process.stdout.write(`${result.sha256}\n`)
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}
