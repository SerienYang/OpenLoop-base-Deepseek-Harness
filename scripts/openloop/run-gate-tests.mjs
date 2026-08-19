#!/usr/bin/env node

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  existsSync,
  readFileSync,
  realpathSync,
  readdirSync,
  statSync,
} from 'node:fs'
import { extname, isAbsolute, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const allowlistPath = 'scripts/openloop/test-skip-allowlist.json'
const ignoredDirectories = new Set([
  '.git',
  '.turbo',
  'coverage',
  'dist',
  'lib',
  'node_modules',
  'output',
  'target',
])
const scannedExtensions = new Set([
  '.cjs',
  '.cts',
  '.js',
  '.jsx',
  '.mjs',
  '.mts',
  '.rs',
  '.ts',
  '.tsx',
])
const globCharacters = /[*?[{]/
const rustIgnorePattern = /#\s*\[\s*ignore(?:\s*=|\s*\])/
const testDeclarationNames = new Set(['describe', 'it', 'suite', 'test'])
const unconditionalSkipNames = new Set(['fixme', 'skip', 'todo'])

function optionMap(args, required) {
  const values = {}
  for (let index = 0; index < args.length; index += 2) {
    const option = args[index]
    const value = args[index + 1]
    if (!required.includes(option)) throw new Error(`unknown option ${option}`)
    if (value === undefined || value.startsWith('--')) throw new Error(`${option} requires a value`)
    if (values[option] !== undefined) throw new Error(`${option} may be specified only once`)
    values[option] = value
  }
  for (const option of required) {
    if (values[option] === undefined) throw new Error(`${option} is required`)
  }
  return values
}

export function parseGateArguments(args) {
  const normalized = args[0] === '--' ? args.slice(1) : args
  const [mode, ...rest] = normalized
  switch (mode) {
    case 'vitest': {
      if (rest[0] !== '--files') throw new Error('vitest requires --files')
      const files = rest.slice(1)
      if (files.length === 0 || files.some(file => file.startsWith('--'))) {
        throw new Error('vitest --files requires one or more exact files')
      }
      return { mode, files }
    }
    case 'cargo': {
      const options = optionMap(rest, ['--manifest', '--test'])
      return { mode, manifest: options['--manifest'], test: options['--test'] }
    }
    case 'playwright': {
      const options = optionMap(rest, ['--file'])
      return { mode, file: options['--file'] }
    }
    case 'wdio': {
      const options = optionMap(rest, ['--config', '--binary', '--file'])
      return {
        mode,
        config: options['--config'],
        binary: options['--binary'],
        file: options['--file'],
      }
    }
    case 'scan-repo':
      if (rest.length > 0) throw new Error('scan-repo accepts no options')
      return { mode }
    default:
      throw new Error('mode must be vitest, cargo, playwright, wdio, or scan-repo')
  }
}

function repoPath(root, value, label) {
  if (globCharacters.test(value)) throw new Error(`${label} must be an exact path: ${value}`)
  const absolute = isAbsolute(value) ? resolve(value) : resolve(root, value)
  const rel = relative(root, absolute)
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error(`${label} must stay inside the repository: ${value}`)
  }
  if (!existsSync(absolute) || !statSync(absolute).isFile()) {
    throw new Error(`${label} does not exist: ${value}`)
  }
  const realRoot = realpathSync(root)
  const realAbsolute = realpathSync(absolute)
  const realRelative = relative(realRoot, realAbsolute)
  if (realRelative === '..'
    || realRelative.startsWith(`..${sep}`)
    || isAbsolute(realRelative)) {
    throw new Error(`${label} must resolve inside the repository: ${value}`)
  }
  return {
    absolute,
    relative: rel.split(sep).join('/'),
  }
}

function walkFiles(root, start = root) {
  const files = []
  for (const entry of readdirSync(start, { withFileTypes: true })) {
    if (entry.isDirectory() && ignoredDirectories.has(entry.name)) continue
    const absolute = resolve(start, entry.name)
    if (entry.isDirectory()) files.push(...walkFiles(root, absolute))
    else if (entry.isFile() && scannedExtensions.has(extname(entry.name))) files.push(absolute)
  }
  return files
}

function normalizedRelativePath(root, absolute) {
  return relative(root, absolute).split(sep).join('/')
}

function isKnownTestFile(root, absolute) {
  const path = normalizedRelativePath(root, absolute)
  if (extname(path) === '.rs') return true
  return path.includes('/tests/')
    || /\.(?:e2e|spec|test)\.[cm]?[jt]sx?$/u.test(path)
}

function calleeSegments(expression) {
  if (ts.isIdentifier(expression)) return [expression.text]
  if (ts.isPropertyAccessExpression(expression)) {
    const parent = calleeSegments(expression.expression)
    return parent === undefined ? undefined : [...parent, expression.name.text]
  }
  if (ts.isElementAccessExpression(expression)
    && expression.argumentExpression !== undefined
    && ts.isStringLiteralLike(expression.argumentExpression)) {
    const parent = calleeSegments(expression.expression)
    return parent === undefined ? undefined : [...parent, expression.argumentExpression.text]
  }
  if (ts.isCallExpression(expression)) return calleeSegments(expression.expression)
  return undefined
}

function recognizedTestIdentifiers(sourceFile) {
  const recognized = new Set(testDeclarationNames)
  const aliases = []

  function visit(node) {
    if (ts.isImportDeclaration(node)
      && ts.isStringLiteralLike(node.moduleSpecifier)
      && (node.moduleSpecifier.text === 'vitest'
        || node.moduleSpecifier.text === '@playwright/test')
      && node.importClause?.namedBindings !== undefined
      && ts.isNamedImports(node.importClause.namedBindings)) {
      for (const element of node.importClause.namedBindings.elements) {
        const imported = element.propertyName?.text ?? element.name.text
        if (testDeclarationNames.has(imported)) recognized.add(element.name.text)
      }
    }
    if (ts.isVariableDeclaration(node)
      && ts.isIdentifier(node.name)
      && node.initializer !== undefined
      && ts.isIdentifier(node.initializer)
      && ts.isVariableDeclarationList(node.parent)
      && (node.parent.flags & (ts.NodeFlags.Const | ts.NodeFlags.Let)) !== 0) {
      aliases.push([node.name.text, node.initializer.text])
    }
    ts.forEachChild(node, visit)
  }

  visit(sourceFile)
  for (let changed = true; changed;) {
    changed = false
    for (const [alias, target] of aliases) {
      if (!recognized.has(target) || recognized.has(alias)) continue
      recognized.add(alias)
      changed = true
    }
  }
  return recognized
}

function isNestedCalleeCall(node) {
  let expression = node
  while ((ts.isPropertyAccessExpression(expression.parent)
      || ts.isElementAccessExpression(expression.parent))
    && expression.parent.expression === expression) {
    expression = expression.parent
  }
  return ts.isCallExpression(expression.parent)
    && expression.parent.expression === expression
}

function normalizeMarkerText(value) {
  const scanner = ts.createScanner(
    ts.ScriptTarget.Latest,
    true,
    ts.LanguageVariant.Standard,
    value,
  )
  const tokens = []
  for (let token = scanner.scan(); token !== ts.SyntaxKind.EndOfFileToken; token = scanner.scan()) {
    tokens.push([
      token,
      scanner.getTokenText().replace(/\r\n?/gu, '\n'),
    ])
  }
  return JSON.stringify(tokens)
}

export function markerFingerprint(marker) {
  return createHash('sha256')
    .update(JSON.stringify({
      kind: marker.kind,
      callee: marker.callee,
      source: normalizeMarkerText(marker.source),
      title: normalizeMarkerText(marker.title),
    }))
    .digest('hex')
}

function javascriptTestDeclarations(root, absolute) {
  const source = readFileSync(absolute, 'utf8')
  const sourceFile = ts.createSourceFile(
    absolute,
    source,
    ts.ScriptTarget.Latest,
    true,
  )
  const file = normalizedRelativePath(root, absolute)
  const recognized = recognizedTestIdentifiers(sourceFile)
  const focused = []
  const skips = []

  function visit(node) {
    if (ts.isCallExpression(node) && !isNestedCalleeCall(node)) {
      const segments = calleeSegments(node.expression)
      if (segments !== undefined
        && recognized.has(segments[0])
        && segments.slice(1).includes('only')) {
        const line = sourceFile.getLineAndCharacterOfPosition(node.expression.getStart(sourceFile)).line + 1
        focused.push({ file, line })
      }
      if (segments !== undefined && recognized.has(segments[0])) {
        const kind = segments.slice(1).find(segment => unconditionalSkipNames.has(segment))
        if (kind !== undefined) {
          const line = sourceFile.getLineAndCharacterOfPosition(node.expression.getStart(sourceFile)).line + 1
          const sourceText = node.getText(sourceFile)
          const title = node.arguments[0]?.getText(sourceFile) ?? ''
          skips.push({
            file,
            line,
            fingerprint: markerFingerprint({
              kind,
              callee: segments.join('.'),
              source: sourceText,
              title,
            }),
          })
        }
      }
    }
    ts.forEachChild(node, visit)
  }

  visit(sourceFile)
  return {
    focused,
    skips,
  }
}

function focusedDeclarations(root, files) {
  return files
    .filter(file => extname(file) !== '.rs' && isKnownTestFile(root, file))
    .flatMap(file => javascriptTestDeclarations(root, file).focused)
}

function rustSkipDeclarations(root, absolute) {
  const file = normalizedRelativePath(root, absolute)
  const skips = []
  const lines = readFileSync(absolute, 'utf8').split(/\r?\n/u)
  for (let index = 0; index < lines.length; index += 1) {
    if (!rustIgnorePattern.test(lines[index])) continue
    skips.push({
      file,
      line: index + 1,
      fingerprint: markerFingerprint({
        kind: 'ignore',
        callee: '#[ignore]',
        source: lines[index],
        title: '',
      }),
    })
  }
  return skips
}

function skipDeclarations(root, files) {
  return files
    .filter(file => isKnownTestFile(root, file))
    .flatMap(file => extname(file) === '.rs'
      ? rustSkipDeclarations(root, file)
      : javascriptTestDeclarations(root, file).skips)
}

function isIsoCalendarDate(value) {
  const parsed = new Date(`${value}T00:00:00.000Z`)
  return !Number.isNaN(parsed.valueOf())
    && parsed.toISOString().slice(0, 10) === value
}

function readAllowlist(root, now) {
  const path = resolve(root, allowlistPath)
  if (!existsSync(path)) throw new Error(`missing skip allowlist: ${allowlistPath}`)
  const document = JSON.parse(readFileSync(path, 'utf8'))
  if (document?.version !== 1 || !Array.isArray(document.skips)) {
    throw new Error(`${allowlistPath}: expected version 1 with a skips array`)
  }

  const entries = new Map()
  const today = now.toISOString().slice(0, 10)
  for (const entry of document.skips) {
    const key = `${entry?.file}:${entry?.line}`
    if (typeof entry?.file !== 'string'
      || !Number.isInteger(entry?.line)
      || entry.line < 1
      || typeof entry?.fingerprint !== 'string'
      || !/^[a-f0-9]{64}$/u.test(entry.fingerprint)
      || typeof entry?.owner !== 'string'
      || entry.owner.trim() === ''
      || typeof entry?.reason !== 'string'
      || entry.reason.trim() === ''
      || typeof entry?.expires !== 'string'
      || !/^\d{4}-\d{2}-\d{2}$/.test(entry.expires)) {
      throw new Error(`${allowlistPath}: skip entries require file, line, fingerprint, owner, reason, and YYYY-MM-DD expires`)
    }
    if (!isIsoCalendarDate(entry.expires)) {
      throw new Error(`${allowlistPath}: skip expiry must be a real YYYY-MM-DD calendar date`)
    }
    let fingerprints = entries.get(key)
    if (fingerprints === undefined) {
      fingerprints = new Map()
      entries.set(key, fingerprints)
    }
    if (fingerprints.has(entry.fingerprint)) {
      throw new Error(`${allowlistPath}: duplicate skip entry ${key}`)
    }
    fingerprints.set(entry.fingerprint, { ...entry, expired: entry.expires <= today })
  }
  return entries
}

function validateSkips(root, files, allowlist) {
  const skips = skipDeclarations(root, files)
  for (const skip of skips) {
    const key = `${skip.file}:${skip.line}`
    const entries = allowlist.get(key)
    if (entries === undefined) throw new Error(`${key}: skip is not present in the allowlist`)
    const entry = entries.get(skip.fingerprint)
    if (entry === undefined) {
      throw new Error(`${key}: skip allowlist fingerprint does not match marker`)
    }
    if (entry.expired) throw new Error(`${key}: skip allowlist entry is expired`)
  }
}

function scanRepository(root, allowlist) {
  const files = walkFiles(root)
  const focused = focusedDeclarations(root, files)
  if (focused.length > 0) {
    const match = focused[0]
    throw new Error(`${match.file}:${match.line}: forbidden focused test marker`)
  }
  validateSkips(root, files, allowlist)
}

function parseJsonOutput(stdout, label) {
  const start = stdout.indexOf('{')
  const end = stdout.lastIndexOf('}')
  if (start < 0 || end < start) throw new Error(`${label} did not produce a JSON report`)
  try {
    return JSON.parse(stdout.slice(start, end + 1))
  } catch {
    throw new Error(`${label} produced an invalid JSON report`)
  }
}

function assertCommandPassed(result, label) {
  if (result.status === 0) return
  const detail = [result.stdout, result.stderr].filter(Boolean).join('\n').trim()
  throw new Error(`${label} failed${detail === '' ? '' : `:\n${detail}`}`)
}

function assertVitestResult(result) {
  const report = parseJsonOutput(result.stdout, 'Vitest')
  if (!Number.isInteger(report.numTotalTests) || report.numTotalTests === 0) {
    throw new Error('Vitest discovered zero tests')
  }
  const pending = Number.isInteger(report.numPendingTests) ? report.numPendingTests : 0
  if (report.numTotalTests - pending <= 0) {
    if (pending > 0) throw new Error('Vitest all discovered tests were skipped')
    throw new Error('Vitest executed zero tests')
  }
  assertCommandPassed(result, 'Vitest')
}

function assertCargoList(result) {
  assertCommandPassed(result, 'Cargo test listing')
  const tests = result.stdout.split(/\r?\n/u).filter(line => /:\s+test$/u.test(line.trim()))
  if (tests.length === 0) throw new Error('Cargo discovered zero tests')
}

function assertCargoResult(result) {
  const matches = [...result.stdout.matchAll(
    /test result: [^.]+\.\s+(\d+) passed;\s+(\d+) failed;\s+(\d+) ignored;/gu,
  )]
  const executed = matches.reduce((total, match) => total + Number(match[1]) + Number(match[2]), 0)
  const skipped = matches.reduce((total, match) => total + Number(match[3]), 0)
  if (executed === 0 && skipped > 0) throw new Error('Cargo all discovered tests were skipped')
  if (executed === 0) throw new Error('Cargo executed zero tests')
  assertCommandPassed(result, 'Cargo')
}

function assertPlaywrightResult(result) {
  const report = parseJsonOutput(result.stdout, 'Playwright')
  const stats = report.stats ?? {}
  const executed = Number(stats.expected ?? 0)
    + Number(stats.unexpected ?? 0)
    + Number(stats.flaky ?? 0)
  if (executed === 0 && Number(stats.skipped ?? 0) > 0) {
    throw new Error('Playwright all discovered tests were skipped')
  }
  if (executed === 0) throw new Error('Playwright executed zero tests')
  assertCommandPassed(result, 'Playwright')
}

function assertWdioResult(result) {
  const summaries = [...`${result.stdout}\n${result.stderr}`.matchAll(
    /(\d+)\s+passed,\s+(\d+)\s+failed,\s+(\d+)\s+skipped/gu,
  )]
  const executed = summaries.reduce(
    (total, match) => total + Number(match[1]) + Number(match[2]),
    0,
  )
  const skipped = summaries.reduce((total, match) => total + Number(match[3]), 0)
  if (executed === 0 && skipped > 0) throw new Error('WDIO all discovered tests were skipped')
  if (executed === 0) throw new Error('WDIO executed zero tests')
  assertCommandPassed(result, 'WDIO')
}

function defaultRunCommand(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    encoding: 'utf8',
  })
  if (result.stdout) process.stdout.write(result.stdout)
  if (result.stderr) process.stderr.write(result.stderr)
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? result.error?.message ?? '',
  }
}

