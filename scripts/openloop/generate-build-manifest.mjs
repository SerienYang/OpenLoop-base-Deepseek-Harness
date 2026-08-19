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
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  parseOpenloopBuildManifest,
} from '../../packages/openloop/build-contract/src/index.ts'

const baselinePath = fileURLToPath(new URL('./upstream-baseline.json', import.meta.url))
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

/** Parse the build-manifest CLI without accepting precomputed artifact hashes. */
export function parseBuildManifestArguments(args) {
  const normalized = args[0] === '--' ? args.slice(1) : args
  const options = {}
  for (let index = 0; index < normalized.length; index += 1) {
    const option = normalized[index]
    const value = optionValue(normalized, index, option)
    const integerField = integerOptions.get(option)
    const stringField = stringOptions.get(option)
    if (integerField !== undefined) {
      options[integerField] = integerValue(value, option)
    } else if (stringField !== undefined) {
      options[stringField] = value
    } else {
      throw new Error(`unknown option ${option}`)
    }
    index += 1
  }
  if (options.channel === undefined) throw new Error('--channel is required')
  if (options.out === undefined) throw new Error('--out is required')
  return options
}

function approvedBaseline(path) {
  const value = JSON.parse(readFileSync(path, 'utf8'))
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('upstream baseline must be an object')
  }
  if (value.sourceType !== 'release') {
    throw new Error('upstream baseline sourceType must be release')
  }
  if (typeof value.sourceRef !== 'string' || value.sourceRef.length === 0) {
    throw new Error('upstream baseline sourceRef must be a non-empty string')
  }
  if (typeof value.commit !== 'string' || !/^[0-9a-f]{40}$/u.test(value.commit)) {
    throw new Error('upstream baseline commit must be 40 lowercase hexadecimal characters')
  }
  return { dshTag: value.sourceRef, dshCommit: value.commit }
}

function canonicalJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`
}

function atomicWrite(path, content, protectedPaths) {
  const absolute = resolve(path)
  mkdirSync(dirname(absolute), { recursive: true })
  const parent = realpathSync(dirname(absolute))
  const target = join(parent, basename(absolute))
  if (protectedPaths.includes(target)) {
    throw new Error(`output must not overwrite the approved baseline: ${path}`)
  }
  if (existsSync(target)) {
    const stat = lstatSync(target)
    if (stat.isSymbolicLink()) throw new Error(`output must not be a symlink: ${path}`)
    if (!stat.isFile()) throw new Error(`output must be a file path: ${path}`)
  }
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
  const identity = approvedBaseline(approvedBaselinePath)
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
  })
  const bytes = canonicalJson(manifest)
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  atomicWrite(options.out, bytes, [realpathSync(approvedBaselinePath)])
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
