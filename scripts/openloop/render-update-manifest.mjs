#!/usr/bin/env node

import { randomUUID } from 'node:crypto'
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
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const repositoryRoot = fileURLToPath(new URL('../../', import.meta.url))
const options = new Map([
  ['--version', 'version'],
  ['--artifact-url', 'artifactUrl'],
  ['--signature', 'signature'],
  ['--notes', 'notes'],
  ['--pub-date', 'pubDate'],
  ['--out', 'out'],
])
const semverPattern = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-(?:(?:0|[1-9]\d*)|(?:\d*[A-Za-z-][0-9A-Za-z-]*))(?:\.(?:(?:0|[1-9]\d*)|(?:\d*[A-Za-z-][0-9A-Za-z-]*)))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u
const rfc3339Pattern = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u

function optionValue(args, index, option) {
  const value = args[index + 1]
  if (value === undefined || value.startsWith('--')) {
    throw new Error(`${option} requires a value`)
  }
  return value
}

/** Parse the complete manifest-rendering CLI without accepting signing keys. */
export function parseUpdateManifestArguments(args) {
  const normalized = args[0] === '--' ? args.slice(1) : args
  if (normalized.includes('--test')) {
    throw new Error(
      '--test is not supported; run the focused Vitest suite or provide --version, --artifact-url, --signature, --notes, --pub-date, and --out',
    )
  }
  const parsed = {}
  for (let index = 0; index < normalized.length; index += 1) {
    const option = normalized[index]
    const field = options.get(option)
    if (field === undefined) throw new Error(`unknown option ${option}`)
    if (parsed[field] !== undefined) throw new Error(`${option} may be specified only once`)
    parsed[field] = optionValue(normalized, index, option)
    index += 1
  }
  for (const [option, field] of options) {
    if (parsed[field] === undefined) throw new Error(`${option} is required`)
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
  const rootMetadata = lstatSync(root)
  if (rootMetadata.isSymbolicLink() || !rootMetadata.isDirectory()) {
    throw new Error(`${label} trusted root must be a real directory: ${trustedRoot}`)
  }
  let current = root
  const child = relative(root, absolute)
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

function regularSignature(path, trustedRoot) {
  const absolute = resolve(path)
  assertNoSymlinkComponents(absolute, trustedRoot, 'signature input')
  if (extname(absolute) !== '.sig') {
    throw new Error('signature input must use the .sig extension')
  }
  const metadata = lstatSync(absolute)
  if (!metadata.isFile()) throw new Error('signature input must be a regular file')
  const real = realpathSync(absolute)
  if (!isWithin(realpathSync(trustedRoot), real)) {
    throw new Error('signature input must resolve inside its trusted root')
  }
  return real
}

function validBase64(value) {
  if (value === '' || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/u.test(value)) {
    return false
  }
  return Buffer.from(value, 'base64').toString('base64') === value
}

function signatureContents(path) {
  const signature = readFileSync(path, 'utf8').trim()
  if (!validBase64(signature)) {
    throw new Error('signature file must contain one non-empty canonical base64 signature')
  }
  const decoded = Buffer.from(signature, 'base64').toString('utf8')
  const lines = decoded.split(/\r?\n/u)
  if (lines.length !== 4
    || !lines[0].startsWith('untrusted comment: ')
    || !lines[2].startsWith('trusted comment: ')
    || !validBase64(lines[1])
    || !validBase64(lines[3])
    || Buffer.from(lines[1], 'base64').length !== 74
    || Buffer.from(lines[3], 'base64').length !== 64) {
    throw new Error('signature file does not contain a valid Tauri Minisign signature')
  }
  return signature
}

function validRfc3339(value) {
  const match = rfc3339Pattern.exec(value)
  if (match === null || !Number.isFinite(Date.parse(value))) return false
  const [, year, month, day, hour, minute, second] = match
  const yearNumber = Number(year)
  const monthNumber = Number(month)
  const dayNumber = Number(day)
  const daysInMonth = new Date(Date.UTC(yearNumber, monthNumber, 0)).getUTCDate()
  return monthNumber >= 1
    && monthNumber <= 12
    && dayNumber >= 1
    && dayNumber <= daysInMonth
    && Number(hour) <= 23
    && Number(minute) <= 59
    && Number(second) <= 59
}

function validateValues(renderOptions) {
  if (!semverPattern.test(renderOptions.version)) {
    throw new Error('version must be valid semver')
  }
  let artifactUrl
  try {
    artifactUrl = new URL(renderOptions.artifactUrl)
  } catch {
    throw new Error('artifact URL must be a valid HTTPS URL')
  }
  if (artifactUrl.protocol !== 'https:'
    || artifactUrl.username !== ''
    || artifactUrl.password !== ''
    || artifactUrl.hash !== ''
    || artifactUrl.hostname === '') {
    throw new Error('artifact URL must be an HTTPS URL without credentials or fragments')
  }
  if (renderOptions.notes.trim() === '') {
    throw new Error('release notes must be non-empty')
  }
  if (!validRfc3339(renderOptions.pubDate)) {
    throw new Error('pub_date must be a valid RFC3339 timestamp')
  }
}

function sameFile(left, right) {
  if (!existsSync(left) || !existsSync(right)) return false
  const leftMetadata = lstatSync(left)
  const rightMetadata = lstatSync(right)
  return leftMetadata.dev === rightMetadata.dev && leftMetadata.ino === rightMetadata.ino
}

function outputTarget(path, signature, trustedRoot) {
  const absolute = resolve(path)
  assertNoSymlinkComponents(dirname(absolute), trustedRoot, 'output', true)
  mkdirSync(dirname(absolute), { recursive: true })
  assertNoSymlinkComponents(dirname(absolute), trustedRoot, 'output')
  const parent = realpathSync(dirname(absolute))
  if (!isWithin(realpathSync(trustedRoot), parent)) {
    throw new Error('output parent must stay inside its trusted root')
  }
  const target = join(parent, basename(absolute))
  if (sameFile(target, signature)) {
    throw new Error('output must not overlap the signature input')
  }
  if (existsSync(target)) {
    const metadata = lstatSync(target)
    if (metadata.isSymbolicLink()) throw new Error('output must not be a symlink')
    if (!metadata.isFile()) throw new Error('output must be a regular file path')
  }
  return target
}

function atomicWrite(target, bytes) {
  if (existsSync(target) && readFileSync(target, 'utf8') === bytes) return
  const temporary = join(
    dirname(target),
    `.${basename(target)}.${process.pid}.${randomUUID()}.tmp`,
  )
  try {
    writeFileSync(temporary, bytes, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
    renameSync(temporary, target)
  } finally {
    rmSync(temporary, { force: true })
  }
}

/** Render one canonical Tauri v2 static update manifest and never sign data. */
export function renderUpdateManifest(renderOptions, dependencies = {}) {
  validateValues(renderOptions)
  const trustedRoot = dependencies.trustedRoot ?? repositoryRoot
  const signaturePath = regularSignature(renderOptions.signature, trustedRoot)
  const signature = signatureContents(signaturePath)
  const manifest = {
    version: renderOptions.version,
    notes: renderOptions.notes,
    pub_date: renderOptions.pubDate,
    platforms: {
      'darwin-aarch64': {
        url: renderOptions.artifactUrl,
        signature,
      },
    },
  }
  const bytes = `${JSON.stringify(manifest, null, 2)}\n`
  atomicWrite(outputTarget(renderOptions.out, signaturePath, trustedRoot), bytes)
  return { manifest, bytes }
}

const isMain = process.argv[1] !== undefined
  && resolve(process.argv[1]) === fileURLToPath(import.meta.url)

if (isMain) {
  try {
    renderUpdateManifest(parseUpdateManifestArguments(process.argv.slice(2)))
  } catch (error) {
    process.stderr.write(
      `render-update-manifest: ${error instanceof Error ? error.message : String(error)}\n`,
    )
    process.exitCode = 1
  }
}
