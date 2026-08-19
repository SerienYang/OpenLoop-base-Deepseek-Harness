#!/usr/bin/env node

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const upstreamRepository = 'deepseek-ai/deepseek-harness'
const upstreamBranch = 'master'
const githubApiRoot = 'https://api.github.com'
const apiRoot = `${githubApiRoot}/repos/${upstreamRepository}`
const baselinePath = fileURLToPath(new URL('./upstream-baseline.json', import.meta.url))
const fullShaPattern = /^[0-9a-f]{40}$/u
const baselineSourceTypes = new Set(['release', 'tag', 'approved_commit'])
const candidateSourceTypes = new Set(['release', 'tag', 'branch_head'])
const issueMarkerPrefix = 'openloop-upstream-radar:issue-key='
const issueMarkerPattern = /<!-- openloop-upstream-radar:issue-key=[^\s<>]+ -->/gu
const issuePageSize = 100
const defaultMaxIssuePages = 100
const isoTimestampPattern = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?Z$/u

function objectValue(value, label) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`)
  }
  return value
}

function trimmedString(value, label) {
  if (typeof value !== 'string' || value.length === 0 || value.trim() !== value) {
    throw new Error(`${label} must be a non-empty trimmed string`)
  }
  return value
}

function fullSha(value, label) {
  if (typeof value !== 'string' || !fullShaPattern.test(value)) {
    throw new Error(`${label} must be a full lowercase 40-character SHA`)
  }
  return value
}

function githubRepository(value) {
  const repository = trimmedString(value, 'repository')
  const match = /^([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\/([A-Za-z0-9._-]{1,100})$/u.exec(repository)
  if (match === null || match[2] === '.' || match[2] === '..') {
    throw new Error('repository must use the GitHub owner/name format')
  }
  return repository
}

function isoTimestamp(value, label) {
  if (typeof value !== 'string') {
    throw new Error(`upstream baseline ${label} must be a valid ISO timestamp`)
  }
  const match = isoTimestampPattern.exec(value)
  if (match === null) {
    throw new Error(`upstream baseline ${label} must be a valid ISO timestamp`)
  }
  const parsed = new Date(value)
  const expected = match.slice(1, 7).map(Number)
  const actual = [
    parsed.getUTCFullYear(),
    parsed.getUTCMonth() + 1,
    parsed.getUTCDate(),
    parsed.getUTCHours(),
    parsed.getUTCMinutes(),
    parsed.getUTCSeconds(),
  ]
  if (!Number.isFinite(parsed.getTime())
    || actual.some((component, index) => component !== expected[index])) {
    throw new Error(`upstream baseline ${label} must be a valid ISO timestamp`)
  }
  return value
}

/** Validate and normalize the immutable approved upstream baseline. */
export function parseBaseline(value) {
  const input = objectValue(value, 'upstream baseline')
  if (!baselineSourceTypes.has(input.sourceType)) {
    throw new Error('upstream baseline sourceType must be release, tag, or approved_commit')
  }
  const parsed = {
    sourceType: input.sourceType,
    sourceRef: trimmedString(input.sourceRef, 'upstream baseline sourceRef'),
    commit: fullSha(input.commit, 'upstream baseline commit'),
    approvedAt: isoTimestamp(input.approvedAt, 'approvedAt'),
    capturedAt: isoTimestamp(input.capturedAt, 'capturedAt'),
  }
  if (Date.parse(parsed.capturedAt) < Date.parse(parsed.approvedAt)) {
    throw new Error('upstream baseline capturedAt must not precede approvedAt')
  }
  return parsed
}

/** Normalize one GitHub tags-list item into a fully resolved candidate. */
export function normalizeTagCandidate(value) {
  const input = objectValue(value, 'upstream tag')
  const commit = objectValue(input.commit, 'upstream tag commit')
  return {
    sourceType: 'tag',
    sourceRef: trimmedString(input.name, 'upstream tag ref'),
    commit: fullSha(commit.sha, 'upstream tag commit SHA'),
    automaticUpgradeEligible: true,
  }
}

/** Normalize the GitHub master commit response as a detection-only fallback. */
export function normalizeBranchCandidate(value, branchName = upstreamBranch) {
  const input = objectValue(value, 'upstream branch head')
  const sha = input.sha ?? objectValue(input.commit, 'upstream branch commit').sha
  return {
    sourceType: 'branch_head',
    sourceRef: trimmedString(branchName, 'upstream branch name'),
    commit: fullSha(sha, 'upstream branch head SHA'),
    automaticUpgradeEligible: false,
  }
}

/** Normalize a release by resolving its tag through the tags-list response. */
export function normalizeReleaseCandidate(value, tags) {
  const input = objectValue(value, 'upstream release')
  if (input.draft === true) return null
  if (input.draft !== false || typeof input.prerelease !== 'boolean') {
    throw new Error('upstream release draft and prerelease flags must be booleans')
  }
  if (!Array.isArray(tags)) throw new Error('upstream tags response must be an array')
  const sourceRef = trimmedString(input.tag_name, 'upstream release tag ref')
  const matchingTag = tags.find(candidate => (
    typeof candidate === 'object'
      && candidate !== null
      && !Array.isArray(candidate)
      && candidate.name === sourceRef
  ))
  if (matchingTag === undefined) {
    throw new Error(`upstream release tag ref ${sourceRef} is missing from tags response`)
  }
  const resolvedTag = normalizeTagCandidate(matchingTag)
  const target = trimmedString(input.target_commitish, 'upstream release target commit')
  if (fullShaPattern.test(target) && target !== resolvedTag.commit) {
    throw new Error(`upstream release target SHA does not match tag ${sourceRef}`)
  }
  if (!fullShaPattern.test(target) && target !== sourceRef && target !== upstreamBranch) {
    throw new Error(`upstream release target ref ${target} is inconsistent with ${sourceRef}`)
  }
  return {
    sourceType: 'release',
    sourceRef,
    commit: resolvedTag.commit,
    automaticUpgradeEligible: true,
    prerelease: input.prerelease,
  }
}

/** Select release, tag, or master branch head in strict priority order. */
export function selectUpstreamCandidate(value) {
  const input = objectValue(value, 'upstream API input')
  if (!Array.isArray(input.releases)) {
    throw new Error('upstream releases response must be an array')
  }
  if (!Array.isArray(input.tags)) {
    throw new Error('upstream tags response must be an array')
  }
  for (const release of input.releases) {
    const candidate = normalizeReleaseCandidate(release, input.tags)
    if (candidate !== null) return candidate
  }
  if (input.tags.length > 0) return normalizeTagCandidate(input.tags[0])
  return normalizeBranchCandidate(input.branch)
}

function validateCandidate(value) {
  const input = objectValue(value, 'upstream candidate')
  if (!candidateSourceTypes.has(input.sourceType)) {
    throw new Error('upstream candidate sourceType is invalid')
  }
  const automaticUpgradeEligible = input.automaticUpgradeEligible
  if (typeof automaticUpgradeEligible !== 'boolean') {
    throw new Error('upstream candidate automaticUpgradeEligible must be boolean')
  }
  if (input.sourceType === 'branch_head' && automaticUpgradeEligible) {
    throw new Error('branch_head candidates cannot be automatically upgrade eligible')
  }
  return {
    sourceType: input.sourceType,
    sourceRef: trimmedString(input.sourceRef, 'upstream candidate sourceRef'),
    commit: fullSha(input.commit, 'upstream candidate commit'),
    automaticUpgradeEligible,
    ...(input.sourceType === 'release'
      ? { prerelease: Boolean(input.prerelease) }
      : {}),
  }
}

/** Build the stable identity used only by hidden issue markers. */
export function issueKeyForCandidate(value) {
  const candidate = validateCandidate(value)
  return [
    'upstream-radar',
    'v1',
    candidate.sourceType,
    encodeURIComponent(candidate.sourceRef),
    candidate.commit,
  ].join(':')
}

function issueMarker(issueKey) {
  return `<!-- ${issueMarkerPrefix}${issueKey} -->`
}

/** Compare an approved baseline with one candidate and exact marker matches. */
export function decideRadarAction(baselineValue, candidateValue, issues = []) {
  const baseline = parseBaseline(baselineValue)
  const candidate = validateCandidate(candidateValue)
  if (candidate.commit === baseline.commit) {
    return {
      action: 'no-op',
      reason: 'candidate matches approved baseline',
    }
  }
  if (!Array.isArray(issues)) throw new Error('issues must be an array')
  const issueKey = issueKeyForCandidate(candidate)
  const marker = issueMarker(issueKey)
  const matches = issues.filter((value) => {
    const issue = objectValue(value, 'issue')
    return typeof issue.body === 'string' && issue.body.includes(marker)
  })
  if (matches.length > 1) {
    throw new Error(`fail-closed: multiple duplicate issues match ${issueKey}`)
  }
  if (matches.length === 1) {
    const issueNumber = objectValue(matches[0], 'issue').number
    if (!Number.isSafeInteger(issueNumber) || issueNumber < 1) {
      throw new Error('matching issue number must be a positive integer')
    }
    return {
      action: 'update-existing',
      issueKey,
      issueNumber,
    }
  }
  return {
    action: 'create',
    issueKey,
  }
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue)
  if (typeof value !== 'object' || value === null) return value
  return Object.fromEntries(
    Object.keys(value).sort().map(key => [key, stableValue(value[key])]),
  )
}

/** Render canonical, deterministic JSON with a final newline. */
export function renderRadarJson(report) {
  return `${JSON.stringify(stableValue(report), null, 2)}\n`
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

function markdownCell(value) {
  return escapeHtml(value)
    .replaceAll('|', '&#124;')
    .replace(/\r\n?|\n/gu, '<br>')
}

function inlineText(value) {
  return escapeHtml(value).replace(/\s+/gu, ' ').trim()
}

/** Render the deterministic GitHub issue body without raw candidate markup. */
export function renderRadarMarkdown(reportValue) {
  const report = objectValue(reportValue, 'radar report')
  const baseline = parseBaseline(report.baseline)
  const candidate = validateCandidate(report.candidate)
  const decision = objectValue(report.decision, 'radar decision')
  const issue = objectValue(report.issue, 'radar issue')
  const marker = trimmedString(issue.marker, 'radar issue marker')
  return [
    marker,
    '',
    '# Upstream change detected',
    '',
    '| Field | Approved baseline | Candidate |',
    '| --- | --- | --- |',
    `| Source type | ${markdownCell(baseline.sourceType)} | ${markdownCell(candidate.sourceType)} |`,
    `| Source ref | ${markdownCell(baseline.sourceRef)} | ${markdownCell(candidate.sourceRef)} |`,
    `| Commit | \`${baseline.commit}\` | \`${candidate.commit}\` |`,
    `| Automatic upgrade eligible | n/a | ${candidate.automaticUpgradeEligible ? 'yes' : 'no'} |`,
    '',
    `Decision: **${markdownCell(decision.action)}**`,
    '',
    'This issue is an informational upstream radar report. Approval and upgrade automation are out of scope.',
    '',
  ].join('\n')
}

