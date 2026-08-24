import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import ts from 'typescript'
import { afterEach, describe, expect, it } from 'vitest'
import {
  adaptDesktopDescription,
  adaptSettingsDescription,
  adaptShell,
  adaptWorkspaceList,
  OPENLOOP_ADAPTER_CONTRACT_VERSION,
} from '../src/index.ts'
import { currentDshFixture } from './fixtures/current-dsh/index.ts'
import {
  documentPathDshFixture,
  oldDshFixture,
} from './fixtures/old-dsh/index.ts'

const declarationRoots: string[] = []

function emitAdapterDeclarations(): Readonly<Record<string, string>> {
  const outputRoot = mkdtempSync(join(tmpdir(), 'openloop-adapters-declarations-'))
  declarationRoots.push(outputRoot)
  const configPath = resolve(import.meta.dirname, '../tsconfig.json')
  const config = ts.readConfigFile(configPath, path => ts.sys.readFile(path))
  const parsed = ts.parseJsonConfigFileContent(
    config.config,
    ts.sys,
    dirname(configPath),
    {
      composite: false,
      declaration: true,
      declarationMap: false,
      emitDeclarationOnly: true,
      incremental: false,
      outDir: outputRoot,
    },
    configPath,
  )
  const program = ts.createProgram({
    rootNames: parsed.fileNames,
    options: parsed.options,
    projectReferences: parsed.projectReferences ?? [],
  })
  const emit = program.emit()
  const diagnostics = [
    ...ts.getPreEmitDiagnostics(program),
    ...emit.diagnostics,
  ]
  expect(
    diagnostics.map(diagnostic =>
      ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')),
  ).toEqual([])

  const declarations: Record<string, string> = {}
  function collect(directory: string): void {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) collect(path)
      else if (entry.isFile() && entry.name.endsWith('.d.ts')) {
        declarations[relative(outputRoot, path)] = readFileSync(path, 'utf8')
      }
    }
  }
  collect(outputRoot)
  return declarations
}

function compileCurrentContractWithEnvelope(envelope: string): readonly ts.Diagnostic[] {
  const fixtureRoot = mkdtempSync(join(tmpdir(), 'openloop-adapters-contract-negative-'))
  declarationRoots.push(fixtureRoot)
  const currentContract = readFileSync(
    resolve(import.meta.dirname, '../contracts/current.ts'),
    'utf8',
  )
    .replace("'@deepseek-ai/dsh-client-web'", "'./upstream.ts'")
    .replace("'@deepseek-ai/dsh-host-apiproxy/api'", "'./upstream.ts'")
    .replace("'../src/index.ts'", "'./adapter-inputs.ts'")
  writeFileSync(join(fixtureRoot, 'current.ts'), currentContract)
  writeFileSync(join(fixtureRoot, 'upstream.ts'), [
    'export interface AppShellService { renderApp(): unknown }',
    `type Envelope = ${envelope}`,
    'export interface WorkspaceApi { list(): Promise<Envelope> }',
    'export interface SettingsApi { describe(): Promise<Envelope> }',
    'export interface HostApi { describe(): Promise<Envelope> }',
    '',
  ].join('\n'))
  writeFileSync(join(fixtureRoot, 'adapter-inputs.ts'), [
    'export type OpenloopDesktopDescriptionInput = unknown',
    'export type OpenloopSettingsDescriptionInput = unknown',
    'export type OpenloopShellInput = unknown',
    'export type OpenloopWorkspaceListInput = unknown',
    '',
  ].join('\n'))

  const program = ts.createProgram({
    rootNames: [join(fixtureRoot, 'current.ts')],
    options: {
      allowImportingTsExtensions: true,
      module: ts.ModuleKind.NodeNext,
      moduleResolution: ts.ModuleResolutionKind.NodeNext,
      noEmit: true,
      skipLibCheck: true,
      strict: true,
      target: ts.ScriptTarget.ESNext,
    },
  })
  return ts.getPreEmitDiagnostics(program)
}

