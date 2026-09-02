import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import ts from 'typescript'

const openLoopFaces = ['host', 'client', 'pure'] as const

type OpenLoopFace = typeof openLoopFaces[number]

interface OpenLoopManifest {
  name?: string
  private?: boolean
  openloop?: {
    face?: unknown
    cordisPlugin?: unknown
    service?: unknown
  }
  peerDependencies?: Record<string, string>
  devDependencies?: Record<string, string>
}

interface AggregateConfig {
  extends?: unknown
  references?: ReadonlyArray<{ path?: unknown }>
}

const cordisPackage = '@deepseek-ai/cordis'

function readManifest(path: string): OpenLoopManifest {
  return JSON.parse(readFileSync(path, 'utf8')) as OpenLoopManifest
}

function isCordisPlugin(manifest: OpenLoopManifest): boolean {
  return manifest.openloop?.cordisPlugin === true
    || typeof manifest.openloop?.service === 'string'
    || manifest.peerDependencies?.[cordisPackage] !== undefined
    || manifest.devDependencies?.[cordisPackage] !== undefined
}

function aggregateReferences(root: string, face: 'host' | 'client'): readonly string[] {
  const path = join(root, `tsconfig.${face}.json`)
  if (!existsSync(path)) return []
  const parsed = ts.readConfigFile(path, file => ts.sys.readFile(file))
  if (parsed.error !== undefined) {
    const message = ts.flattenDiagnosticMessageText(parsed.error.messageText, '\n')
    throw new Error(`tsconfig.${face}.json: ${message}`)
  }
  const config = parsed.config as AggregateConfig
  return (config.references ?? [])
    .map(reference => reference.path)
    .filter((reference): reference is string => typeof reference === 'string')
}

function canonicalPath(path: string): string {
  let ancestor = path
  while (!existsSync(ancestor)) {
    const parent = dirname(ancestor)
    if (parent === ancestor) return resolve(path)
    ancestor = parent
  }
  return resolve(realpathSync.native(ancestor), relative(ancestor, path))
}

function referenceConfigPath(sourceConfig: string, reference: string): string {
  const target = resolve(dirname(sourceConfig), reference)
  return target.endsWith('.json') ? target : join(target, 'tsconfig.json')
}

function formatConfigDiagnostic(root: string, configPath: string, diagnostic: ts.Diagnostic): Error {
  const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')
  return new Error(`${relative(root, configPath).split(sep).join('/')}: ${message}`)
}

function readConfig(root: string, configPath: string): AggregateConfig {
  const parsed = ts.readConfigFile(configPath, path => ts.sys.readFile(path))
  if (parsed.error !== undefined) throw formatConfigDiagnostic(root, configPath, parsed.error)
  return parsed.config as AggregateConfig
}

function extendsConfigPaths(
  root: string,
  configPath: string,
  value: unknown,
): readonly string[] {
  const extensions = Array.isArray(value) ? value : [value]
  return extensions
    .filter((extension): extension is string => typeof extension === 'string')
    .flatMap((extension) => {
      const sourceFile = ts.parseJsonText(
        configPath,
        JSON.stringify({ extends: extension, files: [] }),
      ) as ts.TsConfigSourceFile
      const parsed = ts.parseJsonSourceFileConfigFileContent(
        sourceFile,
        ts.sys,
        dirname(configPath),
        undefined,
        configPath,
      )
      const [parentPath] = sourceFile.extendedSourceFiles ?? []
      if (parentPath !== undefined) return [parentPath]
      const error = parsed.errors.find(diagnostic =>
        diagnostic.category === ts.DiagnosticCategory.Error
        && diagnostic.code !== 18000
        && diagnostic.code !== 18002
        && diagnostic.code !== 18003)
      if (error !== undefined) throw formatConfigDiagnostic(root, configPath, error)
      return []
    })
}

function isClientConfig(
  root: string,
  configPath: string,
  config: AggregateConfig,
  seen = new Set<string>(),
): boolean {
  const canonicalConfig = canonicalPath(configPath)
  if (canonicalConfig === canonicalPath(join(root, 'tsconfig.base.client.json'))
    || configPath.endsWith(`${sep}tsconfig.client.json`)) return true
  if (seen.has(canonicalConfig)) return false
  seen.add(canonicalConfig)

  return extendsConfigPaths(root, configPath, config.extends).some((parentPath) => {
    const canonicalParent = canonicalPath(parentPath)
    if (!existsSync(canonicalParent)) return false
    return isClientConfig(root, canonicalParent, readConfig(root, canonicalParent), seen)
  })
}

