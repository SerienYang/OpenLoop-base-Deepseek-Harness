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
  })

  it('checks out and preflights the exact protected main trigger SHA', () => {
    const source = workflowSource()
    const checkout = publishJob().steps?.find(step => step.uses === 'actions/checkout@v6')
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

  it('rejects an exact remote tag while allowing only a matching draft release to resume', () => {
    const source = workflowSource()
    const preflight = source.slice(
      source.indexOf('- name: Validate isolated test release inputs'),
      source.indexOf('- name: Install immutable dependencies'),
    )
    const publish = namedStep('Publish immutable A/B prerelease').run ?? ''

    expect(preflight).toMatch(
      /REMOTE_TAG=.*git ls-remote[^]*refs\/tags\/\$\{RELEASE_TAG\}/u,
    )
    expect(preflight).toMatch(/test -z "\$REMOTE_TAG"/u)
    expect(preflight).not.toMatch(/if git ls-remote/u)
    expect(preflight).toMatch(/remote tag[^]*already exists|already exists[^]*remote tag/iu)
    expect(publish).toMatch(
      /gh release view "\$RELEASE_TAG" --json isDraft,targetCommitish/u,
    )
    expect(publish).toMatch(/isDraft[^]*true/iu)
    expect(publish).toMatch(/targetCommitish[^]*GITHUB_SHA/u)
    expect(publish).toMatch(/published[^]*(?:refus|forbid|reject|immutable)/iu)
    expect(publish).toMatch(
      /gh release create "\$RELEASE_TAG"[^]*--draft[^]*--target "\$GITHUB_SHA"/u,
    )
  })

  it('uploads and verifies every immutable asset before publishing the draft', () => {
    const source = workflowSource()
    const publish = namedStep('Publish immutable A/B prerelease').run ?? ''

    expect(source).toContain('render-update-manifest.mjs')
    expect(source).toContain('latest-test-k1.json')
    expect(source).toContain('openloop-test-rolling')
    expect(source).toContain('/releases/download/openloop-test-rolling/latest-test-k1.json')
    expect(source).not.toContain('/releases/latest')
    expect(publish).toMatch(/gh release create[^]*--prerelease/u)
    expect(publish).toMatch(/gh release upload "\$RELEASE_TAG"[^]*--clobber/u)
    expect(publish).toMatch(/gh release view "\$RELEASE_TAG" --json [^\n]*assets/u)
    expect(publish).toMatch(/gh release edit "\$RELEASE_TAG" --draft=false/u)
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
    expect(source).not.toMatch(/(?:docs\/|screenshots?)/iu)
  })

  it('creates the draft only after builds and publishes it only after asset verification', () => {
    const source = workflowSource()
    const publish = namedStep('Publish immutable A/B prerelease').run ?? ''
    const releaseStep = source.indexOf('- name: Publish immutable A/B prerelease')
    const rollingStep = source.indexOf('- name: Publish deterministic rolling test manifest')
    const create = publish.indexOf('gh release create "$RELEASE_TAG"')
    const upload = publish.indexOf('gh release upload "$RELEASE_TAG"')
    const verify = publish.lastIndexOf('gh release view "$RELEASE_TAG"')
    const finalize = publish.indexOf('gh release edit "$RELEASE_TAG" --draft=false')

    expect(source.indexOf('pnpm openloop:build-desktop')).toBeLessThan(releaseStep)
    expect(source.indexOf('render-update-manifest.mjs')).toBeLessThan(releaseStep)
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