/** Build the complete report consumed by stdout and the issue workflow. */
export function createRadarReport(value) {
  const input = objectValue(value, 'radar input')
  const baseline = parseBaseline(input.baseline)
  const candidate = selectUpstreamCandidate(input)
  const decision = decideRadarAction(baseline, candidate, input.issues ?? [])
  const key = decision.issueKey ?? issueKeyForCandidate(candidate)
  const marker = issueMarker(key)
  const title = `[Upstream Radar] ${inlineText(candidate.sourceType)}: ${inlineText(candidate.sourceRef)}`
  const partial = {
    version: 1,
    upstreamRepository,
    baseline,
    candidate,
    decision,
    issue: {
      title,
      marker,
    },
  }
  return {
    ...partial,
    issue: {
      ...partial.issue,
      body: renderRadarMarkdown(partial),
    },
  }
}

/** Escape a value for the single-line GitHub output-file command format. */
export function escapeGitHubOutput(value) {
  return String(value)
    .replaceAll('%', '%25')
    .replaceAll('\r', '%0D')
    .replaceAll('\n', '%0A')
}

function nonEmptyToken(value) {
  if (typeof value !== 'string') return undefined
  const token = value.trim()
  return token.length > 0 ? token : undefined
}

function liveGitHubToken(options) {
  return nonEmptyToken(options.token ?? (options.env ?? process.env).GITHUB_TOKEN)
}

