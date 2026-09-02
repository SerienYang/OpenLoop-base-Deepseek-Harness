#!/usr/bin/env node

import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  createProcessRunner,
  nodeFileSystem,
} from './build-desktop.mjs'
import { generateArtifactManifest } from './generate-artifact-manifest.mjs'

const TARGET = 'aarch64-apple-darwin'

export function e2eBuildPaths(root) {
  const repositoryRoot = resolve(root)
  const targetDir = join(repositoryRoot, '.artifacts/openloop-e2e-target')
  const app = join(
    targetDir,
    `${TARGET}/release/bundle/macos/Openloop E2E.app`,
  )
  return {
    root: repositoryRoot,
    targetDir,
    app,
    binary: join(app, 'Contents/MacOS/openloop-desktop'),
    releaseApp: join(
      repositoryRoot,
      `apps/openloop-desktop/src-tauri/target/${TARGET}/release/bundle/macos/Openloop.app`,
    ),
    core: join(repositoryRoot, 'dist-openloop/openloop-core.json'),
    sidecar: join(repositoryRoot, `dist-openloop/openloop-runtime-${TARGET}`),
    runtimeSbom: join(repositoryRoot, 'dist-openloop/openloop-runtime-sbom-inputs.json'),
    web: join(repositoryRoot, 'apps/web/dist'),
    bundleGraph: join(repositoryRoot, 'dist-openloop/openloop-web-bundle-graph.json'),
    artifacts: join(repositoryRoot, 'dist-openloop/openloop-artifacts.json'),
  }
}

export class E2eBuilder {
  constructor(dependencies) {
    this.dependencies = dependencies
  }

  async build() {
    const { root, runner, files, generateArtifactManifest: generate } = this.dependencies
    const paths = e2eBuildPaths(root)
    await runner.run({
      command: 'pnpm',
      args: ['run', 'build'],
      cwd: paths.root,
    })
    await runner.run({
      command: 'pnpm',
      args: ['--dir', 'apps/openloop-desktop', 'run', 'manifest:test'],
      cwd: paths.root,
    })
    await runner.run({
      command: 'pnpm',
      args: [
        'exec',
        'tsx',
        'scripts/openloop/build-runtime-exe.ts',
        '--target',
        TARGET,
        '--skip-build',
      ],
      cwd: paths.root,
    })
    await files.generateBundleGraph(paths.root, paths.web, paths.bundleGraph)
    generate({
      core: paths.core,
      sidecar: paths.sidecar,
      runtimeSbom: paths.runtimeSbom,
      web: paths.web,
      bundleGraph: paths.bundleGraph,
      out: paths.artifacts,
    })
    await runner.run({
      command: 'pnpm',
      args: [
        '--dir',
        'apps/openloop-desktop',
        'exec',
        'tauri',
        'build',
        '--target',
        TARGET,
        '--bundles',
        'app',
        '--features',
        'openloop-e2e',
        '--config',
        'tauri.e2e.conf.json',
        '--ci',
      ],
      cwd: paths.root,
      env: { CARGO_TARGET_DIR: paths.targetDir },
    })
    if (!files.exists(paths.binary)) {
      throw new Error(`build-e2e: isolated E2E binary is missing: ${paths.binary}`)
    }
    return paths
  }
}

export function createE2eBuilder(root = fileURLToPath(new URL('../..', import.meta.url))) {
  const repositoryRoot = resolve(root)
  return new E2eBuilder({
    root: repositoryRoot,
    runner: createProcessRunner(),
    files: {
      generateBundleGraph: nodeFileSystem.generateBundleGraph,
      exists: existsSync,
    },
    generateArtifactManifest: options =>
      generateArtifactManifest(options, { trustedRoot: repositoryRoot }),
  })
}

const isMain = process.argv[1] !== undefined
  && resolve(process.argv[1]) === fileURLToPath(import.meta.url)

if (isMain) {
  try {
    const paths = await createE2eBuilder().build()
    process.stdout.write(`build-e2e: produced ${paths.binary}\n`)
  } catch (error) {
    process.stderr.write(
      `build-e2e: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`,
    )
    process.exitCode = 1
  }
}
