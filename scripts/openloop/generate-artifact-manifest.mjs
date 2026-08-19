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

function optionValue(args, index, option) {
  const value = args[index + 1]
  if (value === undefined || value.startsWith('--')) {
    throw new Error(`${option} requires a value`)
  }
  return value
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

function existingInput(path, label, allowDirectory) {
  const absolute = resolve(path)
  if (!existsSync(absolute)) throw new Error(`${label} input is missing: ${path}`)
  const stat = lstatSync(absolute)
  if (stat.isSymbolicLink()) throw new Error(`${label} input must not be a symlink: ${path}`)
  if (!stat.isFile() && !(allowDirectory && stat.isDirectory())) {
    const expected = allowDirectory ? 'a regular file or directory' : 'a regular file'
    throw new Error(`${label} input must be ${expected}: ${path}`)
  }
  return realpathSync(absolute)
}

function directoryFiles(root, directory = root) {
  const files = []
  const entries = readdirSync(directory, { withFileTypes: true })
    .sort((left, right) => Buffer.compare(Buffer.from(left.name), Buffer.from(right.name)))
  for (const entry of entries) {
    const path = join(directory, entry.name)
    const stat = lstatSync(path)
    if (stat.isSymbolicLink()) throw new Error(`artifact directory contains symlink: ${path}`)
    if (stat.isDirectory()) {
      files.push(...directoryFiles(root, path))
    } else if (stat.isFile()) {
      files.push({
        path,
        relative: relative(root, path).split(sep).join('/'),
      })
    } else {
      throw new Error(`artifact directory contains a non-file entry: ${path}`)
    }
  }
  return files
}

function lengthBytes(value) {
  const bytes = Buffer.allocUnsafe(8)
  bytes.writeBigUInt64BE(BigInt(value))
  return bytes
}

/** Hash one regular file or a deterministic relative-path directory stream. */
export function hashArtifact(path) {
  const real = existingInput(path, 'artifact', true)
  const stat = lstatSync(real)
  if (stat.isFile()) {
    return createHash('sha256').update(readFileSync(real)).digest('hex')
  }

  const hash = createHash('sha256')
  for (const file of directoryFiles(real)) {
    const pathBytes = Buffer.from(file.relative)
    const content = readFileSync(file.path)
    hash.update(lengthBytes(pathBytes.length))
    hash.update(pathBytes)
    hash.update(lengthBytes(content.length))
    hash.update(content)
  }
  return hash.digest('hex')
}

function isWithin(parent, candidate) {
  const child = relative(parent, candidate)
  return child === '' || (child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolute(child))
}

function outputTarget(path, inputs) {
  const absolute = resolve(path)
  for (const input of inputs) {
    const stat = lstatSync(input)
    if ((stat.isDirectory() && isWithin(input, absolute)) || input === absolute) {
      throw new Error(`output must not overlap an artifact input: ${path}`)
    }
  }
  mkdirSync(dirname(absolute), { recursive: true })
  const target = join(realpathSync(dirname(absolute)), basename(absolute))
  for (const input of inputs) {
    const stat = lstatSync(input)
    if ((stat.isDirectory() && isWithin(input, target)) || input === target) {
      throw new Error(`output must not overlap an artifact input: ${path}`)
    }
  }
  if (existsSync(target)) {
    const stat = lstatSync(target)
    if (stat.isSymbolicLink()) throw new Error(`output must not be a symlink: ${path}`)
    if (!stat.isFile()) throw new Error(`output must be a file path: ${path}`)
  }
  return target
}

function atomicWrite(target, content) {
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
export function generateArtifactManifest(options) {
  const core = existingInput(options.core, 'core', false)
  const sidecar = existingInput(options.sidecar, 'sidecar', false)
  const web = existingInput(options.web, 'web', true)
  const bundleGraph = existingInput(options.bundleGraph, 'bundle graph', false)
  const paths = { sidecar, web, bundleGraph }
  for (const name of artifactOrder.slice(3)) {
    if (options[name] !== undefined) {
      paths[name] = existingInput(options[name], name, true)
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
  for (const name of artifactOrder) {
    const path = paths[name]
    if (path !== undefined) artifacts[name] = { sha256: hashArtifact(path) }
  }
  const manifest = parseOpenloopArtifactManifest({
    coreManifestSha256: createHash('sha256').update(coreBytes).digest('hex'),
    artifacts,
  })
  const bytes = canonicalJson(manifest)
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  const target = outputTarget(options.out, [core, ...Object.values(paths)])
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
