/**
 * Read-only drift gate for the Openloop browser API policy.
 *
 * Sources:
 * - Client roster: every enabled row in the nested Entry tree produced from
 *   the three signed profile bundle patches by the repository's own
 *   `composeEntries`.
 * - Legacy calls: TypeScript-resolved callable symbols whose signature belongs
 *   to `IApiClient` and therefore carries a literal `RequestPayload<'...'>`.
 * - Typert calls: generated Remote descriptors selected by
 *   `packages/api/remotes/src/client/index.ts`, plus product-owned facade
 *   packages explicitly mounted by the signed profile. Direct Remote calls
 *   are parsed structurally so the gate also works before generated build
 *   output exists; callable aliases are followed through checker symbols and
 *   delegated package-local Remote interfaces are accepted only when their
 *   resolved member maps unambiguously to one generated namespace.
 * - Transport calls: the fixed Connection downlinks/respond carrier and the
 *   session-log download controller. These are not part of either typed API
 *   catalog, so they remain an explicit, reviewed list tied to their owners.
 *
 * The scan deliberately excludes Connection's in-browser fixture backend:
 * those calls target its in-memory fake API and never cross the Host bridge.
 * Any unresolved external Client package fails the roster check instead of
 * being guessed or added to the runtime policy.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { composeEntries } from '@deepseek-ai/dsh-app-boot'
import { entryListSchema, type PatchOptions } from '@deepseek-ai/cordis-plugin-include'
import type { EntryOptions } from '@deepseek-ai/cordis-plugin-loader'
import {
  parseBrowserApiPolicyManifest,
  type BrowserApiPolicyManifest,
} from '@openloop/desktop-bridge-host'
import { WorkspaceTypertGenerator } from '@deepseek-ai/dsh-typert-generator'
import * as yaml from 'js-yaml'
import ts from 'typescript'
import { workspacePackageManifestPaths } from './workspace-manifests.ts'

interface BundleManifest {
  readonly name?: string
  readonly exports?: unknown
  readonly dsh?: unknown
}

interface RemoteContribution {
  readonly descriptors: readonly {
    readonly namespace: string
    readonly method: string
  }[]
}

interface AssembledClientRow {
  id: string
  packageName: string
}

interface ClientPackageRoot {
  ids: Set<string>
  root: string
}

export interface OpenloopBrowserApiSurface {
  assembledClientRows: AssembledClientRow[]
  cataloguedClientPackages: Set<string>
  legacyRpcMethods: Map<string, Set<string>>
  typertRemoteEndpoints: Map<string, Set<string>>
  transportRoutes: Map<string, Set<string>>
}

const PROFILE_BUNDLES = [
  '@deepseek-ai/dsh-base',
  '@deepseek-ai/dsh-web-app',
  '@openloop/bundle',
] as const

const PRODUCT_REMOTE_FACADES: ReadonlyArray<readonly [string, string]> = [
  ['@openloop/desktop-bridge-host', 'desktop-bridge-host'],
]

const TRANSPORT_CALLS: ReadonlyArray<readonly [string, string]> = [
  ['connection', 'GET /api/events.mux'],
  ['connection', 'GET /api/events.host'],
  ['connection', 'POST /api/respond'],
  ['session-log-download', 'GET /api/session.export'],
  ['session-log-download', 'HEAD /api/session.export'],
]

// These signed Host packages intentionally expose a TypeScript `./client`
// subpath without participating in the browser plugin roster. Every other
// enabled row with that export must carry parseable `dsh.client` metadata.
const SIGNED_NON_CLIENT_PACKAGES = new Set([
  '@deepseek-ai/dsh-goal',
  '@deepseek-ai/dsh-host-apiproxy',
  '@deepseek-ai/dsh-permission-presets',
  '@deepseek-ai/dsh-plan-mode',
  '@deepseek-ai/dsh-session-stats',
  '@deepseek-ai/dsh-session-title',
  '@deepseek-ai/dsh-subagent',
  '@deepseek-ai/dsh-token-meter',
  '@deepseek-ai/dsh-tool-todo',
])

function workspacePackageManifests(root: string): Map<string, {
  path: string
  value: BundleManifest
}> {
  const manifests = new Map<string, { path: string; value: BundleManifest }>()
  for (const path of workspacePackageManifestPaths(root)) {
    const value = JSON.parse(readFileSync(path, 'utf8')) as BundleManifest
    if (value.name === undefined) continue
    const existing = manifests.get(value.name)
    if (existing !== undefined) {
      const displayPath = (candidate: string): string =>
        relative(root, candidate).split(sep).join('/')
      throw new Error(
        `browser-api-drift: duplicate workspace package ${JSON.stringify(value.name)}: `
        + `${displayPath(existing.path)} and ${displayPath(path)}`,
      )
    }
    manifests.set(value.name, { path, value })
  }
  return manifests
}

function packageManifest(
  manifests: ReadonlyMap<string, { path: string; value: BundleManifest }>,
  packageName: string,
): { path: string; value: BundleManifest } {
  const manifest = manifests.get(packageName)
  if (manifest === undefined) throw new Error(`browser-api-drift: unknown workspace package ${packageName}`)
  return manifest
}

function packageJsonFromAnchor(anchor: string, packageName: string): string | undefined {
  for (const searchPath of createRequire(anchor).resolve.paths(packageName) ?? []) {
    const candidate = join(searchPath, packageName, 'package.json')
    if (existsSync(candidate)) return candidate
  }
  return undefined
}

function rowLocation(id: string): string {
  const separator = id.lastIndexOf(':')
  return separator === -1
    ? 'top-level'
    : `nested under ${JSON.stringify(id.slice(0, separator))}`
}

function rowDescription(id: string, name: string): string {
  return `enabled row ${JSON.stringify(id)} (name ${JSON.stringify(name)}, ${rowLocation(id)})`
}

function readRowManifest(
  manifests: ReadonlyMap<string, { path: string; value: BundleManifest }>,
  anchor: string,
  packageName: string,
  id: string,
  name: string,
): { path: string; value: BundleManifest } {
  const workspace = manifests.get(packageName)
  const path = workspace?.path ?? packageJsonFromAnchor(anchor, packageName)
  if (path === undefined) {
    throw new Error(
      `browser-api-drift: ${rowDescription(id, name)} cannot resolve package manifest for `
      + JSON.stringify(packageName),
    )
  }
  if (workspace !== undefined) return workspace
  try {
    return {
      path,
      value: JSON.parse(readFileSync(path, 'utf8')) as BundleManifest,
    }
  } catch (error) {
    throw new Error(
      `browser-api-drift: ${rowDescription(id, name)} has malformed package manifest at ${path}`,
      { cause: error },
    )
  }
}

function hasClientExport(value: BundleManifest): boolean {
  return typeof value.exports === 'object'
    && value.exports !== null
    && Object.hasOwn(value.exports, './client')
}

function clientPlatform(
  manifest: { path: string; value: BundleManifest },
  packageName: string,
  id: string,
  name: string,
): string | undefined {
  const dsh = manifest.value.dsh
  const declaration = typeof dsh === 'object' && dsh !== null && !Array.isArray(dsh)
    ? (dsh as Record<string, unknown>).client
    : undefined
  if (declaration === undefined) {
    if (hasClientExport(manifest.value) && !SIGNED_NON_CLIENT_PACKAGES.has(packageName)) {
      throw new Error(
        `browser-api-drift: ${rowDescription(id, name)} exports "./client" but has no `
        + `dsh.client metadata in ${manifest.path}`,
      )
    }
    return undefined
  }
  if (typeof declaration !== 'object' || declaration === null) {
    throw new Error(
      `browser-api-drift: ${rowDescription(id, name)} has malformed dsh.client metadata `
      + `in ${manifest.path}: declaration must be an object`,
    )
  }
  const metadata = declaration as Record<string, unknown>
  if (typeof metadata.platform !== 'string') {
    throw new Error(
      `browser-api-drift: ${rowDescription(id, name)} has malformed dsh.client metadata `
      + `in ${manifest.path}: platform must be a string`,
    )
  }
  if (metadata.inject !== undefined
    && (!Array.isArray(metadata.inject)
      || metadata.inject.some(value => typeof value !== 'string'))) {
    throw new Error(
      `browser-api-drift: ${rowDescription(id, name)} has malformed dsh.client metadata `
      + `in ${manifest.path}: inject must be a string array`,
    )
  }
  if (metadata.immediately !== undefined
    && typeof metadata.immediately !== 'boolean') {
    throw new Error(
      `browser-api-drift: ${rowDescription(id, name)} has malformed dsh.client metadata `
      + `in ${manifest.path}: immediately must be a boolean`,
    )
  }
  return metadata.platform
}

function openloopEntries(
  manifests: ReadonlyMap<string, { path: string; value: BundleManifest }>,
): EntryOptions[] {
  const layers = PROFILE_BUNDLES.map((packageName) => {
    const manifest = packageManifest(manifests, packageName)
    const dsh = manifest.value.dsh
    const bundle = typeof dsh === 'object' && dsh !== null && !Array.isArray(dsh)
      ? (dsh as Record<string, unknown>).bundle
      : undefined
    const patch = typeof bundle === 'object' && bundle !== null && !Array.isArray(bundle)
      ? (bundle as Record<string, unknown>).patch
      : undefined
    if (patch === undefined) throw new Error(`browser-api-drift: ${packageName} declares no bundle patch`)
    if (typeof patch !== 'string') {
      throw new Error(`browser-api-drift: ${packageName} declares an invalid bundle patch`)
    }
    return yaml.load(readFileSync(join(dirname(manifest.path), patch), 'utf8'), {
      schema: entryListSchema,
    }) as PatchOptions[]
  })
  return composeEntries(layers)
}

function sourceFiles(directory: string): string[] {
  const result: string[] = []
  const visit = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name)
      if (entry.isDirectory()) {
        visit(path)
      } else if (entry.isFile()
        && (path.endsWith('.ts') || path.endsWith('.tsx'))
        && !path.endsWith('.d.ts')) {
        result.push(path)
      }
    }
  }
  if (existsSync(directory)) visit(directory)
  return result
}

function isExcludedClientSource(file: string, packageRoot: string): boolean {
  const child = relative(packageRoot, file)
  if (child === '' || child === '..' || child.startsWith(`..${sep}`)) return false
  const segments = child.split(sep)
  return segments.includes('tests')
    || segments.includes('fixtures')
    || segments.at(-1) === 'fixture.ts'
}

function addCall(calls: Map<string, Set<string>>, endpoint: string, owner: string): void {
  const owners = calls.get(endpoint) ?? new Set<string>()
  owners.add(owner)
  calls.set(endpoint, owners)
}

function unwrapExpression(expression: ts.Expression): ts.Expression {
  let current = expression
  while (ts.isParenthesizedExpression(current)
    || ts.isAsExpression(current)
    || ts.isTypeAssertionExpression(current)
    || ts.isNonNullExpression(current)
    || ts.isSatisfiesExpression(current)) {
    current = current.expression
  }
  return current
}

function typeReferenceName(node: ts.TypeReferenceNode): string {
  return ts.isIdentifier(node.typeName) ? node.typeName.text : node.typeName.right.text
}

function requestPayloadMethod(node: ts.Node): string | undefined {
  let found: string | undefined
  const visit = (candidate: ts.Node): void => {
    if (found !== undefined) return
    const argument = ts.isTypeReferenceNode(candidate)
      ? candidate.typeArguments?.[0]
      : undefined
    if (ts.isTypeReferenceNode(candidate)
      && typeReferenceName(candidate) === 'RequestPayload'
      && candidate.typeArguments?.length === 1
      && argument !== undefined
      && ts.isLiteralTypeNode(argument)
      && ts.isStringLiteral(argument.literal)) {
      found = argument.literal.text
      return
    }
    ts.forEachChild(candidate, visit)
  }
  visit(node)
  return found
}

function enclosingInterface(node: ts.Node): ts.InterfaceDeclaration | undefined {
  let current = node
  while (!ts.isSourceFile(current)) {
    if (ts.isInterfaceDeclaration(current)) return current
    current = current.parent
  }
  return undefined
}

function declarationName(node: ts.Declaration): string | undefined {
  let current: ts.Node = node
  while (!ts.isSourceFile(current)) {
    if (ts.isMethodSignature(current)
      || ts.isPropertySignature(current)
      || ts.isMethodDeclaration(current)
      || ts.isPropertyDeclaration(current)
      || ts.isFunctionDeclaration(current)) {
      const name = ts.getNameOfDeclaration(current)
      if (name !== undefined && (ts.isIdentifier(name) || ts.isStringLiteralLike(name))) {
        return name.text
      }
    }
    current = current.parent
  }
  return undefined
}

function staticExpressionName(
  expression: ts.Expression,
  checker: ts.TypeChecker,
): string | undefined {
  const candidate = unwrapExpression(expression)
  if (ts.isStringLiteralLike(candidate) || ts.isNumericLiteral(candidate)) {
    return candidate.text
  }
  const type = checker.getTypeAtLocation(candidate)
  if (type.isStringLiteral() || type.isNumberLiteral()) return String(type.value)
  return undefined
}

function staticPropertyName(
  name: ts.PropertyName,
  checker: ts.TypeChecker,
): string | undefined {
  if (ts.isIdentifier(name) || ts.isStringLiteralLike(name) || ts.isNumericLiteral(name)) {
    return name.text
  }
  return ts.isComputedPropertyName(name)
    ? staticExpressionName(name.expression, checker)
    : undefined
}

function bindingPropertyName(
  binding: ts.BindingElement,
  checker: ts.TypeChecker,
): string | undefined {
  if (binding.propertyName !== undefined) {
    return staticPropertyName(binding.propertyName, checker)
  }
  return ts.isIdentifier(binding.name) ? binding.name.text : undefined
}

function staticAccessName(
  node: ts.Expression,
  checker: ts.TypeChecker,
): string | undefined {
  const expression = unwrapExpression(node)
  if (ts.isPropertyAccessExpression(expression)) return expression.name.text
  if (ts.isElementAccessExpression(expression)) {
    return staticExpressionName(expression.argumentExpression, checker)
  }
  return undefined
}

interface ReflectGetAccess {
  key: ts.Expression
  target: ts.Expression
}

function builtinReflectGetAccess(
  node: ts.CallExpression,
  checker: ts.TypeChecker,
): ReflectGetAccess | undefined {
  const callee = unwrapExpression(node.expression)
  if (!ts.isPropertyAccessExpression(callee)
    || !ts.isIdentifier(callee.expression)
    || callee.expression.text !== 'Reflect'
    || callee.name.text !== 'get'
    || node.arguments.length < 2) return undefined
  const symbol = checker.getSymbolAtLocation(callee.name)
  const isBuiltin = (symbol?.declarations ?? []).some((declaration) => {
    const block = declaration.parent
    const namespace = block.parent
    return declaration.getSourceFile().isDeclarationFile
      && /(?:^|[/\\])lib\.[^/\\]+\.d\.ts$/u.test(declaration.getSourceFile().fileName)
      && ts.isModuleBlock(block)
      && ts.isModuleDeclaration(namespace)
      && ts.isIdentifier(namespace.name)
      && namespace.name.text === 'Reflect'
  })
  const target = node.arguments[0]
  const key = node.arguments[1]
  return isBuiltin && target !== undefined && key !== undefined
    ? { key, target }
    : undefined
}

function accessTarget(node: ts.Expression): ts.Expression | undefined {
  const expression = unwrapExpression(node)
  return ts.isPropertyAccessExpression(expression) || ts.isElementAccessExpression(expression)
    ? expression.expression
    : undefined
}

function referenceSymbol(
  expression: ts.Expression,
  checker: ts.TypeChecker,
): ts.Symbol | undefined {
  const candidate = unwrapExpression(expression)
  if (ts.isIdentifier(candidate)) return checker.getSymbolAtLocation(candidate)
  if (ts.isPropertyAccessExpression(candidate)) {
    return checker.getSymbolAtLocation(candidate.name)
  }
  if (ts.isElementAccessExpression(candidate)) {
    const name = staticAccessName(candidate, checker)
    return name === undefined
      ? undefined
      : checker.getPropertyOfType(checker.getTypeAtLocation(candidate.expression), name)
  }
  return undefined
}

function directRemoteEndpoint(
  expression: ts.Expression,
  checker: ts.TypeChecker,
  isRemoteRoot: (candidate: ts.Expression) => boolean,
): string | undefined {
  const method = staticAccessName(expression, checker)
  const namespaceAccess = accessTarget(expression)
  if (method === undefined || namespaceAccess === undefined) return undefined
  return remoteEndpointFromNamespace(namespaceAccess, method, checker, isRemoteRoot)
}

function remoteEndpointFromNamespace(
  namespaceAccess: ts.Expression,
  method: string,
  checker: ts.TypeChecker,
  isRemoteRoot: (candidate: ts.Expression) => boolean,
): string | undefined {
  const namespace = staticAccessName(namespaceAccess, checker)
  const remoteAccess = accessTarget(namespaceAccess)
  if (namespace === undefined
    || remoteAccess === undefined
    || !isRemoteRoot(remoteAccess)) return undefined
  return `${namespace}/${method}`
}

function typertRemoteRootSymbol(
  expression: ts.Expression,
  checker: ts.TypeChecker,
): ts.Symbol | undefined {
  const candidate = unwrapExpression(expression)
  if (staticAccessName(candidate, checker) !== 'remote') return undefined
  let symbol: ts.Symbol | undefined
  if (ts.isPropertyAccessExpression(candidate)) {
    symbol = checker.getSymbolAtLocation(candidate.name)
  } else if (ts.isElementAccessExpression(candidate)) {
    symbol = checker.getPropertyOfType(
      checker.getTypeAtLocation(candidate.expression),
      staticAccessName(candidate, checker) ?? '',
    )
  }
  return symbol
}

function isTypertRemoteRootSymbol(symbol: ts.Symbol | undefined): boolean {
  return (symbol?.declarations ?? []).some((declaration) => {
    const path = declaration.getSourceFile().fileName.split(sep).join('/')
    return path.endsWith('/packages/api/remotes/src/client/index.ts')
      || path.endsWith('/packages/api/gateway/src/client/index.ts')
  })
}

function isTypertRemoteRoot(
  expression: ts.Expression,
  checker: ts.TypeChecker,
): boolean {
  return isTypertRemoteRootSymbol(typertRemoteRootSymbol(expression, checker))
}

function canonicalPackageName(specifier: string): string | undefined {
  if (specifier.startsWith('.') || specifier.startsWith('/')
    || /^[a-z][a-z+.-]*:/iu.test(specifier)) return undefined
  const segments = specifier.split('/')
  return specifier.startsWith('@')
    ? segments.length >= 2 ? `${segments[0]}/${segments[1]}` : undefined
    : segments[0] || undefined
}

interface AssembledEntry {
  entry: EntryOptions
  id: string
  disabled: boolean
}

function assembledEntries(entries: readonly EntryOptions[]): AssembledEntry[] {
  const result: AssembledEntry[] = []
  const visit = (
    children: readonly EntryOptions[],
    parentId: string | undefined,
    inheritedDisabled: boolean,
  ): void => {
    for (const entry of children) {
      if (typeof entry.id !== 'string' || entry.id === '') continue
      const id = parentId === undefined ? entry.id : `${parentId}:${entry.id}`
      const disabled = inheritedDisabled || entry.disabled === true
      result.push({ entry, id, disabled })
      if (entry.group === true && Array.isArray(entry.config)) {
        visit(entry.config as EntryOptions[], id, disabled)
      }
    }
  }
  visit(entries, undefined, false)
  return result
}

function packageForPath(
  path: string,
  roots: ReadonlyMap<string, ClientPackageRoot>,
): { ids: ReadonlySet<string>; packageName: string } | undefined {
  for (const [packageName, owner] of roots) {
    const child = relative(owner.root, path)
    if (child !== '' && child !== '..' && !child.startsWith(`..${sep}`)) {
      return { ids: owner.ids, packageName }
    }
  }
  return undefined
}

function selectedRemotePackages(root: string): string[] {
  const path = resolve(root, 'packages/api/remotes/src/client/index.ts')
  const source = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true)
  const packages = new Set(PRODUCT_REMOTE_FACADES.map(([packageName]) => packageName))
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue
    const specifier = statement.moduleSpecifier.text
    if (specifier.endsWith('/remote')) packages.add(specifier.slice(0, -'/remote'.length))
  }
  return [...packages]
}

async function generatedRemoteCatalog(
  root: string,
): Promise<Map<string, readonly { namespace: string; method: string }[]>> {
  const packages = selectedRemotePackages(root)
  const catalog = new Map<string, readonly { namespace: string; method: string }[]>()
  const generatorRequire = createRequire(
    resolve(root, 'packages/typert/generator/package.json'),
  )
  const zodUrl = pathToFileURL(generatorRequire.resolve('zod')).href
  for (const artifact of new WorkspaceTypertGenerator(root).generate(packages, ['host'])) {
    if (artifact.remote === undefined) {
      throw new Error(`browser-api-drift: ${artifact.package} generated no Remote descriptor`)
    }
    const executable = artifact.remote.js.replace(
      "from 'zod'",
      `from ${JSON.stringify(zodUrl)}`,
    )
    const loaded = await import(`data:text/javascript,${encodeURIComponent(executable)}`) as {
      default: RemoteContribution
    }
    catalog.set(artifact.package, loaded.default.descriptors.map(({ namespace, method }) => ({
      namespace,
      method,
    })))
  }
  return catalog
}

function generatedPackageForDeclaration(
  declarationPath: string,
  catalog: ReadonlyMap<string, readonly { namespace: string; method: string }[]>,
  manifests: ReadonlyMap<string, { path: string; value: BundleManifest }>,
): string | undefined {
  for (const packageName of catalog.keys()) {
    const root = dirname(packageManifest(manifests, packageName).path)
    const child = relative(root, declarationPath)
    if (child !== '' && child !== '..' && !child.startsWith(`..${sep}`)) return packageName
  }
  return undefined
}

function generatedEndpoint(
  descriptors: readonly { namespace: string; method: string }[],
  method: string,
): string | undefined {
  const matches = descriptors.filter(descriptor => descriptor.method === method)
  const match = matches[0]
  return matches.length === 1 && match !== undefined
    ? `${match.namespace}/${match.method}`
    : undefined
}

function localRemoteEndpoint(
  declaration: ts.Declaration,
  descriptors: readonly { namespace: string; method: string }[],
): string | undefined {
  const carriesRemoteResult = (node: ts.Node): boolean => {
    if (ts.isTypeReferenceNode(node) && typeReferenceName(node) === 'RemoteResult') return true
    return ts.forEachChild(
      node,
      child => carriesRemoteResult(child) ? true : undefined,
    ) === true
  }
  if (!carriesRemoteResult(declaration)) return undefined
  const iface = enclosingInterface(declaration)
  if (iface === undefined || !iface.name.text.endsWith('Remote')) return undefined
  const method = declarationName(declaration)
  if (method === undefined) return undefined
  const stem = iface.name.text.slice(0, -'Remote'.length)
  const namespace = stem.slice(0, 1).toLowerCase() + stem.slice(1)
  const matches = descriptors.filter(candidate =>
    candidate.namespace === namespace && candidate.method === method)
  return matches.length === 1 ? `${namespace}/${method}` : undefined
}

function assignmentOrigins(source: ts.SourceFile, checker: ts.TypeChecker): Map<ts.Symbol, ts.Expression[]> {
  const result = new Map<ts.Symbol, ts.Expression[]>()
  const add = (target: ts.Expression, value: ts.Expression): void => {
    const symbol = referenceSymbol(target, checker)
    if (symbol === undefined) return
    const origins = result.get(symbol) ?? []
    origins.push(value)
    result.set(symbol, origins)
  }
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node)
      && ts.isIdentifier(node.name)
      && node.initializer !== undefined) {
      add(node.name, node.initializer)
    } else if (ts.isPropertyAssignment(node)) {
      const symbol = checker.getSymbolAtLocation(node.name)
      if (symbol !== undefined) {
        const origins = result.get(symbol) ?? []
        origins.push(node.initializer)
        result.set(symbol, origins)
      }
    } else if (ts.isShorthandPropertyAssignment(node)) {
      const symbol = checker.getSymbolAtLocation(node.name)
      if (symbol !== undefined) {
        const origins = result.get(symbol) ?? []
        origins.push(node.name)
        result.set(symbol, origins)
      }
    } else if (ts.isBinaryExpression(node)
      && node.operatorToken.kind === ts.SyntaxKind.EqualsToken
      && (ts.isIdentifier(unwrapExpression(node.left))
        || ts.isPropertyAccessExpression(unwrapExpression(node.left))
        || ts.isElementAccessExpression(unwrapExpression(node.left)))) {
      add(node.left, node.right)
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return result
}

interface StaticAliasOrigin {
  expression: ts.Expression
  path: readonly string[]
}

function staticAliasOrigins(
  source: ts.SourceFile,
  checker: ts.TypeChecker,
): Map<ts.Symbol, StaticAliasOrigin[]> {
  const result = new Map<ts.Symbol, StaticAliasOrigin[]>()
  const add = (
    target: ts.Expression,
    expression: ts.Expression,
    path: readonly string[],
  ): void => {
    const symbol = referenceSymbol(target, checker)
    if (symbol === undefined) return
    const origins = result.get(symbol) ?? []
    origins.push({ expression, path })
    result.set(symbol, origins)
  }
  const addBinding = (
    binding: ts.BindingName,
    expression: ts.Expression,
    path: readonly string[],
  ): void => {
    if (ts.isIdentifier(binding)) {
      add(binding, expression, path)
      return
    }
    if (!ts.isObjectBindingPattern(binding)) return
    for (const element of binding.elements) {
      if (element.dotDotDotToken !== undefined) continue
      const name = bindingPropertyName(element, checker)
      if (name === undefined) continue
      addBinding(element.name, expression, [...path, name])
    }
  }
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && node.initializer !== undefined) {
      addBinding(node.name, node.initializer, [])
    } else if (ts.isPropertyAssignment(node)) {
      const symbol = checker.getSymbolAtLocation(node.name)
      if (symbol !== undefined) {
        const origins = result.get(symbol) ?? []
        origins.push({ expression: node.initializer, path: [] })
        result.set(symbol, origins)
      }
    } else if (ts.isShorthandPropertyAssignment(node)) {
      const symbol = checker.getSymbolAtLocation(node.name)
      if (symbol !== undefined) {
        const origins = result.get(symbol) ?? []
        origins.push({ expression: node.name, path: [] })
        result.set(symbol, origins)
      }
    } else if (ts.isBinaryExpression(node)
      && node.operatorToken.kind === ts.SyntaxKind.EqualsToken
      && (ts.isIdentifier(unwrapExpression(node.left))
        || ts.isPropertyAccessExpression(unwrapExpression(node.left))
        || ts.isElementAccessExpression(unwrapExpression(node.left)))) {
      add(node.left, node.right, [])
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return result
}

function symbolAtStaticPath(
  origin: StaticAliasOrigin,
  checker: ts.TypeChecker,
): ts.Symbol | undefined {
  let type = checker.getTypeAtLocation(origin.expression)
  let symbol: ts.Symbol | undefined
  for (const segment of origin.path) {
    symbol = checker.getPropertyOfType(type, segment)
    if (symbol === undefined) return undefined
    type = checker.getTypeOfSymbolAtLocation(symbol, origin.expression)
  }
  return symbol
}

interface BindingSelection {
  initializer: ts.Expression
  path: readonly (string | undefined)[]
}

function bindingSelection(
  binding: ts.BindingElement,
  checker: ts.TypeChecker,
): BindingSelection | undefined {
  const path: Array<string | undefined> = []
  let current = binding
  for (;;) {
    if (!ts.isObjectBindingPattern(current.parent)) return undefined
    path.unshift(bindingPropertyName(current, checker))
    const parent = current.parent.parent
    if (ts.isVariableDeclaration(parent)) {
      return parent.initializer === undefined
        ? undefined
        : { initializer: parent.initializer, path }
    }
    if (!ts.isBindingElement(parent)) return undefined
    current = parent
  }
}

function typeAtStaticPath(
  expression: ts.Expression,
  path: readonly string[],
  checker: ts.TypeChecker,
): ts.Type | undefined {
  let type = checker.getTypeAtLocation(expression)
  for (const segment of path) {
    const symbol = checker.getPropertyOfType(type, segment)
    if (symbol === undefined) return undefined
    type = checker.getTypeOfSymbolAtLocation(symbol, expression)
  }
  return type
}

function symbolAtExpressionPath(
  expression: ts.Expression,
  path: readonly string[],
  checker: ts.TypeChecker,
): ts.Symbol | undefined {
  if (path.length === 0) return referenceSymbol(expression, checker)
  const name = path[path.length - 1]
  if (name === undefined) return undefined
  const parent = typeAtStaticPath(expression, path.slice(0, -1), checker)
  return parent === undefined
    ? undefined
    : checker.getPropertyOfType(parent, name)
}

function isStaticPath(path: readonly (string | undefined)[]): path is readonly string[] {
  return path.every(name => name !== undefined)
}

function objectLiteralProperty(
  expression: ts.Expression,
  name: string,
): ts.Expression | undefined {
  const candidate = unwrapExpression(expression)
  if (!ts.isObjectLiteralExpression(candidate)) return undefined
  for (const property of candidate.properties) {
    if (ts.isPropertyAssignment(property)) {
      const propertyName = property.name
      if ((ts.isIdentifier(propertyName) || ts.isStringLiteralLike(propertyName))
        && propertyName.text === name) return property.initializer
    } else if (ts.isShorthandPropertyAssignment(property) && property.name.text === name) {
      return property.name
    }
  }
  return undefined
}

function resolvesStaticAlias(
  expression: ts.Expression,
  checker: ts.TypeChecker,
  origins: ReadonlyMap<ts.Symbol, readonly StaticAliasOrigin[]>,
  matchesExpression: (candidate: ts.Expression) => boolean,
  matchesPathSymbol: (symbol: ts.Symbol | undefined) => boolean,
): boolean {
  const visitedSymbols = new Set<ts.Symbol>()
  const visit = (candidate: ts.Expression): boolean => {
    const expression = unwrapExpression(candidate)
    if (matchesExpression(expression)) return true
    const name = staticAccessName(expression, checker)
    const target = accessTarget(expression)
    if (name !== undefined && target !== undefined) {
      const targetSymbol = referenceSymbol(target, checker)
      if (targetSymbol !== undefined && !visitedSymbols.has(targetSymbol)) {
        visitedSymbols.add(targetSymbol)
        const matched = (origins.get(targetSymbol) ?? []).some((origin) => {
          if (origin.path.length !== 0) return false
          const property = objectLiteralProperty(origin.expression, name)
          return property !== undefined && visit(property)
        })
        if (matched) return true
      }
    }
    const symbol = referenceSymbol(expression, checker)
    if (symbol === undefined || visitedSymbols.has(symbol)) return false
    visitedSymbols.add(symbol)
    return (origins.get(symbol) ?? []).some(origin =>
      origin.path.length === 0
        ? visit(origin.expression)
        : matchesPathSymbol(symbolAtStaticPath(origin, checker)))
  }
  return visit(expression)
}

function bindingRemoteEndpoint(
  declaration: ts.Declaration,
  checker: ts.TypeChecker,
  isRemoteRoot: (candidate: ts.Expression) => boolean,
): string | undefined {
  if (!ts.isBindingElement(declaration)
    || !ts.isObjectBindingPattern(declaration.parent)
    || !ts.isVariableDeclaration(declaration.parent.parent)
    || declaration.parent.parent.initializer === undefined) return undefined
  const name = bindingPropertyName(declaration, checker)
  if (name === undefined) return undefined
  return remoteEndpointFromNamespace(
    declaration.parent.parent.initializer,
    name,
    checker,
    isRemoteRoot,
  )
}

function aliasedRemoteEndpoints(
  expression: ts.Expression,
  checker: ts.TypeChecker,
  origins: ReadonlyMap<ts.Symbol, readonly ts.Expression[]>,
  isRemoteRoot: (candidate: ts.Expression) => boolean,
): string[] {
  const endpoints = new Set<string>()
  const visitedSymbols = new Set<ts.Symbol>()
  const visit = (candidate: ts.Expression): void => {
    const expression = unwrapExpression(candidate)
    const endpoint = directRemoteEndpoint(expression, checker, isRemoteRoot)
    if (endpoint !== undefined) endpoints.add(endpoint)
    const symbol = referenceSymbol(expression, checker)
    if (symbol !== undefined) {
      if (visitedSymbols.has(symbol)) return
      visitedSymbols.add(symbol)
      for (const declaration of symbol.declarations ?? []) {
        const bindingEndpoint = bindingRemoteEndpoint(declaration, checker, isRemoteRoot)
        if (bindingEndpoint !== undefined) endpoints.add(bindingEndpoint)
      }
      for (const origin of origins.get(symbol) ?? []) visit(origin)
    }
    if (ts.isCallExpression(expression)
      && staticAccessName(expression.expression, checker) === 'bind') {
      const target = accessTarget(expression.expression)
      if (target !== undefined) visit(target)
    }
  }
  visit(expression)
  return [...endpoints]
}

function callableDeclarations(
  expression: ts.Expression,
  checker: ts.TypeChecker,
  origins: ReadonlyMap<ts.Symbol, readonly ts.Expression[]>,
): ts.Declaration[] {
  const declarations = new Set<ts.Declaration>()
  const visitedSymbols = new Set<ts.Symbol>()
  const visit = (candidate: ts.Expression): void => {
    const expression = unwrapExpression(candidate)
    for (const signature of checker.getTypeAtLocation(expression).getCallSignatures()) {
      declarations.add(signature.getDeclaration())
    }
    const symbol = referenceSymbol(expression, checker)
    if (symbol !== undefined) {
      if (visitedSymbols.has(symbol)) return
      visitedSymbols.add(symbol)
      for (const origin of origins.get(symbol) ?? []) visit(origin)
    }
    if (ts.isCallExpression(expression)
      && staticAccessName(expression.expression, checker) === 'bind') {
      const target = accessTarget(expression.expression)
      if (target !== undefined) visit(target)
      return
    }
    if (ts.isPropertyAccessExpression(expression)) {
      const property = checker.getSymbolAtLocation(expression.name)
      for (const declaration of property?.declarations ?? []) {
        declarations.add(declaration)
      }
    } else if (ts.isElementAccessExpression(expression)) {
      const name = staticAccessName(expression, checker)
      if (name === undefined) return
      const property = checker.getPropertyOfType(
        checker.getTypeAtLocation(expression.expression),
        name,
      )
      for (const declaration of property?.declarations ?? []) {
        declarations.add(declaration)
      }
    }
  }
  visit(expression)
  return [...declarations]
}

function compilerOptions(root: string): ts.CompilerOptions {
  const path = resolve(root, 'tsconfig.base.client.json')
  const loaded = ts.readConfigFile(path, filename => ts.sys.readFile(filename))
  if (loaded.error !== undefined) {
    throw new Error(ts.flattenDiagnosticMessageText(loaded.error.messageText, '\n'))
  }
  return ts.parseJsonConfigFileContent(loaded.config, ts.sys, root).options
}

/** Collect the final signed Client roster and its statically reachable API calls. */
export async function collectOpenloopBrowserApiSurface(
  root: string,
): Promise<OpenloopBrowserApiSurface> {
  const manifests = workspacePackageManifests(root)
  const profileAnchor = resolve(root, 'packages/openloop/bundle/package.json')
  const rows: AssembledClientRow[] = []
  const roots = new Map<string, ClientPackageRoot>()
  const cataloguedClientPackages = new Set<string>()
  const enabledIds = new Set<string>()

  for (const { entry, id, disabled } of assembledEntries(openloopEntries(manifests))) {
    if (typeof entry.name !== 'string' || disabled) continue
    const packageName = canonicalPackageName(entry.name)
    if (packageName === undefined) continue
    const manifest = readRowManifest(
      manifests,
      profileAnchor,
      packageName,
      id,
      entry.name,
    )
    if (clientPlatform(manifest, packageName, id, entry.name) !== 'web') continue
    enabledIds.add(id)
    rows.push({ id, packageName })
    const packageRoot = dirname(manifest.path)
    const sourceRoot = join(packageRoot, 'src', 'client')
    if (packageName.startsWith('@deepseek-ai/dsh-')
      && relative(root, packageRoot) !== '..'
      && !relative(root, packageRoot).startsWith(`..${sep}`)
      && existsSync(sourceRoot)) {
      cataloguedClientPackages.add(packageName)
      const owner = roots.get(packageName) ?? { ids: new Set<string>(), root: packageRoot }
      owner.ids.add(id)
      roots.set(packageName, owner)
    }
  }

  const files = [...roots.values()].flatMap(owner =>
    sourceFiles(join(owner.root, 'src', 'client'))
      .filter(path => !isExcludedClientSource(path, owner.root)))
  const program = ts.createProgram(files, compilerOptions(root))
  const checker = program.getTypeChecker()
  const remoteCatalog = await generatedRemoteCatalog(root)
  const allRemoteDescriptors = [...remoteCatalog.values()].flat()
  const legacyRpcMethods = new Map<string, Set<string>>()
  const typertRemoteEndpoints = new Map<string, Set<string>>()
  const dynamicReferenceLocations: string[] = []

  for (const [packageName, owner] of PRODUCT_REMOTE_FACADES) {
    const descriptors = remoteCatalog.get(packageName)
    if (descriptors === undefined) {
      throw new Error(`browser-api-drift: product Remote facade ${packageName} has no generated descriptors`)
    }
    for (const descriptor of descriptors) {
      addCall(
        typertRemoteEndpoints,
        `${descriptor.namespace}/${descriptor.method}`,
        owner,
      )
    }
  }

  const legacyMethod = (declaration: ts.Declaration): string | undefined => {
    const method = requestPayloadMethod(declaration)
    return method !== undefined && enclosingInterface(declaration)?.name.text === 'IApiClient'
      ? method
      : undefined
  }

  const remoteEndpoint = (declaration: ts.Declaration): string | undefined => {
    const method = declarationName(declaration)
    if (method === undefined) return undefined
    const generatedPackage = generatedPackageForDeclaration(
      declaration.getSourceFile().fileName,
      remoteCatalog,
      manifests,
    )
    return generatedPackage === undefined
      ? localRemoteEndpoint(declaration, allRemoteDescriptors)
      : generatedEndpoint(remoteCatalog.get(generatedPackage) ?? [], method)
  }

  const typeSymbols = (type: ts.Type): ts.Symbol[] => {
    const symbols = new Set<ts.Symbol>()
    if (type.aliasSymbol !== undefined) symbols.add(type.aliasSymbol)
    const symbol = type.getSymbol()
    if (symbol !== undefined) symbols.add(symbol)
    if (type.isUnionOrIntersection()) {
      for (const member of type.types) {
        for (const memberSymbol of typeSymbols(member)) symbols.add(memberSymbol)
      }
    }
    return [...symbols]
  }

  const isLegacySurfaceType = (type: ts.Type): boolean => {
    for (const symbol of typeSymbols(type)) {
      if (symbol.name === 'IApiClient') return true
      if ((symbol.declarations ?? []).some(declaration =>
        enclosingInterface(declaration)?.name.text === 'IApiClient')) return true
    }
    return type.getProperties().some(symbol =>
      (symbol.declarations ?? []).some(declaration => legacyMethod(declaration) !== undefined
        || (enclosingInterface(declaration)?.name.text === 'IApiClient'
          && requestPayloadMethod(declaration) !== undefined)))
  }

  const isLegacySurfaceDirect = (expression: ts.Expression): boolean =>
    isLegacySurfaceType(checker.getTypeAtLocation(expression))

  for (const source of program.getSourceFiles()) {
    const owner = packageForPath(source.fileName, roots)
    if (owner === undefined || source.isDeclarationFile) continue
    const packageRoot = roots.get(owner.packageName)?.root
    if (packageRoot === undefined || isExcludedClientSource(source.fileName, packageRoot)) continue
    const origins = assignmentOrigins(source, checker)
    const aliases = staticAliasOrigins(source, checker)
    const isRemoteRoot = (expression: ts.Expression): boolean =>
      resolvesStaticAlias(
        expression,
        checker,
        aliases,
        candidate => isTypertRemoteRoot(candidate, checker),
        isTypertRemoteRootSymbol,
      )
    const hasRemoteRoot = (expression: ts.Expression): boolean => {
      let current: ts.Expression | undefined = expression
      while (current !== undefined) {
        if (isRemoteRoot(current)) return true
        current = accessTarget(current)
      }
      return false
    }
    const isLegacySurface = (expression: ts.Expression): boolean =>
      resolvesStaticAlias(
        expression,
        checker,
        aliases,
        isLegacySurfaceDirect,
        () => false,
      )
    const isRemoteSurfaceType = (type: ts.Type): boolean =>
      type.getProperties().some(symbol =>
        (symbol.declarations ?? []).some(declaration => remoteEndpoint(declaration) !== undefined))
    const isRemoteSurface = (expression: ts.Expression): boolean => {
      if (hasRemoteRoot(expression)) return true
      return isRemoteSurfaceType(checker.getTypeAtLocation(expression))
    }
    const isBrowserApiSurface = (expression: ts.Expression): boolean =>
      isLegacySurface(expression) || isRemoteSurface(expression)
    const isBrowserApiType = (type: ts.Type | undefined): boolean =>
      type !== undefined && (isLegacySurfaceType(type) || isRemoteSurfaceType(type))

    const location = (expression: ts.Expression): string => {
      const position = source.getLineAndCharacterOfPosition(expression.getStart(source))
      return `${relative(root, source.fileName)}:${String(position.line + 1)}`
    }

    const recordRemoteEndpoint = (endpoint: string, expression: ts.Expression): void => {
      const known = allRemoteDescriptors.some(
        descriptor => `${descriptor.namespace}/${descriptor.method}` === endpoint,
      )
      if (!known) {
        throw new Error(
          `browser-api-drift: uncatalogued Typert reference ${endpoint} at ${location(expression)}`,
        )
      }
      for (const id of owner.ids) addCall(typertRemoteEndpoints, endpoint, id)
    }

    const recordDeclarations = (
      declarations: Iterable<ts.Declaration>,
    ): void => {
      for (const declaration of declarations) {
        const legacy = legacyMethod(declaration)
        if (legacy !== undefined) {
          const effectiveOwner = source.fileName.includes(
            `${sep}packages${sep}client${sep}runtime${sep}src${sep}client${sep}workspaces${sep}`,
          ) && legacy !== 'workspace.list'
            ? 'ui-workspace'
            : undefined
          if (effectiveOwner === undefined) {
            for (const id of owner.ids) addCall(legacyRpcMethods, legacy, id)
          } else if (enabledIds.has(effectiveOwner)) {
            addCall(legacyRpcMethods, legacy, effectiveOwner)
          }
          continue
        }
        const endpoint = remoteEndpoint(declaration)
        if (endpoint !== undefined) {
          for (const id of owner.ids) addCall(typertRemoteEndpoints, endpoint, id)
        }
      }
    }

    const recordExpression = (expression: ts.Expression): void => {
      for (const endpoint of aliasedRemoteEndpoints(expression, checker, origins, isRemoteRoot)) {
        recordRemoteEndpoint(endpoint, expression)
      }
      recordDeclarations(callableDeclarations(expression, checker, origins))
    }

    const recordBinding = (binding: ts.BindingElement): void => {
      const selection = bindingSelection(binding, checker)
      if (selection === undefined) return
      const sourcePath = selection.path.slice(0, -1)
      if (!isStaticPath(sourcePath)) return
      const isApiRoot = isBrowserApiSurface(selection.initializer)
      const isApiSource = isApiRoot
        || isBrowserApiType(typeAtStaticPath(selection.initializer, sourcePath, checker))
      if (!isApiSource) return
      const name = selection.path.at(-1)
      if (name === undefined) {
        if (binding.propertyName !== undefined
          && ts.isComputedPropertyName(binding.propertyName)) {
          dynamicReferenceLocations.push(location(binding.propertyName.expression))
        }
        return
      }
      const staticPath = [...sourcePath, name]
      if (isRemoteRoot(selection.initializer) && staticPath.length === 2) {
        recordRemoteEndpoint(`${staticPath[0]}/${staticPath[1]}`, selection.initializer)
      } else if (sourcePath.length === 0) {
        const endpoint = remoteEndpointFromNamespace(
          selection.initializer,
          name,
          checker,
          isRemoteRoot,
        )
        if (endpoint !== undefined) recordRemoteEndpoint(endpoint, selection.initializer)
      }
      const symbol = symbolAtExpressionPath(
        selection.initializer,
        staticPath,
        checker,
      )
      recordDeclarations(symbol?.declarations ?? [])
    }

    const visit = (node: ts.Node): void => {
      if (ts.isElementAccessExpression(node)
        && staticAccessName(node, checker) === undefined
        && isBrowserApiSurface(node.expression)) {
        dynamicReferenceLocations.push(location(node))
      } else if (ts.isPropertyAccessExpression(node)
        || ts.isElementAccessExpression(node)) {
        recordExpression(node)
      } else if (ts.isBindingElement(node)) {
        recordBinding(node)
      } else if (ts.isCallExpression(node)) {
        const reflected = builtinReflectGetAccess(node, checker)
        if (reflected !== undefined && isBrowserApiSurface(reflected.target)) {
          const name = staticExpressionName(reflected.key, checker)
          if (name === undefined) {
            dynamicReferenceLocations.push(location(reflected.key))
          } else {
            const endpoint = remoteEndpointFromNamespace(
              reflected.target,
              name,
              checker,
              isRemoteRoot,
            )
            if (endpoint !== undefined) recordRemoteEndpoint(endpoint, reflected.target)
            const property = checker.getPropertyOfType(
              checker.getTypeAtLocation(reflected.target),
              name,
            )
            recordDeclarations(property?.declarations ?? [])
          }
        }
        recordExpression(node.expression)
        const resolved = checker.getResolvedSignature(node)?.getDeclaration()
        if (resolved !== undefined) {
          recordDeclarations([resolved])
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(source)
  }

  if (dynamicReferenceLocations.length > 0) {
    throw new Error(
      'browser-api-drift: computed browser API reference is not cataloguable at:\n'
      + dynamicReferenceLocations.join('\n'),
    )
  }

  const transportRoutes = new Map<string, Set<string>>()
  for (const [owner, endpoint] of TRANSPORT_CALLS) {
    if (enabledIds.has(owner)) addCall(transportRoutes, endpoint, owner)
  }

  return {
    assembledClientRows: rows.sort((left, right) => left.id.localeCompare(right.id)),
    cataloguedClientPackages,
    legacyRpcMethods,
    typertRemoteEndpoints,
    transportRoutes,
  }
}

function difference(left: ReadonlySet<string>, right: ReadonlySet<string>): string[] {
  return [...left].filter(value => !right.has(value)).sort()
}

function assertExactSet(
  label: string,
  calls: ReadonlyMap<string, ReadonlySet<string>>,
  allowedValues: readonly string[],
): void {
  const reachable = new Set(calls.keys())
  const allowed = new Set(allowedValues)
  const missing = difference(reachable, allowed)
  const stale = difference(allowed, reachable)
  if (missing.length > 0 || stale.length > 0) {
    const details = [
      ...missing.map(endpoint =>
        `${endpoint} missing from ${label} allowlist (enabled owners: ${[...(calls.get(endpoint) ?? [])].join(', ')})`),
      ...stale.map(endpoint => `${endpoint} is a stale ${label} allow entry with no enabled Client caller`),
    ]
    throw new Error(`Openloop browser API drift:\n${details.join('\n')}`)
  }
}

/** Assert bidirectional agreement; this function never expands the policy. */
export function assertOpenloopBrowserApiCoverage(
  surface: OpenloopBrowserApiSurface,
  source: unknown,
): void {
  const manifest: BrowserApiPolicyManifest = parseBrowserApiPolicyManifest(source)
  for (const row of surface.assembledClientRows) {
    if (!surface.cataloguedClientPackages.has(row.packageName)) {
      throw new Error(
        `Openloop browser API drift: uncatalogued Client row ${JSON.stringify(row.id)} `
        + `uses ${JSON.stringify(row.packageName)}`,
      )
    }
  }
  assertExactSet('legacyRpcMethods', surface.legacyRpcMethods, manifest.legacyRpcMethods)
  assertExactSet('typertRemoteEndpoints', surface.typertRemoteEndpoints, manifest.typertRemoteEndpoints)
  assertExactSet(
    'transportRoutes',
    surface.transportRoutes,
    manifest.transportRoutes.map(route => `${route.method} ${route.path}`),
  )
}
