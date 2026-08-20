import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import ts from 'typescript'
import { parse as parseToml } from 'smol-toml'
import { describe, expect, test } from 'vitest'

const repositoryRoot = path.resolve(import.meta.dirname, '../../..')
const appRoot = path.join(repositoryRoot, 'apps/openloop-desktop')
const tauriRoot = path.join(appRoot, 'src-tauri')

function requiredFile(relativePath: string): string {
  const absolutePath = path.join(repositoryRoot, relativePath)
  if (!fs.existsSync(absolutePath)) {
    throw new Error(`Missing Foundation Task 8 file: ${relativePath}`)
  }
  return absolutePath
}

function readText(relativePath: string): string {
  return fs.readFileSync(requiredFile(relativePath), 'utf8')
}

function readJson(relativePath: string): Record<string, unknown> {
  const value: unknown = JSON.parse(readText(relativePath))
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError(`${relativePath} must contain a JSON object`)
  }
  return value as Record<string, unknown>
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`)
  }
  return value as Record<string, unknown>
}

function stringRecord(value: unknown, label: string): Record<string, string> {
  const object = record(value, label)
  for (const [key, item] of Object.entries(object)) {
    if (typeof item !== 'string') throw new TypeError(`${label}.${key} must be a string`)
  }
  return object as Record<string, string>
}

type RustVersion = readonly [major: number, minor: number, patch: number]

function rustVersion(value: unknown, label: string): RustVersion {
  if (typeof value !== 'string') throw new TypeError(`${label} must be a string`)
  const match = /^(\d+)\.(\d+)(?:\.(\d+))?$/u.exec(value)
  if (match === null) throw new TypeError(`${label} must be a Rust version`)
  return [
    Number.parseInt(match[1], 10),
    Number.parseInt(match[2], 10),
    Number.parseInt(match[3] ?? '0', 10),
  ]
}

function compareRustVersions(left: RustVersion, right: RustVersion): number {
  for (let index = 0; index < left.length; index += 1) {
    const difference = left[index] - right[index]
    if (difference !== 0) return difference
  }
  return 0
}

function parseCsp(value: unknown): ReadonlyMap<string, readonly string[]> {
  if (typeof value !== 'string') throw new TypeError('security.csp must be a string')
  return new Map(
    value.split(';')
      .map(directive => directive.trim())
      .filter(Boolean)
      .map((directive) => {
        const [name, ...sources] = directive.split(/\s+/u)
        if (name === undefined) throw new TypeError('CSP directive must have a name')
        return [name, sources] as const
      }),
  )
}

function deriveIdentifier(channel: string): string {
  if (channel === 'stable') return 'ai.openloop.desktop'
  if (channel === 'test') return 'ai.openloop.desktop.test'
  throw new Error(`Unsupported desktop channel: ${channel}`)
}

function scriptArguments(script: string): readonly string[] {
  if (/["'\\;|$`()]/u.test(script)) {
    throw new Error(`Desktop scripts must not require shell parsing: ${script}`)
  }
  return script.trim().split(/\s+/u)
}

function commandNamesFromBuildScript(source: string): readonly string[] {
  const calls = [...source.matchAll(/\.commands\s*\(\s*&\s*\[([\s\S]*?)\]\s*\)/gu)]
  if (calls.length !== 1) return []
  return [...(calls[0]?.[1] ?? '').matchAll(/"([a-z][a-z0-9_]*)"/gu)]
    .map(match => match[1] as string)
}

function embeddedManifestPath(source: string): string | undefined {
  const direct = /PathBuf::from\("([^"]*dist-openloop\/)"\)\.join\("openloop-core\.json"\)/u
    .exec(source)
  if (direct?.[1] !== undefined) return direct[1]
  return /let\s+dist\s*=\s*PathBuf::from\("([^"]*dist-openloop\/)"\)/u.exec(source)?.[1]
}

function tauriCommandNames(source: string): readonly string[] {
  return [...source.matchAll(
    /#\s*\[\s*tauri::command\s*\]\s*(?:pub(?:\([^)]*\))?\s+)?fn\s+([a-z][a-z0-9_]*)\s*\(/gu,
  )].map(match => match[1] as string)
}

function invokeHandlerCommands(source: string): readonly string[] {
  const handlers = [...source.matchAll(/tauri::generate_handler!\s*\[([\s\S]*?)\]/gu)]
  if (handlers.length !== 1) return []
  return (handlers[0]?.[1] ?? '')
    .split(',')
    .map(command => command.trim())
    .filter(Boolean)
}

