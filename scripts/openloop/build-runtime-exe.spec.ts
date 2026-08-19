import { createHash } from 'node:crypto'
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { describe, expect, test, vi } from 'vitest'
import {
  ASSET_GLOBS,
  OUTPUT_BASENAME,
  RuntimeExeBuilder,
  collectSbomInputs,
  computeRuntimeManifest,
  materializeSymlinks,
  parseRuntimeBuildArgs,
  prepareDeploymentWorkspace,
  type BuildCommand,
  type PackageManifest,
  type RuntimeBuildFileSystem,
  type RuntimeBuildRunner,
  type WorkspaceManifest,
} from './build-runtime-exe.ts'

function temporaryDirectory(label: string): string {
  return mkdtempSync(join(tmpdir(), `openloop-builder-${label}-`))
}

function write(path: string, content: string | Buffer): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content)
}

function workspaceFixture(): ReadonlyMap<string, WorkspaceManifest> {
  return new Map([
    ['@openloop/runtime', {
      path: 'apps/openloop-runtime/package.json',
      manifest: {
        name: '@openloop/runtime',
        version: '0.1.0',
        dependencies: {
          '@openloop/bundle': 'workspace:^',
          '@openloop/build-contract': 'workspace:^',
        },
        optionalDependencies: {
          '@deepseek-ai/dsh-web-app': 'workspace:^',
        },
      },
    }],
    ['@openloop/bundle', {
      path: 'packages/openloop/bundle/package.json',
      manifest: {
        name: '@openloop/bundle',
        version: '0.1.0',
        dependencies: {
          '@deepseek-ai/dsh-base': 'workspace:^',
        },
        peerDependencies: {
          '@deepseek-ai/cordis': 'workspace:^',
        },
      },
    }],
    ['@openloop/build-contract', {
      path: 'packages/openloop/build-contract/package.json',
      manifest: {
        name: '@openloop/build-contract',
        version: '0.1.0',
        peerDependencies: {
          '@deepseek-ai/cordis': 'workspace:^',
          '@deepseek-ai/dsh-invariants': 'workspace:^',
        },
      },
    }],
    ['@deepseek-ai/dsh-base', {
      path: 'packages/bundle/base/package.json',
      manifest: {
        name: '@deepseek-ai/dsh-base',
        version: '0.1.0',
        dependencies: {
          '@deepseek-ai/dsh-app-boot': 'workspace:^',
        },
      },
    }],
    ['@deepseek-ai/dsh-web-app', {
      path: 'packages/bundle/web-app/package.json',
      manifest: {
        name: '@deepseek-ai/dsh-web-app',
        version: '0.1.0',
        dependencies: {
          '@deepseek-ai/dsh-web-frontend': 'workspace:^',
        },
      },
    }],
    ['@deepseek-ai/dsh-web-frontend', {
      path: 'apps/web/package.json',
      manifest: {
        name: '@deepseek-ai/dsh-web-frontend',
        version: '0.1.0',
      },
    }],
    ['@deepseek-ai/dsh-app-boot', {
      path: 'packages/boot/app-boot/package.json',
      manifest: {
        name: '@deepseek-ai/dsh-app-boot',
        version: '0.1.0',
      },
    }],
    ['@deepseek-ai/cordis', {
      path: 'vendor/cordis/package.json',
      manifest: {
        name: '@deepseek-ai/cordis',
        version: '0.1.0',
      },
    }],
    ['@deepseek-ai/dsh-invariants', {
      path: 'packages/runtime-diagnostics/invariants/package.json',
      manifest: {
        name: '@deepseek-ai/dsh-invariants',
        version: '0.1.0',
      },
    }],
  ])
}

