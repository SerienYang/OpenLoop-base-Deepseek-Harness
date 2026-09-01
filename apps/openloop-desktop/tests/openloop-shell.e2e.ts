import { deepStrictEqual, ok, strictEqual } from 'node:assert'
import * as wdio from '@wdio/globals'

declare function describe(title: string, suite: () => void): void
declare function it(title: string, test: () => Promise<void>): void

interface DesktopElement {
  click(): Promise<void>
  getText(): Promise<string>
  isDisplayed(): Promise<boolean>
}

interface DesktopBrowser {
  $(selector: string): Promise<DesktopElement>
  getTitle(): Promise<string>
  getWindowHandles(): Promise<string[]>
  getWindowSize(): Promise<{ width: number; height: number }>
  maximizeWindow(): Promise<void>
  setWindowSize(width: number, height: number): Promise<void>
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

describe('Openloop desktop shell', () => {
  it('drives the native shell without leaving the main window', async () => {
    strictEqual(await desktop.getTitle(), 'Openloop')
    await expectText('#build-version', '0.1.0')

    const initial = await desktop.getWindowSize()
    await desktop.setWindowSize(920, 700)
    deepStrictEqual(await desktop.getWindowSize(), { width: 920, height: 700 })
    await desktop.maximizeWindow()
    const maximized = await desktop.getWindowSize()
    ok(maximized.width >= initial.width)
    ok(maximized.height >= initial.height)

    await (await element('[data-e2e="check-update"]')).click()
    await expectText('[data-e2e="update-version"]', '0.2.0')
    await expectText('[data-e2e="update-status"]', 'Update available')
    await (await element('[data-e2e="install-update"]')).click()
    await expectText('[data-e2e="update-status"]', 'Installation cancelled')

    await (await element('[data-e2e="replace-credential"]')).click()
    ok(await (await element('[role="dialog"][aria-label="Replace credential"]')).isDisplayed())
    strictEqual((await desktop.getWindowHandles()).length, 1)
    await (await element('[data-e2e="cancel-credential"]')).click()

    await (await element('[data-e2e="add-workspace"]')).click()
    await expectText('[data-e2e="workspace-entry"]', 'Fixture Workspace')
    strictEqual((await desktop.getWindowHandles()).length, 1)
  })
})
