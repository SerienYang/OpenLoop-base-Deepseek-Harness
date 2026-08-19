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
      token?: string
      timeoutMs?: number
    },
  ) => Promise<unknown>
  readonly loadLiveRadarInput: (options?: {
    env?: NodeJS.ProcessEnv
    fetchImpl?: typeof fetch
    maxIssuePages?: number
    token?: string
    timeoutMs?: number
    repository?: string
  }) => Promise<Record<string, unknown>>
  readonly createRadarReport: (
    input: Record<string, unknown>,
  ) => Record<string, unknown>
  readonly runRadarCli: (
    args: string[],
    dependencies?: {
      env?: NodeJS.ProcessEnv
      stdinText?: string
      readFile?: (path: string) => string
      fetchImpl?: typeof fetch
      token?: string
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

function markerFor(
  sourceType: Candidate['sourceType'] = 'release',
  sourceRef = 'dsh-v0.1.0-rc.8',
  commit = releaseCommit,
): string {
  return `<!-- openloop-upstream-radar:issue-key=upstream-radar:v1:${sourceType}:${encodeURIComponent(sourceRef)}:${commit} -->`
}

async function radar(): Promise<RadarModule> {
  return await import(radarModulePath) as RadarModule
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
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
  it('uses upstream candidate endpoints and the origin repository open issues endpoint', async () => {
    const { loadLiveRadarInput } = await radar()
    const urls: string[] = []
    const methods: string[] = []
    const fetchImpl = vi.fn(async (
      input: string | URL | Request,
      init?: RequestInit,
    ) => {
      const url = typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.href
          : input.url
      urls.push(url)
      methods.push(init?.method ?? 'GET')
      let value: unknown
      if (url.includes('/releases?')) value = [release()]
      else if (url.includes('/tags?')) value = [tag()]
      else if (url.endsWith('/commits/master')) value = { sha: branchCommit }
      else if (url.includes('/repos/example/openloop/issues?')) value = []
      else throw new Error(`unexpected URL ${url}`)
      return new Response(JSON.stringify(value), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }) as typeof fetch

    const input = await loadLiveRadarInput({
      fetchImpl,
      repository: 'example/openloop',
    })

    expect(input).toEqual({
      releases: [release()],
      tags: [tag()],
      branch: { sha: branchCommit },
      issues: [],
    })
    expect(urls).toHaveLength(4)
    expect(methods).toEqual(['GET', 'GET', 'GET', 'GET'])
    expect(urls.some(url => /\/releases\?per_page=100$/u.test(url))).toBe(true)
    expect(urls.some(url => /\/tags\?per_page=100$/u.test(url))).toBe(true)
    expect(urls.some(url => /\/commits\/master$/u.test(url))).toBe(true)
    expect(urls.some(url => (
      /\/repos\/example\/openloop\/issues\?state=open&per_page=100$/u.test(url)
    ))).toBe(true)
    expect(urls.some(url => /\/releases\/latest/u.test(url))).toBe(false)
  })

  it('authenticates every live GitHub GET, including paginated origin issues', async () => {
    const { loadLiveRadarInput } = await radar()
    const token = 'github-token-for-header-coverage'
    const requests: Array<{ headers: Headers; url: string }> = []
    const fetchImpl = vi.fn(async (
      input: string | URL | Request,
      init?: RequestInit,
    ) => {
      const url = typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.href
          : input.url
      requests.push({ headers: new Headers(init?.headers), url })
      if (url.includes('/releases?')) return Response.json([release()])
      if (url.includes('/tags?')) return Response.json([tag()])
      if (url.endsWith('/commits/master')) {
        return Response.json({ sha: branchCommit })
      }
      if (url.endsWith('/issues?state=open&per_page=100')) {
        return Response.json([], {
          headers: {
            link: '<https://api.github.com/repos/example/openloop/issues?state=open&per_page=100&page=2>; rel="next"',
          },
        })
      }
      if (url.endsWith('/issues?state=open&per_page=100&page=2')) {
        return Response.json([])
      }
      throw new Error(`unexpected URL ${url}`)
    }) as typeof fetch

    await loadLiveRadarInput({
      fetchImpl,
      repository: 'example/openloop',
      token,
    })

    expect(requests.map(request => request.url)).toEqual([
      'https://api.github.com/repos/deepseek-ai/deepseek-harness/releases?per_page=100',
      'https://api.github.com/repos/deepseek-ai/deepseek-harness/tags?per_page=100',
      'https://api.github.com/repos/deepseek-ai/deepseek-harness/commits/master',
      'https://api.github.com/repos/example/openloop/issues?state=open&per_page=100',
      'https://api.github.com/repos/example/openloop/issues?state=open&per_page=100&page=2',
    ])
    for (const { headers } of requests) {
      expect(headers.get('authorization')).toBe(`Bearer ${token}`)
      expect(headers.get('accept')).toBe('application/vnd.github+json')
      expect(headers.get('x-github-api-version')).toBe('2022-11-28')
    }
  })

  it('reads GITHUB_TOKEN for live API requests when no token is injected', async () => {
    const { loadLiveRadarInput } = await radar()
    const token = 'github-token-from-env'
    const authorizations: Array<string | null> = []
    vi.stubEnv('GITHUB_TOKEN', token)
    const fetchImpl = vi.fn(async (
      input: string | URL | Request,
      init?: RequestInit,
    ) => {
      const url = typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.href
          : input.url
      authorizations.push(new Headers(init?.headers).get('authorization'))
      if (url.includes('/releases?')) return Response.json([release()])
      if (url.includes('/tags?')) return Response.json([tag()])
      if (url.endsWith('/commits/master')) {
        return Response.json({ sha: branchCommit })
      }
      if (url.includes('/issues?')) return Response.json([])
      throw new Error(`unexpected URL ${url}`)
    }) as typeof fetch

    await loadLiveRadarInput({
      fetchImpl,
      repository: 'example/openloop',
    })

    expect(authorizations).toEqual(Array.from({ length: 4 }, () => `Bearer ${token}`))
  })

  it('keeps public GitHub GET requests anonymous when token is empty', async () => {
    const { fetchGitHubJson } = await radar()
    let headers = new Headers()
    const fetchImpl = vi.fn(async (
      _input: string | URL | Request,
      init?: RequestInit,
    ) => {
      headers = new Headers(init?.headers)
      return Response.json({ ok: true })
    }) as typeof fetch

    await fetchGitHubJson('https://api.github.test/resource', {
      fetchImpl,
      token: '',
    })

    expect(headers.get('authorization')).toBeNull()
    expect(headers.get('accept')).toBe('application/vnd.github+json')
    expect(headers.get('x-github-api-version')).toBe('2022-11-28')
  })

  it('redacts the token from request failure messages', async () => {
    const { fetchGitHubJson } = await radar()
    const token = 'github-token-that-must-stay-secret'
    const fetchImpl = vi.fn(async () => {
      throw new Error(`transport rejected Authorization: Bearer ${token}`)
    }) as typeof fetch

    const failure = await fetchGitHubJson('https://api.github.test/resource', {
      fetchImpl,
      token,
    }).catch((error: unknown) => error)

    expect(failure).toBeInstanceOf(Error)
    expect((failure as Error).message).not.toContain(token)
  })

  it('follows paginated open issues and extracts one hidden marker per issue', async () => {
    const { loadLiveRadarInput } = await radar()
    const marker = markerFor()
    const urls: string[] = []
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = String(input)
      urls.push(url)
      if (url.includes('/releases?')) {
        return Response.json([release()])
      }
      if (url.includes('/tags?')) {
        return Response.json([tag()])
      }
      if (url.endsWith('/commits/master')) {
        return Response.json({ sha: branchCommit })
      }
      if (url.endsWith('/issues?state=open&per_page=100')) {
        return Response.json(
          [{ number: 17, body: `context\n${marker}\n` }],
          {
            headers: {
              link: '<https://api.github.com/repos/example/openloop/issues?state=open&per_page=100&page=2>; rel="next"',
            },
          },
        )
      }
      if (url.endsWith('/issues?state=open&per_page=100&page=2')) {
        return Response.json([{ number: 18, body: marker }])
      }
      throw new Error(`unexpected URL ${url}`)
    }) as typeof fetch

    const input = await loadLiveRadarInput({
      fetchImpl,
      repository: 'example/openloop',
    })

    expect(input.issues).toEqual([
      { number: 17, body: marker },
      { number: 18, body: marker },
    ])
    expect(urls.filter(url => url.includes('/issues?'))).toHaveLength(2)
  })

  it('uses page numbers when a full issues page has no next link', async () => {
    const { loadLiveRadarInput } = await radar()
    const issueUrls: string[] = []
    const fullPage = Array.from({ length: 100 }, (_, index) => ({
      number: index + 1,
      body: null,
    }))
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = String(input)
      if (url.includes('/releases?')) return Response.json([release()])
      if (url.includes('/tags?')) return Response.json([tag()])
      if (url.endsWith('/commits/master')) {
        return Response.json({ sha: branchCommit })
      }
      if (url.includes('/issues?')) {
        issueUrls.push(url)
        return Response.json(url.includes('page=2') ? [] : fullPage)
      }
      throw new Error(`unexpected URL ${url}`)
    }) as typeof fetch

    await loadLiveRadarInput({
      fetchImpl,
      repository: 'example/openloop',
    })

    expect(issueUrls).toEqual([
      'https://api.github.com/repos/example/openloop/issues?state=open&per_page=100',
      'https://api.github.com/repos/example/openloop/issues?state=open&per_page=100&page=2',
    ])
  })

  it('fails loudly when issues pagination exceeds its bound', async () => {
    const { loadLiveRadarInput } = await radar()
    const fullPage = Array.from({ length: 100 }, (_, index) => ({
      number: index + 1,
      body: null,
    }))
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = String(input)
      if (url.includes('/releases?')) return Response.json([release()])
      if (url.includes('/tags?')) return Response.json([tag()])
      if (url.endsWith('/commits/master')) {
        return Response.json({ sha: branchCommit })
      }
      if (url.includes('/issues?')) return Response.json(fullPage)
      throw new Error(`unexpected URL ${url}`)
    }) as typeof fetch

    await expect(loadLiveRadarInput({
      fetchImpl,
      maxIssuePages: 2,
      repository: 'example/openloop',
    })).rejects.toThrow(/pagination|pages|limit|bound/iu)
  })

  it('ignores pull requests and non-string issue bodies', async () => {
    const { loadLiveRadarInput } = await radar()
    const marker = markerFor()
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = String(input)
      if (url.includes('/releases?')) return Response.json([release()])
      if (url.includes('/tags?')) return Response.json([tag()])
      if (url.endsWith('/commits/master')) {
        return Response.json({ sha: branchCommit })
      }
      if (url.includes('/issues?')) {
        return Response.json([
          { number: 17, body: marker, pull_request: { url: 'pr' } },
          { number: 18, body: null },
          { number: 19, body: marker },
        ])
      }
      throw new Error(`unexpected URL ${url}`)
    }) as typeof fetch

    const input = await loadLiveRadarInput({
      fetchImpl,
      repository: 'example/openloop',
    })

    expect(input.issues).toEqual([{ number: 19, body: marker }])
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