describe('Openloop runtime deploy-root closure', () => {
  test('computes a sorted fixed point including optional dependencies and nonoptional workspace peers', () => {
    const first = computeRuntimeManifest(workspaceFixture(), '@openloop/runtime')
    const second = computeRuntimeManifest(new Map([...workspaceFixture()].reverse()), '@openloop/runtime')

    expect(second).toEqual(first)
    expect(Object.keys(first.dependencies ?? {})).toEqual([
      '@deepseek-ai/cordis',
      '@deepseek-ai/dsh-app-boot',
      '@deepseek-ai/dsh-base',
      '@deepseek-ai/dsh-invariants',
      '@deepseek-ai/dsh-web-app',
      '@deepseek-ai/dsh-web-frontend',
      '@openloop/build-contract',
      '@openloop/bundle',
      '@openloop/runtime',
    ])
    expect(first).toMatchObject({
      name: 'openloop-runtime-pkg',
      private: true,
      type: 'module',
    })
  })

  test('does not promote optional workspace peers', () => {
    const workspace = new Map(workspaceFixture())
    const bundle = workspace.get('@openloop/bundle')
    if (bundle === undefined) throw new Error('fixture missing bundle')
    workspace.set('@openloop/bundle', {
      ...bundle,
      manifest: {
        ...bundle.manifest,
        peerDependencies: { '@optional/peer': 'workspace:^' },
        peerDependenciesMeta: { '@optional/peer': { optional: true } },
      },
    })
    workspace.set('@optional/peer', {
      path: 'packages/optional/peer/package.json',
      manifest: { name: '@optional/peer', version: '0.1.0' },
    })

    const generated = computeRuntimeManifest(workspace, '@openloop/runtime')
    expect(generated.dependencies).not.toHaveProperty('@optional/peer')
  })
})

