import {
  copyFileSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  assertOpenloopBrowserApiCoverage,
  collectOpenloopBrowserApiSurface,
  type OpenloopBrowserApiSurface,
} from './browser-api-drift.ts'

const root = resolve(import.meta.dirname, '../..')
const manifest = JSON.parse(readFileSync(
  resolve(root, 'packages/openloop/desktop-bridge-host/openloop-browser-api.json'),
  'utf8',
)) as unknown
const openloopDesktopEndpoints = [
  'openloopDesktop/authorizeWorkspace',
  'openloopDesktop/checkForUpdate',
  'openloopDesktop/describeCredential',
  'openloopDesktop/getAppInfo',
  'openloopDesktop/getCredentialMigrationStatus',
  'openloopDesktop/getUpdateStatus',
  'openloopDesktop/installUpdateAndRestart',
  'openloopDesktop/listWorkspaceGrants',
  'openloopDesktop/openCredentialReplacement',
  'openloopDesktop/reauthorizeWorkspace',
  'openloopDesktop/revealWorkspace',
  'openloopDesktop/revokeWorkspace',
  'openloopDesktop/unsetCredential',
] as const
const openloopDesktopHostOnlyEndpoints = [
  'openloopDesktop/abortWorkspaceAuthorization',
  'openloopDesktop/beginWorkspaceAuthorization',
  'openloopDesktop/commitWorkspaceAuthorization',
  'openloopDesktop/openWorkspaceFile',
  'openloopDesktop/resolveCredential',
  'openloopDesktop/spawnWorkspaceProcess',
] as const
const surfacePromise = collectOpenloopBrowserApiSurface(root)
let mutationRoot: string
let mutationSurface: OpenloopBrowserApiSurface
let dynamicRoot: string
let dynamicError: Error | undefined
const rosterFailureRoots: string[] = []

function copyFixtureTree(source: string, destination: string): void {
  cpSync(source, destination, {
    recursive: true,
    filter: path => !['lib', 'tests'].includes(basename(path)),
  })
}

function writeFixture(path: string, value: string): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, value)
}

function createMutationRoot(prefix: string): string {
  const fixtureRoot = mkdtempSync(join(tmpdir(), prefix))
  copyFixtureTree(join(root, 'packages'), join(fixtureRoot, 'packages'))
  copyFixtureTree(join(root, 'vendor'), join(fixtureRoot, 'vendor'))
  for (const config of [
    'pnpm-workspace.yaml',
    'tsconfig.base.json',
    'tsconfig.base.client.json',
    'tsconfig.client.json',
    'tsconfig.host.json',
  ]) {
    copyFileSync(join(root, config), join(fixtureRoot, config))
  }
  symlinkSync(
    join(root, 'node_modules'),
    join(fixtureRoot, 'node_modules'),
    process.platform === 'win32' ? 'junction' : 'dir',
  )

  writeFixture(
    join(fixtureRoot, 'packages/third-party/client/package.json'),
    JSON.stringify({
      name: '@third-party/client',
      dsh: { client: { platform: 'web' } },
    }),
  )
  const patchPath = join(fixtureRoot, 'packages/openloop/bundle/cordis.patch.yml')
  writeFileSync(patchPath, `${readFileSync(patchPath, 'utf8')}
- insert:
    - id: nested-clients
      name: '@deepseek-ai/cordis-plugin-group'
      group: true
      config:
        - id: hidden-third-party
          name: '@third-party/client/browser'
        - id: drift-call-fixture
          name: '@deepseek-ai/dsh-client-drift-fixture/client'
        - id: production-fixture-name
          name: '@deepseek-ai/dsh-production-fixture-name/client'
        - id: disabled-clients
          name: '@deepseek-ai/cordis-plugin-group'
          group: true
          disabled: true
          config:
            - id: disabled-third-party
              name: '@third-party/client'
`)
  writeFixture(
    join(fixtureRoot, 'packages/client/drift-fixture/package.json'),
    JSON.stringify({
      name: '@deepseek-ai/dsh-client-drift-fixture',
      dsh: { client: { platform: 'web' } },
    }),
  )
  writeFixture(
    join(fixtureRoot, 'packages/client/production-fixture-name/package.json'),
    JSON.stringify({
      name: '@deepseek-ai/dsh-production-fixture-name',
      dsh: { client: { platform: 'web' } },
    }),
  )
  return fixtureRoot
}

