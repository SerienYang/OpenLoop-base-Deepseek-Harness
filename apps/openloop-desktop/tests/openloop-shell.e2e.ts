import { deepStrictEqual, ok, strictEqual } from 'node:assert'
import { spawn } from 'node:child_process'
import { cp, mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import * as wdio from '@wdio/globals'
import { remote } from 'webdriverio'

declare function describe(title: string, suite: () => void): void
declare function it(title: string, test: () => Promise<void>): void

interface DesktopElement {
  click(): Promise<void>
  getAttribute(name: string): Promise<string | null>
  getText(): Promise<string>
  isExisting(): Promise<boolean>
}

interface DesktopBrowser {
  $(selector: string): Promise<DesktopElement>
  closeWindow(): Promise<void>
  execute<T, A extends unknown[]>(
    script: (...args: A) => T | Promise<T>,
    ...args: A
  ): Promise<T>
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

interface PersistedSettings {
  readonly locale: string
  readonly theme: string
  readonly busyEnter: string
  readonly maxTokens: number
  readonly maxUses: number
}

const PERSISTED_SETTINGS: PersistedSettings = {
  locale: 'zh',
  theme: 'dark',
  busyEnter: 'queue',
  maxTokens: 32_001,
  maxUses: 7,
}

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

async function writePersistenceFixture(
  browser: DesktopBrowser,
  values: PersistedSettings,
): Promise<void> {
  const result = await browser.execute(async (next) => {
    const describe = await fetch('/api/openloop/settings/describe', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        namespaces: [
          'locale',
          'ui-theme',
          'ui-conversation',
          'llm-deepseek',
          'web-search-deepseek',
        ],
      }),
    }).then(response => response.json()) as {
      ok: boolean
      value?: { namespaces?: Array<{ ns: string; revision: number }> }
    }
    if (!describe.ok || describe.value?.namespaces === undefined) return false
    const revisions = new Map(describe.value.namespaces.map(item => [item.ns, item.revision]))
    const mutations = [
      ['locale', 'preference', next.locale],
      ['ui-theme', 'preference', next.theme],
      ['ui-conversation', 'busyEnter', next.busyEnter],
      ['llm-deepseek', 'maxTokens', next.maxTokens],
      ['web-search-deepseek', 'maxUses', next.maxUses],
    ] as const
    for (const [ns, field, value] of mutations) {
      const expectedRevision = revisions.get(ns)
      if (expectedRevision === undefined) return false
      const response = await fetch('/api/openloop/settings/mutate', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          ns,
          ops: [{ op: 'set', path: [field], value }],
          expectedRevision,
        }),
      }).then(item => item.json()) as { ok: boolean }
      if (!response.ok) return false
    }
    return true
  }, values)
  strictEqual(result, true)
}

async function readPersistenceFixture(browser: DesktopBrowser): Promise<PersistedSettings> {
  return await browser.execute(async () => {
    const response = await fetch('/api/openloop/settings/describe', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        namespaces: [
          'locale',
          'ui-theme',
          'ui-conversation',
          'llm-deepseek',
          'web-search-deepseek',
        ],
      }),
    }).then(item => item.json()) as {
      value: {
        namespaces: Array<{ ns: string; value: Record<string, unknown> }>
      }
    }
    const values = new Map(response.value.namespaces.map(item => [item.ns, item.value]))
    return {
      locale: values.get('locale')?.preference as string,
      theme: values.get('ui-theme')?.preference as string,
      busyEnter: values.get('ui-conversation')?.busyEnter as string,
      maxTokens: values.get('llm-deepseek')?.maxTokens as number,
      maxUses: values.get('web-search-deepseek')?.maxUses as number,
    }
  })
}