describe('Openloop macOS arm64 single-exe builder', () => {
  test('accepts only the Tauri aarch64-apple-darwin target', () => {
    expect(parseRuntimeBuildArgs(['--target', 'aarch64-apple-darwin']).target)
      .toBe('aarch64-apple-darwin')
    expect(() => parseRuntimeBuildArgs(['--target', 'x86_64-apple-darwin']))
      .toThrow(/aarch64-apple-darwin/iu)
    expect(() => parseRuntimeBuildArgs(['--target', 'node24-macos-arm64']))
      .toThrow(/aarch64-apple-darwin/iu)
  })

  test('declares the complete pkg asset boundary', () => {
    expect(ASSET_GLOBS).toEqual(expect.arrayContaining([
      'node_modules/**/*.js',
      'node_modules/**/*.cjs',
      'node_modules/**/*.mjs',
      'node_modules/**/*.json',
      'node_modules/**/*.yml',
      'node_modules/**/*.yaml',
      'node_modules/**/package.json',
      'node_modules/**/*.node',
      'node_modules/**/*.dylib',
      'node_modules/**/*.wasm',
      'node_modules/@deepseek-ai/dsh-web-frontend/dist/**/*',
      'node_modules/@deepseek-ai/dsh/config/**/*',
      'node_modules/@openloop/runtime/openloop-core.json',
    ]))
  })

  test('runs build, closure sync/check, deploy, pkg, and sidecar copy in order', async () => {
    const root = temporaryDirectory('commands')
    const commands: BuildCommand[] = []
    const events: string[] = []
    const runner: RuntimeBuildRunner = {
      run: vi.fn(async (command: BuildCommand) => {
        commands.push(command)
        events.push(`command:${command.command} ${command.args.join(' ')}`)
      }),
    }
    const files = {
      ...RuntimeExeBuilder.nodeFileSystem,
      exists: () => true,
      prepareDeploymentWorkspace: vi.fn(async () => {
        events.push('isolate')
        return join(root, 'dist-openloop/runtime-deploy-workspace')
      }),
      cleanupDeploymentWorkspace: vi.fn(async () => { events.push('cleanup-isolate') }),
      synchronizeClosure: vi.fn(async () => { events.push('closure') }),
      prepareStaging: vi.fn(async () => { events.push('prepare') }),
      injectCoreManifest: vi.fn(async () => { events.push('core') }),
      patchPkgManifest: vi.fn(async () => { events.push('pkg-manifest') }),
      copyProducts: vi.fn(async () => { events.push('copy') }),
      writeSbom: vi.fn(async () => { events.push('sbom') }),
    } satisfies RuntimeBuildFileSystem
    const builder = new RuntimeExeBuilder({
      root,
      target: 'aarch64-apple-darwin',
      skipBuild: false,
      runner,
      files,
    })

    await builder.build()

    expect(commands.map(command => [command.command, ...command.args])).toEqual([
      ['pnpm', 'run', 'build'],
      [
        'pnpm',
        '--filter',
        'openloop-runtime-pkg',
        'deploy',
        '--legacy',
        '--prod',
        '--ignore-scripts',
        '--config.node-linker=hoisted',
        '--config.auto-install-peers=false',
        '--config.link-workspace-packages=true',
        join(root, 'dist-openloop/runtime-staging'),
      ],
      [
        'pnpm',
        'dlx',
        '@yao-pkg/pkg@6.21.0',
        join(root, 'dist-openloop/runtime-staging'),
        '--sea',
        '--targets',
        'node24-macos-arm64',
        '--output',
        join(root, `dist-openloop/${OUTPUT_BASENAME}`),
      ],
    ])
    expect(events).toEqual([
      'command:pnpm run build',
      'closure',
      'isolate',
      `command:pnpm --filter openloop-runtime-pkg deploy --legacy --prod --ignore-scripts --config.node-linker=hoisted --config.auto-install-peers=false --config.link-workspace-packages=true ${join(root, 'dist-openloop/runtime-staging')}`,
      'prepare',
      'cleanup-isolate',
      'core',
      'pkg-manifest',
      `command:pnpm dlx @yao-pkg/pkg@6.21.0 ${join(root, 'dist-openloop/runtime-staging')} --sea --targets node24-macos-arm64 --output ${join(root, `dist-openloop/${OUTPUT_BASENAME}`)}`,
      'copy',
      'sbom',
    ])
    const deploy = commands.find(command => command.args.includes('deploy'))
    expect(deploy?.cwd).toBe(join(root, 'dist-openloop/runtime-deploy-workspace'))
    expect(files.prepareStaging).toHaveBeenCalledBefore(files.injectCoreManifest)
    expect(files.injectCoreManifest).toHaveBeenCalledBefore(files.patchPkgManifest)
    expect(files.patchPkgManifest).toHaveBeenCalledBefore(files.copyProducts)
    expect(files.copyProducts).toHaveBeenCalledBefore(files.writeSbom)
  })

  test('never deploys or installs production dependencies from the repository root', async () => {
    const root = temporaryDirectory('root-mutation')
    const violations: BuildCommand[] = []
    const deploys: BuildCommand[] = []
    const runner: RuntimeBuildRunner = {
      run: async (command) => {
        if (command.args.includes('deploy')) deploys.push(command)
        const productionInstall = command.args[0] === 'install'
          && command.args.some(argument => argument === '--prod' || argument === '--production')
        if (command.cwd === root && (command.args.includes('deploy') || productionInstall)) {
          violations.push(command)
        }
      },
    }
    const files = {
      ...RuntimeExeBuilder.nodeFileSystem,
      exists: () => true,
      clearStaging: async () => {},
      prepareDeploymentWorkspace: async () =>
        join(root, 'dist-openloop/runtime-deploy-workspace'),
      cleanupDeploymentWorkspace: async () => {},
      synchronizeClosure: async () => {},
      prepareStaging: async () => {},
      injectCoreManifest: async () => {},
      patchPkgManifest: async () => {},
      copyProducts: async () => {},
      writeSbom: async () => {},
    } satisfies RuntimeBuildFileSystem
    const builder = new RuntimeExeBuilder({
      root,
      target: 'aarch64-apple-darwin',
      skipBuild: true,
      runner,
      files,
    })

    await builder.build()

    expect(violations).toEqual([])
    expect(deploys).toHaveLength(1)
    expect(deploys[0]?.cwd).toBe(join(root, 'dist-openloop/runtime-deploy-workspace'))
    expect(deploys[0]?.args).toEqual(expect.arrayContaining([
      '--filter',
      'openloop-runtime-pkg',
      'deploy',
      '--prod',
      '--ignore-scripts',
    ]))
  })

  test('copies an isolated deploy workspace without source node_modules or generated binaries', async () => {
    const root = temporaryDirectory('deploy-isolation')
    write(join(root, 'package.json'), '{"name":"root","private":true}\n')
    write(join(root, 'pnpm-lock.yaml'), 'lockfileVersion: "9.0"\n')
    write(join(root, 'pnpm-workspace.yaml'), 'packages:\n  - apps/*\n')
    write(join(root, 'apps/demo/package.json'), '{"name":"demo"}\n')
    write(join(root, 'apps/demo/lib/index.js'), 'export {}\n')
    write(join(root, 'apps/demo/node_modules/forbidden/package.json'), '{"name":"forbidden"}\n')
    write(
      join(root, 'apps/openloop-desktop/src-tauri/binaries/forbidden'),
      'binary',
    )

    const isolated = await prepareDeploymentWorkspace(root)

    expect(readFileSync(join(isolated, 'apps/demo/lib/index.js'), 'utf8'))
      .toBe('export {}\n')
    expect(() => statSync(join(isolated, 'apps/demo/node_modules'))).toThrow()
    expect(() => statSync(
      join(isolated, 'apps/openloop-desktop/src-tauri/binaries'),
    )).toThrow()
  })

  test('rejects staging and output paths outside repository-owned boundaries', () => {
    const root = temporaryDirectory('boundary')
    expect(() => new RuntimeExeBuilder({
      root,
      target: 'aarch64-apple-darwin',
      skipBuild: true,
      staging: join(root, '..', 'escape'),
      runner: { run: async () => {} },
      files: RuntimeExeBuilder.nodeFileSystem,
    })).toThrow(/outside|boundary/iu)
  })

  test('materializes every symlink and leaves a zero-symlink staging tree', async () => {
    const root = temporaryDirectory('links')
    const external = join(root, 'external')
    const staging = join(root, 'staging')
    write(join(external, 'package.json'), '{"name":"linked"}\n')
    write(join(external, 'lib/index.js'), 'export {}\n')
    mkdirSync(join(staging, 'node_modules/@scope'), { recursive: true })
    symlinkSync(external, join(staging, 'node_modules/@scope/linked'))

    await materializeSymlinks(staging)

    const linked = join(staging, 'node_modules/@scope/linked')
    expect(lstatSync(linked).isSymbolicLink()).toBe(false)
    expect(readFileSync(join(linked, 'lib/index.js'), 'utf8')).toBe('export {}\n')
  })

  test('fails when the executable or node-pty helper is missing', async () => {
    const root = temporaryDirectory('missing')
    const builder = new RuntimeExeBuilder({
      root,
      target: 'aarch64-apple-darwin',
      skipBuild: true,
      runner: { run: async () => {} },
      files: RuntimeExeBuilder.nodeFileSystem,
    })

    await expect(builder.copyProducts()).rejects.toThrow(/missing/iu)
  })

  test('writes executable main and helper products with the canonical Tauri names', async () => {
    const root = temporaryDirectory('products')
    const executable = join(root, `dist-openloop/${OUTPUT_BASENAME}`)
    const helper = join(root, 'dist-openloop/runtime-staging/node_modules/node-pty/prebuilds/darwin-arm64/spawn-helper')
    write(executable, 'exe')
    write(helper, 'helper')
    chmodSync(helper, 0o644)
    const builder = new RuntimeExeBuilder({
      root,
      target: 'aarch64-apple-darwin',
      skipBuild: true,
      runner: { run: async () => {} },
      files: RuntimeExeBuilder.nodeFileSystem,
    })

    await builder.copyProducts()

    const binaries = join(root, 'apps/openloop-desktop/src-tauri/binaries')
    const mainProduct = join(binaries, OUTPUT_BASENAME)
    const helperProduct = join(
      binaries,
      'openloop-runtime-spawn-helper-aarch64-apple-darwin',
    )
    expect(readFileSync(mainProduct, 'utf8')).toBe('exe')
    expect(readFileSync(helperProduct, 'utf8')).toBe('helper')
    expect(statSync(mainProduct).mode & 0o111).not.toBe(0)
    expect(statSync(helperProduct).mode & 0o111).not.toBe(0)
  })
})

