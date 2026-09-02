import { deepStrictEqual, ok, strictEqual } from 'node:assert'
import { readFile } from 'node:fs/promises'
import * as wdio from '@wdio/globals'

declare function describe(title: string, suite: () => void): void
declare function it(title: string, test: () => Promise<void>): void

interface DesktopElement {
  click(): Promise<void>
  getText(): Promise<string>
}

interface DesktopBrowser {
  $(selector: string): Promise<DesktopElement>
  getTitle(): Promise<string>
  getWindowHandle(): Promise<string>
  getWindowHandles(): Promise<string[]>
  getWindowSize(): Promise<{ width: number; height: number }>
  maximizeWindow(): Promise<void>
  setWindowSize(width: number, height: number): Promise<void>
  switchToWindow(handle: string): Promise<void>
  waitUntil(
    condition: () => Promise<boolean>,
    options?: { readonly timeout?: number },
  ): Promise<boolean>
}

const desktop = wdio.browser as unknown as DesktopBrowser

async function element(selector: string): Promise<DesktopElement> {
  return await desktop.$(selector)
}

async function expectText(selector: string, expected: string): Promise<void> {
  await desktop.waitUntil(async () => (
    await (await element(selector)).getText()
  ) === expected, { timeout: 15_000 })
}

async function expectTextContaining(selector: string, expected: string): Promise<void> {
  await desktop.waitUntil(async () => (
    await (await element(selector)).getText()
  ).includes(expected), { timeout: 30_000 })
}

async function appKitEvents(): Promise<string[]> {
  const path = process.env.OPENLOOP_E2E_APPKIT_AUDIT
  if (path === undefined) throw new Error('OPENLOOP_E2E_APPKIT_AUDIT is required')
  try {
    return (await readFile(path, 'utf8')).trim().split('\n').filter(Boolean)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
}

async function expectAppKitEvent(event: string): Promise<void> {
  await desktop.waitUntil(async () => (await appKitEvents()).includes(event), {
    timeout: 15_000,
  })
}

describe('Openloop desktop shell', () => {
  it('drives the real runtime, bridge, shell, and AppKit sheets', async () => {
    await desktop.switchToWindow(await desktop.getWindowHandle())
    await desktop.waitUntil(async () => (await desktop.getTitle()) === 'Openloop', {
      timeout: 30_000,
    })
    strictEqual(await desktop.getTitle(), 'Openloop')
    await expectTextContaining('main', 'Openloop')

    await desktop.setWindowSize(920, 700)
    deepStrictEqual(await desktop.getWindowSize(), { width: 920, height: 700 })
    await desktop.maximizeWindow()
    const maximized = await desktop.getWindowSize()
    ok(maximized.width >= 920)
    ok(maximized.height >= 700)
    ok(maximized.width > 920 || maximized.height > 700)

    await (await element('[aria-haspopup="dialog"]')).click()
    await expectAppKitEvent('credential-replacement:main')
    await (await element('#openloop-settings-tab-about-update')).click()
    await expectText(
      '//*[@role="tabpanel"]//*[normalize-space()="0.1.0"]',
      '0.1.0',
    )
    await (await element(
      '//*[@role="tabpanel"]//button[contains(., "Check for updates") or contains(., "检查更新")]',
    )).click()
    await expectText(
      '//*[@role="tabpanel"]//*[normalize-space()="0.2.0"]',
      '0.2.0',
    )
    await (await element(
      '//*[@role="tabpanel"]//button[contains(., "Install and restart") or contains(., "安装并重启")]',
    )).click()
    await expectAppKitEvent('update-install:main')
    await desktop.waitUntil(async () => {
      const status = await (await element('//*[@role="tabpanel"]//*[@role="status"]')).getText()
      return status === 'Update available' || status === '有可用更新'
    }, { timeout: 15_000 })

    await (await element('#openloop-settings-tab-workspace')).click()
    await (await element(
      '//*[@role="tabpanel"]//button[contains(., "Add Workspace") or contains(., "添加 Workspace")]',
    )).click()
    await expectAppKitEvent('workspace-picker:main')
    strictEqual((await desktop.getWindowHandles()).length, 1)
    deepStrictEqual(await appKitEvents(), [
      'credential-replacement:main',
      'update-install:main',
      'workspace-picker:main',
    ])
  })
})