function addRosterFixture(
  prefix: string,
  row: string,
  packageName?: string,
  manifest?: string,
): string {
  const fixtureRoot = createMutationRoot(prefix)
  const patchPath = join(fixtureRoot, 'packages/openloop/bundle/cordis.patch.yml')
  writeFileSync(patchPath, `${readFileSync(patchPath, 'utf8')}\n${row}`)
  if (packageName !== undefined && manifest !== undefined) {
    writeFixture(
      join(
        fixtureRoot,
        'packages/openloop/bundle/node_modules',
        ...packageName.split('/'),
        'package.json',
      ),
      manifest,
    )
  }
  rosterFailureRoots.push(fixtureRoot)
  return fixtureRoot
}

beforeAll(async () => {
  mutationRoot = createMutationRoot('openloop-browser-api-drift-')
  writeFixture(
    join(mutationRoot, 'packages/client/drift-fixture/src/client/index.ts'),
    `import './fixture.ts'
import './fixtures/credential-write.ts'
import type { IApiClient } from '@deepseek-ai/dsh-api-remotes/client'
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'

declare function consume(value: unknown): void

export async function mutateLegacyCalls(api: IApiClient): Promise<void> {
  let assigned: IApiClient['host']['openPath']
  assigned = api.host.openPath
  await assigned?.({ path: '/tmp' })

  const { createDirectory: destructured } = api.host
  await destructured({ path: '/tmp', name: 'fixture' })

  const bound = api.host.listDirectory.bind(api.host)
  await bound({ path: '/tmp' })

  consume(api.settings.update)
  consume(api['settings']['replace'])
  const legacyNamespace = 'agentPresets'
  const legacyMethod = 'copy'
  consume(api[legacyNamespace][legacyMethod])
  const read = api.agentPresets.read
  consume(read)
  const { remove } = api.agentPresets
  consume(remove)
  consume(api.agentPresets.openDocument.bind(api.agentPresets))

  const apiRoot = api
  consume(apiRoot.sessions.models)
  consume(apiRoot['sessions']['fork'])
  const transitiveApiRoot = apiRoot
  const transitiveMethod = transitiveApiRoot.skills.list
  consume(transitiveMethod)
  let assignedApiRoot: IApiClient
  assignedApiRoot = transitiveApiRoot
  consume(assignedApiRoot.settings.mutate)
  const { subagents } = assignedApiRoot
  consume(subagents.interrupt)
  const { api: destructuredApiRoot } = { api: assignedApiRoot }
  consume(destructuredApiRoot.sessions.list)

  consume(Reflect.get(api.sessions, 'search'))
  const reflectedLegacyMethod = 'history' as const
  consume(Reflect.get(api.sessions, reflectedLegacyMethod))
  const reflectedApiRoot = api
  const reflectedSessions = Reflect.get(reflectedApiRoot, 'sessions')
  const reflectedSessionsAlias = reflectedSessions
  consume(Reflect.get(reflectedSessionsAlias, 'cancel'))

  consume((api).sessions.list)
  consume((api as IApiClient).sessions.models)
  consume((<IApiClient>api).sessions.fork)
  consume(api!.skills.list)
  consume((api satisfies IApiClient).settings.mutate)
  const apiBox = { api }
  consume(apiBox.api.subagents.interrupt)
  const assignedApiBox = {} as { api: IApiClient }
  assignedApiBox.api = api
  consume(assignedApiBox.api.agentPresets.read)

  const legacyNamespaceKey = 'credentials' as const
  const legacyMethodKey = 'unset' as const
  const { [legacyNamespaceKey]: { [legacyMethodKey]: computedLegacy } } = api
  consume(computedLegacy)
  const { ['describe']: literalComputedLegacy } = api.credentials
  consume(literalComputedLegacy)
}

export async function mutateTypertCalls(ctx: ClientContext): Promise<void> {
  let assigned: typeof ctx.remote.pluginInventory.list
  assigned = ctx.remote.pluginInventory.list
  await assigned?.()

  const bound = ctx.remote.dynamicCordisRunner.inventory.bind(ctx.remote.dynamicCordisRunner)
  await bound()

  const reflectedRemoteMethod = 'complete' as const
  consume(Reflect.get(ctx.remote.goals, reflectedRemoteMethod))
  const reflectedRemoteRoot = ctx.remote
  const reflectedGoals = Reflect.get(reflectedRemoteRoot, 'goals')
  const reflectedGoalsAlias = reflectedGoals
  consume(Reflect.get(reflectedGoalsAlias, 'complete'))
  consume(ctx.remote['pluginInventory']['list'])
  const remoteNamespace = 'commands'
  const remoteMethod = 'execute'
  consume(ctx.remote[remoteNamespace][remoteMethod])
  const list = ctx.remote.commands.list
  consume(list)
  const { clear } = ctx.remote.goals
  consume(clear)
  consume(ctx.remote.messageFeedback.delete.bind(ctx.remote.messageFeedback))

  const remoteRoot = ctx.remote
  consume(remoteRoot.goals.edit)
  consume(remoteRoot['goals']['pause'])
  const transitiveRemoteRoot = remoteRoot
  const transitiveMethod = transitiveRemoteRoot.goals.resume
  consume(transitiveMethod)
  let assignedRemoteRoot: typeof ctx.remote
  assignedRemoteRoot = transitiveRemoteRoot
  consume(assignedRemoteRoot.goals.clear)
  const { remote: destructuredRemoteRoot } = ctx
  consume(destructuredRemoteRoot.messageFeedback.list)

  consume((ctx.remote).goals.edit)
  consume((ctx.remote as typeof ctx.remote).goals.pause)
  consume((<typeof ctx.remote>ctx.remote).goals.resume)
  consume(ctx.remote!.goals.clear)
  consume((ctx.remote satisfies typeof ctx.remote).messageFeedback.list)
  const box = { remote: ctx.remote }
  consume(box.remote.goals.edit)
  const assignedBox = {} as { remote: typeof ctx.remote }
  assignedBox.remote = ctx.remote
  consume(assignedBox.remote.pluginInventory.list)

  const remoteNamespaceKey = 'goals' as const
  const remoteMethodKey = 'create' as const
  const { [remoteNamespaceKey]: { [remoteMethodKey]: computedRemote } } = ctx.remote
  consume(computedRemote)
  const { ['messageFeedback']: { ['put']: literalComputedRemote } } = ctx.remote
  consume(literalComputedRemote)
}

export function ordinaryProperties(key: string): void {
  const ordinary = {
    host: { pickDirectory: () => 'local' },
    remote: { goals: { create: () => 'local' } },
    settings: { update: 'data' },
  }
  consume(ordinary['settings']['update'])
  consume(ordinary.settings[key])
  consume(ordinary.host.pickDirectory)
  consume(ordinary.remote.goals.create)
  let reassigned = ordinary
  reassigned = {
    host: { pickDirectory: () => 'still local' },
    remote: { goals: { create: () => 'still local' } },
    settings: { update: 'still data' },
  }
  consume(reassigned[key])
  let cycleLeft = reassigned
  let cycleRight = cycleLeft
  cycleLeft = cycleRight
  cycleRight = cycleLeft
  consume(cycleRight[key])
  const ordinaryBox = { remote: ordinary.remote, api: ordinary }
  consume(ordinaryBox.remote[key])
  consume(ordinaryBox.api[key])
  const assignedOrdinaryBox = {} as {
    remote: typeof ordinary.remote
    api: typeof ordinary
  }
  assignedOrdinaryBox.remote = ordinary.remote
  assignedOrdinaryBox.api = ordinary
  consume(assignedOrdinaryBox.remote[key])
  consume(assignedOrdinaryBox.api[key])
  const { [key]: ordinaryComputed } = ordinary
  const { settings: { [key]: nestedOrdinaryComputed } } = ordinary
  consume(ordinaryComputed)
  consume(nestedOrdinaryComputed)
}
`,
  )
  const excludedCredentialWrite = `import type { IApiClient } from '@deepseek-ai/dsh-api-remotes/client'

export function writeFixtureCredential(api: IApiClient): void {
  void api.credentials.set
}
`
  writeFixture(
    join(mutationRoot, 'packages/client/drift-fixture/src/client/fixture.ts'),
    excludedCredentialWrite,
  )
  writeFixture(
    join(mutationRoot, 'packages/client/drift-fixture/src/client/fixtures/credential-write.ts'),
    excludedCredentialWrite,
  )
  writeFixture(
    join(
      mutationRoot,
      'packages/client/production-fixture-name/src/client/credential-fixture.ts',
    ),
    `import type { IApiClient } from '@deepseek-ai/dsh-api-remotes/client'

export function writeProductionCredential(api: IApiClient): void {
  void api.credentials.set
}
`,
  )
  mutationSurface = await collectOpenloopBrowserApiSurface(mutationRoot)

  dynamicRoot = createMutationRoot('openloop-browser-api-drift-dynamic-')
  writeFixture(
    join(dynamicRoot, 'packages/client/drift-fixture/src/client/index.ts'),
    `import type { IApiClient } from '@deepseek-ai/dsh-api-remotes/client'
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'

declare function consume(value: unknown): void

export function dynamicReferences(api: IApiClient, ctx: ClientContext, key: string): void {
  const ordinary = { settings: { update: 'data' } }
  consume(ordinary.settings[key])
  consume(api.settings[key])
  consume(ctx.remote[key])

  const apiRoot = api
  consume(apiRoot[key])
  const transitiveApiRoot = apiRoot
  consume(transitiveApiRoot[key])
  let assignedApiRoot: IApiClient
  assignedApiRoot = transitiveApiRoot
  consume(assignedApiRoot[key])
  const { api: destructuredApiRoot } = { api: assignedApiRoot }
  consume(destructuredApiRoot[key])

  const remoteRoot = ctx.remote
  consume(remoteRoot[key])
  const transitiveRemoteRoot = remoteRoot
  consume(transitiveRemoteRoot[key])
  let assignedRemoteRoot: typeof ctx.remote
  assignedRemoteRoot = transitiveRemoteRoot
  consume(assignedRemoteRoot[key])
  const { remote: destructuredRemoteRoot } = ctx
  consume(destructuredRemoteRoot[key])

  consume((ctx.remote)[key])
  consume((ctx.remote as typeof ctx.remote)[key])
  consume((<typeof ctx.remote>ctx.remote)[key])
  consume(ctx.remote![key])
  consume((ctx.remote satisfies typeof ctx.remote)[key])

  const box = { remote: ctx.remote }
  consume(box.remote[key])
  const assignedBox = {} as { remote: typeof ctx.remote }
  assignedBox.remote = ctx.remote
  consume(assignedBox.remote[key])

  const { [key]: computedApi } = api
  const { [key]: computedRemote } = ctx.remote
  const { credentials: { [key]: nestedComputedApi } } = api
  const { goals: { [key]: nestedComputedRemote } } = ctx.remote
  const { [key]: ordinaryComputed } = ordinary
  consume(computedApi)
  consume(computedRemote)
  consume(nestedComputedApi)
  consume(nestedComputedRemote)
  consume(ordinaryComputed)

  consume(Reflect.get(api.sessions, key))
  consume(Reflect.get(ctx.remote.goals, key))
  const reflectedApiRoot = api
  const reflectedSessions = Reflect.get(reflectedApiRoot, 'sessions')
  consume(Reflect.get(reflectedSessions, key))

  consume(Reflect.get(ordinary.settings, key))
}

export function shadowedReflect(api: IApiClient, key: string): void {
  const Reflect = {
    get(target: object, property: PropertyKey): unknown {
      return target[property as keyof typeof target]
    },
  }
  consume(Reflect.get(api.sessions, key))
}
`,
  )
  try {
    await collectOpenloopBrowserApiSurface(dynamicRoot)
  } catch (error) {
    dynamicError = error instanceof Error ? error : new Error(String(error))
  }
}, 120_000)