function parseLockedSource(name: string): ts.SourceFile {
  const path = resolve(
    import.meta.dirname,
    `fixtures/old-dsh/sources/${name}.source.txt`,
  )
  return ts.createSourceFile(
    path,
    readFileSync(path, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  )
}

function namedDeclaration(sourceFile: ts.SourceFile, name: string): string {
  const declaration = sourceFile.statements.find(statement =>
    (ts.isInterfaceDeclaration(statement)
      || ts.isTypeAliasDeclaration(statement)
      || ts.isClassDeclaration(statement))
    && statement.name?.text === name)
  if (declaration === undefined) {
    throw new Error(`${sourceFile.fileName}: missing public declaration ${name}`)
  }
  return declaration.getText(sourceFile)
}

function typeReferenceArgument(
  sourceFile: ts.SourceFile,
  node: ts.TypeNode,
  expectedName: string,
): ts.TypeNode {
  if (!ts.isTypeReferenceNode(node)
    || !ts.isIdentifier(node.typeName)
    || node.typeName.text !== expectedName
    || node.typeArguments?.length !== 1) {
    throw new Error(
      `${sourceFile.fileName}: expected ${expectedName}<T>, got ${node.getText(sourceFile)}`,
    )
  }
  return node.typeArguments[0]!
}

function methodResponsePayload(
  sourceFile: ts.SourceFile,
  interfaceName: string,
  methodName: string,
): string {
  const declaration = sourceFile.statements.find(statement =>
    ts.isInterfaceDeclaration(statement) && statement.name.text === interfaceName)
  if (declaration === undefined || !ts.isInterfaceDeclaration(declaration)) {
    throw new Error(`${sourceFile.fileName}: missing public interface ${interfaceName}`)
  }
  const method = declaration.members.find(member =>
    ts.isMethodSignature(member)
    && ((ts.isIdentifier(member.name) || ts.isStringLiteralLike(member.name))
      && member.name.text === methodName))
  if (method === undefined || !ts.isMethodSignature(method) || method.type === undefined) {
    throw new Error(`${sourceFile.fileName}: missing ${interfaceName}.${methodName} return type`)
  }
  const rpcResponse = typeReferenceArgument(sourceFile, method.type, 'Promise')
  return typeReferenceArgument(sourceFile, rpcResponse, 'RpcResponse').getText(sourceFile)
}

function relativeImport(fromDirectory: string, target: string): string {
  const specifier = relative(fromDirectory, target).split('\\').join('/')
  return specifier.startsWith('.') ? specifier : `./${specifier}`
}

function compileExtractedOldContract(options?: {
  readonly forceNeverResponsePayloads?: boolean
}): {
  readonly diagnostics: readonly ts.Diagnostic[]
  readonly source: string
} {
  const fixtureRoot = mkdtempSync(join(tmpdir(), 'openloop-adapters-old-contract-'))
  declarationRoots.push(fixtureRoot)
  const shellSource = parseLockedSource('app-shell.ts')
  const workspaceSource = parseLockedSource('workspace.ts')
  const settingsSource = parseLockedSource('settings.ts')
  const desktopSource = parseLockedSource('host.ts')
  const adapterImport = relativeImport(
    fixtureRoot,
    resolve(import.meta.dirname, '../src/index.ts'),
  )
  const source = [
    `import type {
  OpenloopDesktopDescriptionInput,
  OpenloopSettingsDescriptionInput,
  OpenloopShellInput,
  OpenloopWorkspaceListInput,
} from ${JSON.stringify(adapterImport)}`,
    'type ReactNode = unknown',
    'type Branded<Name extends string> = string & { readonly __brand: Name }',
    'type SessionId = Branded<\'SessionId\'>',
    namedDeclaration(shellSource, 'AppShellService'),
    namedDeclaration(workspaceSource, 'WorkspaceId'),
    namedDeclaration(workspaceSource, 'WorkspaceView'),
    namedDeclaration(settingsSource, 'SettingsSecretView'),
    namedDeclaration(settingsSource, 'SettingsNamespaceView'),
    `type HistoricalWorkspaceList = ${options?.forceNeverResponsePayloads === true
      ? 'never'
      : methodResponsePayload(workspaceSource, 'WorkspaceApi', 'list')}`,
    `type HistoricalSettingsDescription = ${options?.forceNeverResponsePayloads === true
      ? 'never'
      : methodResponsePayload(settingsSource, 'SettingsApi', 'describe')}`,
    `type HistoricalDesktopDescription = ${options?.forceNeverResponsePayloads === true
      ? 'never'
      : methodResponsePayload(desktopSource, 'HostApi', 'describe')}`,
    'type Assert<Condition extends true> = Condition',
    'type Assignable<Source, Target> = [Source] extends [Target] ? true : false',
    'type IsNever<Value> = [Value] extends [never] ? true : false',
    'type OldWorkspaceResponseContract = Assert<IsNever<HistoricalWorkspaceList> extends true ? false : true>',
    'type OldSettingsResponseContract = Assert<IsNever<HistoricalSettingsDescription> extends true ? false : true>',
    'type OldDesktopResponseContract = Assert<IsNever<HistoricalDesktopDescription> extends true ? false : true>',
    'type OldShellContract = Assert<Assignable<AppShellService, OpenloopShellInput>>',
    'type OldWorkspaceContract = Assert<Assignable<HistoricalWorkspaceList, OpenloopWorkspaceListInput>>',
    'type OldSettingsContract = Assert<Assignable<HistoricalSettingsDescription, OpenloopSettingsDescriptionInput>>',
    'type OldDesktopContract = Assert<Assignable<HistoricalDesktopDescription, OpenloopDesktopDescriptionInput>>',
    '',
  ].join('\n\n')
  const contractPath = join(fixtureRoot, 'old-source-contract.ts')
  writeFileSync(contractPath, source)
  const program = ts.createProgram({
    rootNames: [contractPath],
    options: {
      allowImportingTsExtensions: true,
      exactOptionalPropertyTypes: true,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      noEmit: true,
      skipLibCheck: true,
      strict: true,
      target: ts.ScriptTarget.ESNext,
    },
  })
  return {
    diagnostics: ts.getPreEmitDiagnostics(program),
    source,
  }
}

afterEach(() => {
  for (const root of declarationRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

describe('stable Openloop adapter contracts', () => {
  it('reads git-show source fixtures and verifies their locked SHA-256 hashes', () => {
    const fixtureRoot = resolve(import.meta.dirname, 'fixtures')
    const repositoryRoot = resolve(import.meta.dirname, '../../../..')
    const manifestPath = join(fixtureRoot, 'public-source-manifest.json')
    expect(existsSync(manifestPath)).toBe(true)
    if (!existsSync(manifestPath)) return

    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
      readonly sources: ReadonlyArray<{
        readonly contract: string
        readonly fixture: string
        readonly version: string
        readonly tag: string | null
        readonly sourceSha: string
        readonly sourcePath: string
        readonly sha256: string
      }>
    }
    expect(manifest.sources).toEqual([
      {
        contract: 'old-shell',
        fixture: 'old-dsh/sources/app-shell.ts.source.txt',
        version: '0.0.1',
        tag: null,
        sourceSha: 'b00cd0cd8cc75517262b3f1eba93ffd818f7b05c',
        sourcePath: 'packages/client/web/src/app-shell.ts',
        sha256: 'e81ab2300780d3f1041365eac80c471f3f0b5ad560121230b54371d1e532bda4',
      },
      {
        contract: 'old-workspace',
        fixture: 'old-dsh/sources/workspace.ts.source.txt',
        version: '0.0.1',
        tag: null,
        sourceSha: 'b00cd0cd8cc75517262b3f1eba93ffd818f7b05c',
        sourcePath: 'packages/host/apiproxy/src/api/workspace.ts',
        sha256: '3a076324f7db8a22c8ab9148acb6f4123ae2958db9093fc24d62503fb3405ee0',
      },
      {
        contract: 'old-settings',
        fixture: 'old-dsh/sources/settings.ts.source.txt',
        version: '0.0.1',
        tag: null,
        sourceSha: 'e31b7221e726f6e93c6462a1e46dddd122e19816',
        sourcePath: 'packages/host/apiproxy/src/api/settings.ts',
        sha256: 'eb381eb6ca1c85fcdd56b73e4cf56f6e7a1606584fab8d8b523cb261c6623307',
      },
      {
        contract: 'old-desktop',
        fixture: 'old-dsh/sources/host.ts.source.txt',
        version: '0.0.1',
        tag: null,
        sourceSha: 'b00cd0cd8cc75517262b3f1eba93ffd818f7b05c',
        sourcePath: 'packages/host/apiproxy/src/api/host.ts',
        sha256: '69591641802e2502af83e8caf5cd55097072af2f59f56fd31130d44785e76496',
      },
      {
        contract: 'current-shell',
        fixture: 'current-dsh/sources/app-shell.ts.source.txt',
        version: '0.1.0-rc.7',
        tag: 'dsh-v0.1.0-rc.7',
        sourceSha: '99f6f02fecdb7dff40c3fbc9470f5907c29f74ca',
        sourcePath: 'packages/client/web/src/app-shell.ts',
        sha256: 'b164f0f72e0a522b44f83851858adc2adc3c13da722a3b2ee15a0eee11942bcc',
      },
      {
        contract: 'current-workspace',
        fixture: 'current-dsh/sources/workspace.ts.source.txt',
        version: '0.1.0-rc.7',
        tag: 'dsh-v0.1.0-rc.7',
        sourceSha: '99f6f02fecdb7dff40c3fbc9470f5907c29f74ca',
        sourcePath: 'packages/host/apiproxy/src/api/workspace.ts',
        sha256: 'de4fbddcdfd65ab3a8ce8a3c03b59031fce7ca47475553204c46bb16a0fc0ae6',
      },
      {
        contract: 'current-settings',
        fixture: 'current-dsh/sources/settings.ts.source.txt',
        version: '0.1.0-rc.7',
        tag: 'dsh-v0.1.0-rc.7',
        sourceSha: '99f6f02fecdb7dff40c3fbc9470f5907c29f74ca',
        sourcePath: 'packages/host/apiproxy/src/api/settings.ts',
        sha256: '6c6dd27f994f0cb1d8dfcd1fb05bd82c31c0b9b9e8b93917abae8f39aa9bf732',
      },
      {
        contract: 'current-desktop',
        fixture: 'current-dsh/sources/host.ts.source.txt',
        version: '0.1.0-rc.7',
        tag: 'dsh-v0.1.0-rc.7',
        sourceSha: '99f6f02fecdb7dff40c3fbc9470f5907c29f74ca',
        sourcePath: 'packages/host/apiproxy/src/api/host.ts',
        sha256: '179b1124920059b39a1063d57f9c90d69e62767dee5600751608cab857a547c9',
      },
    ])
    for (const source of manifest.sources) {
      const fixturePath = join(fixtureRoot, source.fixture)
      expect(existsSync(fixturePath), source.fixture).toBe(true)
      if (!existsSync(fixturePath)) continue
      const fixtureBytes = readFileSync(fixturePath)
      const gitBytes = execFileSync(
        'git',
        ['-C', repositoryRoot, 'show', `${source.sourceSha}:${source.sourcePath}`],
      )
      expect(gitBytes, `${source.sourceSha}:${source.sourcePath}`).toEqual(fixtureBytes)
      expect(createHash('sha256').update(fixtureBytes).digest('hex'))
        .toBe(source.sha256)
      const sourceFile = ts.createSourceFile(
        source.sourcePath,
        fixtureBytes.toString('utf8'),
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.TS,
      )
      const extracted = source.contract.endsWith('-shell')
        ? namedDeclaration(sourceFile, 'AppShellService')
        : source.contract.endsWith('-workspace')
          ? methodResponsePayload(sourceFile, 'WorkspaceApi', 'list')
          : source.contract.endsWith('-settings')
            ? methodResponsePayload(sourceFile, 'SettingsApi', 'describe')
            : methodResponsePayload(sourceFile, 'HostApi', 'describe')
      expect(extracted.length, source.contract).toBeGreaterThan(0)
    }
  })

  it('derives the compiled old contracts from locked source fixtures', () => {
    expect(existsSync(resolve(
      import.meta.dirname,
      '../contracts/old-public-contracts.ts',
    ))).toBe(false)
    const result = compileExtractedOldContract()

    expect(result.source).toContain('export interface AppShellService')
    expect(result.source).toContain('export interface WorkspaceView')
    expect(result.source).toContain('export interface SettingsNamespaceView')
    expect(result.source).toContain('type HistoricalDesktopDescription = {')
    expect(result.diagnostics.map(diagnostic =>
      ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')))
      .toEqual([])
  })

  it('fails historical contract compilation when response extraction yields never', () => {
    const result = compileExtractedOldContract({
      forceNeverResponsePayloads: true,
    })

    expect(result.diagnostics.map(diagnostic => diagnostic.code)).toEqual([2344, 2344, 2344])
  })

  it('emits a stable declaration surface without DSH or React imports', () => {
    const declarations = emitAdapterDeclarations()
    const declarationText = Object.values(declarations).join('\n')

    expect(Object.keys(declarations)).toContain('index.d.ts')
    expect(declarationText).not.toMatch(/(?:from\s+|import\s*\()['"]@deepseek-ai\//u)
    expect(declarationText).not.toMatch(/(?:from\s+|import\s*\()['"]react(?:\/|['"])/u)
    expect(declarations['index.d.ts']).not.toMatch(/\bDsh[A-Z]/u)
  })

  it('fails compilation when the current DSH response envelope no longer exposes result', () => {
    const diagnostics = compileCurrentContractWithEnvelope(
      '{ readonly data: { readonly ok: true; readonly value: unknown } }',
    )

    expect(diagnostics.map(diagnostic => diagnostic.code)).toEqual([2344, 2344, 2344])
    expect(diagnostics.map(diagnostic =>
      ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')))
      .toEqual([
        "Type 'false' does not satisfy the constraint 'true'.",
        "Type 'false' does not satisfy the constraint 'true'.",
        "Type 'false' does not satisfy the constraint 'true'.",
      ])
  })

  it.each([
    ['old', oldDshFixture.shell, 'old-dsh-shell'],
    ['current', currentDshFixture.shell, 'current-dsh-shell'],
  ])('versions and forwards the %s DSH shell contract', (_label, source, rendered) => {
    const shell = adaptShell(source)

    expect(shell.contractVersion).toBe(OPENLOOP_ADAPTER_CONTRACT_VERSION)
    expect(shell.renderApp()).toBe(rendered)
  })

  it('normalizes old and current Workspace list snapshots', () => {
    expect(adaptWorkspaceList(oldDshFixture.workspace)).toEqual({
      contractVersion: 1,
      items: [{
        id: 'workspace-old',
        path: '/fixtures/old',
        title: 'Old workspace',
        sessionIds: ['session-old'],
        createdAt: '2026-07-30T00:00:00.000Z',
        updatedAt: '2026-07-30T01:00:00.000Z',
      }],
      archivedSessionIds: [],
    })
    expect(adaptWorkspaceList(currentDshFixture.workspace)).toEqual({
      contractVersion: 1,
      items: [{
        id: 'workspace-current',
        path: '/fixtures/current',
        title: 'Current workspace',
        sessionIds: ['session-current'],
        createdAt: '2026-08-23T00:00:00.000Z',
        updatedAt: '2026-08-23T01:00:00.000Z',
      }],
      archivedSessionIds: ['session-archived'],
    })
  })

  it('normalizes old and current settings descriptions without exposing a document path', () => {
    expect(adaptSettingsDescription(oldDshFixture.settings)).toEqual({
      contractVersion: 1,
      writable: true,
      hasDocument: false,
      namespaces: [{
        ns: 'appearance',
        schema: { type: 'object' },
        value: { theme: 'dark' },
        applies: 'live',
        secrets: [],
        revision: 3,
      }],
    })
    expect(adaptSettingsDescription(currentDshFixture.settings)).toEqual({
      contractVersion: 1,
      writable: false,
      hasDocument: true,
      namespaces: [{
        ns: 'appearance',
        schema: { type: 'object' },
        value: { theme: 'system' },
        user: { theme: 'system' },
        applies: 'restart',
        secrets: [{ path: ['token'], set: true }],
        revision: 7,
      }],
    })
    expect(adaptSettingsDescription(documentPathDshFixture.settings)).toEqual({
      contractVersion: 1,
      writable: true,
      hasDocument: true,
      namespaces: [{
        ns: 'appearance',
        schema: { type: 'object' },
        value: { theme: 'dark' },
        applies: 'live',
        secrets: [],
        revision: 3,
      }],
    })
    expect(adaptSettingsDescription(documentPathDshFixture.settings)).not.toHaveProperty('documentPath')
  })

  it('maps only stable settings fields into a detached snapshot without mutating input', () => {
    const source = {
      writable: true,
      hasDocument: true,
      futureDescriptionField: 'not-public',
      namespaces: [{
        ns: 'models',
        schema: { type: 'object', properties: { token: { type: 'string' } } },
        value: { provider: { name: 'deepseek' } },
        base: { provider: { enabled: true } },
        user: { provider: { model: 'deepseek-chat' } },
        applies: 'restart' as const,
        secrets: [{
          path: ['provider', 'token'],
          set: true,
          futureSecretField: 'not-public',
        }],
        revision: 11,
        futureNamespaceField: { retainedByDsh: true },
      }],
    }
    const original = structuredClone(source)

    const adapted = adaptSettingsDescription(source)

    expect(adapted).toEqual({
      contractVersion: 1,
      writable: true,
      hasDocument: true,
      namespaces: [{
        ns: 'models',
        schema: { type: 'object', properties: { token: { type: 'string' } } },
        value: { provider: { name: 'deepseek' } },
        base: { provider: { enabled: true } },
        user: { provider: { model: 'deepseek-chat' } },
        applies: 'restart',
        secrets: [{ path: ['provider', 'token'], set: true }],
        revision: 11,
      }],
    })
    expect(source).toEqual(original)

    source.namespaces[0]!.schema.properties.token.type = 'number'
    source.namespaces[0]!.value.provider.name = 'changed'
    source.namespaces[0]!.base.provider.enabled = false
    source.namespaces[0]!.user.provider.model = 'changed'
    source.namespaces[0]!.secrets[0]!.path.push('changed')

    expect(adapted.namespaces[0]).toEqual({
      ns: 'models',
      schema: { type: 'object', properties: { token: { type: 'string' } } },
      value: { provider: { name: 'deepseek' } },
      base: { provider: { enabled: true } },
      user: { provider: { model: 'deepseek-chat' } },
      applies: 'restart',
      secrets: [{ path: ['provider', 'token'], set: true }],
      revision: 11,
    })
  })

  it('normalizes old and current desktop descriptions with a conservative capability default', () => {
    expect(adaptDesktopDescription(oldDshFixture.desktop)).toEqual({
      contractVersion: 1,
      dshVersion: '0.0.1',
      cwd: '/fixtures/old',
      defaultModel: {
        provider: 'deepseek',
        model: 'deepseek-chat',
      },
      attachedSessions: 1,
      canOpenPath: false,
    })
    expect(adaptDesktopDescription(currentDshFixture.desktop)).toEqual({
      contractVersion: 1,
      dshVersion: '0.1.0-rc.7',
      cwd: '/fixtures/current',
      attachedSessions: 2,
      canOpenPath: true,
    })
  })

  it('returns detached snapshots instead of retaining mutable DSH state', () => {
    const source = {
      items: [{
        workspaceId: 'workspace',
        path: '/workspace',
        title: 'Workspace',
        sessionIds: ['session'],
        createdAt: '2026-08-23T00:00:00.000Z',
        updatedAt: '2026-08-23T00:00:00.000Z',
      }],
      archivedSessionIds: ['archived'],
    }

    const adapted = adaptWorkspaceList(source)
    source.items[0]!.title = 'mutated'
    source.items[0]!.sessionIds.push('later')
    source.archivedSessionIds.push('later')

    expect(adapted.items[0]).toMatchObject({
      title: 'Workspace',
      sessionIds: ['session'],
    })
    expect(adapted.archivedSessionIds).toEqual(['archived'])
  })
})
