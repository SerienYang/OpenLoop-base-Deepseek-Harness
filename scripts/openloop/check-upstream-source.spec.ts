import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import yaml from 'js-yaml'

const radarModulePath: string = './check-upstream-source.mjs'
const baselineCommit = 'a'.repeat(40)
const releaseCommit = 'b'.repeat(40)
const tagCommit = 'c'.repeat(40)
const branchCommit = 'd'.repeat(40)
const roots: string[] = []

interface Candidate {
  readonly sourceType: 'release' | 'tag' | 'branch_head'
  readonly sourceRef: string
  readonly commit: string
  readonly automaticUpgradeEligible: boolean
  readonly prerelease?: boolean
}

interface RadarModule {
  readonly parseBaseline: (value: unknown) => Record<string, unknown>
  readonly normalizeReleaseCandidate: (
    release: Record<string, unknown>,
    tags: Record<string, unknown>[],
  ) => Candidate | null
  readonly normalizeTagCandidate: (tag: Record<string, unknown>) => Candidate
  readonly normalizeBranchCandidate: (
    branch: Record<string, unknown>,
    branchName?: string,
  ) => Candidate
  readonly selectUpstreamCandidate: (input: {
    releases: Record<string, unknown>[]
    tags: Record<string, unknown>[]
    branch: Record<string, unknown>
  }) => Candidate
  readonly issueKeyForCandidate: (candidate: Candidate) => string
  readonly decideRadarAction: (
    baseline: Record<string, unknown>,
    candidate: Candidate,
    issues: Record<string, unknown>[],
  ) => Record<string, unknown>
  readonly renderRadarJson: (report: Record<string, unknown>) => string
  readonly renderRadarMarkdown: (report: Record<string, unknown>) => string
  readonly escapeGitHubOutput: (value: string) => string
  readonly fetchGitHubJson: (
    url: string,
    options?: {
      fetchImpl?: typeof fetch
      timeoutMs?: number
    },
  ) => Promise<unknown>
  readonly loadLiveRadarInput: (options?: {
    fetchImpl?: typeof fetch
    timeoutMs?: number
  }) => Promise<Record<string, unknown>>
  readonly createRadarReport: (
    input: Record<string, unknown>,
  ) => Record<string, unknown>
  readonly runRadarCli: (
    args: string[],
    dependencies?: {
      stdinText?: string
      readFile?: (path: string) => string
      fetchImpl?: typeof fetch
      writeStdout?: (value: string) => void
    },
  ) => Promise<number>
}

function baseline(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    sourceType: 'release',
    sourceRef: 'dsh-v0.1.0-rc.7',
    commit: baselineCommit,
    approvedAt: '2026-08-18T12:12:25Z',
    capturedAt: '2026-08-18T12:12:25Z',
    ...overrides,
  }
}

function release(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    tag_name: 'dsh-v0.1.0-rc.8',
    draft: false,
    prerelease: true,
    target_commitish: 'master',
    published_at: '2026-08-20T00:00:00Z',
    ...overrides,
  }
}

function tag(
  name = 'dsh-v0.1.0-rc.8',
  sha = releaseCommit,
): Record<string, unknown> {
  return { name, commit: { sha } }
}

function offlineInput(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    baseline: baseline(),
    releases: [release()],
    tags: [tag()],
    branch: { sha: branchCommit },
    issues: [],
    ...overrides,
  }
}

async function radar(): Promise<RadarModule> {
  return await import(radarModulePath) as RadarModule
}