describe('Openloop runtime SBOM inputs', () => {
  test('hashes stable sorted paths for manifests, frontend, native files, helper, and patches', async () => {
    const root = temporaryDirectory('sbom')
    const paths = [
      'pnpm-lock.yaml',
      'runtime/openloop/package.json',
      'dist-openloop/openloop-core.json',
      'scripts/openloop/upstream-baseline.json',
      'dist-openloop/runtime-staging/package.json',
      'dist-openloop/runtime-staging/node_modules/a/package.json',
      'dist-openloop/runtime-staging/node_modules/@deepseek-ai/dsh-web-frontend/dist/index.html',
      'dist-openloop/runtime-staging/node_modules/node-pty/prebuilds/darwin-arm64/pty.node',
      'dist-openloop/runtime-staging/node_modules/@img/sharp-libvips-darwin-arm64/lib/libvips.dylib',
      'dist-openloop/runtime-staging/node_modules/node-pty/prebuilds/darwin-arm64/spawn-helper',
      'patches/node-pty.patch',
    ]
    for (const path of paths.reverse()) write(join(root, path), path)

    const inputs = await collectSbomInputs(root, join(root, 'dist-openloop/runtime-staging'))

    expect(inputs.map(input => input.path)).toEqual([...inputs.map(input => input.path)].sort())
    expect(inputs.map(input => input.path)).toEqual(expect.arrayContaining(paths))
    for (const input of inputs) {
      const bytes = readFileSync(join(root, input.path))
      expect(input.sha256).toBe(createHash('sha256').update(bytes).digest('hex'))
      expect(relative(root, join(root, input.path))).not.toMatch(/^\.\./u)
    }
  })
})