afterAll(() => {
  rmSync(mutationRoot, { recursive: true, force: true })
  rmSync(dynamicRoot, { recursive: true, force: true })
  for (const fixtureRoot of rosterFailureRoots) {
    rmSync(fixtureRoot, { recursive: true, force: true })
  }
})

function cloneSurface(surface: OpenloopBrowserApiSurface): OpenloopBrowserApiSurface {
  return {
    assembledClientRows: surface.assembledClientRows.map(row => ({ ...row })),
    cataloguedClientPackages: new Set(surface.cataloguedClientPackages),
    legacyRpcMethods: new Map(
      [...surface.legacyRpcMethods].map(([endpoint, owners]) => [endpoint, new Set(owners)]),
    ),
    typertRemoteEndpoints: new Map(
      [...surface.typertRemoteEndpoints].map(([endpoint, owners]) => [endpoint, new Set(owners)]),
    ),
    transportRoutes: new Map(
      [...surface.transportRoutes].map(([endpoint, owners]) => [endpoint, new Set(owners)]),
    ),
  }
}

describe('Openloop assembled browser API drift gate', () => {
  it('keeps the final enabled Client roster and every reachable call in exact policy agreement', async () => {
    const surface = await surfacePromise

    expect(() => { assertOpenloopBrowserApiCoverage(surface, manifest) }).not.toThrow()
  }, 60_000)

  it('requires every reviewed OpenLoop Remote facade and excludes every Host-only method', async () => {
    const surface = await surfacePromise

    for (const endpoint of openloopDesktopEndpoints) {
      expect(surface.typertRemoteEndpoints.has(endpoint), endpoint).toBe(true)
    }
    for (const endpoint of openloopDesktopHostOnlyEndpoints) {
      expect(surface.typertRemoteEndpoints.has(endpoint), endpoint).toBe(false)
    }
  })

  it('keeps signed non-Client rows with client-facing type exports out of the roster', async () => {
    const surface = await surfacePromise

    expect(surface.assembledClientRows)
      .not.toContainEqual(expect.objectContaining({ packageName: '@deepseek-ai/dsh-session-title' }))
  })

  it('keeps the real client-hmr workspace package in the signed Client roster', async () => {
    const surface = await surfacePromise

    expect(surface.assembledClientRows).toContainEqual({
      id: 'client-hmr',
      packageName: '@deepseek-ai/dsh-client-hmr',
    })
    expect(surface.cataloguedClientPackages).toContain('@deepseek-ai/dsh-client-hmr')
  })

  it('does not let a nested fixture manifest override a declared workspace package', async () => {
    const fixtureRoot = createMutationRoot('openloop-browser-api-drift-nested-fixture-')
    rosterFailureRoots.push(fixtureRoot)
    writeFixture(
      join(fixtureRoot, 'packages/client/hmr/tests/fixtures/shadow/package.json'),
      JSON.stringify({
        name: '@deepseek-ai/dsh-client-hmr',
        dsh: { client: { platform: 'node' } },
      }),
    )

    const surface = await collectOpenloopBrowserApiSurface(fixtureRoot)

    expect(surface.assembledClientRows).toContainEqual({
      id: 'client-hmr',
      packageName: '@deepseek-ai/dsh-client-hmr',
    })
    expect(surface.cataloguedClientPackages).toContain('@deepseek-ai/dsh-client-hmr')
  }, 60_000)

  it('fails when two declared workspace packages have the same name', async () => {
    const fixtureRoot = createMutationRoot('openloop-browser-api-drift-duplicate-package-')
    rosterFailureRoots.push(fixtureRoot)
    writeFixture(
      join(fixtureRoot, 'packages/duplicate/client-hmr/package.json'),
      JSON.stringify({
        name: '@deepseek-ai/dsh-client-hmr',
        dsh: { client: { platform: 'web' } },
      }),
    )

    const duplicatePattern = new RegExp(
      'duplicate workspace package.*@deepseek-ai/dsh-client-hmr'
      + '.*packages/client/hmr/package\\.json'
      + '.*packages/duplicate/client-hmr/package\\.json',
      'isu',
    )
    await expect(collectOpenloopBrowserApiSurface(fixtureRoot)).rejects.toThrow(
      duplicatePattern,
    )
  })

  it('rejects a newly assembled third-party Client row without a reviewed catalog owner', async () => {
    const surface = cloneSurface(await surfacePromise)
    surface.assembledClientRows.push({
      id: 'third-party-client',
      packageName: '@third-party/client',
    })

    expect(() => { assertOpenloopBrowserApiCoverage(surface, manifest) })
      .toThrow(/third-party-client|uncatalogued Client/iu)
  }, 60_000)

  it('recurses through the composed Entry tree and inherits disabled state', () => {
    expect(mutationSurface.assembledClientRows).toContainEqual({
      id: 'nested-clients:hidden-third-party',
      packageName: '@third-party/client',
    })
    expect(mutationSurface.assembledClientRows)
      .not.toContainEqual(expect.objectContaining({ id: 'nested-clients:disabled-clients:disabled-third-party' }))
    expect(() => { assertOpenloopBrowserApiCoverage(mutationSurface, manifest) })
      .toThrow(/nested-clients:hidden-third-party|uncatalogued Client/iu)
  })

  it('fails closed for a top-level Client row whose package does not exist', async () => {
    const fixtureRoot = addRosterFixture(
      'openloop-browser-api-drift-missing-package-',
      `- insert:
    - id: missing-client
      name: '@fixture/missing-client'
`,
    )

    await expect(collectOpenloopBrowserApiSurface(fixtureRoot)).rejects.toThrow(
      /missing-client.*@fixture\/missing-client.*top-level.*package manifest/isu,
    )
  })

  it('fails closed for a nested Client row whose package manifest is malformed', async () => {
    const fixtureRoot = addRosterFixture(
      'openloop-browser-api-drift-malformed-manifest-',
      `- insert:
    - id: broken-clients
      name: '@deepseek-ai/cordis-plugin-group'
      group: true
      config:
        - id: malformed-client
          name: '@fixture/malformed-client'
`,
      '@fixture/malformed-client',
      '{"name":"@fixture/malformed-client","dsh":',
    )

    await expect(collectOpenloopBrowserApiSurface(fixtureRoot)).rejects.toThrow(
      /broken-clients:malformed-client.*@fixture\/malformed-client.*nested.*package\.json/isu,
    )
  })

  it('fails closed for a Client-exporting row without dsh.client metadata', async () => {
    const fixtureRoot = addRosterFixture(
      'openloop-browser-api-drift-missing-client-metadata-',
      `- insert:
    - id: no-client-metadata
      name: '@fixture/no-client-metadata'
`,
      '@fixture/no-client-metadata',
      JSON.stringify({
        name: '@fixture/no-client-metadata',
        exports: {
          './client': './client.js',
          './package.json': './package.json',
        },
      }),
    )

    await expect(collectOpenloopBrowserApiSurface(fixtureRoot)).rejects.toThrow(
      /no-client-metadata.*@fixture\/no-client-metadata.*top-level.*dsh\.client/isu,
    )
  })

  it('catalogues assigned, destructured, and bound legacy and Typert calls', () => {
    expect([...mutationSurface.legacyRpcMethods.keys()]).toEqual(expect.arrayContaining([
      'host.openPath',
      'host.createDirectory',
      'host.listDirectory',
    ]))
    expect([...mutationSurface.typertRemoteEndpoints.keys()]).toEqual(expect.arrayContaining([
      'pluginInventory/list',
      'goals/complete',
      'dynamicCordisRunner/inventory',
    ]))
    const callsOnly = cloneSurface(mutationSurface)
    callsOnly.assembledClientRows = callsOnly.assembledClientRows
      .filter(row => row.packageName !== '@third-party/client')
    expect(() => { assertOpenloopBrowserApiCoverage(callsOnly, manifest) })
      .toThrow(/host\.openPath|pluginInventory\/list|missing from.*allow/iu)
  })

  it('catalogues referenced legacy and Typert methods without requiring a direct call', () => {
    const owner = 'nested-clients:drift-call-fixture'
    for (const method of [
      'settings.update',
      'settings.replace',
      'agentPreset.copy',
      'agentPreset.read',
      'agentPreset.remove',
      'agentPreset.openDocument',
    ]) {
      expect(mutationSurface.legacyRpcMethods.get(method)).toContain(owner)
    }
    for (const endpoint of [
      'goals/complete',
      'pluginInventory/list',
      'commands/execute',
      'commands/list',
      'goals/clear',
      'messageFeedback/delete',
    ]) {
      expect(mutationSurface.typertRemoteEndpoints.get(endpoint)).toContain(owner)
    }
    expect(mutationSurface.legacyRpcMethods.has('host.pickDirectory')).toBe(false)
  })

  it('excludes imported test fixtures without excluding production names containing fixture', () => {
    expect([...mutationSurface.legacyRpcMethods.get('credentials.set') ?? []]).toEqual([
      'nested-clients:production-fixture-name',
    ])
  })

  it('catalogues static references through legacy root aliases', () => {
    const owner = 'nested-clients:drift-call-fixture'
    for (const method of [
      'session.models',
      'session.fork',
      'skill.list',
      'settings.mutate',
      'subagent.interrupt',
    ]) {
      expect(mutationSurface.legacyRpcMethods.get(method)).toContain(owner)
    }
  })

  it('catalogues built-in Reflect.get references through literal, const, and root aliases', () => {
    const owner = 'nested-clients:drift-call-fixture'
    for (const method of ['session.search', 'session.history', 'session.cancel']) {
      expect(mutationSurface.legacyRpcMethods.get(method)).toContain(owner)
    }
    expect(mutationSurface.typertRemoteEndpoints.get('goals/complete')).toContain(owner)
  })

  it('catalogues static references through Remote root aliases', () => {
    const owner = 'nested-clients:drift-call-fixture'
    for (const endpoint of [
      'goals/edit',
      'goals/pause',
      'goals/resume',
      'goals/clear',
      'messageFeedback/list',
    ]) {
      expect(mutationSurface.typertRemoteEndpoints.get(endpoint)).toContain(owner)
    }
  })

  it('catalogues literal and const computed bindings through nested API roots', () => {
    const owner = 'nested-clients:drift-call-fixture'
    for (const method of ['credentials.unset', 'credentials.describe']) {
      expect(mutationSurface.legacyRpcMethods.get(method)).toContain(owner)
    }
    for (const endpoint of ['goals/create', 'messageFeedback/put']) {
      expect(mutationSurface.typertRemoteEndpoints.get(endpoint)).toContain(owner)
    }
  })

  it('fails closed at every dynamic root alias and ignores non-API reassignments', () => {
    const message = dynamicError?.message ?? ''
    expect(message).toContain('computed browser API reference')
    expect(message).toContain('packages/client/drift-fixture/src/client/index.ts:39')
    expect(message).toContain('packages/client/drift-fixture/src/client/index.ts:42')
    expect(message).toContain('packages/client/drift-fixture/src/client/index.ts:44')
    expect(message).toContain('packages/client/drift-fixture/src/client/index.ts:45')
    expect(message).toContain('packages/client/drift-fixture/src/client/index.ts:46')
    expect(message).toContain('packages/client/drift-fixture/src/client/index.ts:47')
    expect([...message.matchAll(
      /packages\/client\/drift-fixture\/src\/client\/index\.ts:(\d+)/gu,
    )].map(match => Number(match[1]))).toEqual([
      9, 10, 13, 15, 18, 20, 23, 25, 28, 30, 32, 33, 34, 35, 36, 39, 42,
      44, 45, 46, 47, 55, 56, 59,
    ])
  })

  it('rejects a newly reachable Client call that is absent from the allowlist', async () => {
    const surface = cloneSurface(await surfacePromise)
    surface.legacyRpcMethods.set('session.newCapability', new Set(['client-runtime']))

    expect(() => { assertOpenloopBrowserApiCoverage(surface, manifest) })
      .toThrow(/session\.newCapability|missing from.*allow/iu)
  }, 60_000)

  it('rejects a stale allow entry with no reachable enabled Client caller', async () => {
    const surface = cloneSurface(await surfacePromise)
    const source = structuredClone(manifest) as {
      legacyRpcMethods: string[]
    }
    source.legacyRpcMethods.push('session.staleCapability')

    expect(() => { assertOpenloopBrowserApiCoverage(surface, source) })
      .toThrow(/session\.staleCapability|stale/iu)
  }, 60_000)
})
