import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = '/repo'
const modulePath: string = './build-e2e.mjs'

interface E2ePaths {
  readonly targetDir: string
  readonly app: string
  readonly binary: string
  readonly releaseApp: string
}

interface BuildCommand {
  readonly command: string
  readonly args: readonly string[]
  readonly cwd: string
  readonly env?: NodeJS.ProcessEnv
}

interface E2eBuildDependencies {
  readonly root: string
  readonly withBuildLock: (
    root: string,
    operation: () => Promise<E2ePaths>,
  ) => Promise<E2ePaths>
  readonly runner: {
    run(command: BuildCommand): Promise<void>
  }
  readonly files: {
    generateBundleGraph(root: string, web: string, graph: string): Promise<void>
    exists(path: string): boolean
  }
  readonly generateArtifactManifest: (options: { readonly out: string }) => void
}

interface E2eModule {
  readonly E2eBuilder: new (dependencies: E2eBuildDependencies) => {
    build(): Promise<E2ePaths>
  }
  readonly e2eBuildPaths: (root: string) => E2ePaths
}

async function loadE2eModule(): Promise<E2eModule> {
  return await import(modulePath) as E2eModule
}

function dependencies(binaryExists = true): {
  readonly value: E2eBuildDependencies
  readonly calls: Array<{
    readonly command: string
    readonly args: readonly string[]
    readonly cwd: string
    readonly env?: NodeJS.ProcessEnv
  }>
  readonly generated: string[]
  readonly lockEvents: string[]
} {
  const calls: Array<{
    command: string
    args: readonly string[]
    cwd: string
    env?: NodeJS.ProcessEnv
  }> = []
  const generated: string[] = []
  const lockEvents: string[] = []
  let lockHeld = false
  return {
    calls,
    generated,
    lockEvents,
    value: {
      root,
      async withBuildLock(_root, operation) {
        lockEvents.push('acquire')
        lockHeld = true
        try {
          return await operation()
        } finally {
          lockHeld = false
          lockEvents.push('release')
        }
      },
      runner: {
        async run(command) {
          expect(lockHeld).toBe(true)
          calls.push(command)
        },
      },
      files: {
        async generateBundleGraph(_root, web, graph) {
          expect(lockHeld).toBe(true)
          generated.push(`graph:${web}:${graph}`)
        },
        exists(path) {
          expect(lockHeld).toBe(true)
          return binaryExists && path === join(
            root,
            '.artifacts/openloop-e2e-target/aarch64-apple-darwin/release/bundle/macos/Openloop E2E.app/Contents/MacOS/openloop-desktop',
          )
        },
      },
      generateArtifactManifest(options) {
        expect(lockHeld).toBe(true)
        generated.push(`manifest:${options.out}`)
      },
    },
  }
}

describe('Openloop E2E build', () => {
  it('uses an ignored Cargo target and binary disjoint from release output', async () => {
    const { e2eBuildPaths } = await loadE2eModule()
    const paths = e2eBuildPaths(root)

    expect(paths.targetDir).toBe(join(root, '.artifacts/openloop-e2e-target'))
    expect(paths.app).toBe(join(
      paths.targetDir,
      'aarch64-apple-darwin/release/bundle/macos/Openloop E2E.app',
    ))
    expect(paths.binary).toBe(join(paths.app, 'Contents/MacOS/openloop-desktop'))
    expect(paths.releaseApp).toBe(join(
      root,
      'apps/openloop-desktop/src-tauri/target/aarch64-apple-darwin/release/bundle/macos/Openloop.app',
    ))
    expect(paths.app.startsWith(paths.releaseApp)).toBe(false)
    expect(paths.releaseApp.startsWith(paths.app)).toBe(false)
  })

  it('builds libraries, web, runtime, manifests, then Tauri in the isolated target', async () => {
    const { E2eBuilder, e2eBuildPaths } = await loadE2eModule()
    const fixture = dependencies()

    await new E2eBuilder(fixture.value).build()

    const paths = e2eBuildPaths(root)
    expect(fixture.calls).toEqual([
      {
        command: 'pnpm',
        args: ['run', 'build'],
        cwd: root,
      },
      {
        command: 'pnpm',
        args: ['--dir', 'apps/openloop-desktop', 'run', 'manifest:test'],
        cwd: root,
      },
      {
        command: 'pnpm',
        args: [
          'exec',
          'tsx',
          'scripts/openloop/build-runtime-exe.ts',
          '--target',
          'aarch64-apple-darwin',
          '--skip-build',
        ],
        cwd: root,
      },
      {
        command: 'pnpm',
        args: [
          '--dir',
          'apps/openloop-desktop',
          'exec',
          'tauri',
          'build',
          '--target',
          'aarch64-apple-darwin',
          '--bundles',
          'app',
          '--features',
          'openloop-e2e',
          '--config',
          'tauri.e2e.conf.json',
          '--ci',
        ],
        cwd: root,
        env: {
          CARGO_TARGET_DIR: paths.targetDir,
        },
      },
    ])
    expect(fixture.generated).toEqual([
      `graph:${join(root, 'apps/web/dist')}:${join(root, 'dist-openloop/openloop-web-bundle-graph.json')}`,
      `manifest:${join(root, 'dist-openloop/openloop-artifacts.json')}`,
    ])
    expect(fixture.lockEvents).toEqual(['acquire', 'release'])
  })

  it('fails when Tauri does not produce the isolated binary', async () => {
    const { E2eBuilder } = await loadE2eModule()
    const fixture = dependencies(false)

    await expect(new E2eBuilder(fixture.value).build()).rejects.toThrow(
      'isolated E2E binary is missing',
    )
    expect(fixture.lockEvents).toEqual(['acquire', 'release'])
  })
})