function clientProjectConfigs(root: string): ReadonlySet<string> {
  const rootConfig = join(root, 'tsconfig.client.json')
  if (!existsSync(rootConfig)) return new Set()

  const clientConfigs = new Set<string>()
  const visited = new Set<string>()
  const queue = [rootConfig]
  while (queue.length > 0) {
    const configPath = queue.shift()
    if (configPath === undefined) break
    const canonicalConfig = canonicalPath(configPath)
    if (visited.has(canonicalConfig)) continue
    visited.add(canonicalConfig)
    if (!existsSync(configPath)) continue

    const config = readConfig(root, configPath)
    if (isClientConfig(root, configPath, config)) clientConfigs.add(canonicalConfig)
    for (const reference of config.references ?? []) {
      if (typeof reference.path !== 'string') continue
      queue.push(referenceConfigPath(configPath, reference.path))
    }
  }
  return clientConfigs
}

function pureClientConfigExtensions(
  root: string,
  packageDirectory: string,
  clientConfigs: ReadonlySet<string>,
): readonly string[] {
  const configPath = join(packageDirectory, 'tsconfig.json')
  if (!existsSync(configPath)) return []

  const canonicalRoot = canonicalPath(root)
  const forbiddenConfigs = new Set([
    canonicalPath(join(root, 'tsconfig.base.client.json')),
    ...clientConfigs,
  ])
  const clientExtensions = new Set<string>()
  const visited = new Set<string>()
  const queue = [configPath]
  while (queue.length > 0) {
    const currentConfig = queue.shift()
    if (currentConfig === undefined) break
    const canonicalConfig = canonicalPath(currentConfig)
    if (visited.has(canonicalConfig)) continue
    visited.add(canonicalConfig)
    if (!existsSync(currentConfig)) continue

    const config = readConfig(root, currentConfig)
    for (const parentPath of extendsConfigPaths(root, currentConfig, config.extends)) {
      const canonicalParent = canonicalPath(parentPath)
      if (forbiddenConfigs.has(canonicalParent)) {
        clientExtensions.add(canonicalParent)
      } else {
        queue.push(canonicalParent)
      }
    }
  }

  return [...clientExtensions]
    .map(extension => relative(canonicalRoot, extension))
    .map(extension => extension.split(sep).join('/'))
    .sort()
}

function pureClientProjectReferences(
  root: string,
  packageDirectory: string,
  clientConfigs: ReadonlySet<string>,
): readonly string[] {
  const configPath = join(packageDirectory, 'tsconfig.json')
  if (!existsSync(configPath)) return []
  const canonicalRoot = canonicalPath(root)
  const clientReferences = new Set<string>()
  const visited = new Set<string>()
  const queue = [configPath]
  while (queue.length > 0) {
    const currentConfig = queue.shift()
    if (currentConfig === undefined) break
    const canonicalConfig = canonicalPath(currentConfig)
    if (visited.has(canonicalConfig)) continue
    visited.add(canonicalConfig)
    if (!existsSync(currentConfig)) continue

    const config = readConfig(root, currentConfig)
    for (const reference of config.references ?? []) {
      if (typeof reference.path !== 'string') continue
      const targetConfig = referenceConfigPath(currentConfig, reference.path)
      const canonicalTarget = canonicalPath(targetConfig)
      if (clientConfigs.has(canonicalTarget)) clientReferences.add(canonicalTarget)
      queue.push(targetConfig)
    }
  }

  return [...clientReferences]
    .map(reference => relative(canonicalRoot, dirname(reference)))
    .map(reference => reference.split(sep).join('/'))
    .sort()
}

/**
 * Preserve the upstream package namespace for every DSH package group. The
 * product-owned packages/openloop group is the only exception.
 */
export function collectDshWorkspaceNamingViolations(root: string): string[] {
  const packagesRoot = join(root, 'packages')
  if (!existsSync(packagesRoot)) return []

  const errors: string[] = []
  const groups = readdirSync(packagesRoot, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && entry.name !== 'openloop')
    .sort((left, right) => left.name.localeCompare(right.name))

  for (const group of groups) {
    const groupRoot = join(packagesRoot, group.name)
    const packages = readdirSync(groupRoot, { withFileTypes: true })
      .filter(entry => entry.isDirectory())
      .sort((left, right) => left.name.localeCompare(right.name))
    for (const entry of packages) {
      const manifestPath = join(groupRoot, entry.name, 'package.json')
      if (!existsSync(manifestPath)) continue
      const manifest = readManifest(manifestPath)
      if (manifest.name?.startsWith('@deepseek-ai/dsh-') === true) continue
      errors.push(
        `packages/${group.name}/${entry.name}/package.json: DSH packages must use the @deepseek-ai/dsh-* namespace`,
      )
    }
  }

  return errors
}

