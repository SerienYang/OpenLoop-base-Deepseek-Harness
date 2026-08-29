// Assembled proof for the Openloop Workspace authority. The browser, Cordis
// plugins, policy, DSH registry/session handlers, and React surfaces are real;
// only the authenticated native AppKit/grant-store boundary is doubled.
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import type {
  Browser,
  Page,
  Request,
  Response as PlaywrightResponse,
} from 'playwright'
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
const STREAM_CAPTURE_LIMIT_BYTES = 64 * 1024
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
  for (const [index, close] of resources.entries()) {
    try {
      await withTimeout(
        Promise.resolve(close()),
        `Workspace authority cleanup resource ${index + 1}`,
        15_000,
      )
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

function isStreamingApiResponse(headers: Readonly<Record<string, string>>): boolean {
  const contentType = headers['content-type']?.toLowerCase() ?? ''
  return contentType.includes('text/event-stream')
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

interface BrowserStreamCapture {
  readonly transport: 'sse' | 'websocket'
  readonly url: string
  bytes: number
  frameCount: number
  text: string
  truncated: boolean
}

async function installSseCapture(page: Page): Promise<void> {
  await page.addInitScript((maximumBytes) => {
    interface SseCapture {
      readonly transport: 'sse'
      readonly url: string
      bytes: number
      frameCount: number
      text: string
      truncated: boolean
    }
    interface CaptureGlobal {
      __openloopSseCaptures?: SseCapture[]
      __openloopCloseDownlinks?: () => void
    }
    const state = globalThis as typeof globalThis & CaptureGlobal
    state.__openloopSseCaptures = []
    let capturedBytes = 0
    const sockets = new Set<WebSocket>()
    const NativeWebSocket = globalThis.WebSocket
    globalThis.WebSocket = new Proxy(NativeWebSocket, {
      construct(Target, args: ConstructorParameters<typeof WebSocket>) {
        const socket = new Target(...args)
        sockets.add(socket)
        socket.addEventListener('close', () => { sockets.delete(socket) }, { once: true })
        return socket
      },
    })
    state.__openloopCloseDownlinks = () => {
      for (const socket of sockets) socket.close()
    }
    const originalFetch = globalThis.fetch.bind(globalThis)
    globalThis.fetch = async (...args): Promise<Response> => {
      const response = await originalFetch(...args)
      if (!response.headers.get('content-type')?.toLowerCase().includes('text/event-stream')
        || response.body === null) {
        return response
      }
      const capture: SseCapture = {
        transport: 'sse',
        url: response.url,
        bytes: 0,
        frameCount: 0,
        text: '',
        truncated: false,
      }
      state.__openloopSseCaptures?.push(capture)
      const decoder = new TextDecoder()
      const observed = response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          capture.frameCount += 1
          const remaining = maximumBytes - capturedBytes
          if (remaining > 0) {
            const recorded = chunk.subarray(0, remaining)
            capture.text += decoder.decode(recorded, { stream: recorded.length === chunk.length })
            capture.bytes += recorded.byteLength
            capturedBytes += recorded.byteLength
          }
          if (chunk.byteLength > remaining) capture.truncated = true
          controller.enqueue(chunk)
        },
        flush() {
          if (!capture.truncated) capture.text += decoder.decode()
        },
      }))
      return new Response(observed, {
        headers: response.headers,
        status: response.status,
        statusText: response.statusText,
      })
    }
  }, STREAM_CAPTURE_LIMIT_BYTES)
}

async function readSseCaptures(page: Page): Promise<BrowserStreamCapture[]> {
  return await page.evaluate(() => {
    return [...((globalThis as typeof globalThis & {
      __openloopSseCaptures?: BrowserStreamCapture[]
    }).__openloopSseCaptures ?? [])]
  })
}

async function reconnectBrowserTransport(page: Page): Promise<void> {
  await page.evaluate(() => {
    const close = (globalThis as typeof globalThis & {
      __openloopCloseDownlinks?: () => void
    }).__openloopCloseDownlinks
    if (close === undefined) throw new Error('browser downlink lifecycle control is unavailable')
    close()
  })
}

