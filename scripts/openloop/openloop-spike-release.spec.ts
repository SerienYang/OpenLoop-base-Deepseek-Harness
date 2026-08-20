import fs from 'node:fs'
import path from 'node:path'
import { load } from 'js-yaml'
import { describe, expect, it } from 'vitest'

const repositoryRoot = path.resolve(import.meta.dirname, '../..')
const workflowPath = path.join(
  repositoryRoot,
  '.github/workflows/openloop-spike-release.yml',
)

function workflowSource(): string {
  return fs.readFileSync(workflowPath, 'utf8')
}

interface WorkflowStep {
  readonly name?: string
  readonly uses?: string
  readonly with?: Record<string, unknown>
  readonly env?: Record<string, unknown>
  readonly run?: string
}

interface PublishJob {
  readonly if?: string
  readonly environment?: string
  readonly env?: Record<string, unknown>
  readonly steps?: WorkflowStep[]
}

function publishJob(): PublishJob {
  const workflow = load(workflowSource()) as {
    readonly jobs?: Record<string, PublishJob>
  }
  const job = workflow.jobs?.['publish-test']
  expect(job).toBeDefined()
  return job ?? {}
}

function namedStep(name: string): WorkflowStep {
  const step = publishJob().steps?.find(candidate => candidate.name === name)
  expect(step, `missing workflow step: ${name}`).toBeDefined()
  return step ?? {}
}

