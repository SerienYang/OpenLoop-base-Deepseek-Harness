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
import { verifyTauriUpdaterSignature } from './verify-tauri-updater-signature.mjs'

const repositoryRoot = fileURLToPath(new URL('../../', import.meta.url))
const options = new Map([
  ['--version', 'version'],
  ['--artifact-url', 'artifactUrl'],
  ['--artifact', 'artifact'],
  ['--signature', 'signature'],
  ['--public-key', 'publicKey'],
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
      '--test is not supported; run the focused Vitest suite or provide --version, --artifact-url, --artifact, --signature, --public-key, --notes, --pub-date, and --out',
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

function regularArtifact(path, trustedRoot) {
  const absolute = resolve(path)
  assertNoSymlinkComponents(absolute, trustedRoot, 'artifact input')
  const metadata = lstatSync(absolute)
  if (!metadata.isFile()) throw new Error('artifact input must be a regular file')
  const real = realpathSync(absolute)
  if (!isWithin(realpathSync(trustedRoot), real)) {
    throw new Error('artifact input must resolve inside its trusted root')
  }
  return real
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

function validateArtifactUrl(value, version) {
  let artifactUrl
  try {
    artifactUrl = new URL(value)
  } catch {
    throw new Error('artifact URL must be a valid GitHub release URL')
  }
  if (artifactUrl.protocol !== 'https:') {
    throw new Error('artifact URL must use HTTPS')
  }
  if (artifactUrl.username !== '' || artifactUrl.password !== '' || artifactUrl.hash !== '') {
    throw new Error('artifact URL must not contain credentials or a fragment')
  }
  const expectedPrefix = 'https://github.com/SerienYang/OpenLoop-base-Deepseek-Harness/releases/download/'
  if (value !== artifactUrl.href
    || !value.startsWith(expectedPrefix)
    || artifactUrl.hostname !== 'github.com'
    || artifactUrl.host !== 'github.com'
    || artifactUrl.search !== ''
  ) {
    throw new Error(
      'artifact URL must be the credential-free GitHub release URL without a custom port, query, or fragment',
    )
  }
  if (artifactUrl.pathname.includes('%')) {
    throw new Error('artifact URL must not contain an encoded release path')
  }
  const segments = artifactUrl.pathname.split('/').slice(1)
  if (segments.length !== 6
    || segments[0] !== 'SerienYang'
    || segments[1] !== 'OpenLoop-base-Deepseek-Harness'
    || segments[2] !== 'releases'
    || segments[3] !== 'download'
    || segments[5] !== 'Openloop.app.tar.gz') {
    throw new Error('artifact URL must use the exact immutable GitHub release asset path')
  }
  const tag = segments[4]
  if (tag !== `openloop-test-a-v${version}` && tag !== `openloop-test-b-v${version}`) {
    throw new Error('artifact URL test release tag must match openloop-test-[ab]-v<version>')
  }
}

function validateValues(renderOptions) {
  if (!semverPattern.test(renderOptions.version)) {
    throw new Error('version must be valid semver')
  }
  validateArtifactUrl(renderOptions.artifactUrl, renderOptions.version)
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

function outputTarget(path, inputs, trustedRoot) {
  const absolute = resolve(path)
  assertNoSymlinkComponents(dirname(absolute), trustedRoot, 'output', true)
  mkdirSync(dirname(absolute), { recursive: true })
  assertNoSymlinkComponents(dirname(absolute), trustedRoot, 'output')
  const parent = realpathSync(dirname(absolute))
  if (!isWithin(realpathSync(trustedRoot), parent)) {
    throw new Error('output parent must stay inside its trusted root')
  }
  const target = join(parent, basename(absolute))
  if (inputs.some(input => sameFile(target, input))) {
    throw new Error('output must not overlap an input')
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
  const artifactPath = regularArtifact(renderOptions.artifact, trustedRoot)
  const signaturePath = regularSignature(renderOptions.signature, trustedRoot)
  const signature = verifyTauriUpdaterSignature({
    artifactBytes: readFileSync(artifactPath),
    signature: readFileSync(signaturePath, 'utf8'),
    publicKey: renderOptions.publicKey,
  })
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
  atomicWrite(
    outputTarget(renderOptions.out, [artifactPath, signaturePath], trustedRoot),
    bytes,
  )
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