function recordStreamFrame(
  capture: BrowserStreamCapture,
  payload: string | Buffer,
  budget: { bytes: number },
): void {
  capture.frameCount += 1
  const bytes = typeof payload === 'string' ? Buffer.from(payload) : payload
  const remaining = STREAM_CAPTURE_LIMIT_BYTES - budget.bytes
  if (remaining > 0) {
    const recorded = bytes.subarray(0, remaining)
    capture.text += recorded.toString('utf8')
    capture.bytes += recorded.byteLength
    budget.bytes += recorded.byteLength
  }
  if (bytes.byteLength > remaining) capture.truncated = true
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

function withTimeout<T>(read: Promise<T>, label: string, timeoutMs = 5_000): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`timed out reading ${label}`))
    }, timeoutMs)
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
  const browserStreamCaptures: BrowserStreamCapture[] = []
  const browserStreamBudget = { bytes: 0 }
  const apiResponsesByRequest = new Map<Request, {
    readonly response: PlaywrightResponse
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
    await expect.poll(() => composer.evaluate((element) => {
      const textarea = element as HTMLTextAreaElement
      return textarea.disabled || textarea.readOnly
    }), { timeout: 10_000 }).toBe(blocked)
    if (blocked) {
      expect(await composer.getAttribute('placeholder')).toMatch(
        /Workspace authorization is required before sending|Choose a workspace to start/u,
      )
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
    await installSseCapture(page)
    tripwire = watchConsole(page)
    page.on('websocket', (socket) => {
      const pathname = new URL(socket.url()).pathname
      if (pathname !== '/api/events.mux' && pathname !== '/api/events.host') return
      const capture: BrowserStreamCapture = {
        transport: 'websocket',
        url: socket.url(),
        bytes: 0,
        frameCount: 0,
        text: '',
        truncated: false,
      }
      browserStreamCaptures.push(capture)
      socket.on('framereceived', ({ payload }) => {
        recordStreamFrame(capture, payload, browserStreamBudget)
      })
    })
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
      requestReads.push(withTimeout(
        request.allHeaders().then((headers) => {
          capture.headers = headers
        }),
        `request headers for ${capture.method} ${capture.url}`,
      ))
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
      if (isStreamingApiResponse(capture.headers)) return
      const read = response.allHeaders().then((headers) => {
        capture.headers = headers
      })
      responseReads.push(withTimeout(
        read,
        `headers for ${capture.requestMethod} ${capture.url}`,
      ))
    })
    page.on('requestfinished', (request) => {
      const entry = apiResponsesByRequest.get(request)
      if (entry === undefined
        || isStreamingApiResponse(entry.capture.headers)
        || !shouldReadApiResponseBody(entry.capture.requestMethod, entry.capture.headers)) {
        return
      }
      const read = entry.response.text().then((body) => {
        entry.capture.body = body
      })
      responseReads.push(withTimeout(
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

  it('runs a self-contained Workspace add and lifecycle through the real UI', async () => {
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
    const missingRefreshes = browserApiRequests.filter(
      request => request.rpcMethod === 'openloopDesktop/listWorkspaceGrants',
    ).length
    await reconnectBrowserTransport(page)
    await expect.poll(() => browserApiRequests.filter(
      request => request.rpcMethod === 'openloopDesktop/listWorkspaceGrants',
    ).length, { timeout: 15_000 }).toBeGreaterThan(missingRefreshes)
    await page.getByText('Missing', { exact: true }).waitFor({ timeout: 15_000 })
    await sessionRow.click()
    await expect.poll(() => sessionRow.getAttribute('aria-current'), {
      timeout: 10_000,
    }).toBe('true')
    await expectComposerBlocked(true)
    await expect(scaffold.ctx.desktopBridge.inspectWorkspaceGrant(workspace.id))
      .resolves.toMatchObject({
        exists: true,
        status: 'ready',
        effectiveStatus: 'missing',
        identityValid: false,
      })
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
    for (const state of ['permission-denied', 'identity-mismatch'] as const) {
      bridge.setWorkspaceGrantState(workspace.id, state)
      await expect(scaffold.ctx.desktopBridge.inspectWorkspaceGrant(workspace.id))
        .resolves.toMatchObject({
          exists: true,
          status: 'ready',
          effectiveStatus: state,
          identityValid: false,
        })
    }
    bridge.setWorkspaceGrantState(workspace.id, 'ready')
    const readyRefreshes = browserApiRequests.filter(
      request => request.rpcMethod === 'openloopDesktop/listWorkspaceGrants',
    ).length
    await reconnectBrowserTransport(page)
    await expect.poll(() => browserApiRequests.filter(
      request => request.rpcMethod === 'openloopDesktop/listWorkspaceGrants',
    ).length, { timeout: 15_000 }).toBeGreaterThan(readyRefreshes)
    await sessionRow.click()
    await expectComposerBlocked(false)

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

    const transactionCalls = bridge.calls.filter(call => [
      'prepareWorkspaceTransaction',
      'advanceWorkspaceTransaction',
      'abortWorkspaceTransaction',
      'completeWorkspaceTransaction',
    ].includes(call.method))
    expect(transactionCalls.map(call => call.method)).toEqual([
      'prepareWorkspaceTransaction',
      'advanceWorkspaceTransaction',
      'advanceWorkspaceTransaction',
      'completeWorkspaceTransaction',
      'prepareWorkspaceTransaction',
      'advanceWorkspaceTransaction',
      'advanceWorkspaceTransaction',
      'completeWorkspaceTransaction',
    ])
    const addOperationId = (transactionCalls[1]?.payload as { operationId?: unknown }).operationId
    const revokeOperationId = (transactionCalls[5]?.payload as { operationId?: unknown }).operationId
    expect(transactionCalls[0]?.payload).toEqual(expect.objectContaining({
      kind: 'add',
      workspaceId: workspace.id,
      stage: 'prepared',
    }))
    expect(transactionCalls.slice(1, 4).map(call => call.payload)).toEqual([
      expect.objectContaining({
        operationId: addOperationId,
        expectedGeneration: 1,
        expectedStage: 'prepared',
        nextStage: 'registry-committed',
      }),
      expect.objectContaining({
        operationId: addOperationId,
        expectedGeneration: 2,
        expectedStage: 'registry-committed',
        nextStage: 'grant-committed',
      }),
      {
        operationId: addOperationId,
        expectedGeneration: 3,
        expectedStage: 'grant-committed',
      },
    ])
    expect(transactionCalls[4]?.payload).toEqual(expect.objectContaining({
      kind: 'revoke',
      workspaceId: workspace.id,
      stage: 'revoke-prepared',
    }))
    expect(transactionCalls.slice(5).map(call => call.payload)).toEqual([
      expect.objectContaining({
        operationId: revokeOperationId,
        expectedGeneration: 1,
        expectedStage: 'revoke-prepared',
        nextStage: 'registry-deleted',
      }),
      expect.objectContaining({
        operationId: revokeOperationId,
        expectedGeneration: 2,
        expectedStage: 'registry-deleted',
        nextStage: 'grant-deleted',
      }),
      {
        operationId: revokeOperationId,
        expectedGeneration: 3,
        expectedStage: 'grant-deleted',
      },
    ])

    const grantGeneration = await scaffold.ctx.desktopBridge.getWorkspaceGrantGeneration()
    const invalidOrder = await scaffold.ctx.desktopBridge.prepareWorkspaceTransaction({
      kind: 'add',
      workspaceId: 'transaction-contract-workspace',
      expectedCatalogGeneration: 0,
      expectedGrantGeneration: grantGeneration,
      stage: 'prepared',
    })
    expect(invalidOrder.generation).toBe(1)
    await expect(scaffold.ctx.desktopBridge.completeWorkspaceTransaction(
      invalidOrder.operationId,
      invalidOrder.generation,
      invalidOrder.stage,
    )).rejects.toThrow('cannot complete')
    await expect(scaffold.ctx.desktopBridge.advanceWorkspaceTransaction(
      invalidOrder.operationId,
      invalidOrder.generation,
      invalidOrder.stage,
      'grant-committed',
    )).rejects.toThrow('transition is invalid')
    await expect(scaffold.ctx.desktopBridge.advanceWorkspaceTransaction(
      invalidOrder.operationId,
      invalidOrder.generation,
      invalidOrder.stage,
      'registry-committed',
      'rebound-workspace',
    )).rejects.toThrow('transition is invalid')
    await scaffold.ctx.desktopBridge.abortWorkspaceTransaction(
      invalidOrder.operationId,
      invalidOrder.generation,
      invalidOrder.stage,
    )
    const resetGeneration = await scaffold.ctx.desktopBridge.prepareWorkspaceTransaction({
      kind: 'revoke',
      workspaceId: 'transaction-contract-workspace',
      expectedCatalogGeneration: 0,
      expectedGrantGeneration: grantGeneration,
      stage: 'revoke-prepared',
    })
    expect(resetGeneration.generation).toBe(1)
    await scaffold.ctx.desktopBridge.abortWorkspaceTransaction(
      resetGeneration.operationId,
      resetGeneration.generation,
      resetGeneration.stage,
    )

    const finalAria = await captureStableAria(page, '[class*="frame"]', scaffold.workspaceCwd)
    const finalDom = await page.content()
    await withTimeout(
      drainDynamicReads([requestReads, responseReads]),
      'dynamic browser API reads',
      15_000,
    )
    await expect.poll(
      () => browserApiResponses.length,
      { timeout: 10_000 },
    ).toBe(browserApiRequests.length)
    await withTimeout(
      drainDynamicReads([requestReads, responseReads]),
      'final dynamic browser API reads',
      15_000,
    )
    const browserStreams = [...browserStreamCaptures, ...await readSseCaptures(page)]
    for (const path of ['/api/events.mux', '/api/events.host']) {
      expect(
        browserStreams.some(capture =>
          new URL(capture.url).pathname === path && capture.frameCount > 0),
        `browser capture did not observe a real ${path} frame`,
      ).toBe(true)
    }
    const responseMethods = browserApiResponses.map(response => response.rpcMethod)
    expect(responseMethods, 'API response capture omitted session.create')
      .toContain('session.create')
    expect(responseMethods, 'API response capture omitted renameWorkspace')
      .toContain('openloopDesktop/renameWorkspace')
    const browserApiRequestTraffic = JSON.stringify(browserApiRequests)
    const browserApiResponseTraffic = JSON.stringify(browserApiResponses.filter(
      response => response.rpcMethod?.startsWith('openloopDesktop/') === true,
    ))
    const browserStreamTraffic = JSON.stringify(browserStreams)
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
      if (label !== 'canonical path') {
        expect(browserStreamTraffic, `browser API streams leaked ${label}`).not.toContain(value)
      }
      expect(preRemoveAria, `pre-remove ARIA snapshot leaked ${label}`).not.toContain(value)
      expect(finalAria, `final ARIA snapshot leaked ${label}`).not.toContain(value)
      expect(finalDom, `final DOM snapshot leaked ${label}`).not.toContain(value)
    }

    expect(tripwire.warnings).toEqual([
      '[web-runtime] connection lost, retry #1',
      '[web-runtime] connection lost, retry #1',
    ])
    expect(tripwire.pageErrors).toEqual([])
  }, 300_000)

  it('keeps the fixture inventory exact', async () => {
    await assertFixtureInventory(SNAPSHOT_DIR, ['ui.expected.md'])
  })
})

describe('web e2e: Workspace authorization cancellation lifecycle', () => {
  it('sends $cancel for the deferred native request when its browser page closes', async () => {
    const launchId = '1cb4b3b2-2ab3-42f7-ad40-e728f9ec1bbc'
    const bootstrapToken = Uint8Array.from({ length: 32 }, (_, index) => index + 17)
    const bridgeSecret = Uint8Array.from({ length: 32 }, (_, index) => index + 113)
    let bridge: AuthenticatedUnixBridgeServer | undefined
    let scaffold: WebScaffold | undefined
    let browser: Browser | undefined
    let page: Page | undefined
    try {
      bridge = await AuthenticatedUnixBridgeServer.start({
        launchId,
        secret: bridgeSecret,
      })
      scaffold = await launchWebScaffold({
        agentPresets: {
          roots: [{ path: PRESET_ROOT, trust: 'system' }],
          default: 'standard',
        },
        openloop: {
          launchId,
          bootstrapToken,
          bridgeSecret,
          socketPath: bridge.socketPath,
          coreManifest: CORE_MANIFEST,
          coreManifestSha256: CORE_MANIFEST_SHA256,
        },
      })
      browser = await chromium.launch()
      page = await newEnglishPage(browser)
      page.setDefaultTimeout(10_000)
      bridge.enqueueWorkspaceAuthorization({
        outcome: 'pending',
        canonicalPath: join(scaffold.workspaceCwd, 'cancelled-workspace'),
        displayPath: '~/Projects/cancelled-workspace',
        deferred: true,
      })
      const bootstrap = Buffer.from(bootstrapToken).toString('hex')
      await page.goto(
        `${scaffold.baseUrl}/#bootstrap=${bootstrap}&launch=${launchId}`,
        { waitUntil: 'load' },
      )
      await page.waitForFunction(
        () => document.documentElement.dataset.openloopBootstrap === 'ready',
        undefined,
        { timeout: 30_000 },
      )
      await page.getByRole('textbox', { name: /choose workspace/iu }).click()
      await page.getByRole('menuitem', { name: 'Add Workspace' }).click()
      await bridge.whenCalled('beginWorkspaceAuthorization')
      const beginRequestId = bridge.requestIdForCall('beginWorkspaceAuthorization')
      expect(beginRequestId).toBeTypeOf('string')
      expect(bridge.pendingRequestCount()).toBe(1)

      await withTimeout(page.close(), 'cancel fixture page close', 10_000)
      await bridge.whenCalled('$cancel')
      await expect.poll(() => bridge?.pendingRequestCount(), { timeout: 10_000 }).toBe(0)
      expect(bridge.calls.find(call => call.method === '$cancel')?.payload).toEqual({
        requestId: beginRequestId,
      })
    } finally {
      await closeAll([
        () => page?.isClosed() === false ? page.close() : undefined,
        () => browser?.close(),
        () => scaffold?.close(),
        () => bridge?.close(),
      ])
    }
  }, 120_000)
})