describe('Openloop spike release workflow', () => {
  it('is valid YAML with a protected-main environment-gated publication job', () => {
    const source = workflowSource()
    const workflow = load(source) as {
      readonly permissions?: unknown
      readonly jobs?: Record<string, {
        readonly 'runs-on'?: unknown
        readonly permissions?: unknown
      }>
    }

    expect(workflow).toBeTypeOf('object')
    expect(source).toMatch(/^on:\s*\n\s+workflow_dispatch:/mu)
    expect(source).not.toMatch(/^\s+(?:push|pull_request|release|schedule):/mu)
    expect(workflow.permissions).toEqual({ contents: 'read' })
    expect(Object.keys(workflow.jobs ?? {})).toEqual(['publish-test'])
    expect(workflow.jobs?.['publish-test']?.['runs-on']).toBe('macos-15')
    expect(workflow.jobs?.['publish-test']?.permissions).toEqual({ contents: 'write' })
    expect(publishJob().if).toContain("github.ref == 'refs/heads/main'")
    expect(publishJob().if).toContain('github.ref_protected == true')
    expect(publishJob().environment).toBe('openloop-test-release')
    expect(source).toContain('test "$(uname -m)" = arm64')
    for (const step of publishJob().steps ?? []) {
      if (step.uses !== undefined) {
        expect(step.uses).toMatch(/^[^@]+@[a-f0-9]{40}$/u)
      }
    }
  })

  it('checks out and preflights the exact protected main trigger SHA', () => {
    const source = workflowSource()
    const checkout = publishJob().steps?.find(step => step.uses === 'actions/checkout@d23441a48e516b6c34aea4fa41551a30e30af803')
    const preflight = namedStep('Validate isolated test release inputs').run ?? ''

    expect(checkout?.with).toMatchObject({
      ref: '${{ github.sha }}',
      'persist-credentials': false,
    })
    expect(preflight).toContain('test "$GITHUB_REF" = refs/heads/main')
    expect(preflight).toContain('test "$GITHUB_REF_PROTECTED" = true')
    expect(preflight).toContain('test "$(git rev-parse HEAD)" = "$GITHUB_SHA"')
    expect(source.indexOf('git rev-parse HEAD')).toBeLessThan(
      source.indexOf('pnpm install --frozen-lockfile'),
    )
  })

  it('defines the A/B release identity, semver, notes, and rolling behavior inputs', () => {
    const source = workflowSource()

    for (const input of [
      'release_tag:',
      'app_version:',
      'release_notes:',
      'update_rolling_manifest:',
    ]) {
      expect(source).toContain(input)
    }
    expect(source).toContain('type: boolean')
    expect(source).toMatch(/openloop-test-\[ab\]/u)
    expect(source).toMatch(/stable/iu)
    expect(source).toMatch(/semver/iu)
  })

  it('scopes updater private credentials to the signed build step only', () => {
    const source = workflowSource()
    const job = publishJob()
    const build = namedStep('Build and verify the signed test desktop')
    const buildCommand = 'pnpm openloop:build-desktop -- --channel test --target aarch64-apple-darwin --bundle all'

    expect(source).toContain("github.repository == 'SerienYang/OpenLoop-base-Deepseek-Harness'")
    expect(source).toContain('pnpm install --frozen-lockfile')
    expect(job.env).not.toHaveProperty('TAURI_SIGNING_PRIVATE_KEY')
    expect(job.env).not.toHaveProperty('TAURI_SIGNING_PRIVATE_KEY_PASSWORD')
    expect(build.env).toMatchObject({
      TAURI_SIGNING_PRIVATE_KEY: '${{ secrets.OPENLOOP_TEST_UPDATER_PRIVATE_KEY }}',
      TAURI_SIGNING_PRIVATE_KEY_PASSWORD:
        '${{ secrets.OPENLOOP_TEST_UPDATER_PRIVATE_KEY_PASSWORD }}',
    })
    for (const step of job.steps ?? []) {
      if (step.name === 'Build and verify the signed test desktop') continue
      expect(step.env ?? {}).not.toHaveProperty('TAURI_SIGNING_PRIVATE_KEY')
      expect(step.env ?? {}).not.toHaveProperty('TAURI_SIGNING_PRIVATE_KEY_PASSWORD')
    }
    expect(build.run).toMatch(/TAURI_SIGNING_PRIVATE_KEY[^]*must be configured/iu)
    expect(build.run).toMatch(/TAURI_SIGNING_PRIVATE_KEY_PASSWORD[^]*must be configured/iu)
    expect(source).toMatch(/OPENLOOP_UPDATER_PUBLIC_KEY[^]*must be configured/iu)
    expect(source.split(buildCommand)).toHaveLength(2)
    expect(source).not.toMatch(/\b(?:cargo|pnpm exec) tauri build\b/u)
    expect(source).not.toContain('deepseek-openloop')
  })

  it('allows a remote immutable tag only when it resolves to the trigger SHA', () => {
    const source = workflowSource()
    const preflight = source.slice(
      source.indexOf('- name: Validate isolated test release inputs'),
      source.indexOf('- name: Install immutable dependencies'),
    )

    expect(preflight).toMatch(
      /REMOTE_TAG=.*git ls-remote[^]*refs\/tags\/\$\{RELEASE_TAG\}/u,
    )
    expect(preflight).toMatch(/REMOTE_TAG_SHA=/u)
    expect(preflight).toMatch(
      /test -z "\$REMOTE_TAG_SHA"[^]*"\$REMOTE_TAG_SHA" = "\$GITHUB_SHA"/u,
    )
    expect(preflight).toMatch(/remote tag[^]*different commit/iu)
    expect(preflight).not.toMatch(/test -z "\$REMOTE_TAG"/u)
  })

  it('resumes matching drafts but rejects mismatched immutable release metadata', () => {
    const publish = namedStep('Publish immutable A/B prerelease').run ?? ''

    expect(publish).toMatch(
      /gh release view "\$RELEASE_TAG" --json isDraft,isPrerelease,tagName,targetCommitish,name,body,assets/u,
    )
    expect(publish).toMatch(/\.tagName[^]*RELEASE_TAG/u)
    expect(publish).toMatch(/\.targetCommitish[^]*GITHUB_SHA/u)
    expect(publish).toMatch(/\.isPrerelease[^]*true/u)
    expect(publish).toMatch(/\.name[^]*APP_VERSION/u)
    expect(publish).toMatch(/\.body[^]*RELEASE_NOTES/u)
    expect(publish).toMatch(/release tag[^]*does not match/iu)
    expect(publish).toMatch(/different commit/iu)
    expect(publish).toMatch(/metadata[^]*does not match/iu)
    expect(publish).toMatch(/isDraft[^]*immutable_state=draft/u)
    expect(publish).toMatch(
      /gh release create "\$RELEASE_TAG"[^]*--draft[^]*--target "\$GITHUB_SHA"/u,
    )
  })

  it('resumes a same-SHA published prerelease only when every immutable asset exists', () => {
    const source = workflowSource()
    const publish = namedStep('Publish immutable A/B prerelease').run ?? ''

    expect(source).toContain('render-update-manifest.mjs')
    expect(source).toContain('latest-test-k1.json')
    expect(source).toContain('openloop-test-rolling')
    expect(source).toContain('/releases/download/openloop-test-rolling/latest-test-k1.json')
    expect(source).not.toContain('/releases/latest')
    expect(publish).toMatch(/gh release create[^]*--prerelease/u)
    expect(publish).toMatch(/immutable_state=published/u)
    expect(publish).toMatch(/published immutable prerelease[^]*resume rolling/iu)
    expect(publish).toMatch(
      /gh release download "\$RELEASE_TAG"[^]*Openloop\.app\.tar\.gz[^]*Openloop\.app\.tar\.gz\.sig/u,
    )
    expect(publish).toContain(
      'published_assets_dir="$(mktemp -d "${GITHUB_WORKSPACE}/.openloop-published-assets.XXXXXX")"',
    )
    expect(publish).not.toContain('published_assets_dir="$(mktemp -d)"')
    expect(publish).toMatch(
      /render-update-manifest\.mjs[^]*--artifact "\$published_updater"[^]*--signature "\$published_signature"/u,
    )
    expect(publish).toMatch(/if test "\$immutable_state" = draft; then/u)
    expect(publish).toMatch(/gh release upload "\$RELEASE_TAG"[^]*--clobber/u)
    expect(publish).toMatch(/gh release edit "\$RELEASE_TAG" --draft=false[^]*fi/u)
    for (const asset of [
      'Openloop.app.tar.gz',
      'Openloop.app.tar.gz.sig',
      '.dmg',
      'openloop-core.json',
      'openloop-artifacts.json',
      'openloop-runtime-sbom-inputs.json',
    ]) {
      expect(publish).toContain(asset)
    }
    expect(publish).toContain(
      'validate_required_assets "$release_json" "published immutable prerelease"',
    )
    expect(publish).toMatch(/is missing asset[^]*exit 1/iu)
    expect(source).not.toMatch(/(?:docs\/|screenshots?)/iu)
  })

  it('orders immutable inspection and conditional mutation before rolling upload', () => {
    const source = workflowSource()
    const publish = namedStep('Publish immutable A/B prerelease').run ?? ''
    const releaseStep = source.indexOf('- name: Publish immutable A/B prerelease')
    const rollingStep = source.indexOf('- name: Publish deterministic rolling test manifest')
    const inspect = publish.indexOf(
      'gh release view "$RELEASE_TAG" --json isDraft,isPrerelease,tagName,targetCommitish,name,body,assets',
    )
    const publishedResume = publish.indexOf('immutable_state=published')
    const mutationGate = publish.indexOf('if test "$immutable_state" = draft; then')
    const create = publish.indexOf('gh release create "$RELEASE_TAG"')
    const upload = publish.indexOf('gh release upload "$RELEASE_TAG"')
    const verify = publish.lastIndexOf('validate_required_assets "$release_json"')
    const finalize = publish.indexOf('gh release edit "$RELEASE_TAG" --draft=false')

    expect(source.indexOf('pnpm openloop:build-desktop')).toBeLessThan(releaseStep)
    expect(source.indexOf('render-update-manifest.mjs')).toBeLessThan(releaseStep)
    expect(inspect).toBeGreaterThanOrEqual(0)
    expect(inspect).toBeLessThan(publishedResume)
    expect(publishedResume).toBeLessThan(mutationGate)
    expect(create).toBeGreaterThanOrEqual(0)
    expect(create).toBeLessThan(upload)
    expect(upload).toBeLessThan(verify)
    expect(verify).toBeLessThan(finalize)
    expect(releaseStep).toBeLessThan(rollingStep)
  })

  it('serializes every rolling test publication without cancelling an in-flight release', () => {
    const source = workflowSource()

    expect(source).toMatch(/concurrency:\s*\n\s+group:\s*openloop-test-release\s*\n\s+cancel-in-progress:\s*false/mu)
  })
})