const workspaceExecutionForbiddenModules = new Set([
  'fs',
  'fs/promises',
  'child_process',
  'node:fs',
  'node:fs/promises',
  'node:child_process',
  'node-pty',
])

export const OPENLOOP_FORBIDDEN_PROCESS_PACKAGES = new Set([
  '@deepseek-ai/dsh-agent-tool-presentation',
  '@deepseek-ai/dsh-bash-sandbox',
  '@deepseek-ai/dsh-code-runtime-worker-thread',
  '@deepseek-ai/dsh-lsp-stdio',
  '@deepseek-ai/dsh-mcp-client',
  '@deepseek-ai/dsh-pwsh-sandbox',
  '@deepseek-ai/dsh-subagent-acp',
  '@deepseek-ai/dsh-subagent-claude-code',
  '@deepseek-ai/dsh-subagent-codex',
  '@deepseek-ai/dsh-subagent-dsh-sdk',
  '@deepseek-ai/dsh-subprocess-local',
  '@deepseek-ai/dsh-terminal',
  '@deepseek-ai/dsh-terminal-bash',
  '@deepseek-ai/dsh-tool-bash',
  '@deepseek-ai/dsh-tool-bash-persistent',
  '@deepseek-ai/dsh-tool-cordis',
  '@deepseek-ai/dsh-tool-fs-search',
  '@deepseek-ai/dsh-tool-lsp',
  '@deepseek-ai/dsh-tool-pwsh',
  '@deepseek-ai/dsh-tool-ralph',
  '@deepseek-ai/dsh-tool-terminal',
  '@deepseek-ai/dsh-tool-workflow',
  '@deepseek-ai/dsh-workflow-worker-thread',
])

function sourceFiles(directory: string): string[] {
  if (!existsSync(directory)) return []
  return readdirSync(directory, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name))
    .flatMap((entry) => {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) return sourceFiles(path)
      return entry.isFile() && /\.[cm]?[jt]sx?$/u.test(entry.name) ? [path] : []
    })
}

function importedModules(path: string): ReadonlyArray<{ value: string; line: number }> {
  const source = ts.createSourceFile(
    path,
    readFileSync(path, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
  )
  const imports: Array<{ value: string; line: number }> = []
  const add = (literal: ts.StringLiteralLike): void => {
    imports.push({
      value: literal.text,
      line: source.getLineAndCharacterOfPosition(literal.getStart(source)).line + 1,
    })
  }
  const visit = (node: ts.Node): void => {
    const firstArgument = ts.isCallExpression(node) ? node.arguments[0] : undefined
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node))
      && node.moduleSpecifier !== undefined
      && ts.isStringLiteralLike(node.moduleSpecifier)) {
      add(node.moduleSpecifier)
    } else if (ts.isCallExpression(node)
      && node.arguments.length === 1
      && firstArgument !== undefined
      && ts.isStringLiteralLike(firstArgument)
      && (node.expression.kind === ts.SyntaxKind.ImportKeyword
        || (ts.isIdentifier(node.expression) && node.expression.text === 'require'))) {
      add(firstArgument)
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return imports
}

function workspaceExecutionBoundaryViolations(root: string): string[] {
  const boundaries = [
    {
      packageDirectory: 'fs-workspace',
      message: (specifier: string) =>
        `@openloop/fs-workspace must use the Workspace file broker instead of ${specifier}`,
    },
    {
      packageDirectory: 'sandbox-workspace',
      message: (specifier: string) =>
        `@openloop/sandbox-workspace must not implement process execution through ${specifier}`,
    },
  ] as const
  return boundaries.flatMap(boundary =>
    sourceFiles(join(root, 'packages', 'openloop', boundary.packageDirectory, 'src'))
      .flatMap(path => importedModules(path)
        .filter(entry => workspaceExecutionForbiddenModules.has(entry.value))
        .map(entry =>
          `${relative(root, path).split(sep).join('/')}:${String(entry.line)}: `
          + boundary.message(entry.value))))
}