async function fetchGitHubResource(url, options = {}) {
  const fetchImpl = options.fetchImpl ?? fetch
  const timeoutMs = options.timeoutMs ?? 10_000
  const token = nonEmptyToken(options.token)
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    throw new Error('GitHub API timeout must be a positive integer')
  }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetchImpl(url, {
      method: 'GET',
      headers: {
        accept: 'application/vnd.github+json',
        'user-agent': 'openloop-upstream-radar',
        'x-github-api-version': '2022-11-28',
        ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
      },
      signal: controller.signal,
    })
    const rateLimited = (response.status === 403 || response.status === 429)
      && response.headers.get('x-ratelimit-remaining') === '0'
    if (rateLimited) {
      throw new Error(`GitHub API rate limit exceeded for ${url}`)
    }
    if (!response.ok) {
      throw new Error(`GitHub API ${response.status} for ${url}`)
    }
    const body = await response.text()
    try {
      return {
        headers: response.headers,
        value: JSON.parse(body),
      }
    } catch {
      throw new Error(`GitHub API returned malformed JSON for ${url}`)
    }
  } catch (error) {
    if (controller.signal.aborted
      || (error instanceof Error && error.name === 'AbortError')) {
      throw new Error(`GitHub API timeout for ${url}`)
    }
    if (token !== undefined) {
      const message = error instanceof Error ? error.message : String(error)
      throw new Error(message.replaceAll(token, '[REDACTED]'))
    }
    throw error
  } finally {
    clearTimeout(timer)
  }
}