async function waitForEmbeddedDriver(port: number, ready: boolean): Promise<void> {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${String(port)}/status`)
      const body = await response.json() as { value?: { ready?: boolean } }
      if ((body.value?.ready === true) === ready) return
    } catch {
      if (!ready) return
    }
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error(`embedded WebDriver did not become ${ready ? 'ready' : 'stopped'}`)
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
    const resized = await desktop.getWindowSize()
    strictEqual(resized.width, 920)
    ok(resized.height <= 700)
    ok(resized.height >= 636)
    await desktop.maximizeWindow()
    const maximized = await desktop.getWindowSize()
    ok(maximized.width >= resized.width)
    ok(maximized.height >= resized.height)
    ok(maximized.width > resized.width || maximized.height > resized.height)

    await (await element('[aria-haspopup="dialog"]')).click()
    await expectAppKitEvent('credential-replacement:main')
    for (const id of ['general', 'models', 'plugins', 'about-update']) {
      strictEqual(await (await element(`#openloop-settings-tab-${id}`)).isExisting(), true)
    }
    strictEqual(await (await element('#openloop-settings-tab-workspace')).isExisting(), false)
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

    await (await element(
      '//*[@role="dialog"]//button[contains(@aria-label, "Close Settings") or contains(@aria-label, "关闭设置")]',
    )).click()
    await (await element(
      '//button[@aria-label="Add Workspace" or @aria-label="添加 Workspace"]',
    )).click()
    await expectAppKitEvent('workspace-picker:main')
    strictEqual((await desktop.getWindowHandles()).length, 1)
    deepStrictEqual(await appKitEvents(), [
      'credential-replacement:main',
      'update-install:main',
      'workspace-picker:main',
    ])

    await writePersistenceFixture(desktop, PERSISTED_SETTINGS)
    const binary = process.env.OPENLOOP_WDIO_BINARY
    const e2eRoot = process.env.OPENLOOP_E2E_ROOT
    if (binary === undefined || e2eRoot === undefined) {
      throw new Error('Openloop restart E2E paths are required')
    }
    const sourceDshHome = process.env.DSH_HOME
    if (sourceDshHome === undefined) throw new Error('Openloop DSH_HOME is required')
    const restartRoot = join(e2eRoot, 'restart', 'Openloop-Test')
    const restartDshHome = join(restartRoot, 'dsh')
    await mkdir(restartRoot, { recursive: true, mode: 0o700 })
    await cp(sourceDshHome, restartDshHome, { recursive: true })
    const child = spawn(binary, ['-ApplePersistenceIgnoreState', 'YES'], {
      env: {
        ...process.env,
        DSH_HOME: restartDshHome,
        TAURI_WEBDRIVER_PORT: '4446',
        OPENLOOP_E2E_RUN_ID: `${process.env.OPENLOOP_E2E_RUN_ID ?? 'wdio'}-restart`,
        OPENLOOP_E2E_RUNTIME_AUDIT: join(e2eRoot, 'runtime-process-restart.json'),
      },
      stdio: 'ignore',
    })
    let restarted: DesktopBrowser | undefined
    try {
      await waitForEmbeddedDriver(4446, true)
      restarted = await remote({
        hostname: '127.0.0.1',
        port: 4446,
        path: '/',
        capabilities: {
          browserName: 'tauri',
          'tauri:options': { application: binary },
        } as never,
      }) as unknown as DesktopBrowser
      await restarted.waitUntil(async () => (await restarted!.getTitle()) === 'Openloop', {
        timeout: 30_000,
      })
      deepStrictEqual(await readPersistenceFixture(restarted), PERSISTED_SETTINGS)
      await (await restarted.$('[aria-haspopup="dialog"]')).click()
      strictEqual(
        await (await restarted.$('#openloop-settings-tab-general')).getText(),
        '通用',
      )
      strictEqual(
        await (await restarted.$('//*[@role="tabpanel"]//button[normalize-space()="深色"]'))
          .getAttribute('aria-pressed'),
        'true',
      )
      await restarted.closeWindow()
      await waitForEmbeddedDriver(4446, false)
    } finally {
      child.kill('SIGKILL')
    }
    await desktop.closeWindow()
  })
})
