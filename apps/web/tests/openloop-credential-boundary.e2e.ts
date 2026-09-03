// Assembled credential-boundary proof for the Openloop profile and the
// unchanged DSH Web profile. The only double is the native desktop sheet and
// Keychain boundary; every Cordis plugin and dispatcher remains real.
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { readdir, readFile } from 'node:fs/promises'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type {} from '@deepseek-ai/dsh-api-gateway'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import {
  assertFixtureInventory,
  captureStableAria,
  compareOrRefreshGolden,
  launchWebScaffold,
  watchConsole,
  webSnapshotMode,
  type WebScaffold,
  WELCOME_NOTICE_COPY,
} from './scaffold.ts'
import { AuthenticatedUnixBridgeServer } from './openloop-bridge-server.ts'
import { ZH_BROWSER_LOCALE } from './support.ts'

const SNAPSHOT_DIR = fileURLToPath(new URL(
  './snapshots/openloop-credential-boundary',
  import.meta.url,
))
const UI_EXPECTED = join(SNAPSHOT_DIR, 'ui.expected.md')
const MODE = webSnapshotMode()
const REF = 'DEEPSEEK_API_KEY'
const DSH_REF = credentialRef(REF)
const LAUNCH_ID = '8f5d7e17-9b2b-4b2c-9c2a-1f3e6b2a4d90'
const BOOTSTRAP_TOKEN = Uint8Array.from({ length: 32 }, (_, index) => index + 1)
const BRIDGE_SECRET = Uint8Array.from({ length: 32 }, (_, index) => index + 65)
const CORE_MANIFEST_SHA256 = 'a'.repeat(64)
const CORE_MANIFEST = {
  appVersion: '0.1.0',
  channel: 'test',
  dshTag: 'dsh-v0.1.0-rc.7',
  dshCommit: '99f6f02fecdb7dff40c3fbc9470f5907c29f74ca',
  brand: {
    productName: 'Openloop',
    documentSuffix: 'Openloop',
    markAsset: 'data:image/svg+xml;base64,PHN2Zy8+',
    heroTitle: 'Openloop',
    previewLabel: '预览版',
    attribution: 'Built on DeepSeek Harness',
  },
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
    throw new AggregateError(failures, 'credential boundary cleanup failed')
  }
}

async function fixtureFileBodies(root: string): Promise<string[]> {
  const bodies: string[] = []
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) await visit(path)
      else if (entry.isFile()) bodies.push((await readFile(path)).toString('utf8'))
    }
  }
  await visit(root)
  return bodies
}