function unapprovedProcessProviderViolations(root: string): string[] {
  const packagesRoot = join(root, 'packages', 'openloop')
  const packageSources = existsSync(packagesRoot)
    ? readdirSync(packagesRoot, { withFileTypes: true })
      .filter(entry => entry.isDirectory())
      .sort((left, right) => left.name.localeCompare(right.name))
      .map(entry => join(packagesRoot, entry.name, 'src'))
    : []
  return [...packageSources, join(root, 'apps', 'openloop-runtime', 'src')]
    .flatMap(sourceFiles)
    .flatMap(path => importedModules(path)
      .filter(entry => OPENLOOP_FORBIDDEN_PROCESS_PACKAGES.has(entry.value))
      .map(entry =>
        `${relative(root, path).split(sep).join('/')}:${String(entry.line)}: `
        + `Openloop code must not import unapproved process provider ${JSON.stringify(entry.value)}`))
}

/**
 * Validate the product-owned package namespace without changing DSH's public
 * package policy.
 */
export function collectOpenLoopWorkspaceViolations(root: string): string[] {
  const packagesRoot = join(root, 'packages', 'openloop')

  const errors: string[] = []
  const aggregates = {
    host: aggregateReferences(root, 'host'),
    client: aggregateReferences(root, 'client'),
  }
  const clientConfigs = clientProjectConfigs(root)
  const packageDirectories = existsSync(packagesRoot)
    ? readdirSync(packagesRoot, { withFileTypes: true })
      .filter(entry => entry.isDirectory())
      .sort((left, right) => left.name.localeCompare(right.name))
    : []

  for (const entry of packageDirectories) {
    const relativeManifestPath = `packages/openloop/${entry.name}/package.json`
    const manifestPath = join(packagesRoot, entry.name, 'package.json')
    if (!existsSync(manifestPath)) continue

    const manifest = readManifest(manifestPath)
    const expectedName = `@openloop/${entry.name}`
    if (manifest.name !== expectedName) {
      errors.push(`${relativeManifestPath}: package name must be ${expectedName}`)
    }
    if (manifest.private !== true) {
      errors.push(`${relativeManifestPath}: OpenLoop packages must set "private": true`)
    }
    const face = manifest.openloop?.face
    if (!openLoopFaces.includes(face as OpenLoopFace)) {
      errors.push(`${relativeManifestPath}: openloop.face must be exactly one of host, client, or pure`)
    } else {
      const expectedFace = face === 'client' ? 'client' : 'host'
      const otherFace = expectedFace === 'client' ? 'host' : 'client'
      const reference = `./packages/openloop/${entry.name}`
      const expectedCount = aggregates[expectedFace].filter(path => path === reference).length
      const otherCount = aggregates[otherFace].filter(path => path === reference).length
      if (expectedCount !== 1 || otherCount !== 0) {
        errors.push(
          `${relativeManifestPath}: openloop.face ${String(face)} requires exactly one tsconfig.${expectedFace}.json reference and no tsconfig.${otherFace}.json reference (found ${expectedFace}=${expectedCount}, ${otherFace}=${otherCount})`,
        )
      }
      if (face === 'pure') {
        for (const extension of pureClientConfigExtensions(
          root,
          join(packagesRoot, entry.name),
          clientConfigs,
        )) {
          errors.push(
            `packages/openloop/${entry.name}/tsconfig.json: pure production config must not extend Client config ${extension}`,
          )
        }
        for (const reference of pureClientProjectReferences(
          root,
          join(packagesRoot, entry.name),
          clientConfigs,
        )) {
          errors.push(
            `packages/openloop/${entry.name}/tsconfig.json: pure production config must not reference Client project ${reference}`,
          )
        }
      }
    }

    if (!isCordisPlugin(manifest)) continue
    const peer = manifest.peerDependencies?.[cordisPackage]
    const dev = manifest.devDependencies?.[cordisPackage]
    if (peer === undefined) {
      errors.push(`${relativeManifestPath}: Cordis plugin must declare ${cordisPackage} as a peerDependency`)
    }
    if (dev === undefined) {
      errors.push(`${relativeManifestPath}: Cordis plugin must also declare ${cordisPackage} as a devDependency`)
    }
    if (peer !== undefined && dev !== undefined && peer !== dev) {
      errors.push(`${relativeManifestPath}: ${cordisPackage} peer (${peer}) and dev (${dev}) ranges must match`)
    }
  }

  errors.push(...workspaceExecutionBoundaryViolations(root))
  errors.push(...unapprovedProcessProviderViolations(root))
  return errors
}