/** Perform one bounded, read-only GitHub API GET and parse JSON strictly. */
export async function fetchGitHubJson(url, options = {}) {
  const response = await fetchGitHubResource(url, options)
  return response.value
}

function nextLink(value) {
  if (value === null) return null
  for (const entry of value.split(',')) {
    const match = /^\s*<([^>]+)>\s*;\s*rel="([^"]+)"\s*$/u.exec(entry)
    if (match !== null && match[2].split(/\s+/u).includes('next')) {
      return match[1]
    }
  }
  return null
}

function nextIssuesUrl(url, headers, itemCount, repository) {
  const linked = nextLink(headers.get('link'))
  if (linked !== null) {
    const parsed = new URL(linked)
    if (parsed.origin !== githubApiRoot
      || parsed.pathname !== `/repos/${repository}/issues`) {
      throw new Error(`GitHub issues pagination returned an invalid next link: ${linked}`)
    }
    return parsed.href
  }
  if (itemCount < issuePageSize) return null
  const parsed = new URL(url)
  const page = Number(parsed.searchParams.get('page') ?? '1')
  if (!Number.isSafeInteger(page) || page < 1) {
    throw new Error(`GitHub issues pagination returned an invalid page URL: ${url}`)
  }
  parsed.searchParams.set('page', String(page + 1))
  return parsed.href
}

function extractRadarIssues(values) {
  if (!Array.isArray(values)) {
    throw new Error('GitHub issues response must be an array')
  }
  const issues = []
  for (const value of values) {
    const issue = objectValue(value, 'GitHub issue')
    if (issue.pull_request !== undefined || typeof issue.body !== 'string') {
      continue
    }
    const markers = Array.from(issue.body.matchAll(issueMarkerPattern), match => match[0])
    if (markers.length === 0) continue
    if (markers.length > 1) {
      throw new Error('fail-closed: issue body contains multiple upstream radar issue markers')
    }
    if (!Number.isSafeInteger(issue.number) || issue.number < 1) {
      throw new Error('radar issue number must be a positive integer')
    }
    issues.push({
      number: issue.number,
      body: markers[0],
    })
  }
  return issues
}

async function loadOpenRadarIssues(repositoryValue, options) {
  const repository = githubRepository(repositoryValue)
  const maxPages = options.maxIssuePages ?? defaultMaxIssuePages
  if (!Number.isSafeInteger(maxPages) || maxPages < 1) {
    throw new Error('GitHub issues pagination limit must be a positive integer')
  }
  const fetchOptions = {
    fetchImpl: options.fetchImpl,
    token: options.token,
    timeoutMs: options.timeoutMs,
  }
  const pages = []
  const visited = new Set()
  let url = `${githubApiRoot}/repos/${repository}/issues?state=open&per_page=${issuePageSize}`
  for (let page = 1; page <= maxPages; page += 1) {
    if (visited.has(url)) {
      throw new Error(`GitHub issues pagination returned a cycle at ${url}`)
    }
    visited.add(url)
    const response = await fetchGitHubResource(url, fetchOptions)
    if (!Array.isArray(response.value)) {
      throw new Error('GitHub issues response must be an array')
    }
    pages.push(...response.value)
    const next = nextIssuesUrl(
      url,
      response.headers,
      response.value.length,
      repository,
    )
    if (next === null) return extractRadarIssues(pages)
    if (page === maxPages) {
      throw new Error(`GitHub issues pagination exceeded ${maxPages} pages`)
    }
    url = next
  }
  throw new Error(`GitHub issues pagination exceeded ${maxPages} pages`)
}

