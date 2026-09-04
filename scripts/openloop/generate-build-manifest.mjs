#!/usr/bin/env node

import { createHash, randomUUID } from 'node:crypto'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  parseOpenloopBuildManifest,
} from '../../packages/openloop/build-contract/src/index.ts'

const repositoryRoot = fileURLToPath(new URL('../../', import.meta.url))
const baselinePath = fileURLToPath(new URL('./upstream-baseline.json', import.meta.url))
const brandMarkPath = fileURLToPath(new URL('../../assets/brand/openloop-mark.svg', import.meta.url))
const integerOptions = new Map([
  ['--runtime-version', 'runtimeVersion'],
  ['--bridge-protocol-version', 'bridgeProtocolVersion'],
  ['--openloop-data-version', 'openloopDataVersion'],
  ['--dsh-data-version', 'dshDataVersion'],
])
const stringOptions = new Map([
  ['--channel', 'channel'],
  ['--out', 'out'],
  ['--app-version', 'appVersion'],
  ['--ui-sdk-version', 'uiSdkVersion'],
  ['--plugin-package-spec-version', 'pluginPackageSpecVersion'],
])
const baselineSourceTypes = new Set(['release', 'tag', 'approved_commit'])
const isoTimestampPattern = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?Z$/u

function optionValue(args, index, option) {
  const value = args[index + 1]
  if (value === undefined || value.startsWith('--')) {
    throw new Error(`${option} requires a value`)
  }
  return value
}

function integerValue(value, option) {
  if (!/^(?:0|[1-9]\d*)$/u.test(value)) {
    throw new Error(`${option} requires a nonnegative integer`)
  }
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`${option} requires a safe integer`)
  }
  return parsed
}

function isWithin(parent, candidate) {
  const child = relative(parent, candidate)
  return child === '' || (child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolute(child))
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

/** Parse the build-manifest CLI without accepting precomputed artifact hashes. */
export function parseBuildManifestArguments(args) {
  const normalized = args[0] === '--' ? args.slice(1) : args
  const options = {}
  for (let index = 0; index < normalized.length; index += 1) {
    const option = normalized[index]
    const integerField = integerOptions.get(option)
    const stringField = stringOptions.get(option)
    const field = integerField ?? stringField
    if (field === undefined) throw new Error(`unknown option ${option}`)
    if (options[field] !== undefined) throw new Error(`${option} may be specified only once`)
    const value = optionValue(normalized, index, option)
    if (integerField !== undefined) {
      options[integerField] = integerValue(value, option)
    } else {
      options[stringField] = value
    }
    index += 1
  }
  if (options.channel === undefined) throw new Error('--channel is required')
  if (options.out === undefined) throw new Error('--out is required')
  return options
}

function baselineTimestamp(value, field, now) {
  if (typeof value !== 'string') {
    throw new Error(`upstream baseline ${field} must be a valid ISO timestamp`)
  }
  const match = isoTimestampPattern.exec(value)
  if (match === null) {
    throw new Error(`upstream baseline ${field} must be a valid ISO timestamp`)
  }
  const wholeSecond = `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}Z`
  const parsed = Date.parse(wholeSecond)
  if (!Number.isFinite(parsed)) {
    throw new Error(`upstream baseline ${field} must be a valid ISO timestamp`)
  }
  const date = new Date(parsed)
  const expected = match.slice(1, 7).map(Number)
  const actual = [
    date.getUTCFullYear(),
    date.getUTCMonth() + 1,
    date.getUTCDate(),
    date.getUTCHours(),
    date.getUTCMinutes(),
    date.getUTCSeconds(),
  ]
  if (actual.some((component, index) => component !== expected[index])) {
    throw new Error(`upstream baseline ${field} must be a valid ISO timestamp`)
  }
  const fraction = (match[7] ?? '').replace(/0+$/u, '')
  const milliseconds = parsed + Number(fraction.slice(0, 3).padEnd(3, '0'))
  if (milliseconds > now
    || (milliseconds === now && /[1-9]/u.test(fraction.slice(3)))) {
    throw new Error(`upstream baseline ${field} must not be in the future`)
  }
  return { parsed, fraction }
}

function compareTimestamps(left, right) {
  if (left.parsed !== right.parsed) return left.parsed < right.parsed ? -1 : 1
  const width = Math.max(left.fraction.length, right.fraction.length)
  const leftFraction = left.fraction.padEnd(width, '0')
  const rightFraction = right.fraction.padEnd(width, '0')
  if (leftFraction === rightFraction) return 0
  return leftFraction < rightFraction ? -1 : 1
}

function approvedBaseline(path, now, trustedRoot) {
  assertNoSymlinkComponents(path, trustedRoot, 'upstream baseline')
  const value = JSON.parse(readFileSync(path, 'utf8'))
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('upstream baseline must be an object')
  }
  if (!baselineSourceTypes.has(value.sourceType)) {
    throw new Error('upstream baseline sourceType must be release, tag, or approved_commit')
  }
  if (typeof value.sourceRef !== 'string'
    || value.sourceRef.length === 0
    || value.sourceRef.trim() !== value.sourceRef) {
    throw new Error('upstream baseline sourceRef must be a non-empty trimmed string')
  }
  if (typeof value.commit !== 'string' || !/^[0-9a-f]{40}$/u.test(value.commit)) {
    throw new Error('upstream baseline commit must be 40 lowercase hexadecimal characters')
  }
  const approvedAt = baselineTimestamp(value.approvedAt, 'approvedAt', now)
  const capturedAt = baselineTimestamp(value.capturedAt, 'capturedAt', now)
  if (compareTimestamps(capturedAt, approvedAt) < 0) {
    throw new Error('upstream baseline capturedAt must not precede approvedAt')
  }
  return { dshTag: value.sourceRef, dshCommit: value.commit }
}

function canonicalJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`
}

function openloopBrand() {
  return {
    productName: 'Openloop',
    documentSuffix: 'Openloop',
    markAsset: `data:image/svg+xml;base64,${readFileSync(brandMarkPath).toString('base64')}`,
    heroTitle: 'Openloop',
    previewLabel: '预览版',
    attribution: 'Built on DeepSeek Harness',
  }
}

function sameFileIdentity(left, right) {
  if (!existsSync(left) || !existsSync(right)) return false
  const leftStat = lstatSync(left)
  const rightStat = lstatSync(right)
  return leftStat.dev === rightStat.dev && leftStat.ino === rightStat.ino
}

function atomicWrite(path, content, protectedPaths, trustedRoot) {
  const absolute = resolve(path)
  assertNoSymlinkComponents(dirname(absolute), trustedRoot, 'output', true)
  mkdirSync(dirname(absolute), { recursive: true })
  assertNoSymlinkComponents(dirname(absolute), trustedRoot, 'output')
  const parent = realpathSync(dirname(absolute))
  if (!isWithin(realpathSync(trustedRoot), parent)) {
    throw new Error(`output parent must resolve inside its trusted root: ${path}`)
  }
  const target = join(parent, basename(absolute))
  if (existsSync(target)) {
    const stat = lstatSync(target)
    if (stat.isSymbolicLink()) throw new Error(`output must not be a symlink: ${path}`)
    if (!stat.isFile()) throw new Error(`output must be a file path: ${path}`)
  }
  if (protectedPaths.some(protectedPath => sameFileIdentity(target, protectedPath))) {
    throw new Error(`output must not overwrite the approved baseline: ${path}`)
  }
  if (existsSync(target) && readFileSync(target).equals(Buffer.from(content))) return
  const temporary = join(parent, `.${basename(target)}.${process.pid}.${randomUUID()}.tmp`)
  try {
    writeFileSync(temporary, content, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
    renameSync(temporary, target)
  } finally {
    rmSync(temporary, { force: true })
  }
}

/** Generate, validate, atomically write, and hash one canonical core manifest. */
export function generateBuildManifest(options, dependencies = {}) {
  const approvedBaselinePath = dependencies.baselinePath ?? baselinePath
  const trustedRoot = dependencies.trustedRoot ?? repositoryRoot
  const identity = approvedBaseline(
    approvedBaselinePath,
    dependencies.now ?? Date.now(),
    trustedRoot,
  )
  const manifest = parseOpenloopBuildManifest({
    appVersion: options.appVersion ?? '0.1.0',
    channel: options.channel,
    ...identity,
    runtimeVersion: options.runtimeVersion ?? 1,
    bridgeProtocolVersion: options.bridgeProtocolVersion ?? 1,
    uiSdkVersion: options.uiSdkVersion ?? '0.1.0',
    pluginPackageSpecVersion: options.pluginPackageSpecVersion ?? '0.1.0',
    openloopDataVersion: options.openloopDataVersion ?? 0,
    dshDataVersion: options.dshDataVersion ?? 0,
    brand: openloopBrand(),
  })
  const bytes = canonicalJson(manifest)
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  atomicWrite(options.out, bytes, [realpathSync(approvedBaselinePath)], trustedRoot)
  return { manifest, bytes, sha256 }
}

const isMain = process.argv[1] !== undefined
  && resolve(process.argv[1]) === fileURLToPath(import.meta.url)

if (isMain) {
  try {
    const result = generateBuildManifest(parseBuildManifestArguments(process.argv.slice(2)))
    process.stdout.write(`${result.sha256}\n`)
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}