async function invoke(runCommand, root, command, args, options = {}) {
  return await runCommand(command, args, {
    cwd: root,
    ...options,
  })
}

export async function runGateTests(args, dependencies = {}) {
  const root = resolve(dependencies.root ?? fileURLToPath(new URL('../..', import.meta.url)))
  const now = dependencies.now ?? new Date()
  const runCommand = dependencies.runCommand ?? defaultRunCommand
  const request = parseGateArguments(args)
  const allowlist = readAllowlist(root, now)

  scanRepository(root, allowlist)
  if (request.mode === 'scan-repo') return

  if (request.mode === 'vitest') {
    const files = request.files.map(file => repoPath(root, file, 'target'))
    validateSkips(root, files.map(file => file.absolute), allowlist)
    const result = await invoke(
      runCommand,
      root,
      'pnpm',
      ['exec', 'vitest', 'run', ...files.map(file => file.relative), '--reporter=json'],
    )
    assertVitestResult(result)
    return
  }

  if (request.mode === 'cargo') {
    const manifest = repoPath(root, request.manifest, 'Cargo manifest')
    const rustFiles = walkFiles(root, resolve(manifest.absolute, '..'))
      .filter(file => extname(file) === '.rs')
    validateSkips(root, rustFiles, allowlist)
    const baseArgs = [
      'test',
      '--manifest-path', manifest.relative,
      '--test', request.test,
    ]
    const listed = await invoke(runCommand, root, 'cargo', [...baseArgs, '--', '--list'])
    assertCargoList(listed)
    const result = await invoke(runCommand, root, 'cargo', baseArgs)
    assertCargoResult(result)
    return
  }

  if (request.mode === 'playwright') {
    const file = repoPath(root, request.file, 'target')
    validateSkips(root, [file.absolute], allowlist)
    const result = await invoke(
      runCommand,
      root,
      'pnpm',
      ['exec', 'playwright', 'test', file.relative, '--reporter=json'],
    )
    assertPlaywrightResult(result)
    return
  }

  const config = repoPath(root, request.config, 'WDIO config')
  const binary = repoPath(root, request.binary, 'WDIO binary')
  const file = repoPath(root, request.file, 'target')
  validateSkips(root, [file.absolute], allowlist)
  const result = await invoke(
    runCommand,
    root,
    'pnpm',
    ['exec', 'wdio', 'run', config.relative, '--spec', file.relative],
    {
      env: {
        ...process.env,
        OPENLOOP_WDIO_BINARY: binary.absolute,
      },
    },
  )
  assertWdioResult(result)
}

const isMain = process.argv[1] !== undefined
  && resolve(process.argv[1]) === fileURLToPath(import.meta.url)

if (isMain) {
  runGateTests(process.argv.slice(2)).catch(error => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
}