/** Read upstream candidates and current-repository issues without mutation. */
export async function loadLiveRadarInput(options = {}) {
  const repository = githubRepository(options.repository)
  const token = liveGitHubToken(options)
  const fetchOptions = {
    fetchImpl: options.fetchImpl,
    token,
    timeoutMs: options.timeoutMs,
  }
  const [releases, tags, branch, issues] = await Promise.all([
    fetchGitHubJson(`${apiRoot}/releases?per_page=100`, fetchOptions),
    fetchGitHubJson(`${apiRoot}/tags?per_page=100`, fetchOptions),
    fetchGitHubJson(`${apiRoot}/commits/${upstreamBranch}`, fetchOptions),
    loadOpenRadarIssues(repository, { ...options, token }),
  ])
  return { releases, tags, branch, issues }
}

function optionValue(args, index, option) {
  const value = args[index + 1]
  if (value === undefined || value.startsWith('--')) {
    throw new Error(`${option} requires a value`)
  }
  return value
}

function parseArguments(args) {
  const normalized = args[0] === '--' ? args.slice(1) : args
  const options = {
    offline: false,
    dryRun: false,
    githubOutput: false,
  }
  for (let index = 0; index < normalized.length; index += 1) {
    const option = normalized[index]
    if (option === '--offline') {
      if (options.offline) throw new Error('--offline may be specified only once')
      options.offline = true
    } else if (option === '--dry-run') {
      if (options.dryRun) throw new Error('--dry-run may be specified only once')
      options.dryRun = true
    } else if (option === '--github-output') {
      if (options.githubOutput) throw new Error('--github-output may be specified only once')
      options.githubOutput = true
    } else if (option === '--input-file') {
      if (options.inputFile !== undefined) {
        throw new Error('--input-file may be specified only once')
      }
      options.inputFile = optionValue(normalized, index, option)
      index += 1
    } else if (option === '--repository') {
      if (options.repository !== undefined) {
        throw new Error('--repository may be specified only once')
      }
      options.repository = githubRepository(optionValue(normalized, index, option))
      index += 1
    } else {
      throw new Error(`unknown option ${option}`)
    }
  }
  if (!options.dryRun) throw new Error('--dry-run is required')
  if (options.offline && options.inputFile === undefined) {
    throw new Error('--offline requires --input-file')
  }
  if (!options.offline && options.inputFile !== undefined) {
    throw new Error('--input-file requires --offline')
  }
  if (options.offline && options.repository !== undefined) {
    throw new Error('--repository is available only for live input')
  }
  if (!options.offline && options.repository === undefined) {
    throw new Error('--repository is required for live input')
  }
  return options
}

function parseJsonInput(source, label) {
  try {
    return JSON.parse(source)
  } catch {
    throw new Error(`${label} contains malformed JSON`)
  }
}

/** Execute the detection-only CLI using injectable read and GET dependencies. */
export async function runRadarCli(args, dependencies = {}) {
  const options = parseArguments(args)
  const readFile = dependencies.readFile ?? (path => readFileSync(path, 'utf8'))
  let input
  if (options.offline) {
    const source = options.inputFile === '-'
      ? (dependencies.stdinText ?? readFileSync(0, 'utf8'))
      : readFile(options.inputFile)
    input = parseJsonInput(source, `offline input ${options.inputFile}`)
  } else {
    const live = await loadLiveRadarInput({
      env: dependencies.env,
      fetchImpl: dependencies.fetchImpl,
      repository: options.repository,
      token: dependencies.token,
    })
    input = {
      baseline: parseJsonInput(readFile(baselinePath), 'upstream baseline'),
      ...live,
    }
  }
  const report = createRadarReport(input)
  const json = renderRadarJson(report)
  const output = options.githubOutput
    ? `report=${escapeGitHubOutput(json)}\n`
    : json
  const writeStdout = dependencies.writeStdout ?? (value => process.stdout.write(value))
  writeStdout(output)
  return 0
}

const isMain = process.argv[1] !== undefined
  && resolve(process.argv[1]) === fileURLToPath(import.meta.url)

if (isMain) {
  runRadarCli(process.argv.slice(2)).then(
    status => {
      process.exitCode = status
    },
    error => {
      console.error(error instanceof Error ? error.message : String(error))
      process.exitCode = 1
    },
  )
}
