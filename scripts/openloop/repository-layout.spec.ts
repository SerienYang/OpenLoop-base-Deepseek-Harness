import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import type { Nodes } from 'mdast'
import { describe, expect, test } from 'vitest'
import { parseTranslationMarkdown } from '../translation-pairing.ts'

const trackedFiles = execFileSync('git', ['ls-files', '-z'], {
  encoding: 'utf8',
}).split('\0').filter(Boolean)

const tracked = new Set(trackedFiles)

const allowedRootEntries = new Set([
  '.editorconfig',
  '.gitattributes',
  '.github',
  '.gitignore',
  '.jscpd.json',
  '.oxlintrc.json',
  '.oxlintrc.staged.json',
  '.rgignore',
  'AGENTS.md',
  'LICENSE',
  'README.md',
  'THIRD_PARTY_NOTICES.md',
  'apps',
  'assets',
  'examples',
  'knip.json',
  'lefthook.yml',
  'native',
  'package.json',
  'packages',
  'patches',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  'pytest.ini',
  'python',
  'runtime',
  'scripts',
  'tsconfig.base.client.json',
  'tsconfig.base.json',
  'tsconfig.client.json',
  'tsconfig.host.json',
  'tsconfig.json',
  'tsdown.config.ts',
  'vendor',
  'vitest.config.ts',
  'vitest.e2e.config.ts',
  'vitest.shared.ts',
  'vitest.snapshot.config.ts',
  'vitest.web-stress.config.ts',
  'vitest.web.config.ts',
  'vitest.web.perf.config.ts',
])

const allowedWorkflowFiles = new Set([
  '.github/workflows/openloop-ci.yml',
  '.github/workflows/openloop-release.yml',
  '.github/workflows/upstream-radar.yml',
])

const forbiddenRootPrefixes = [
  '.agents/',
  '.claude/',
  'docs/',
  'website/',
]

const forbiddenLinkRoots = forbiddenRootPrefixes
  .map(prefix => path.resolve(prefix))

const forbiddenRootFiles = new Set([
  '.gitlab-ci.yml',
  'BENCHMARK.md',
  'CLAUDE.md',
  'CONTRIBUTING.i18n.yaml',
  'CONTRIBUTING.md',
  'CONTRIBUTING.zh.md',
  'README.i18n.yaml',
  'README.zh.md',
])

const forbiddenPathPatterns = [
  /(^|\/)\.env(?:\.|$)/u,
  /(^|\/)(?:id_rsa|id_ed25519)(?:\.pub)?$/u,
  /\.(?:7z|cer|crt|dmg|key|log|mobileprovision|p12|pem|pfx|pkg|rar|tar|tgz|zip)$/iu,
  /\.(?:tar\.(?:bz2|gz|xz)|tbz2|txz)$/iu,
  /(^|\/)[^/]+\.app(?:\/|$)/iu,
  /\.keychain-db$/iu,
  /(^|\/)(?:\.artifacts|build|coverage|dist|dist-exe|lib|node_modules|output|target)(?:\/|$)/u,
  /(^|\/)(?:signing|updater)[-_]private(?:\/|\.|$)/iu,
]

