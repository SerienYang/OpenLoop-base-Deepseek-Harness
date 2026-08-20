import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { describe, expect, test, vi } from 'vitest'
import {
  ASSET_GLOBS,
  HELPER_BASENAME,
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
      '!node_modules/**/test/**/*',
      '!node_modules/**/tests/**/*',
      '!node_modules/**/__tests__/**/*',
      '!node_modules/**/fixture/**/*',
      '!node_modules/**/fixtures/**/*',
      '!node_modules/**/*.{test,spec}.{js,cjs,mjs}',
    ]))
    expect(ASSET_GLOBS).not.toContain('!node_modules/**/src/**/*')
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
        join(root, 'node_modules/.bin/pkg'),
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
      `command:${join(root, 'node_modules/.bin/pkg')} ${join(root, 'dist-openloop/runtime-staging')} --sea --targets node24-macos-arm64 --output ${join(root, `dist-openloop/${OUTPUT_BASENAME}`)}`,
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

  test.each([
    ['a symlinked dist-openloop ancestor', 'dist'],
    ['a symlinked runtime staging path', 'staging'],
    ['a symlinked executable path', 'executable'],
  ])('rejects %s before any build operation', async (_label, boundary) => {
    const root = temporaryDirectory(`boundary-${boundary}`)
    const outside = temporaryDirectory(`boundary-${boundary}-outside`)
    const operations: string[] = []
    write(join(outside, 'sentinel'), 'keep\n')
    if (boundary === 'dist') {
      symlinkSync(outside, join(root, 'dist-openloop'), 'dir')
    } else {
      mkdirSync(join(root, 'dist-openloop'), { recursive: true })
      const path = boundary === 'staging'
        ? join(root, 'dist-openloop/runtime-staging')
        : join(root, `dist-openloop/${OUTPUT_BASENAME}`)
      symlinkSync(outside, path, boundary === 'staging' ? 'dir' : 'file')
    }
    const files = {
      ...RuntimeExeBuilder.nodeFileSystem,
      exists: () => true,
      clearStaging: async () => { operations.push('clear') },
      synchronizeClosure: async () => { operations.push('closure') },
      prepareDeploymentWorkspace: async () => {
        operations.push('isolate')
        return join(root, 'dist-openloop/runtime-deploy-workspace')
      },
      cleanupDeploymentWorkspace: async () => { operations.push('cleanup') },
      prepareStaging: async () => { operations.push('prepare') },
      injectCoreManifest: async () => { operations.push('core') },
      patchPkgManifest: async () => { operations.push('manifest') },
      copyProducts: async () => { operations.push('copy') },
      writeSbom: async () => { operations.push('sbom') },
    } satisfies RuntimeBuildFileSystem
    const builder = new RuntimeExeBuilder({
      root,
      target: 'aarch64-apple-darwin',
      skipBuild: true,
      runner: { run: async () => { operations.push('command') } },
      files,
    })

    await expect(builder.build()).rejects.toThrow(/symlink|canonical|boundary/iu)
    expect(operations).toEqual([])
    expect(readFileSync(join(outside, 'sentinel'), 'utf8')).toBe('keep\n')
  })

  test('rejects a symlinked Tauri binaries directory before copying products', async () => {
    const root = temporaryDirectory('boundary-binaries')
    const outside = temporaryDirectory('boundary-binaries-outside')
    const executable = join(root, `dist-openloop/${OUTPUT_BASENAME}`)
    const helper = join(root, 'dist-openloop/runtime-staging/node_modules/node-pty/prebuilds/darwin-arm64/spawn-helper')
    const binaries = join(root, 'apps/openloop-desktop/src-tauri/binaries')
    write(executable, 'exe')
    write(helper, 'helper')
    mkdirSync(dirname(binaries), { recursive: true })
    symlinkSync(outside, binaries, 'dir')
    const builder = new RuntimeExeBuilder({
      root,
      target: 'aarch64-apple-darwin',
      skipBuild: true,
      runner: { run: async () => {} },
      files: RuntimeExeBuilder.nodeFileSystem,
    })

    await expect(builder.copyProducts()).rejects.toThrow(/symlink|canonical|boundary/iu)
    expect(() => statSync(join(outside, OUTPUT_BASENAME))).toThrow()
  })

  test('materializes every symlink and leaves a zero-symlink staging tree', async () => {
    const root = temporaryDirectory('links')
    const external = join(root, 'external')
    const nestedTarget = join(root, 'nested-target.js')
    const staging = join(root, 'staging')
    write(join(external, 'package.json'), '{"name":"linked"}\n')
    write(join(external, 'lib/index.js'), 'export {}\n')
    write(nestedTarget, 'export const nested = true\n')
    symlinkSync(nestedTarget, join(external, 'lib/nested.js'))
    mkdirSync(join(staging, 'node_modules/@scope'), { recursive: true })
    symlinkSync(external, join(staging, 'node_modules/@scope/linked'))

    await materializeSymlinks(staging, root)

    const linked = join(staging, 'node_modules/@scope/linked')
    expect(lstatSync(linked).isSymbolicLink()).toBe(false)
    expect(readFileSync(join(linked, 'lib/index.js'), 'utf8')).toBe('export {}\n')
    expect(lstatSync(join(linked, 'lib/nested.js')).isSymbolicLink()).toBe(false)
    expect(readFileSync(join(linked, 'lib/nested.js'), 'utf8')).toBe('export const nested = true\n')
  })

  test('rejects a repository directory containing a nested symlink outside the repository', async () => {
    const root = temporaryDirectory('nested-external-link-root')
    const outside = temporaryDirectory('nested-external-link-target')
    const source = join(root, 'linked-package')
    const staging = join(root, 'dist-openloop/runtime-staging')
    write(join(source, 'package.json'), '{"name":"linked-package"}\n')
    write(join(outside, 'payload'), 'OUTSIDE_BYTES\n')
    symlinkSync(join(outside, 'payload'), join(source, 'payload'), 'file')
    mkdirSync(staging, { recursive: true })
    symlinkSync(source, join(staging, 'linked-package'), 'dir')

    await expect(materializeSymlinks(staging, root)).rejects.toThrow(
      /outside|trusted root|boundary/iu,
    )
    expect(lstatSync(join(staging, 'linked-package/payload')).isSymbolicLink()).toBe(true)
  })

  test('rejects a staged symlink whose canonical target is outside the repository', async () => {
    const root = temporaryDirectory('external-link-root')
    const outside = temporaryDirectory('external-link-target')
    const staging = join(root, 'dist-openloop/runtime-staging')
    write(join(outside, 'package.json'), '{"name":"outside"}\n')
    mkdirSync(staging, { recursive: true })
    symlinkSync(outside, join(staging, 'outside'))

    await expect(materializeSymlinks(staging, root)).rejects.toThrow(/outside|trusted root|boundary/iu)
    expect(lstatSync(join(staging, 'outside')).isSymbolicLink()).toBe(true)
  })

  test('rejects a staged symlink chain that leaves and re-enters the repository', async () => {
    const root = temporaryDirectory('escaping-chain-root')
    const outside = temporaryDirectory('escaping-chain-target')
    const staging = join(root, 'dist-openloop/runtime-staging')
    const allowed = join(root, 'allowed')
    write(join(allowed, 'index.js'), 'export {}\n')
    symlinkSync(allowed, join(outside, 'return'), 'dir')
    mkdirSync(staging, { recursive: true })
    symlinkSync(join(outside, 'return'), join(staging, 'escaped'))

    await expect(materializeSymlinks(staging, root)).rejects.toThrow(/outside|trusted root|boundary/iu)
    expect(lstatSync(join(staging, 'escaped')).isSymbolicLink()).toBe(true)
  })

  test('rejects a cyclic staged symlink chain without mutating it', async () => {
    const root = temporaryDirectory('cyclic-chain')
    const staging = join(root, 'dist-openloop/runtime-staging')
    mkdirSync(staging, { recursive: true })
    symlinkSync('second', join(staging, 'first'))
    symlinkSync('first', join(staging, 'second'))

    await expect(materializeSymlinks(staging, root)).rejects.toThrow(/cycle|loop/iu)
    expect(lstatSync(join(staging, 'first')).isSymbolicLink()).toBe(true)
    expect(lstatSync(join(staging, 'second')).isSymbolicLink()).toBe(true)
  })

  test.runIf(process.platform !== 'win32')('rejects staged symlinks to special files', async () => {
    const root = temporaryDirectory('special-link')
    const staging = join(root, 'dist-openloop/runtime-staging')
    const fifo = join(root, 'runtime.fifo')
    mkdirSync(staging, { recursive: true })
    execFileSync('mkfifo', [fifo])
    symlinkSync(fifo, join(staging, 'special'))

    await expect(materializeSymlinks(staging, root)).rejects.toThrow(/regular file|directory|special/iu)
    expect(lstatSync(join(staging, 'special')).isSymbolicLink()).toBe(true)
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
      'package.json',
      'pnpm-lock.yaml',
      'pnpm-workspace.yaml',
      'scripts/openloop/build-runtime-exe.ts',
      'apps/openloop-runtime/package.json',
      'apps/openloop-runtime/tsdown.config.ts',
      'runtime/openloop/package.json',
      'dist-openloop/openloop-core.json',
      'scripts/openloop/upstream-baseline.json',
      'dist-openloop/runtime-staging/package.json',
      'dist-openloop/runtime-staging/node_modules/a/package.json',
      'dist-openloop/runtime-staging/node_modules/a/lib/index.js',
      'dist-openloop/runtime-staging/node_modules/a/config/runtime.yaml',
      'dist-openloop/runtime-staging/node_modules/@deepseek-ai/dsh-web-frontend/dist/index.html',
      'dist-openloop/runtime-staging/node_modules/node-pty/prebuilds/darwin-arm64/pty.node',
      'dist-openloop/runtime-staging/node_modules/@img/sharp-libvips-darwin-arm64/lib/libvips.dylib',
      'dist-openloop/runtime-staging/node_modules/node-pty/prebuilds/darwin-arm64/spawn-helper',
      `apps/openloop-desktop/src-tauri/binaries/${OUTPUT_BASENAME}`,
      `apps/openloop-desktop/src-tauri/binaries/${HELPER_BASENAME}`,
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

  test('pins the pkg executable in the root lockfile-owned development closure', () => {
    const rootPackage = JSON.parse(
      readFileSync(join(repositoryRoot, 'package.json'), 'utf8'),
    ) as { devDependencies?: Record<string, string> }

    expect(rootPackage.devDependencies?.['@yao-pkg/pkg']).toBe('6.21.0')
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