describe('web e2e: Openloop credential boundary', () => {
  let scaffold: WebScaffold
  let bridge: AuthenticatedUnixBridgeServer
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>

  beforeAll(async () => {
    bridge = await AuthenticatedUnixBridgeServer.start({
      launchId: LAUNCH_ID,
      secret: BRIDGE_SECRET,
    })
    scaffold = await launchWebScaffold({
      deepSeekMissingCredential: true,
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
    page = await browser.newPage({
      viewport: { width: 1440, height: 960 },
      locale: ZH_BROWSER_LOCALE,
    })
    tripwire = watchConsole(page)
    const bootstrap = Buffer.from(BOOTSTRAP_TOKEN).toString('hex')
    await page.goto(
      `${scaffold.baseUrl}/#bootstrap=${bootstrap}&launch=${LAUNCH_ID}`,
      { waitUntil: 'load' },
    )
    await page.waitForSelector('#root', { timeout: 30_000 })
    await page.waitForFunction(
      () => document.documentElement.dataset.openloopBootstrap === 'ready',
      undefined,
      { timeout: 30_000 },
    )
    const welcome = page.getByRole('dialog', { name: WELCOME_NOTICE_COPY.zh.title })
    await welcome.waitFor({ timeout: 10_000 })
    expect(await welcome.locator('input[type="password"]').count()).toBe(0)
    await welcome.getByRole('button', { name: WELCOME_NOTICE_COPY.zh.continueLabel }).click()
    const credential = page.getByRole('dialog', { name: '添加一个 API Key 开始使用' })
    const credentialVisible = await credential.waitFor({ timeout: 5_000 })
      .then(() => true, () => false)
    if (credentialVisible) {
      expect(await credential.locator('input[type="password"]').count()).toBe(0)
      await credential.getByRole('button', { name: '稍后配置' }).click()
    }
  }, 120_000)

  afterAll(async () => {
    await closeAll([
      () => browser?.close(),
      () => scaffold?.close(),
      () => bridge?.close(),
    ])
  })

  it('removes every DSH credential owner from the Openloop browser surface', async () => {
    const entries = [...scaffold.ctx.loader.entries()]
    const entry = (id: string) => entries.find(candidate => candidate.options.id === id)
    for (const id of [
      'ui-settings',
      'ui-settings-plugin-inventory',
      'ui-permission',
      'ui-agent-preset',
    ]) {
      expect(entry(id)?.disabled, `${id} must stay disabled in the Openloop profile`).toBe(true)
    }
    for (const id of [
      'openloop-settings-foundation',
      'desktop-bridge-host',
      'credentials-keychain',
      'connection',
      'api-gateway',
      'typert-gateway',
      'openloop-bootstrap',
      'ui-settings-general',
      'ui-settings-models',
      'ui-settings-plugins',
    ]) {
      expect(entry(id)?.fiber, `${id} must be active in the Openloop fixture`).toBeDefined()
    }
    expect(await page.locator('html').getAttribute('data-openloop-bootstrap')).toBe('ready')
    expect(scaffold.ctx.get('browserApiPolicy')).toBeDefined()
    expect(scaffold.ctx.get('openloopCredentialOperations')).toBeDefined()
    expect(bridge.calls.filter(call => call.method === 'getCandidateCredentialHealthPlan'))
      .toHaveLength(1)
    expect(bridge.calls.filter(call => call.method === 'acknowledgeMainWebviewHealth'))
      .toEqual([{
        method: 'acknowledgeMainWebviewHealth',
        payload: {
          launchId: LAUNCH_ID,
          coreManifestSha256: CORE_MANIFEST_SHA256,
          openloopDataVersion: 0,
          dshDataVersion: 0,
        },
      }])
    expect(await page.locator('input[type="password"]').count()).toBe(0)
    const snapshot = await captureStableAria(page, '[class*="frame"]', scaffold.workspaceCwd)
    expect(snapshot).not.toContain('password')
    expect(snapshot).not.toContain('API 密钥')
    await compareOrRefreshGolden(UI_EXPECTED, snapshot, MODE)

    const workspaceSettings = page.getByRole('button', { name: '设置', exact: true })
    expect(await workspaceSettings.count()).toBe(1)
    await workspaceSettings.click()
    let settings = page.getByRole('dialog', { name: '设置', exact: true })
    if (await settings.count() === 0) {
      await page.getByRole('button', { name: '设置', exact: true }).click()
      settings = page.getByRole('dialog', { name: '设置', exact: true })
      await settings.waitFor()
    }
    await settings.waitFor({ timeout: 10_000 })
    expect(await settings.getByRole('tab').allTextContents()).toEqual([
      '通用',
      '模型与凭据',
      '插件',
      '关于与更新',
    ])
    expect(await page.getByRole('dialog', { name: WELCOME_NOTICE_COPY.zh.title }).count()).toBe(0)
    expect(await page.getByRole('dialog', { name: '添加一个 API Key 开始使用' }).count()).toBe(0)

    expect(tripwire.warnings).toEqual([])
    expect(tripwire.pageErrors).toEqual([])
  })

  it('keeps a native-sheet sentinel out of every browser, settings, log, and crash sink', async () => {
    const sentinel = 'OPENLOOP_SECRET_SENTINEL_1788373237'
    await expect(scaffold.ctx.typertGateway.invoke({
      namespace: 'openloopDesktop',
      method: 'describeCredential',
      args: { ref: REF },
    })).resolves.toEqual({ configured: false, writable: true })

    const requests: string[] = []
    const responses: Promise<void>[] = []
    const requestListener = (request: import('playwright').Request): void => {
      requests.push(`${request.url()}\n${request.postData() ?? ''}`)
    }
    const responseListener = (response: import('playwright').Response): void => {
      responses.push(response.text().then(
        (body) => { requests.push(`${response.url()}\n${body}`) },
        () => undefined,
      ))
    }
    page.on('request', requestListener)
    page.on('response', responseListener)
    const hostLogs: unknown[][] = []
    const consoleSpies = (['log', 'warn', 'error'] as const).map(method =>
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
        hostLogs.push(args)
      }))

    await page.getByRole('dialog', { name: '设置', exact: true })
      .getByRole('button', { name: '关闭设置' }).click()
    await page.getByRole('button', { name: '设置', exact: true }).click()
    const settings = page.getByRole('dialog', { name: '设置', exact: true })
    await settings.waitFor({ timeout: 10_000 })
    await settings.getByRole('tab', { name: '模型与凭据' }).click()
    const providers: unknown = await page.evaluate(async (): Promise<unknown> => {
      const response = await fetch('/api/openloop/settings/providers', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      })
      return await response.json() as unknown
    })
    const providerResponse = providers as {
      readonly ok?: unknown
      readonly value?: {
        readonly providers?: readonly {
          readonly provider?: unknown
          readonly credentialRef?: unknown
        }[]
      }
    }
    expect(providerResponse.ok).toBe(true)
    expect(providerResponse.value?.providers?.some(provider =>
      provider.provider === 'deepseek-official'
      && provider.credentialRef === REF)).toBe(true)
    expect(await settings.getByRole('tabpanel').innerText()).toContain('DeepSeek')
    const addCredential = settings.getByRole('button', { name: '添加 API 密钥' })
    if (await addCredential.count() === 0) {
      await settings.getByRole('button', { name: '重试' }).click()
    }
    await addCredential.click()
    await bridge.whenCredentialReplacementOpened()

    bridge.completeCredentialReplacement(sentinel)
    await expect(scaffold.ctx.typertGateway.invoke({
      namespace: 'openloopDesktop',
      method: 'describeCredential',
      args: { ref: REF },
    })).resolves.toEqual({
      configured: true,
      source: 'keychain',
      writable: true,
    })
    const configuredMask = settings.getByText('**** **** **** ****', { exact: true })
    if (await configuredMask.count() === 0) {
      const providerRow = settings.getByText('DeepSeek', { exact: true })
        .locator('xpath=ancestor::li[1]')
      await providerRow.getByRole('button', { name: /编辑|Edit/u }).click()
    }
    await configuredMask.waitFor({ timeout: 10_000 })
    expect(await configuredMask.count()).toBe(1)
    expect(await settings.getByRole('button', { name: '更新 API 密钥' }).count()).toBe(1)
    expect(await settings.locator('input[type="password"]').count()).toBe(0)
    const modelsText = await settings.getByRole('tabpanel').innerText()
    expect(modelsText).not.toContain(REF)
    expect(modelsText).not.toContain(sentinel)
    expect(bridge.storedCredentialByteLength()).toBe(Buffer.byteLength(sentinel))

    await settings.getByRole('button', { name: '更新 API 密钥' }).click()
    await bridge.whenCalled('openCredentialReplacement', 2)
    bridge.completeCredentialReplacement(sentinel)
    await configuredMask.waitFor({ timeout: 10_000 })
    expect(bridge.storedCredentialByteLength()).toBe(Buffer.byteLength(sentinel))

    await Promise.all(responses)
    page.off('request', requestListener)
    page.off('response', responseListener)
    for (const spy of consoleSpies) spy.mockRestore()

    const browserState = await page.evaluate(() => ({
      dom: document.documentElement.outerHTML,
      localStorage: JSON.stringify(Object.fromEntries(
        Array.from({ length: localStorage.length }, (_, index) => {
          const key = localStorage.key(index) ?? ''
          return [key, localStorage.getItem(key)]
        }),
      )),
      sessionStorage: JSON.stringify(Object.fromEntries(
        Array.from({ length: sessionStorage.length }, (_, index) => {
          const key = sessionStorage.key(index) ?? ''
          return [key, sessionStorage.getItem(key)]
        }),
      )),
    }))
    const fixtureFiles = await fixtureFileBodies(scaffold.workspaceCwd)
    const audit = JSON.stringify({
      requests,
      browserState,
      browserWarnings: tripwire.warnings,
      browserErrors: tripwire.pageErrors,
      hostLogs,
      bridgeCalls: bridge.calls,
      fixtureFiles,
    })
    expect(audit).not.toContain(sentinel)
    expect(bridge.calls.filter(call => call.method === 'resolveCredential')).toEqual([])
    expect(bridge.calls.filter(call => call.method === 'openCredentialReplacement'))
      .toEqual([
        { method: 'openCredentialReplacement', payload: { ref: REF } },
        { method: 'openCredentialReplacement', payload: { ref: REF } },
      ])
  })

  it('denies legacy credential handlers and Host-only Typert endpoints', async () => {
    const api = scaffold.ctx.apiProxy
    const set = vi.spyOn(api.credentials, 'set')
    const unset = vi.spyOn(api.credentials, 'unset')
    const resolve = vi.spyOn(scaffold.ctx.credentials, 'resolve')
    for (const [method, payload] of [
      ['credentials.set', { ref: REF, value: 'must-not-be-read' }],
      ['credentials.unset', { ref: REF }],
      ['credentials.resolve', { ref: REF }],
    ] as const) {
      const response = await fetch(`${scaffold.baseUrl}/api/${method}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          type: 'client-request',
          rpcId: `boundary-${method}`,
          method,
          payload,
        }),
      })
      expect([method, response.status]).toEqual([method, 403])
    }
    expect(set).not.toHaveBeenCalled()
    expect(unset).not.toHaveBeenCalled()
    expect(resolve).not.toHaveBeenCalled()
    expect(bridge.calls.filter(call => call.method === 'resolveCredential')).toEqual([])

    for (const [namespace, method, args] of [
      ['openloopDesktop', 'resolveCredential', { ref: REF }],
      ['credentials', 'set', { ref: REF, value: 'must-not-be-read' }],
      ['credentials', 'unset', { ref: REF }],
      ['credentials', 'resolve', { ref: REF }],
    ] as const) {
      await expect(scaffold.ctx.typertGateway.invoke({ namespace, method, args }))
        .rejects.toMatchObject({
          code: 'policy-denied',
          endpoint: `${namespace}/${method}`,
        })
    }

    await expect(scaffold.ctx.typertGateway.invoke({
      namespace: 'openloopDesktop',
      method: 'getAppInfo',
      args: {},
    })).resolves.toEqual({ appVersion: '0.1.0', channel: 'test' })
    expect(bridge.calls.filter(call => call.method === 'getAppInfo')).toHaveLength(1)
    expect(bridge.calls.filter(call => call.method === 'resolveCredential')).toEqual([])
  })

  it('keeps the fixture inventory closed', async () => {
    await assertFixtureInventory(SNAPSHOT_DIR, ['ui.expected.md'])
  })
})

describe('web e2e: default DSH credential surface remains unchanged', () => {
  it('keeps onboarding, Models, Plugins, and the legacy credential seam', async () => {
    const scaffold = await launchWebScaffold({
      deepSeekMissingCredential: true,
      welcomeNoticePending: true,
    })
    const browser = await chromium.launch()
    const page = await browser.newPage({
      viewport: { width: 1440, height: 960 },
      locale: ZH_BROWSER_LOCALE,
    })
    try {
      expect(scaffold.ctx.get('browserApiPolicy')).toBeUndefined()
      await page.goto(scaffold.baseUrl, { waitUntil: 'load' })
      await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })

      const welcome = page.getByRole('dialog', { name: WELCOME_NOTICE_COPY.zh.title })
      await welcome.getByRole('button', { name: WELCOME_NOTICE_COPY.zh.continueLabel }).click()
      const onboarding = page.getByRole('dialog', { name: '添加一个 API Key 开始使用' })
      const onboardingKey = onboarding.getByLabel('API 密钥', { exact: true })
      await onboardingKey.waitFor({ timeout: 10_000 })
      expect(await onboardingKey.getAttribute('type')).toBe('password')
      await onboarding.getByRole('button', { name: '稍后配置' }).click()

      await page.getByRole('button', { name: '设置', exact: true }).click()
      const settings = page.getByRole('dialog', { name: '设置' })
      await settings.getByRole('button', { name: '模型' }).click()
      const modelKey = settings.getByLabel('API 密钥', { exact: true })
      await modelKey.waitFor({ timeout: 10_000 })
      expect(await modelKey.getAttribute('type'))
        .toBe('password')

      await settings.getByRole('button', { name: '插件', exact: true }).click()
      await settings.getByText('网页搜索', { exact: true }).click()
      const searchKey = settings.getByLabel('API Key', { exact: true })
      await searchKey.waitFor({ timeout: 10_000 })
      expect(await searchKey.getAttribute('type')).toBe('password')

      await scaffold.ctx.credentials.set(DSH_REF, 'default-dsh-fixture-value')
      await expect(scaffold.ctx.credentials.resolve(DSH_REF)).resolves.toMatchObject({
        value: 'default-dsh-fixture-value',
      })
      await scaffold.ctx.credentials.unset(DSH_REF)
      await expect(scaffold.ctx.credentials.resolve(DSH_REF)).resolves.toBeUndefined()
    } finally {
      await closeAll([
        () => browser.close(),
        () => scaffold.close(),
      ])
    }
  }, 120_000)
})