function rustStructFields(source: string, name: string): Record<string, string> {
  const match = new RegExp(`struct\\s+${name}\\s*\\{([\\s\\S]*?)\\}`, 'u').exec(source)
  if (match?.[1] === undefined) return {}
  return Object.fromEntries(
    [...match[1].matchAll(
      /(?:pub(?:\([^)]*\))?\s+)?([a-z][a-z0-9_]*)\s*:\s*([A-Za-z][A-Za-z0-9_:<>]*)\s*,/gu,
    )].map(field => [field[1], field[2]]),
  )
}

function interfaceFields(relativePath: string, interfaceName: string): Record<string, string> {
  const source = ts.createSourceFile(
    relativePath,
    readText(relativePath),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  )
  const declaration = source.statements.find(
    (statement): statement is ts.InterfaceDeclaration =>
      ts.isInterfaceDeclaration(statement) && statement.name.text === interfaceName,
  )
  if (declaration === undefined) return {}
  return Object.fromEntries(declaration.members.map((member) => {
    if (!ts.isPropertySignature(member)
      || member.type === undefined
      || member.name === undefined
      || !ts.isIdentifier(member.name)) {
      throw new TypeError(`${interfaceName} must contain plain required properties`)
    }
    return [member.name.text, member.type.getText(source)]
  }))
}

