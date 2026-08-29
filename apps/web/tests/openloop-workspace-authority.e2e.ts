// Assembled proof for the Openloop Workspace authority. The browser, Cordis
// plugins, policy, DSH registry/session handlers, and React surfaces are real;
// only the authenticated native AppKit/grant-store boundary is doubled.
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import type { Browser, Page, Request, Response } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import {
  assertFixtureInventory,
  captureStableAria,
  compareOrRefreshGolden,
  launchWebScaffold,
  watchConsole,
  webSnapshotMode,
  type WebScaffold,
} from './scaffold.ts'
import { AuthenticatedUnixBridgeServer } from './openloop-bridge-server.ts'
import { newEnglishPage } from './support.ts'

const SNAPSHOT_DIR = fileURLToPath(new URL(
  './snapshots/openloop-workspace-authority',
  import.meta.url,
))
const PRESET_ROOT = fileURLToPath(new URL(
  '../../../packages/preset/agent-presets/tests/fixtures/system',
  import.meta.url,
))
const UI_EXPECTED = join(SNAPSHOT_DIR, 'ui.expected.md')
const MODE = webSnapshotMode()
const LAUNCH_ID = 'f11b8617-c090-4f86-a670-d98c5e147345'
const BOOTSTRAP_TOKEN = Uint8Array.from({ length: 32 }, (_, index) => index + 9)
const BRIDGE_SECRET = Uint8Array.from({ length: 32 }, (_, index) => index + 97)
const CORE_MANIFEST_SHA256 = 'b'.repeat(64)
const CORE_MANIFEST = {
  appVersion: '0.1.0',
  channel: 'test',
  dshTag: 'dsh-v0.1.0-rc.7',
  dshCommit: '99f6f02fecdb7dff40c3fbc9470f5907c29f74ca',
  runtimeVersion: 1,
  bridgeProtocolVersion: 1,
  uiSdkVersion: '0.1.0',
  pluginPackageSpecVersion: '0.1.0',
  openloopDataVersion: 0,
  dshDataVersion: 0,
} as const

async function closeAll(
  resources: ReadonlyArray<() => Promise<void> | undefined>,
): Promise<void> {
  const failures: unknown[] = []
  for (const close of resources) {
    try {
      await close()
    } catch (error) {
      failures.push(error)
    }
  }
  if (failures.length > 0) {
    throw new AggregateError(failures, 'Workspace authority E2E cleanup failed')
  }
}

function rpcMethodOf(body: string | null): string | undefined {
  if (body === null) return undefined
  try {
    const value = JSON.parse(body) as { method?: unknown }
    return typeof value.method === 'string' ? value.method : undefined
  } catch {
    return undefined
  }
}

function isBusinessApiUrl(url: string): boolean {
  return new URL(url).pathname.startsWith('/api/')
}

function isStreamingApiResponse(
  url: string,
  headers: Readonly<Record<string, string>>,
): boolean {
  const pathname = new URL(url).pathname
  const contentType = headers['content-type']?.toLowerCase() ?? ''
  return pathname === '/api/events.mux'
    || pathname === '/api/events.host'
    || contentType.includes('text/event-stream')
}

function shouldReadApiResponseBody(
  requestMethod: string,
  headers: Readonly<Record<string, string>>,
): boolean {
  const contentDisposition = headers['content-disposition']?.toLowerCase() ?? ''
  return requestMethod !== 'HEAD'
    && !contentDisposition.includes('attachment')
}

interface BrowserApiRequestCapture {
  readonly method: string
  readonly url: string
  readonly postData: string | null
  readonly rpcMethod: string | undefined
  headers: Readonly<Record<string, string>>
}

interface BrowserApiResponseCapture {
  readonly requestMethod: string
  readonly url: string
  readonly status: number
  readonly rpcMethod: string | undefined
  headers: Readonly<Record<string, string>>
  body: string | undefined
}

async function drainDynamicReads(
  readGroups: ReadonlyArray<readonly Promise<void>[]>,
): Promise<void> {
  const offsets = readGroups.map(() => 0)
  while (true) {
    const batch = readGroups.flatMap((reads, index) => {
      const pending = reads.slice(offsets[index])
      offsets[index] = reads.length
      return pending
    })
    if (batch.length > 0) await Promise.all(batch)
    await new Promise<void>(resolve => setTimeout(resolve, 0))
    if (readGroups.every((reads, index) => reads.length === offsets[index])) return
  }
}