afterEach(() => {
  vi.restoreAllMocks()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('upstream baseline validation', () => {
  it('accepts the approved baseline schema', async () => {
    const { parseBaseline } = await radar()

    expect(parseBaseline(baseline())).toEqual(baseline())
  })

  it.each([
    ['non-object', null],
    ['unknown source type', baseline({ sourceType: 'branch_head' })],
    ['empty source ref', baseline({ sourceRef: '' })],
    ['untrimmed source ref', baseline({ sourceRef: ' rc.7 ' })],
    ['uppercase commit', baseline({ commit: 'A'.repeat(40) })],
    ['short commit', baseline({ commit: 'a'.repeat(39) })],
    ['invalid approved timestamp', baseline({ approvedAt: '2026-02-30T00:00:00Z' })],
    ['invalid captured timestamp', baseline({ capturedAt: 'not-a-date' })],
  ])('rejects malformed baseline: %s', async (_label, value) => {
    const { parseBaseline } = await radar()

    expect(() => parseBaseline(value)).toThrow(/baseline/iu)
  })
})

describe('candidate normalization and selection', () => {
  it('accepts a non-draft prerelease and resolves its full SHA from tags', async () => {
    const { normalizeReleaseCandidate } = await radar()

    expect(normalizeReleaseCandidate(release(), [tag()])).toEqual({
      sourceType: 'release',
      sourceRef: 'dsh-v0.1.0-rc.8',
      commit: releaseCommit,
      automaticUpgradeEligible: true,
      prerelease: true,
    })
  })

  it('ignores drafts before validating their incomplete metadata', async () => {
    const { normalizeReleaseCandidate } = await radar()

    expect(normalizeReleaseCandidate({
      tag_name: '',
      draft: true,
      prerelease: false,
    }, [])).toBeNull()
  })

  it('rejects release and tag refs whose target SHA is inconsistent', async () => {
    const { normalizeReleaseCandidate, normalizeTagCandidate } = await radar()

    expect(() => normalizeReleaseCandidate(
      release({ target_commitish: tagCommit }),
      [tag()],
    )).toThrow(/target|sha|commit/iu)
    expect(() => normalizeReleaseCandidate(release(), [
      tag('another-ref', releaseCommit),
    ])).toThrow(/tag|ref/iu)
    expect(() => normalizeTagCandidate({
      name: 'dsh-v0.1.0-rc.8',
      commit: { sha: 'short' },
    })).toThrow(/sha|commit/iu)
  })

  it('selects release, then tag, then the master branch head', async () => {
    const { selectUpstreamCandidate } = await radar()
    const shared = {
      tags: [tag('dsh-v0.1.0-rc.8', tagCommit)],
      branch: { sha: branchCommit },
    }

    expect(selectUpstreamCandidate({
      releases: [release({ draft: true }), release()],
      tags: [tag()],
      branch: shared.branch,
    })).toMatchObject({
      sourceType: 'release',
      commit: releaseCommit,
      prerelease: true,
    })
    expect(selectUpstreamCandidate({
      releases: [release({ draft: true })],
      ...shared,
    })).toEqual({
      sourceType: 'tag',
      sourceRef: 'dsh-v0.1.0-rc.8',
      commit: tagCommit,
      automaticUpgradeEligible: true,
    })
    expect(selectUpstreamCandidate({
      releases: [],
      tags: [],
      branch: shared.branch,
    })).toEqual({
      sourceType: 'branch_head',
      sourceRef: 'master',
      commit: branchCommit,
      automaticUpgradeEligible: false,
    })
  })
})

describe('radar decision and issue deduplication', () => {
  it('returns no-op when candidate and baseline SHAs are equal', async () => {
    const { decideRadarAction } = await radar()
    const candidate: Candidate = {
      sourceType: 'release',
      sourceRef: 'dsh-v0.1.0-rc.7',
      commit: baselineCommit,
      automaticUpgradeEligible: true,
    }

    expect(decideRadarAction(baseline(), candidate, [])).toMatchObject({
      action: 'no-op',
      reason: 'candidate matches approved baseline',
    })
  })

  it('creates, updates one exact issue-key match, and fails closed on duplicates', async () => {
    const {
      decideRadarAction,
      issueKeyForCandidate,
      normalizeTagCandidate,
    } = await radar()
    const candidate = normalizeTagCandidate(tag())
    const issueKey = issueKeyForCandidate(candidate)
    const marker = `<!-- openloop-upstream-radar:issue-key=${issueKey} -->`

    expect(decideRadarAction(baseline(), candidate, [])).toMatchObject({
      action: 'create',
      issueKey,
    })
    expect(decideRadarAction(baseline(), candidate, [{
      number: 17,
      title: 'renamed without affecting identity',
      body: `context\n${marker}\n`,
    }])).toMatchObject({
      action: 'update-existing',
      issueKey,
      issueNumber: 17,
    })
    expect(() => decideRadarAction(baseline(), candidate, [
      { number: 17, body: marker },
      { number: 18, body: marker },
    ])).toThrow(/duplicate|multiple|fail.closed/iu)
  })

  it('builds stable collision-resistant keys without relying on titles', async () => {
    const { issueKeyForCandidate } = await radar()
    const common = {
      commit: tagCommit,
      automaticUpgradeEligible: true,
    }

    const tagKey = issueKeyForCandidate({
      sourceType: 'tag',
      sourceRef: 'same title',
      ...common,
    })
    const releaseKey = issueKeyForCandidate({
      sourceType: 'release',
      sourceRef: 'same title',
      ...common,
    })
    const otherRefKey = issueKeyForCandidate({
      sourceType: 'tag',
      sourceRef: 'other/ref',
      ...common,
    })

    expect(new Set([tagKey, releaseKey, otherRefKey]).size).toBe(3)
    expect(tagKey).toContain('tag')
    expect(tagKey).toContain(tagCommit)
    expect(tagKey).not.toContain('\n')
  })
})

describe('deterministic report rendering', () => {
  it('renders byte-identical canonical JSON and Markdown', async () => {
    const {
      createRadarReport,
      renderRadarJson,
      renderRadarMarkdown,
    } = await radar()
    const report = createRadarReport(offlineInput())

    expect(renderRadarJson(report)).toBe(renderRadarJson(report))
    expect(renderRadarJson(report).endsWith('\n')).toBe(true)
    expect(renderRadarMarkdown(report)).toBe(renderRadarMarkdown(report))
    expect(renderRadarMarkdown(report)).toContain('dsh-v0.1.0-rc.8')
    expect(renderRadarMarkdown(report)).toContain(releaseCommit)
  })

  it('escapes candidate-controlled Markdown and hidden-marker content', async () => {
    const {
      createRadarReport,
      renderRadarMarkdown,
    } = await radar()
    const hostileRef = 'rc.8|row\n<script>alert(1)</script><!--'
    const report = createRadarReport(offlineInput({
      releases: [],
      tags: [tag(hostileRef, tagCommit)],
    }))
    const markdown = renderRadarMarkdown(report)

    expect(markdown).not.toContain('<script>')
    expect(markdown).not.toContain('<!--\n')
    expect(markdown).not.toContain('|row\n')
    expect(markdown).toContain('&lt;script&gt;')
    expect(markdown.match(/openloop-upstream-radar:issue-key=/gu)).toHaveLength(1)
  })

  it('escapes GitHub output command delimiters', async () => {
    const { escapeGitHubOutput } = await radar()

    expect(escapeGitHubOutput('100%\r\nnext')).toBe('100%25%0D%0Anext')
  })
})

describe('read-only GitHub API handling', () => {
  it('uses list releases, tags, and the master commit endpoints', async () => {
    const { loadLiveRadarInput } = await radar()
    const urls: string[] = []
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.href
          : input.url
      urls.push(url)
      let value: unknown
      if (url.includes('/releases?')) value = [release()]
      else if (url.includes('/tags?')) value = [tag()]
      else if (url.endsWith('/commits/master')) value = { sha: branchCommit }
      else throw new Error(`unexpected URL ${url}`)
      return new Response(JSON.stringify(value), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }) as typeof fetch

    const input = await loadLiveRadarInput({ fetchImpl })

    expect(input).toEqual({
      releases: [release()],
      tags: [tag()],
      branch: { sha: branchCommit },
    })
    expect(urls).toHaveLength(3)
    expect(urls.some(url => /\/releases\?per_page=100$/u.test(url))).toBe(true)
    expect(urls.some(url => /\/tags\?per_page=100$/u.test(url))).toBe(true)
    expect(urls.some(url => /\/commits\/master$/u.test(url))).toBe(true)
    expect(urls.some(url => /\/releases\/latest/u.test(url))).toBe(false)
  })

  it.each([
    ['404', new Response('not found', { status: 404 })],
    ['rate limit', new Response('{}', {
      status: 403,
      headers: {
        'content-type': 'application/json',
        'x-ratelimit-remaining': '0',
      },
    })],
    ['malformed JSON', new Response('{', {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })],
  ])('fails loudly for %s responses', async (_label, response) => {
    const { fetchGitHubJson } = await radar()
    const fetchImpl = vi.fn(async () => response) as typeof fetch

    await expect(fetchGitHubJson('https://api.github.test/resource', {
      fetchImpl,
    })).rejects.toThrow(/404|rate|json|malformed/iu)
  })

  it('fails loudly when a request times out', async () => {
    const { fetchGitHubJson } = await radar()
    const fetchImpl = vi.fn((_input: string | URL | Request, init?: RequestInit) => (
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(new DOMException('aborted', 'AbortError'))
        })
      })
    )) as typeof fetch

    await expect(fetchGitHubJson('https://api.github.test/slow', {
      fetchImpl,
      timeoutMs: 5,
    })).rejects.toThrow(/timeout/iu)
  })
})

