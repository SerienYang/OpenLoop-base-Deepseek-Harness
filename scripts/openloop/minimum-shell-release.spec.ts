import fs from 'node:fs'
import path from 'node:path'
import { load } from 'js-yaml'
import { describe, expect, it } from 'vitest'

const repositoryRoot = path.resolve(import.meta.dirname, '../..')
const workflowPath = path.join(
  repositoryRoot,
  '.github/workflows/openloop-spike-release.yml',
)

interface WorkflowStep {
  readonly name?: string
  readonly env?: Record<string, unknown>
  readonly run?: string
  readonly 'timeout-minutes'?: number
}

function publishSteps(): WorkflowStep[] {
  const workflow = load(fs.readFileSync(workflowPath, 'utf8')) as {
    readonly jobs?: Record<string, { readonly steps?: WorkflowStep[] }>
  }
  const steps = workflow.jobs?.['publish-test']?.steps
  expect(steps).toBeDefined()
  return steps ?? []
}

function namedStep(steps: readonly WorkflowStep[], name: string): WorkflowStep {
  const step = steps.find(candidate => candidate.name === name)
  expect(step, `missing workflow step: ${name}`).toBeDefined()
  return step ?? {}
}

describe('minimum Openloop shell release gates', () => {
  it('builds host workspace prerequisites before loading gate scripts', () => {
    const steps = publishSteps()
    const install = steps.indexOf(namedStep(
      steps,
      'Install immutable dependencies',
    ))
    const buildHost = steps.indexOf(namedStep(
      steps,
      'Build host workspace prerequisites',
    ))
    const installPlaywright = steps.indexOf(namedStep(
      steps,
      'Install Playwright Chromium',
    ))

    const buildHostStep = namedStep(
      steps,
      'Build host workspace prerequisites',
    )
    expect(buildHostStep.run).toBe('pnpm run build:lib:host')
    expect(buildHostStep['timeout-minutes']).toBe(15)
    expect(buildHost).toBeGreaterThan(install)
    expect(buildHost).toBeLessThan(installPlaywright)
  })

  it('runs every exact minimum-shell gate in an auditable order', () => {
    const steps = publishSteps()
    const expected = [
      {
        name: 'Install Playwright Chromium',
        run: 'pnpm exec playwright install chromium',
      },
      {
        name: 'Verify the assembled minimum Openloop shell',
        run: 'DSH_SNAPSHOT=replay pnpm openloop:gate-test -- playwright --file apps/web/tests/openloop-minimum-shell.e2e.ts',
      },
      {
        name: 'Verify native credential migration',
        run: 'pnpm openloop:gate-test -- cargo --manifest apps/openloop-desktop/src-tauri/Cargo.toml --test credential_migration',
      },
      {
        name: 'Verify native Workspace authority',
        run: 'pnpm openloop:gate-test -- cargo --manifest apps/openloop-desktop/src-tauri/Cargo.toml --test workspace_authority',
      },
      {
        name: 'Verify native update rollback and cleanup',
        run: [
          'pnpm openloop:gate-test -- cargo --manifest apps/openloop-desktop/src-tauri/Cargo.toml --test update',
          'pnpm openloop:gate-test -- cargo --manifest apps/openloop-desktop/src-tauri/Cargo.toml --test update_coordinator',
        ].join('\n'),
      },
      {
        name: 'Verify the real Tauri shell',
        run: 'pnpm openloop:gate-test -- wdio --config apps/openloop-desktop/wdio.conf.ts --binary ".artifacts/openloop-e2e-target/aarch64-apple-darwin/release/bundle/macos/Openloop E2E.app/Contents/MacOS/openloop-desktop" --file apps/openloop-desktop/tests/openloop-shell.e2e.ts',
      },
      {
        name: 'Verify release defaults exclude WDIO',
        run: 'pnpm openloop:gate-test -- vitest --files apps/openloop-desktop/tests/config.spec.ts scripts/openloop/build-desktop.spec.ts',
      },
    ] as const

    const indexes = expected.map(({ name, run }) => {
      const step = namedStep(steps, name)
      expect(step.run).toBe(run)
      return steps.indexOf(step)
    })

    expect(indexes).toEqual([...indexes].sort((left, right) => left - right))
  })

  it('finishes all gates before signing or publishing without exposing release secrets', () => {
    const steps = publishSteps()
    const firstReleaseSecret = steps.findIndex(step =>
      Object.keys(step.env ?? {}).some(key => key.startsWith('TAURI_SIGNING_')),
    )
    const firstPublish = steps.findIndex(step => step.run?.includes('gh release'))
    const finalGate = steps.indexOf(namedStep(
      steps,
      'Verify release defaults exclude WDIO',
    ))

    expect(firstReleaseSecret).toBeGreaterThan(finalGate)
    expect(firstPublish).toBeGreaterThan(finalGate)
    for (const step of steps.slice(0, finalGate + 1)) {
      expect(step.env ?? {}).not.toHaveProperty('TAURI_SIGNING_PRIVATE_KEY')
      expect(step.env ?? {}).not.toHaveProperty('TAURI_SIGNING_PRIVATE_KEY_PASSWORD')
    }
  })

  it('runs fixed-version contracts before mutating the workspace version', () => {
    const steps = publishSteps()
    const finalGate = steps.indexOf(namedStep(
      steps,
      'Verify release defaults exclude WDIO',
    ))
    const setVersion = steps.indexOf(namedStep(
      steps,
      'Set the workspace-local desktop version',
    ))
    const signedBuild = steps.indexOf(namedStep(
      steps,
      'Build and verify the signed test desktop',
    ))

    expect(setVersion).toBeGreaterThan(finalGate)
    expect(setVersion).toBeLessThan(signedBuild)
  })

  it('bounds every minimum-shell release gate', () => {
    const steps = publishSteps()
    const expectedTimeouts = new Map([
      ['Install Playwright Chromium', 10],
      ['Verify the assembled minimum Openloop shell', 15],
      ['Verify native credential migration', 20],
      ['Verify native Workspace authority', 20],
      ['Verify native update rollback and cleanup', 30],
      ['Verify the real Tauri shell', 30],
      ['Verify release defaults exclude WDIO', 10],
    ])

    for (const [name, timeout] of expectedTimeouts) {
      expect(namedStep(steps, name)['timeout-minutes']).toBe(timeout)
    }
  })

  it('keeps the signed release build on the default non-WDIO feature set', () => {
    const build = namedStep(
      publishSteps(),
      'Build and verify the signed test desktop',
    ).run ?? ''

    expect(build).toContain(
      'pnpm openloop:build-desktop -- --channel test --target aarch64-apple-darwin --bundle all',
    )
    expect(build).not.toMatch(/openloop-e2e|tauri\.e2e\.conf\.json|--features/u)
  })
})