function withReadTimeout(read: Promise<void>, label: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`timed out reading ${label}`))
    }, 5_000)
    read.then(resolve, reject).finally(() => {
      clearTimeout(timer)
    })
  })
}

describe('web e2e: assembled Openloop Workspace authority', () => {
  let scaffold: WebScaffold
  let bridge: AuthenticatedUnixBridgeServer
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>
  let pendingGrantId = ''
  const browserApiRequests: BrowserApiRequestCapture[] = []
  const browserApiResponses: BrowserApiResponseCapture[] = []
  const requestReads: Promise<void>[] = []
  const responseReads: Promise<void>[] = []
  const apiResponsesByRequest = new Map<Request, {
    readonly response: Response
    readonly capture: BrowserApiResponseCapture
  }>()

  async function openHeroWorkspaceMenu(): Promise<void> {
    await page.getByRole('textbox', { name: /choose workspace/iu }).click()
    await page.getByRole('menuitem', { name: 'Add Workspace' })
      .waitFor({ timeout: 10_000 })
  }

  async function openWorkspaceSettings(): Promise<void> {
    await page.getByRole('button', { name: 'Settings', exact: true }).click()
    await page.getByRole('dialog', { name: 'Workspace settings' })
      .waitFor({ timeout: 10_000 })
  }

  async function openWorkspaceActions(name: string): Promise<void> {
    const settings = page.getByRole('dialog', { name: 'Workspace settings' })
    await settings.getByRole('button', { name: `Workspace actions for ${name}` }).click()
  }

  async function expectComposerBlocked(blocked: boolean): Promise<void> {
    const composer = page.locator('textarea').last()
    await composer.waitFor({ timeout: 15_000 })
    await expect.poll(() => composer.isDisabled(), { timeout: 10_000 }).toBe(blocked)
    if (blocked) {
      await expect.poll(
        () => page.getByText('Workspace authorization is required before sending.', {
          exact: true,
        }).count(),
        { timeout: 10_000 },
      ).toBeGreaterThan(0)
    }
  }

  beforeAll(async () => {
    bridge = await AuthenticatedUnixBridgeServer.start({
      launchId: LAUNCH_ID,
      secret: BRIDGE_SECRET,
    })
    scaffold = await launchWebScaffold({
      agentPresets: {
        roots: [{ path: PRESET_ROOT, trust: 'system' }],
        default: 'standard',
      },
      openloop: {
        launchId: LAUNCH_ID,
        bootstrapToken: BOOTSTRAP_TOKEN,
        bridgeSecret: BRIDGE_SECRET,
        socketPath: bridge.socketPath,
        coreManifest: CORE_MANIFEST,
        coreManifestSha256: CORE_MANIFEST_SHA256,
      },
    })
    browser = await chromium.launch()
    page = await newEnglishPage(browser)
    page.setDefaultTimeout(10_000)
    tripwire = watchConsole(page)
    page.on('request', (request) => {
      if (!isBusinessApiUrl(request.url())) return
      const postData = request.postData()
      const capture: BrowserApiRequestCapture = {
        method: request.method(),
        url: request.url(),
        postData,
        rpcMethod: rpcMethodOf(postData),
        headers: request.headers(),
      }
      browserApiRequests.push(capture)
      requestReads.push(request.allHeaders().then((headers) => {
        capture.headers = headers
      }))
    })
    page.on('response', (response) => {
      if (!isBusinessApiUrl(response.url())) return
      const request = response.request()
      const capture: BrowserApiResponseCapture = {
        requestMethod: request.method(),
        url: response.url(),
        status: response.status(),
        rpcMethod: rpcMethodOf(request.postData()),
        headers: response.headers(),
        body: undefined,
      }
      browserApiResponses.push(capture)
      apiResponsesByRequest.set(request, { response, capture })
      if (isStreamingApiResponse(capture.url, capture.headers)) return
      const read = response.allHeaders().then((headers) => {
        capture.headers = headers
      })
      responseReads.push(withReadTimeout(
        read,
        `headers for ${capture.requestMethod} ${capture.url}`,
      ))
    })
    page.on('requestfinished', (request) => {
      const entry = apiResponsesByRequest.get(request)
      if (entry === undefined
        || isStreamingApiResponse(entry.capture.url, entry.capture.headers)
        || !shouldReadApiResponseBody(entry.capture.requestMethod, entry.capture.headers)) {
        return
      }
      const read = entry.response.text().then((body) => {
        entry.capture.body = body
      })
      responseReads.push(withReadTimeout(
        read,
        `${entry.capture.requestMethod} ${entry.capture.url}`
          + ` (${entry.capture.rpcMethod ?? 'no RPC method'})`,
      ))
    })
    const bootstrap = Buffer.from(BOOTSTRAP_TOKEN).toString('hex')
    await page.goto(
      `${scaffold.baseUrl}/#bootstrap=${bootstrap}&launch=${LAUNCH_ID}`,
      { waitUntil: 'load' },
    )
    try {
      await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    } catch (error) {
      throw new Error([
        String(error),
        `page: ${await page.locator('body').innerText().catch(() => '<unavailable>')}`,
        `pageErrors: ${JSON.stringify(tripwire.pageErrors)}`,
        `bridgeCalls: ${JSON.stringify(bridge.calls.slice(-12))}`,
      ].join('\n'))
    }
    await page.waitForFunction(
      () => document.documentElement.dataset.openloopBootstrap === 'ready',
      undefined,
      { timeout: 30_000 },
    )
  }, 120_000)

  afterAll(async () => {
    await closeAll([
      () => browser?.close(),
      () => scaffold?.close(),
      () => bridge?.close(),
    ])
  })

  it('assembles only the Openloop Workspace owners', () => {
    const entries = [...scaffold.ctx.loader.entries()]
    const entry = (id: string) => entries.find(candidate => candidate.options.id === id)
    for (const id of [
      'openloop-settings-scope',
      'openloop-workspace-client',
      'desktop-bridge-client',
      'workspace-authority',
    ]) {
      expect(entry(id)?.fiber, `${id} must be active in the assembled profile`).toBeDefined()
    }
    for (const id of ['ui-workspace', 'ui-settings']) {
      expect(entry(id)?.disabled, `${id} must stay disabled in the Openloop profile`).toBe(true)
    }
    expect(scaffold.ctx.get('browserApiPolicy')).toBeDefined()
    expect(scaffold.ctx.get('workspaceAuthority')).toBeDefined()
    expect(scaffold.ctx.workspaceRegistry.list()).toEqual([])
  })

  it('cancels and completes Add with a standard Session through the real UI', async () => {
    const canonicalPath = join(scaffold.workspaceCwd, 'authority-project')
    const displayPath = '~/Projects/authority-project'
    await mkdir(canonicalPath, { recursive: true })
    await writeFile(join(canonicalPath, 'keep.txt'), 'retained\n')

    bridge.enqueueWorkspaceAuthorization({ outcome: 'cancelled' })
    await openHeroWorkspaceMenu()
    await page.getByRole('menuitem', { name: 'Add Workspace' }).click()
    try {
      await bridge.whenCalled('beginWorkspaceAuthorization', 1)
    } catch (error) {
      throw new Error([
        String(error),
        `page: ${await page.locator('body').innerText()}`,
        `requests: ${JSON.stringify(browserApiRequests.slice(-12))}`,
      ].join('\n'))
    }
    await expect.poll(() => page.getByRole('menuitem').count(), { timeout: 10_000 }).toBe(0)
    expect(scaffold.ctx.workspaceRegistry.list()).toEqual([])
    expect(bridge.workspaceGrantCount()).toBe(0)
    await page.getByRole('textbox', { name: /choose workspace/iu })
      .waitFor({ timeout: 10_000 })

    const authorization = bridge.enqueueWorkspaceAuthorization({
      outcome: 'pending',
      canonicalPath,
      displayPath,
    })
    pendingGrantId = authorization.pendingGrantId
    await openHeroWorkspaceMenu()
    await page.getByRole('menuitem', { name: 'Add Workspace' }).click()
    const composer = page.locator(
      'textarea:enabled[placeholder="Describe what you want to build"]',
    )
    await composer.waitFor({ timeout: 20_000 })

    await expect.poll(() => scaffold.ctx.workspaceRegistry.list().length, {
      timeout: 10_000,
    }).toBe(1)
    const workspace = scaffold.ctx.workspaceRegistry.list()[0]
    if (workspace === undefined) throw new Error('Workspace add did not commit a registry row')
    expect(workspace.title).toBe('authority-project')
    expect(bridge.workspaceGrantState(workspace.id)).toBe('ready')
    await expect.poll(() => workspace.sessionIds.length, { timeout: 15_000 }).toBe(1)
    const initialSessionId = workspace.sessionIds[0]
    if (initialSessionId === undefined) throw new Error('Workspace did not receive its standard Session')
    await expect.poll(
      () => scaffold.ctx.sessions.get(initialSessionId)?.header.agentPreset,
      { timeout: 15_000 },
    ).toBe('standard')
    await page.getByText('authority-project', { exact: true }).first()
      .waitFor({ timeout: 10_000 })
    await page.getByText(displayPath, { exact: true }).first()
      .waitFor({ timeout: 10_000 })
    await expectComposerBlocked(false)

    const sessionCreatePayloads = await page.evaluate(() => {
      return performance.getEntriesByType('resource')
        .map(entry => entry.name)
        .filter(name => name.includes('/api/session.create'))
    })
    expect(sessionCreatePayloads.length).toBeGreaterThan(0)
    const createRequests = bridge.calls.filter(call => call.method === 'session.create')
    expect(createRequests).toEqual([])

    const sidebarWorkspace = page.getByRole('button', {
      name: 'Switch to authority-project',
    })
    await sidebarWorkspace.click()
    await expect.poll(() => workspace.sessionIds.length, { timeout: 15_000 })
      .toBeGreaterThanOrEqual(1)
    const sessionRow = page.locator('[class*="sessionRow"]').first()
    await sessionRow.waitFor({ timeout: 10_000 })
    await sessionRow.click()
    await expect.poll(() => sessionRow.getAttribute('aria-current'), {
      timeout: 10_000,
    }).toBe('true')
  }, 120_000)

  it('drives Workspace authority states and lifecycle actions through the real UI', async () => {
    const canonicalPath = join(scaffold.workspaceCwd, 'authority-project')
    const workspace = scaffold.ctx.workspaceRegistry.list()[0]
    if (workspace === undefined) throw new Error('Workspace add prerequisite is missing')
    const initialSessionId = workspace.sessionIds[0]
    if (initialSessionId === undefined) throw new Error('Workspace Session prerequisite is missing')
    await openWorkspaceSettings()
    await openWorkspaceActions('authority-project')
    await page.getByRole('menuitem', { name: 'Rename' }).click()
    const rename = page.getByRole('dialog', { name: 'Rename Workspace' })
    await rename.getByRole('textbox', { name: 'Rename' }).fill('Workspace Alpha')
    await rename.getByRole('button', { name: 'Rename' }).click()
    await page.getByRole('dialog', { name: 'Workspace settings' })
      .getByText('Workspace Alpha', { exact: true })
      .waitFor({ timeout: 10_000 })
    expect(scaffold.ctx.workspaceRegistry.get(workspace.id)?.title).toBe('Workspace Alpha')

    const revealCalls = bridge.calls.filter(call => call.method === 'revealWorkspace').length
    await openWorkspaceActions('Workspace Alpha')
    await page.getByRole('menuitem', { name: 'Reveal in Finder' }).click()
    await bridge.whenCalled('revealWorkspace', revealCalls + 1)
    expect(bridge.calls.filter(call => call.method === 'revealWorkspace').at(-1)).toEqual({
      method: 'revealWorkspace',
      payload: { workspaceId: workspace.id },
    })
    await page.getByRole('dialog', { name: 'Workspace settings' })
      .getByRole('button', { name: 'Close' }).click()

    bridge.setWorkspaceGrantState(workspace.id, 'missing')
    const create = vi.spyOn(scaffold.ctx.apiProxy.sessions, 'create')
    const createCallsBefore = create.mock.calls.length
    const denied = await fetch(`${scaffold.baseUrl}/api/session.create`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        type: 'client-request',
        rpcId: 'workspace-authority-not-ready',
        method: 'session.create',
        payload: { workspaceId: workspace.id },
      }),
    })
    expect(denied.status).toBe(403)
    expect(create.mock.calls).toHaveLength(createCallsBefore)
    bridge.setWorkspaceGrantState(workspace.id, 'ready')

    const preRemoveAria = await captureStableAria(page, '[class*="frame"]', scaffold.workspaceCwd)
    await compareOrRefreshGolden(UI_EXPECTED, preRemoveAria, MODE)

    expect(scaffold.ctx.sessions.get(initialSessionId)).toBeDefined()

    bridge.enqueueWorkspaceRevoke('cancelled')
    await openWorkspaceSettings()
    await openWorkspaceActions('Workspace Alpha')
    await page.getByRole('menuitem', { name: 'Remove' }).click()
    const remove = page.getByRole('dialog', { name: 'Remove Workspace' })
    expect(await remove.textContent()).toContain(
      'Only the authorization and list item are removed. Files and session history are kept.',
    )
    await remove.getByRole('button', { name: 'Remove' }).click()
    await bridge.whenCalled('confirmWorkspaceRevoke', 1)
    expect(scaffold.ctx.workspaceRegistry.get(workspace.id)).toBeDefined()
    await remove.getByRole('button', { name: 'Cancel' }).click()

    bridge.enqueueWorkspaceRevoke('confirmed')
    const deleteGrantCalls = bridge.calls.filter(call => call.method === 'deleteWorkspaceGrant').length
    const completeTransactionCalls = bridge.calls
      .filter(call => call.method === 'completeWorkspaceTransaction').length
    await openWorkspaceActions('Workspace Alpha')
    await page.getByRole('menuitem', { name: 'Remove' }).click()
    await page.getByRole('dialog', { name: 'Remove Workspace' })
      .getByRole('button', { name: 'Remove' }).click()
    await expect.poll(() => scaffold.ctx.workspaceRegistry.get(workspace.id), {
      timeout: 10_000,
    }).toBeUndefined()
    await bridge.whenCalled('deleteWorkspaceGrant', deleteGrantCalls + 1)
    await bridge.whenCalled('completeWorkspaceTransaction', completeTransactionCalls + 1)
    expect(bridge.workspaceGrantCount()).toBe(0)
    expect(await readFile(join(canonicalPath, 'keep.txt'), 'utf8')).toBe('retained\n')
    expect(scaffold.ctx.sessions.get(initialSessionId)).toBeDefined()

    const finalAria = await captureStableAria(page, '[class*="frame"]', scaffold.workspaceCwd)
    const finalDom = await page.content()
    await drainDynamicReads([requestReads, responseReads])
    await expect.poll(
      () => browserApiResponses.length,
      { timeout: 10_000 },
    ).toBe(browserApiRequests.length)
    await drainDynamicReads([requestReads, responseReads])
    const responseMethods = browserApiResponses.map(response => response.rpcMethod)
    expect(responseMethods, 'API response capture omitted session.create')
      .toContain('session.create')
    expect(responseMethods, 'API response capture omitted renameWorkspace')
      .toContain('openloopDesktop/renameWorkspace')
    const browserApiRequestTraffic = JSON.stringify(browserApiRequests)
    const browserApiResponseTraffic = JSON.stringify(browserApiResponses)
    const forbidden = [
      ['canonicalPath field', 'canonicalPath'],
      ['pendingGrantId field', 'pendingGrantId'],
      ['canonical path', canonicalPath],
      ['pending grant id', pendingGrantId],
      ['Bridge secret hex', Buffer.from(BRIDGE_SECRET).toString('hex')],
      ['Bridge secret base64', Buffer.from(BRIDGE_SECRET).toString('base64')],
      ['Bridge socket path', bridge.socketPath],
    ] as const
    for (const [label, value] of forbidden) {
      expect(browserApiRequestTraffic, `browser API requests leaked ${label}`).not.toContain(value)
      expect(browserApiResponseTraffic, `browser API responses leaked ${label}`)
        .not.toContain(value)
      expect(preRemoveAria, `pre-remove ARIA snapshot leaked ${label}`).not.toContain(value)
      expect(finalAria, `final ARIA snapshot leaked ${label}`).not.toContain(value)
      expect(finalDom, `final DOM snapshot leaked ${label}`).not.toContain(value)
    }

    expect(tripwire.warnings).toEqual([])
    expect(tripwire.pageErrors).toEqual([])
  }, 240_000)

  it('keeps the fixture inventory exact', async () => {
    await assertFixtureInventory(SNAPSHOT_DIR, ['ui.expected.md'])
  })
})