describe('offline dry-run CLI', () => {
  it('uses only supplied input and emits a deterministic report', async () => {
    const {
      createRadarReport,
      renderRadarJson,
      runRadarCli,
    } = await radar()
    const input = offlineInput()
    const output: string[] = []
    const fetchImpl = vi.fn(() => {
      throw new Error('offline mode must not access the network')
    }) as typeof fetch

    const status = await runRadarCli(
      ['--offline', '--input-file', '-', '--dry-run'],
      {
        stdinText: JSON.stringify(input),
        readFile: () => {
          throw new Error('stdin input must not read a file')
        },
        fetchImpl,
        writeStdout: value => output.push(value),
      },
    )

    expect(status).toBe(0)
    expect(fetchImpl).not.toHaveBeenCalled()
    expect(output.join('')).toBe(renderRadarJson(createRadarReport(input)))
  })

  it('reads an offline fixture without mutating it or creating files', () => {
    const root = mkdtempSync(join(tmpdir(), 'openloop-radar-'))
    roots.push(root)
    const fixture = join(root, 'input.json')
    const source = `${JSON.stringify(offlineInput(), null, 2)}\n`
    writeFileSync(fixture, source)

    const result = spawnSync(process.execPath, [
      'scripts/openloop/check-upstream-source.mjs',
      '--offline',
      '--input-file',
      fixture,
      '--dry-run',
    ], {
      cwd: process.cwd(),
      encoding: 'utf8',
    })

    expect(result.status, result.stderr).toBe(0)
    expect(JSON.parse(result.stdout)).toMatchObject({
      decision: { action: 'create' },
      candidate: { sourceRef: 'dsh-v0.1.0-rc.8' },
    })
    expect(readFileSync(fixture, 'utf8')).toBe(source)
    expect(readdirSync(root)).toEqual(['input.json'])
  })
})

