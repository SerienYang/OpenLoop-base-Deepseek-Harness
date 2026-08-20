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

describe('Openloop spike release workflow', () => {
  it('is valid YAML with a manual-only Apple Silicon publication job', () => {
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
    expect(source).toContain('test "$(uname -m)" = arm64')
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

  it('fails closed on repository and updater credentials and uses one exact build command', () => {
    const source = workflowSource()
    const buildCommand = 'pnpm openloop:build-desktop -- --channel test --target aarch64-apple-darwin --bundle all'

    expect(source).toContain("github.repository == 'SerienYang/OpenLoop-base-Deepseek-Harness'")
    expect(source).toContain('pnpm install --frozen-lockfile')
    expect(source).toContain(
      'TAURI_SIGNING_PRIVATE_KEY: ${{ secrets.OPENLOOP_TEST_UPDATER_PRIVATE_KEY }}',
    )
    expect(source).toContain(
      'TAURI_SIGNING_PRIVATE_KEY_PASSWORD: ${{ secrets.OPENLOOP_TEST_UPDATER_PRIVATE_KEY_PASSWORD }}',
    )
    expect(source).toContain(
      'OPENLOOP_UPDATER_PUBLIC_KEY: ${{ vars.OPENLOOP_TEST_UPDATER_PUBLIC_KEY }}',
    )
    expect(source).toMatch(/TAURI_SIGNING_PRIVATE_KEY[^]*must be configured/iu)
    expect(source).toMatch(/TAURI_SIGNING_PRIVATE_KEY_PASSWORD[^]*must be configured/iu)
    expect(source).toMatch(/OPENLOOP_UPDATER_PUBLIC_KEY[^]*must be configured/iu)
    expect(source.split(buildCommand)).toHaveLength(2)
    expect(source).not.toMatch(/\b(?:cargo|pnpm exec) tauri build\b/u)
    expect(source).not.toContain('deepseek-openloop')
  })

  it('renders and publishes signed immutable assets plus the deterministic rolling manifest', () => {
    const source = workflowSource()

    expect(source).toContain('render-update-manifest.mjs')
    expect(source).toContain('latest-test-k1.json')
    expect(source).toContain('openloop-test-rolling')
    expect(source).toContain('/releases/download/openloop-test-rolling/latest-test-k1.json')
    expect(source).not.toContain('/releases/latest')
    expect(source).toMatch(/gh release create[^]*--prerelease/u)
    expect(source).toMatch(/gh release upload[^]*--clobber/u)
    for (const asset of [
      'Openloop.app.tar.gz',
      'Openloop.app.tar.gz.sig',
      '.dmg',
      'openloop-core.json',
      'openloop-artifacts.json',
      'openloop-runtime-sbom-inputs.json',
    ]) {
      expect(source).toContain(asset)
    }
    expect(source).not.toMatch(/(?:docs\/|screenshots?)/iu)
  })

  it('serializes every rolling test publication without cancelling an in-flight release', () => {
    const source = workflowSource()

    expect(source).toMatch(/concurrency:\s*\n\s+group:\s*openloop-test-release\s*\n\s+cancel-in-progress:\s*false/mu)
  })
})