describe('public repository layout', () => {
  test('keeps the root limited to product code and required tooling', () => {
    const rootEntries = new Set(
      trackedFiles.map(path => path.split('/', 1)[0] ?? path),
    )
    const unexpected = [...rootEntries]
      .filter(entry => !allowedRootEntries.has(entry))
      .sort()

    expect(unexpected).toEqual([])
  })

  test('excludes internal planning, upstream docs, and website content', () => {
    const forbidden = trackedFiles
      .filter(path => forbiddenRootFiles.has(path)
        || forbiddenRootPrefixes.some(prefix => path.startsWith(prefix)))
      .sort()

    expect(forbidden).toEqual([])
  })

  test('keeps agent instructions at the repository root only', () => {
    const nestedAgentInstructions = trackedFiles
      .filter(path => path !== 'AGENTS.md')
      .filter(path => /(^|\/)(?:AGENTS|CLAUDE)\.md$/u.test(path))
      .filter(path => !/^examples\/.+\/tests\/.+\/workspace\/.+/u.test(path))
      .sort()

    expect(nestedAgentInstructions).toEqual([])
  })

  test('keeps only OpenLoop-owned GitHub workflows', () => {
    const githubFiles = trackedFiles
      .filter(path => path.startsWith('.github/'))
      .filter(path => !allowedWorkflowFiles.has(path))
      .sort()

    expect(githubFiles).toEqual([])
  })

  test('rejects secrets, installers, logs, and build outputs', () => {
    const forbidden = trackedFiles
      .filter(path => forbiddenPathPatterns.some(pattern => pattern.test(path)))
      .sort()

    expect(forbidden).toEqual([])
  })

  test('requires the public entrypoint, brand assets, legal notices, and baseline', () => {
    const required = [
      'AGENTS.md',
      'LICENSE',
      'README.md',
      'THIRD_PARTY_NOTICES.md',
      'assets/brand/openloop-dsh-hero.png',
      'assets/brand/openloop-dsh-hero.svg',
      'assets/brand/openloop-icon.svg',
      '.github/workflows/openloop-ci.yml',
      'scripts/openloop/upstream-baseline.json',
    ]

    expect(required.filter(path => !tracked.has(path))).toEqual([])
  })

  test('pins the approved DeepSeek Harness commit', () => {
    const baselinePath = 'scripts/openloop/upstream-baseline.json'
    expect(fs.existsSync(baselinePath)).toBe(true)

    const baseline = JSON.parse(
      fs.readFileSync(baselinePath, 'utf8'),
    ) as { commit?: unknown }

    expect(baseline.commit).toBe(
      '99f6f02fecdb7dff40c3fbc9470f5907c29f74ca',
    )
  })

  test('does not expose commands or agent rules for removed documentation systems', () => {
    const packageJson = fs.readFileSync('package.json', 'utf8')
    const agentRules = fs.readFileSync('AGENTS.md', 'utf8')
    const forbiddenTerms = [
      '.agents/',
      'doc-sync',
      'docs/',
      'website/',
      'website:build',
    ]

    expect(forbiddenTerms.filter(term => packageJson.includes(term))).toEqual([])
    expect(forbiddenTerms.filter(term => agentRules.includes(term))).toEqual([])
  })

  test('does not link retained Markdown to missing repository content', () => {
    const brokenLinks: string[] = []

    for (const file of trackedFiles.filter(file => file.endsWith('.md'))) {
      const tree = parseTranslationMarkdown(fs.readFileSync(file, 'utf8'))
      const checkTarget = (targetUrl: string): void => {
        if (targetUrl.startsWith('#') || /^[a-z][a-z0-9+.-]*:/iu.test(targetUrl)) return
        const target = targetUrl.split(/[?#]/u, 1)[0]
        if (target === undefined || target === '') return
        const resolved = path.resolve(path.dirname(file), decodeURI(target))
        const forbidden = forbiddenLinkRoots
          .some(root => resolved === root || resolved.startsWith(`${root}${path.sep}`))
        if (forbidden || !fs.existsSync(resolved)) {
          brokenLinks.push(`${file}: ${targetUrl}`)
        }
      }
      const visit = (node: Nodes): void => {
        if (node.type === 'link' || node.type === 'image' || node.type === 'definition') {
          checkTarget(node.url)
        }
        if (node.type === 'html') {
          for (const match of node.value.matchAll(/\b(?:href|src)\s*=\s*(?:(["'])(.*?)\1|([^\s"'=<>`]+))/gisu)) {
            const target = match[2] ?? match[3]
            if (target !== undefined) checkTarget(target)
          }
        }
        if ('children' in node) {
          for (const child of node.children) visit(child)
        }
      }
      visit(tree)
    }

    expect(brokenLinks.sort()).toEqual([])
  })

  test('keeps every required agent command wired to an existing entrypoint', () => {
    const packageJson = JSON.parse(
      fs.readFileSync('package.json', 'utf8'),
    ) as { scripts?: Record<string, string> }
    const agentRules = fs.readFileSync('AGENTS.md', 'utf8')
    const pnpmScripts = [...agentRules.matchAll(/^pnpm run ([\w:-]+)$/gmu)]
      .map(match => match[1])
      .filter((script): script is string => script !== undefined)
    const missingScripts = pnpmScripts
      .filter(script => packageJson.scripts?.[script] === undefined)
      .sort()

    expect(missingScripts).toEqual([])
    expect(tracked.has('scripts/openloop/repository-layout.spec.ts')).toBe(true)
    expect(fs.existsSync('python/sdk/pyproject.toml')).toBe(true)

    const nativePackage = JSON.parse(
      fs.readFileSync('native/landlock-run/package.json', 'utf8'),
    ) as { scripts?: Record<string, string> }
    expect(nativePackage.scripts?.test).toBeTypeOf('string')
  })
})