describe('upstream radar workflow', () => {
  it('has only read-only detection triggers and least-privilege issue reporting', () => {
    const source = readFileSync('.github/workflows/upstream-radar.yml', 'utf8')
    const workflow = yaml.load(source) as {
      on?: Record<string, unknown>
      permissions?: Record<string, string>
      concurrency?: Record<string, unknown>
      jobs?: Record<string, {
        steps?: Array<Record<string, unknown>>
      }>
    }

    expect(Object.keys(workflow.on ?? {}).sort()).toEqual([
      'schedule',
      'workflow_dispatch',
    ])
    expect(workflow.permissions).toEqual({
      contents: 'read',
      issues: 'write',
    })
    expect(workflow.concurrency).toMatchObject({
      'cancel-in-progress': false,
    })

    const steps = workflow.jobs?.radar?.steps ?? []
    const checkout = steps.find(step => step.uses === 'actions/checkout@v4')
    expect(checkout?.with).toMatchObject({
      'persist-credentials': false,
    })
    expect(steps.some(step => step.id === 'detect'
      && typeof step.run === 'string'
      && step.run.includes('openloop:radar')
      && step.run.includes('GITHUB_OUTPUT'))).toBe(true)
    expect(steps.at(-1)?.uses).toBe('actions/github-script@v7')
  })

  it('contains no release automation, elevated permissions, or forbidden side effects', () => {
    const source = readFileSync('.github/workflows/upstream-radar.yml', 'utf8')
    const script = readFileSync('scripts/openloop/check-upstream-source.mjs', 'utf8')
    const forbiddenWorkflow = [
      /contents:\s*write/iu,
      /pull-requests:\s*write/iu,
      /persist-credentials:\s*true/iu,
      /\bpush\b/iu,
      /\bartifact/iu,
      /\bsecrets?\./iu,
      /\benvironment:/iu,
    ]
    const forbiddenScript = [
      /\bmethod\s*:\s*['"](?:POST|PATCH|PUT|DELETE)['"]/iu,
      /\bgit\s+push\b/iu,
      /\bgh\s+(?:api|pr)\b/iu,
    ]

    expect(forbiddenWorkflow.filter(pattern => pattern.test(source))).toEqual([])
    expect(forbiddenScript.filter(pattern => pattern.test(script))).toEqual([])
  })
})