function findBaselineUrl(relativePath: string): string | undefined {
  const source = ts.createSourceFile(
    relativePath,
    readText(relativePath),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  )
  let baselineUrl: string | undefined
  const visit = (node: ts.Node): void => {
    if (ts.isNewExpression(node)
      && ts.isIdentifier(node.expression)
      && node.expression.text === 'URL'
      && node.arguments?.length === 2
      && ts.isStringLiteral(node.arguments[0])) {
      const candidate = node.arguments[0].text
      if (candidate.endsWith('upstream-baseline.json')) baselineUrl = candidate
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return baselineUrl
}

describe('Openloop desktop foundation configuration', () => {
  test('pins package identity, versions, scripts, and the test build manifest', () => {
    const packageJson = readJson('apps/openloop-desktop/package.json')
    const scripts = stringRecord(packageJson.scripts, 'package.json scripts')
    const dependencies = stringRecord(packageJson.dependencies, 'package.json dependencies')
    const devDependencies = stringRecord(
      packageJson.devDependencies,
      'package.json devDependencies',
    )
    const manifestArgs = scriptArguments(scripts['manifest:test'] ?? '')
    const channel = manifestArgs[manifestArgs.indexOf('--channel') + 1]
    const output = manifestArgs[manifestArgs.indexOf('--out') + 1]
    const appVersion = manifestArgs[manifestArgs.indexOf('--app-version') + 1]

    expect(packageJson).toMatchObject({
      name: '@openloop/desktop',
      private: true,
      type: 'module',
      version: '0.1.0',
    })
    expect(Object.keys(scripts).sort()).toEqual([
      'build',
      'dev',
      'frontend:build',
      'frontend:dev',
      'icon',
      'manifest:test',
      'tauri',
    ])
    expect(manifestArgs).toEqual([
      'node',
      '../../scripts/openloop/generate-build-manifest.mjs',
      '--channel',
      'test',
      '--out',
      '../../dist-openloop/openloop-core.json',
      '--app-version',
      '0.1.0',
    ])
    expect(channel).toBe('test')
    expect(output).toBe('../../dist-openloop/openloop-core.json')
    expect(path.resolve(appRoot, output as string)).toBe(
      path.join(repositoryRoot, 'dist-openloop/openloop-core.json'),
    )
    expect(appVersion).toBe(packageJson.version)
    expect(findBaselineUrl('scripts/openloop/generate-build-manifest.mjs'))
      .toBe('./upstream-baseline.json')
    expect(dependencies).toEqual({ '@tauri-apps/api': '2.11.1' })
    expect(devDependencies).toEqual({
      '@tauri-apps/cli': '2.11.4',
      typescript: '6.0.3',
      vite: '8.0.16',
    })
    expect(scriptArguments(scripts.tauri)).toEqual(['tauri'])
    expect(scriptArguments(scripts['frontend:dev'])).toEqual(['vite'])
    expect(scriptArguments(scripts['frontend:build'])).toEqual(['tsc', '&&', 'vite', 'build'])
    expect(scriptArguments(scripts.dev)).toEqual(['pnpm', 'manifest:test', '&&', 'tauri', 'dev'])
    expect(scriptArguments(scripts.build)).toEqual([
      'pnpm',
      '--dir',
      '../..',
      'openloop:build-desktop',
      '--',
      '--channel',
      'test',
      '--target',
      'aarch64-apple-darwin',
      '--bundle',
      'app',
    ])
    expect(scriptArguments(scripts.icon)).toEqual([
      'tauri',
      'icon',
      '../../assets/brand/openloop-icon.svg',
      '--output',
      'src-tauri/icons',
    ])
  })

  test('keeps Cargo, npm, Tauri, and manifest versions consistent and exact', () => {
    const packageJson = readJson('apps/openloop-desktop/package.json')
    const cargo = record(
      parseToml(readText('apps/openloop-desktop/src-tauri/Cargo.toml')),
      'Cargo.toml',
    )
    const cargoPackage = record(cargo.package, 'Cargo.toml package')
    const dependencies = record(cargo.dependencies, 'Cargo.toml dependencies')
    const buildDependencies = record(
      cargo['build-dependencies'],
      'Cargo.toml build-dependencies',
    )
    const tauriDependency = record(dependencies.tauri, 'Cargo.toml tauri dependency')
    const tauriBuildDependency = record(
      buildDependencies['tauri-build'],
      'Cargo.toml tauri-build dependency',
    )
    const tauriConfig = readJson('apps/openloop-desktop/src-tauri/tauri.conf.json')

    expect(cargoPackage.version).toBe(packageJson.version)
    expect(tauriConfig.version).toBe(packageJson.version)
    expect(tauriDependency.version).toBe('=2.11.5')
    expect(tauriBuildDependency.version).toBe('=2.6.3')
    expect(record(dependencies.serde, 'Cargo.toml serde dependency').version).toBe('=1.0.229')
    expect(dependencies.serde_json).toBe('=1.0.151')
    expect(buildDependencies.serde_json).toBe('=1.0.151')
    expect(buildDependencies.sha2).toBe('=0.10.9')
  })

  test('declares a Rust baseline at least as high as the locked dependency closure', () => {
    const cargo = record(
      parseToml(readText('apps/openloop-desktop/src-tauri/Cargo.toml')),
      'Cargo.toml',
    )
    const cargoPackage = record(cargo.package, 'Cargo.toml package')
    const metadata = record(JSON.parse(execFileSync(
      'cargo',
      ['metadata', '--locked', '--format-version', '1'],
      { cwd: tauriRoot, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 },
    )), 'cargo metadata')
    if (!Array.isArray(metadata.packages)) {
      throw new TypeError('cargo metadata packages must be an array')
    }
    const lockedRustVersions = metadata.packages.flatMap((value, index) => {
      const rustVersionValue = record(value, `cargo metadata packages[${index}]`).rust_version
      return rustVersionValue === null ? [] : [
        rustVersion(rustVersionValue, `cargo metadata packages[${index}].rust_version`),
      ]
    })
    const highestLockedRustVersion = lockedRustVersions.reduce(
      (highest, candidate) =>
        compareRustVersions(candidate, highest) > 0 ? candidate : highest,
    )
    const declaredRustVersion = rustVersion(
      cargoPackage['rust-version'],
      'Cargo.toml package.rust-version',
    )

    expect(compareRustVersions(declaredRustVersion, highestLockedRustVersion))
      .toBeGreaterThanOrEqual(0)
  })

  test('defines one local main window with a channel-derived identifier and strict CSP', () => {
    const packageJson = readJson('apps/openloop-desktop/package.json')
    const scripts = stringRecord(packageJson.scripts, 'package.json scripts')
    const manifestArgs = scriptArguments(scripts['manifest:test'] ?? '')
    const channel = manifestArgs[manifestArgs.indexOf('--channel') + 1] as string
    const config = readJson('apps/openloop-desktop/src-tauri/tauri.conf.json')
    const build = record(config.build, 'tauri build config')
    const app = record(config.app, 'tauri app config')
    const windows = app.windows
    const security = record(app.security, 'tauri security config')
    const bundle = record(config.bundle, 'tauri bundle config')
    const csp = parseCsp(security.csp)

    expect(config.productName).toBe('Openloop')
    expect(config.identifier).toBe(deriveIdentifier(channel))
    expect(build).toMatchObject({
      beforeDevCommand: 'pnpm frontend:dev',
      devUrl: 'http://localhost:1420',
      beforeBuildCommand: 'pnpm frontend:build',
      frontendDist: '../dist',
    })
    expect(windows).toEqual([{
      label: 'main',
      title: 'Openloop',
      width: 760,
      height: 520,
      minWidth: 760,
      minHeight: 520,
      resizable: false,
      fullscreen: false,
    }])
    expect(security.capabilities).toEqual(['main'])
    expect(security.freezePrototype).toBe(true)
    expect(csp).toEqual(new Map([
      ['default-src', ["'self'"]],
      ['base-uri', ["'none'"]],
      ['connect-src', ["'self'", 'ipc:', 'http://ipc.localhost']],
      ['font-src', ["'self'"]],
      ['form-action', ["'none'"]],
      ['frame-ancestors', ["'none'"]],
      ['frame-src', ["'none'"]],
      ['img-src', ["'self'"]],
      ['object-src', ["'none'"]],
      ['script-src', ["'self'"]],
      ['style-src', ["'self'"]],
    ]))
    expect(bundle.targets).toEqual(['app'])
    expect(bundle.active).toBe(true)
    expect(bundle.externalBin).toEqual([
      'binaries/openloop-runtime',
      'binaries/openloop-runtime-spawn-helper',
    ])
    expect(bundle.icon).toEqual([
      'icons/32x32.png',
      'icons/128x128.png',
      'icons/128x128@2x.png',
      'icons/icon.icns',
    ])
    expect(record(bundle.macOS, 'tauri macOS bundle config')).toEqual({
      minimumSystemVersion: '11.0',
      signingIdentity: '-',
      entitlements: 'Entitlements.plist',
    })
  })

  test('grants only the native runtime entitlements required by the hardened Node sidecar', () => {
    const entitlementsPath = requiredFile(
      'apps/openloop-desktop/src-tauri/Entitlements.plist',
    )
    const entitlements = JSON.parse(execFileSync(
      'plutil',
      ['-convert', 'json', '-o', '-', entitlementsPath],
      { encoding: 'utf8' },
    )) as Record<string, unknown>

    expect(entitlements).toEqual({
      'com.apple.security.cs.allow-jit': true,
      'com.apple.security.cs.disable-library-validation': true,
    })
  })

  test('grants only build_manifest to the local main window on macOS', () => {
    const capability = readJson('apps/openloop-desktop/src-tauri/capabilities/main.json')
    const serialized = JSON.stringify(capability)

    expect(capability).toEqual({
      $schema: '../gen/schemas/desktop-schema.json',
      identifier: 'main',
      description: 'Local capability for the Openloop bootstrap window.',
      local: true,
      windows: ['main'],
      platforms: ['macOS'],
      permissions: ['allow-build-manifest'],
    })
    expect(capability).not.toHaveProperty('remote')
    expect(serialized).not.toContain('*')

    const buildScript = readText('apps/openloop-desktop/src-tauri/build.rs')
    expect(commandNamesFromBuildScript(buildScript)).toEqual(['build_manifest'])
    expect([...buildScript.matchAll(/\.commands\s*\(/gu)]).toHaveLength(1)

    const library = readText('apps/openloop-desktop/src-tauri/src/lib.rs')
    expect(tauriCommandNames(library)).toEqual(['build_manifest'])
    expect(invokeHandlerCommands(library)).toEqual(['build_manifest'])
  })

  test('keeps the Rust and TypeScript build-manifest contracts identical', () => {
    const library = readText('apps/openloop-desktop/src-tauri/src/lib.rs')
    const rustFields = rustStructFields(library, 'OpenloopBuildManifest')
    const typeScriptFields = interfaceFields(
      'apps/openloop-desktop/src/main.ts',
      'OpenloopBuildManifest',
    )

    expect(library).toMatch(/#\s*\[\s*serde\s*\(\s*rename_all\s*=\s*"camelCase"\s*,\s*deny_unknown_fields\s*\)\s*\]/u)
    expect(rustFields).toEqual({
      app_version: 'String',
      channel: 'String',
      dsh_tag: 'String',
      dsh_commit: 'String',
      runtime_version: 'u64',
      bridge_protocol_version: 'u64',
      ui_sdk_version: 'String',
      plugin_package_spec_version: 'String',
      openloop_data_version: 'u64',
      dsh_data_version: 'u64',
    })
    expect(typeScriptFields).toEqual({
      appVersion: 'string',
      channel: "'test' | 'stable'",
      dshTag: 'string',
      dshCommit: 'string',
      runtimeVersion: 'number',
      bridgeProtocolVersion: 'number',
      uiSdkVersion: 'string',
      pluginPackageSpecVersion: 'string',
      openloopDataVersion: 'number',
      dshDataVersion: 'number',
    })
  })

  test('embeds validated canonical manifest bytes and exposes no dangerous plugins', () => {
    const buildScript = readText('apps/openloop-desktop/src-tauri/build.rs')
    const library = readText('apps/openloop-desktop/src-tauri/src/lib.rs')
    const cargo = record(
      parseToml(readText('apps/openloop-desktop/src-tauri/Cargo.toml')),
      'Cargo.toml',
    )
    const cargoDependencyNames = Object.keys(record(cargo.dependencies, 'Cargo dependencies'))
    const packageJson = readJson('apps/openloop-desktop/package.json')
    const npmDependencyNames = [
      ...Object.keys(record(packageJson.dependencies, 'npm dependencies')),
      ...Object.keys(record(packageJson.devDependencies, 'npm devDependencies')),
    ]
    const dangerous = /(?:^|[-_])(fs|shell|updater|dialog)(?:$|[-_])/u

    expect(path.resolve(
      tauriRoot,
      embeddedManifestPath(buildScript) ?? '',
      'openloop-core.json',
    )).toBe(path.join(repositoryRoot, 'dist-openloop/openloop-core.json'))
    expect(buildScript).toMatch(/PathBuf::from\("[^"]*dist-openloop\/"\)/u)
    expect(buildScript).toMatch(/dist\.join\("openloop-core\.json"\)/u)
    expect(buildScript).toMatch(/dist\.join\("openloop-artifacts\.json"\)/u)
    expect(buildScript).toMatch(/std::str::from_utf8/u)
    expect(buildScript).toMatch(/serde_json::from_str/u)
    expect(buildScript).toMatch(/serde_json::to_string_pretty/u)
    expect(buildScript).toMatch(/Sha256/u)
    expect(buildScript).toMatch(/OPENLOOP_BUILD_MANIFEST_SHA256/u)
    expect(buildScript).toMatch(/OUT_DIR/u)
    expect(library).toMatch(/include_bytes!\s*\(\s*concat!\s*\(\s*env!\s*\(\s*"OUT_DIR"/u)
    expect(library).toMatch(
      /fn\s+build_manifest\s*\(\s*\)\s*->\s*Result\s*<\s*OpenloopBuildManifest\s*,\s*String\s*>/u,
    )
    expect(cargoDependencyNames.filter(name => dangerous.test(name))).toEqual([])
    expect(npmDependencyNames.filter(name => dangerous.test(name))).toEqual([])
  })

  test('uses generated macOS icons and a restrained bootstrap-only frontend', () => {
    const iconPaths = [
      'apps/openloop-desktop/src-tauri/icons/32x32.png',
      'apps/openloop-desktop/src-tauri/icons/128x128.png',
      'apps/openloop-desktop/src-tauri/icons/128x128@2x.png',
      'apps/openloop-desktop/src-tauri/icons/icon.icns',
    ]
    for (const iconPath of iconPaths) requiredFile(iconPath)

    const viteConfig = readText('apps/openloop-desktop/vite.config.ts')
    const mainSource = readText('apps/openloop-desktop/src/main.ts')
    const styles = readText('apps/openloop-desktop/src/styles.css')
    const index = readText('apps/openloop-desktop/index.html')
    const frontend = `${viteConfig}\n${mainSource}\n${styles}\n${index}`.toLowerCase()

    expect(viteConfig).toMatch(/port:\s*1420/u)
    expect(viteConfig).toMatch(/strictPort:\s*true/u)
    expect(mainSource).toContain('../../../assets/brand/openloop-icon.svg')
    expect(mainSource).toContain("invoke<OpenloopBuildManifest>('build_manifest')")
    expect(index).toContain('<title>Openloop</title>')
    expect(frontend).not.toMatch(/\bcyan\b|#00ffff|#0ff\b|rgb\s*\(\s*0\s*,\s*255\s*,\s*255\s*\)/u)
    expect(frontend).not.toMatch(/\b(?:linear|radial|conic)-gradient\s*\(/u)
    expect(frontend).not.toMatch(/\borbs?\b|\bcards?\b/u)
    expect(frontend).not.toMatch(/https?:\/\/(?!ipc\.localhost|localhost:1420)/u)
  })

  test('keeps the bootstrap layout inside narrow browser viewports', () => {
    const styles = readText('apps/openloop-desktop/src/styles.css')
    const mobileBreakpoint = '@media (max-width: 759px)'
    const mobileStyles = styles.slice(styles.indexOf(mobileBreakpoint))
    const bootstrapStyles = /\.bootstrap\s*\{([^}]*)\}/u.exec(mobileStyles)?.[1]

    expect(styles).toContain(mobileBreakpoint)
    expect(mobileStyles).toMatch(
      /html,\s*body,\s*#app\s*\{[^}]*min-width:\s*0;[^}]*min-height:\s*0;/u,
    )
    expect(mobileStyles).toMatch(/body\s*\{[^}]*overflow:\s*auto;/u)
    expect(bootstrapStyles).toMatch(/grid-template-columns:\s*minmax\(0,\s*1fr\);/u)
    expect(bootstrapStyles).toMatch(/gap:\s*\d+px;/u)
    expect(bootstrapStyles).toMatch(/width:\s*100%;/u)
    expect(bootstrapStyles).toMatch(/min-height:\s*100%;/u)
    expect(bootstrapStyles).toMatch(/height:\s*auto;/u)
    expect(bootstrapStyles).toMatch(/padding:\s*\d+px\s+\d+px\s+\d+px;/u)
    expect(mobileStyles).toMatch(
      /\.brand-mark\s*\{[^}]*grid-row:\s*auto;[^}]*width:\s*\d+px;[^}]*height:\s*\d+px;/u,
    )
    expect(mobileStyles).toMatch(
      /\.build-facts\s*\{[^}]*grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\);/u,
    )
    expect(mobileStyles).toMatch(
      /\.build-facts div:last-child\s*\{[^}]*grid-column:\s*1\s*\/\s*-1;/u,
    )
    expect(mobileStyles).toMatch(
      /\.build-facts dd\s*\{[^}]*overflow-wrap:\s*anywhere;[^}]*white-space:\s*normal;/u,
    )
    expect(styles).toMatch(/\.status\s*\{[^}]*overflow-wrap:\s*anywhere;/u)
  })

  test('uses non-negative typography tracking', () => {
    const styles = readText('apps/openloop-desktop/src/styles.css')

    expect(styles).not.toMatch(/letter-spacing\s*:\s*-\d/u)
    expect(styles).toMatch(/h1\s*\{[^}]*letter-spacing:\s*0;/u)
  })

  test('keeps bootstrap failure details out of the browser UI', () => {
    const mainSource = readText('apps/openloop-desktop/src/main.ts')

    expect(mainSource).toContain("text('bootstrap-status', 'Build manifest unavailable')")
    expect(mainSource).not.toMatch(/error\.message|String\s*\(\s*error\s*\)/u)
  })

  test('bundles the existing Openloop brand mark as the favicon', () => {
    const index = readText('apps/openloop-desktop/index.html')
    const faviconPath = '../../assets/brand/openloop-icon.svg'

    expect(index).toContain(
      `<link rel="icon" type="image/svg+xml" href="${faviconPath}">`,
    )
    expect(path.resolve(appRoot, faviconPath)).toBe(
      requiredFile('assets/brand/openloop-icon.svg'),
    )
  })

  test('keeps generated build and app outputs ignored', () => {
    const gitignore = readText('.gitignore').split(/\r?\n/u)

    expect(gitignore).toContain('dist-openloop/')
    expect(gitignore).toContain('*.app')
    expect(path.relative(appRoot, tauriRoot)).toBe('src-tauri')
  })

  test('exposes the root desktop builder as the only build orchestrator', () => {
    const rootPackage = readJson('package.json')
    const rootScripts = stringRecord(rootPackage.scripts, 'root package scripts')
    const desktopPackage = readJson('apps/openloop-desktop/package.json')
    const desktopScripts = stringRecord(desktopPackage.scripts, 'desktop package scripts')

    expect(rootScripts['openloop:build-desktop']).toBe(
      'node scripts/openloop/build-desktop.mjs',
    )
    expect(desktopScripts.build).toContain('openloop:build-desktop')
    expect(desktopScripts.build).not.toContain('tauri build')
    expect(Object.values(rootScripts).filter(script =>
      script.includes('build-desktop.mjs'))).toEqual([
      'node scripts/openloop/build-desktop.mjs',
    ])
  })

  test('is accepted as a private Openloop workspace application', () => {
    expect(() => execFileSync('pnpm', ['run', 'constraints'], {
      cwd: repositoryRoot,
      stdio: 'pipe',
    })).not.toThrow()
  })
})