describe('live dry-run CLI', () => {
  function liveFetch(issues: Record<string, unknown>[]): typeof fetch {
    return vi.fn(async (input: string | URL | Request) => {
      const url = String(input)
      if (url.includes('/releases?')) return Response.json([release()])
      if (url.includes('/tags?')) return Response.json([tag()])
      if (url.endsWith('/commits/master')) {
        return Response.json({ sha: branchCommit })
      }
      if (url.includes('/repos/example/openloop/issues?')) {
        return Response.json(issues)
      }
      throw new Error(`unexpected URL ${url}`)
    }) as typeof fetch
  }

  it('reports update-existing and matching Markdown when one marker exists', async () => {
    const { runRadarCli } = await radar()
    const output: string[] = []

    await runRadarCli(
      ['--repository', 'example/openloop', '--dry-run'],
      {
        readFile: () => JSON.stringify(baseline()),
        fetchImpl: liveFetch([{
          number: 17,
          body: `context\n${markerFor()}\n`,
        }]),
        writeStdout: value => output.push(value),
      },
    )

    const report = JSON.parse(output.join('')) as {
      decision: { action: string; issueNumber?: number }
      issue: { body: string }
    }
    expect(report.decision).toMatchObject({
      action: 'update-existing',
      issueNumber: 17,
    })
    expect(report.issue.body).toContain('Decision: **update-existing**')
  })

  it('reports create when no matching marker exists', async () => {
    const { runRadarCli } = await radar()
    const output: string[] = []

    await runRadarCli(
      ['--repository', 'example/openloop', '--dry-run'],
      {
        readFile: () => JSON.stringify(baseline()),
        fetchImpl: liveFetch([]),
        writeStdout: value => output.push(value),
      },
    )

    const report = JSON.parse(output.join('')) as {
      decision: { action: string }
      issue: { body: string }
    }
    expect(report.decision.action).toBe('create')
    expect(report.issue.body).toContain('Decision: **create**')
  })

  it('fails closed when duplicate exact markers exist', async () => {
    const { runRadarCli } = await radar()
    const marker = markerFor()

    await expect(runRadarCli(
      ['--repository', 'example/openloop', '--dry-run'],
      {
        readFile: () => JSON.stringify(baseline()),
        fetchImpl: liveFetch([
          { number: 17, body: marker },
          { number: 18, body: marker },
        ]),
      },
    )).rejects.toThrow(/duplicate|multiple|fail.closed/iu)
  })

  it('requires an explicit repository only for live input', async () => {
    const { runRadarCli } = await radar()

    await expect(runRadarCli(
      ['--dry-run'],
      { fetchImpl: liveFetch([]) },
    )).rejects.toThrow(/repository/iu)
    await expect(runRadarCli(
      ['--offline', '--input-file', '-', '--dry-run'],
      {
        stdinText: JSON.stringify(offlineInput()),
        writeStdout: () => {},
      },
    )).resolves.toBe(0)
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
    const dependencies = {
      get env(): NodeJS.ProcessEnv {
        throw new Error('offline mode must not read GITHUB_TOKEN')
      },
      fetchImpl,
      stdinText: JSON.stringify(input),
      readFile: () => {
        throw new Error('stdin input must not read a file')
      },
      writeStdout: (value: string) => output.push(value),
    }

    const status = await runRadarCli(
      ['--offline', '--input-file', '-', '--dry-run'],
      dependencies,
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
    const detect = steps.find(step => step.id === 'detect')
    expect(checkout?.with).toMatchObject({
      'persist-credentials': false,
    })
    expect(detect).toMatchObject({
      env: {
        GITHUB_TOKEN: '${{ github.token }}',
      },
    })
    expect(typeof detect?.run === 'string'
      && detect.run.includes('openloop:radar')
      && detect.run.includes('--repository "$GITHUB_REPOSITORY"')
      && detect.run.includes('GITHUB_OUTPUT')).toBe(true)
    expect(steps.at(-1)?.uses).toBe('actions/github-script@v7')
  })

  it('uses the report decision for create and update without re-reading issues', () => {
    const source = readFileSync('.github/workflows/upstream-radar.yml', 'utf8')

    expect(source).not.toContain('github.paginate')
    expect(source).not.toContain('issues.listForRepo')
    expect(source).toContain("report.decision.action === 'update-existing'")
    expect(source).toContain('issue_number: report.decision.issueNumber')
    expect(source).toContain("report.decision.action === 'create'")
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
