// Assembled credential-boundary proof for the Openloop profile and the
// unchanged DSH Web profile. The only double is the native desktop sheet and
// Keychain boundary; every Cordis plugin and dispatcher remains real.
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type {} from '@deepseek-ai/dsh-api-gateway'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { toFetchHandler } from '@deepseek-ai/dsh-host-apiproxy'
import {
  assertFixtureInventory,
  captureStableAria,
  compareOrRefreshGolden,
  launchWebScaffold,
  watchConsole,
  webSnapshotMode,
  type OpenloopFixtureDesktopBridge,
  type WebScaffold,
  WELCOME_NOTICE_COPY,
} from './scaffold.ts'
import { ZH_BROWSER_LOCALE } from './support.ts'

const SNAPSHOT_DIR = fileURLToPath(new URL(
  './snapshots/openloop-credential-boundary',
  import.meta.url,
))
const UI_EXPECTED = join(SNAPSHOT_DIR, 'ui.expected.md')
const MODE = webSnapshotMode()
const REF = 'DEEPSEEK_API_KEY'
const DSH_REF = credentialRef(REF)

class DeferredCredentialSheet implements OpenloopFixtureDesktopBridge {
  configured = false
  readonly calls: Array<{ method: string; payload: unknown }> = []
  private openedResolve!: () => void
  private readonly opened = new Promise<void>((resolve) => {
    this.openedResolve = resolve
  })
  private replacementResolve: ((result: 'saved') => void) | undefined

  async call<Result>(method: string, payload: unknown): Promise<Result> {
    this.calls.push({ method, payload })
    switch (method) {
      case 'describeCredential':
        return {
          configured: this.configured,
          writable: true,
        } as Result
      case 'openCredentialReplacement':
        this.openedResolve()
        return await new Promise<'saved'>((resolve) => {
          this.replacementResolve = resolve
        }) as Result
      case 'resolveCredential':
        return null as Result
      case 'getAppInfo':
        return { appVersion: '0.1.0', channel: 'test' } as Result
      default:
        throw new Error(`unexpected fake desktop bridge method ${method}`)
    }
  }

  whenOpened(): Promise<void> {
    return this.opened
  }

  completeSaved(): void {
    if (this.replacementResolve === undefined) {
      throw new Error('credential replacement sheet is not pending')
    }
    this.configured = true
    this.replacementResolve('saved')
    this.replacementResolve = undefined
  }
}

function legacyRequest(method: string, payload: unknown): Request {
  return new Request(`http://openloop.test/api/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      type: 'client-request',
      rpcId: `boundary-${method}`,
      method,
      payload,
    }),
  })
}

describe('web e2e: Openloop credential boundary', () => {
  let scaffold: WebScaffold
  let bridge: DeferredCredentialSheet
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>

  beforeAll(async () => {
    bridge = new DeferredCredentialSheet()
    scaffold = await launchWebScaffold({
      openloop: { desktopBridge: bridge },
    })
    browser = await chromium.launch()
    page = await browser.newPage({
      viewport: { width: 1440, height: 960 },
      locale: ZH_BROWSER_LOCALE,
    })
    tripwire = watchConsole(page)
    await page.goto(scaffold.baseUrl, { waitUntil: 'load' })
    await page.waitForSelector('#root', { timeout: 30_000 })
  }, 120_000)

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
  })

  it('removes every DSH credential owner from the Openloop browser surface', async () => {
    const entries = [...scaffold.ctx.loader.entries()]
    const entry = (id: string) => entries.find(candidate => candidate.options.id === id)
    for (const id of [
      'ui-settings',
      'ui-settings-models',
      'ui-settings-plugins',
    ]) {
      expect(entry(id)?.disabled, `${id} must stay disabled in the Openloop profile`).toBe(true)
    }
    for (const id of [
      'credentials-keychain',
      'connection',
      'api-gateway',
      'typert-gateway',
    ]) {
      expect(entry(id)?.fiber, `${id} must be active in the Openloop fixture`).toBeDefined()
    }
    expect(scaffold.ctx.get('browserApiPolicy')).toBeDefined()
    expect(scaffold.ctx.get('openloopCredentialOperations')).toBeDefined()
    expect(await page.locator('input[type="password"]').count()).toBe(0)
    expect(await page.getByRole('button', { name: '设置', exact: true }).count()).toBe(0)
    expect(await page.getByRole('dialog', { name: WELCOME_NOTICE_COPY.zh.title }).count()).toBe(0)
    expect(await page.getByRole('dialog', { name: '添加一个 API Key 开始使用' }).count()).toBe(0)

    const snapshot = await captureStableAria(page, '[class*="wordmark"]', scaffold.workspaceCwd)
    expect(snapshot).not.toContain('password')
    expect(snapshot).not.toContain('API 密钥')
    await compareOrRefreshGolden(UI_EXPECTED, snapshot, MODE)
    expect(tripwire.warnings).toEqual([])
    expect(tripwire.pageErrors).toEqual([])
  })

  it('keeps replacement pending until the native sheet reports saved', async () => {
    await expect(scaffold.ctx.typertGateway.invoke({
      namespace: 'openloopDesktop',
      method: 'describeCredential',
      args: { ref: REF },
    })).resolves.toEqual({ configured: false, writable: true })

    let replacementSettled = false
    const replacement = scaffold.ctx.typertGateway.invoke({
      namespace: 'openloopDesktop',
      method: 'openCredentialReplacement',
      args: { ref: REF },
    }).finally(() => {
      replacementSettled = true
    })
    await bridge.whenOpened()

    expect(replacementSettled).toBe(false)
    await expect(scaffold.ctx.typertGateway.invoke({
      namespace: 'openloopDesktop',
      method: 'describeCredential',
      args: { ref: REF },
    })).resolves.toEqual({ configured: false, writable: true })

    bridge.completeSaved()
    await expect(replacement).resolves.toBe('saved')
    await expect(scaffold.ctx.typertGateway.invoke({
      namespace: 'openloopDesktop',
      method: 'describeCredential',
      args: { ref: REF },
    })).resolves.toEqual({
      configured: true,
      source: 'keychain',
      writable: true,
    })
  })

  it('denies legacy credential handlers and Host-only Typert endpoints', async () => {
    const api = scaffold.ctx.apiProxy
    const set = vi.spyOn(api.credentials, 'set')
    const unset = vi.spyOn(api.credentials, 'unset')
    const dispatcher = toFetchHandler(
      api,
      scaffold.ctx.get('browserApiPolicy'),
    )
    for (const [method, payload] of [
      ['credentials.set', { ref: REF, value: 'must-not-be-read' }],
      ['credentials.unset', { ref: REF }],
      ['credentials.resolve', { ref: REF }],
    ] as const) {
      const response = await dispatcher.fetch(legacyRequest(method, payload))
      expect([method, response.status]).toEqual([method, 403])
    }
    expect(set).not.toHaveBeenCalled()
    expect(unset).not.toHaveBeenCalled()

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
      await browser.close()
      await scaffold.close()
    }
  }, 120_000)
})