describe('Openloop runtime repository wiring', () => {
  const repositoryRoot = resolve(import.meta.dirname, '../..')

  test('registers the private runtime bin in the workspace and Host build', () => {
    const runtimePackage = JSON.parse(
      readFileSync(join(repositoryRoot, 'apps/openloop-runtime/package.json'), 'utf8'),
    ) as {
      name?: string
      private?: boolean
      bin?: Record<string, string>
    }
    const workspace = readFileSync(join(repositoryRoot, 'pnpm-workspace.yaml'), 'utf8')
    const hostConfig = readFileSync(join(repositoryRoot, 'tsconfig.host.json'), 'utf8')
    const rootTsdown = readFileSync(join(repositoryRoot, 'tsdown.config.ts'), 'utf8')
    const runtimeTsdown = readFileSync(
      join(repositoryRoot, 'apps/openloop-runtime/tsdown.config.ts'),
      'utf8',
    )

    expect(runtimePackage).toMatchObject({
      name: '@openloop/runtime',
      private: true,
      bin: { 'openloop-runtime': 'lib/bin.js' },
    })
    expect(workspace).toMatch(/-\s+runtime\/openloop/u)
    expect(hostConfig).toContain('{ "path": "./apps/openloop-runtime" }')
    expect(rootTsdown).toContain("'apps/openloop-runtime'")
    expect(runtimeTsdown).toContain("entry: ['lib/types/bin.js']")
  })

  test('keeps the generated deploy manifest closed over Web bundles and required peers', () => {
    const deploy = JSON.parse(
      readFileSync(join(repositoryRoot, 'runtime/openloop/package.json'), 'utf8'),
    ) as PackageManifest
    const dependencies = deploy.dependencies ?? {}

    expect(deploy.name).toBe('openloop-runtime-pkg')
    expect(Object.keys(dependencies)).toEqual(Object.keys(dependencies).sort())
    expect(dependencies).toEqual(expect.objectContaining({
      '@deepseek-ai/dsh-base': 'workspace:^',
      '@deepseek-ai/dsh-web-app': 'workspace:^',
      '@deepseek-ai/dsh-web-frontend': 'workspace:^',
      '@openloop/build-contract': 'workspace:^',
      '@openloop/bundle': 'workspace:^',
      '@openloop/runtime': 'workspace:^',
    }))

    const workspace = new Map<string, PackageManifest>()
    for (const path of [
      ...findPackageJson(repositoryRoot, 'apps'),
      ...findPackageJson(repositoryRoot, 'packages'),
      ...findPackageJson(repositoryRoot, 'vendor'),
    ]) {
      const manifest = JSON.parse(readFileSync(path, 'utf8')) as PackageManifest
      if (manifest.name !== undefined) workspace.set(manifest.name, manifest)
    }
    const missingPeers: string[] = []
    for (const name of Object.keys(dependencies)) {
      const manifest = workspace.get(name)
      for (const peer of Object.keys(manifest?.peerDependencies ?? {})) {
        if (manifest?.peerDependenciesMeta?.[peer]?.optional === true) continue
        if (workspace.has(peer) && dependencies[peer] === undefined) {
          missingPeers.push(`${name} -> ${peer}`)
        }
      }
    }
    expect(missingPeers).toEqual([])
  })

  test('keeps generated sidecars ignored at the Tauri binary boundary', () => {
    const ignore = readFileSync(
      join(repositoryRoot, 'apps/openloop-desktop/.gitignore'),
      'utf8',
    )
    expect(ignore).toMatch(/^\/src-tauri\/binaries\/$/mu)
  })
})

function findPackageJson(root: string, segment: string): string[] {
  const start = join(root, segment)
  const found: string[] = []
  const visit = (directory: string, depth: number): void => {
    if (depth > 3) return
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isFile() && entry.name === 'package.json') found.push(path)
      else if (entry.isDirectory()) visit(path, depth + 1)
    }
  }
  visit(start, 0)
  return found
}
