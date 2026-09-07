import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { expect, test, type Locator, type Page, type Route } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import {
  FixtureProcess,
  type FixtureReady,
} from './openloop-fixture-process.ts'

const SNAPSHOT_DIR = fileURLToPath(new URL(
  './snapshots/openloop-minimum-shell',
  import.meta.url,
))
const UI_EXPECTED = join(SNAPSHOT_DIR, 'ui.expected.md')
const OPENLOOP_MARK_DATA_URI = `data:image/svg+xml;base64,${
  readFileSync(fileURLToPath(new URL('../../../assets/brand/openloop-mark.svg', import.meta.url)))
    .toString('base64')
}`
const BOOTSTRAP_ROUTE = '**/api/openloop/bootstrap'
const COMPACT_VIEWPORT = { width: 760, height: 520 } as const

interface ElementBox {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

interface LockupGeometry {
  readonly lockup: ElementBox
  readonly mark: ElementBox
  readonly name: ElementBox
}

async function boxOf(locator: Locator, label: string): Promise<ElementBox> {
  const box = await locator.boundingBox()
  expect(box, `${label} must have a rendered box`).not.toBeNull()
  return box as ElementBox
}

function expectZeroTracking(value: string, label: string): void {
  // Chromium normalizes authored `letter-spacing: 0` to computed `normal`.
  expect(value, `${label} computed letter spacing`).toBe('normal')
}

async function lockupGeometry(
  lockup: Locator,
  mark: Locator,
  name: Locator,
  label: string,
): Promise<LockupGeometry> {
  return {
    lockup: await boxOf(lockup, `${label} lockup`),
    mark: await boxOf(mark, `${label} mark`),
    name: await boxOf(name, `${label} name`),
  }
}

function expectInside(
  child: ElementBox,
  parent: ElementBox,
  label: string,
): void {
  expect(child.x, `${label} left edge`).toBeGreaterThanOrEqual(parent.x)
  expect(child.y, `${label} top edge`).toBeGreaterThanOrEqual(parent.y)
  expect(child.x + child.width, `${label} right edge`)
    .toBeLessThanOrEqual(parent.x + parent.width)
  expect(child.y + child.height, `${label} bottom edge`)
    .toBeLessThanOrEqual(parent.y + parent.height)
}

function expectCentersAligned(
  mark: ElementBox,
  name: ElementBox,
  label: string,
): void {
  const delta = Math.abs(
    (mark.y + mark.height / 2) - (name.y + name.height / 2),
  )
  expect(delta, `${label} mark/name vertical center delta`).toBeLessThanOrEqual(1)
}

async function expectMarkMatchesNameInBothThemes(
  page: Page,
  mark: Locator,
  name: Locator,
  label: string,
): Promise<void> {
  const originalTheme = await page.evaluate(() => ({
    colorScheme: document.documentElement.style.colorScheme,
    dark: document.body.hasAttribute('data-ds-dark-theme'),
    labelPrimary: document.body.style.getPropertyValue('--dsw-alias-label-primary'),
  }))
  const markColors: string[] = []
  try {
    for (const theme of [
      { colorScheme: 'light', dark: false, labelPrimary: '#111316' },
      { colorScheme: 'dark', dark: true, labelPrimary: '#f7f8fa' },
    ] as const) {
      await page.evaluate((next) => {
        document.documentElement.style.colorScheme = next.colorScheme
        document.body.toggleAttribute('data-ds-dark-theme', next.dark)
        document.body.style.setProperty('--dsw-alias-label-primary', next.labelPrimary)
      }, theme)
      const [markColor, nameColor] = await Promise.all([
        mark.evaluate(element => getComputedStyle(element).backgroundColor),
        name.evaluate(element => getComputedStyle(element).color),
      ])
      expect(markColor, `${label} ${theme.colorScheme} mark color`)
        .toBe(nameColor)
      markColors.push(markColor)
    }
    expect(new Set(markColors).size, `${label} mark must respond to the theme`).toBe(2)
  } finally {
    await page.evaluate((theme) => {
      document.documentElement.style.colorScheme = theme.colorScheme
      document.body.toggleAttribute('data-ds-dark-theme', theme.dark)
      if (theme.labelPrimary === '') {
        document.body.style.removeProperty('--dsw-alias-label-primary')
      } else {
        document.body.style.setProperty('--dsw-alias-label-primary', theme.labelPrimary)
      }
    }, originalTheme)
  }
}

async function stableAria(page: Page, selector: string): Promise<string> {
  const region = page.locator(selector).first()
  let previous = await region.ariaSnapshot()
  await expect.poll(async () => {
    const current = await region.ariaSnapshot()
    const stable = current === previous
    previous = current
    return stable
  }).toBe(true)
  return previous
}

test.describe.serial('assembled minimum Openloop shell', () => {
  let fixture: FixtureProcess
  let ready: FixtureReady

  test.beforeAll(async () => {
    fixture = new FixtureProcess()
    ready = await fixture.ready
  })

  test.afterAll(async () => {
    await fixture?.close()
  })

  test('brands the complete shell and drives the native update boundary', async ({ page }) => {
    let bootstrapObserved = false
    let gateReleased = false
    let bootstrapHandlerCompletion = Promise.resolve()
    const bootstrapGate = Promise.withResolvers<undefined>()
    const releaseBootstrap = (): void => {
      if (gateReleased) return
      gateReleased = true
      bootstrapGate.resolve(undefined)
    }
    const bootstrapHandler = (route: Route): Promise<void> => {
      if (route.request().method() !== 'POST') return route.continue()
      bootstrapObserved = true
      bootstrapHandlerCompletion = (async () => {
        const response = await route.fetch()
        await bootstrapGate.promise
        await route.fulfill({ response })
      })()
      return bootstrapHandlerCompletion
    }
    await page.route(BOOTSTRAP_ROUTE, bootstrapHandler)
    try {
      await page.goto(ready.url, { waitUntil: 'domcontentloaded' })
      await expect.poll(
        () => bootstrapObserved,
        { message: 'the Host bootstrap request must reach the route gate' },
      ).toBe(true)

      const attribution = page.getByText('Built on DeepSeek Harness', { exact: true })
      await expect(attribution).toBeVisible()
      const launchCard = attribution.locator('..')
      const launchLockup = launchCard.locator('[data-product-lockup]')
      await expect(
        launchLockup,
        'the launch page must expose its ProductLockup while Host bootstrap is blocked',
      ).toBeVisible()
      const launchMark = launchLockup.locator('[data-product-mark]')
      const launchName = launchLockup.getByText('Openloop', { exact: true })
      await expect(launchMark, 'the first launch render must include the Openloop mark')
        .toBeVisible()
      await expect(launchName).toBeVisible()
      const prebootGeometry = await lockupGeometry(
        launchLockup,
        launchMark,
        launchName,
        'preboot launch',
      )
      const launchLockupElement = await launchLockup.elementHandle()
      expect(launchLockupElement, 'the launch lockup handle must remain addressable')
        .not.toBeNull()
      if (launchLockupElement === null) throw new Error('launch lockup handle is missing')
      const [launchGap, launchNameStyle, launchLetterSpacing] = await Promise.all([
        launchLockup.evaluate(element => getComputedStyle(element).gap),
        launchName.evaluate((element) => {
          const style = getComputedStyle(element)
          return {
            fontSize: style.fontSize,
            fontWeight: style.fontWeight,
            lineHeight: style.lineHeight,
          }
        }),
        launchName.evaluate(element => getComputedStyle(element).letterSpacing),
      ])
      expect(prebootGeometry.mark.width).toBe(25)
      expect(prebootGeometry.mark.height).toBe(25)
      expect(launchGap).toBe('9px')
      expect(launchNameStyle).toEqual({
        fontSize: '20px',
        fontWeight: '600',
        lineHeight: '25px',
      })
      expectZeroTracking(launchLetterSpacing, 'launch name')
      expectCentersAligned(prebootGeometry.mark, prebootGeometry.name, 'launch')

      const attributionStyle = await attribution.evaluate((element) => {
        const style = getComputedStyle(element)
        return {
          fontSize: style.fontSize,
          fontWeight: style.fontWeight,
          lineHeight: style.lineHeight,
        }
      })
      expect(attributionStyle).toEqual({
        fontSize: '13px',
        fontWeight: '400',
        lineHeight: '20px',
      })
      const spinnerSeat = launchCard.locator('[class*="spinnerSeat"]')
      const spinnerBox = await boxOf(spinnerSeat, 'launch spinner seat')
      expect(spinnerBox.width).toBe(26)
      expect(spinnerBox.height).toBe(26)
      await expectMarkMatchesNameInBothThemes(
        page,
        launchMark,
        launchName,
        'launch lockup',
      )

      const normalViewport = page.viewportSize()
      expect(normalViewport, 'the browser test must use a restorable viewport').not.toBeNull()
      await page.setViewportSize(COMPACT_VIEWPORT)
      try {
        const compactViewport = {
          x: 0,
          y: 0,
          width: COMPACT_VIEWPORT.width,
          height: COMPACT_VIEWPORT.height,
        }
        const compactCard = await boxOf(launchCard, 'compact launch content')
        const compactLockup = await boxOf(launchLockup, 'compact launch lockup')
        const compactMark = await boxOf(launchMark, 'compact launch mark')
        const compactName = await boxOf(launchName, 'compact launch name')
        const compactAttribution = await boxOf(attribution, 'compact launch attribution')
        const compactSpinner = await boxOf(spinnerSeat, 'compact launch spinner seat')
        expectInside(compactCard, compactViewport, 'launch content in compact viewport')
        expectInside(compactLockup, compactCard, 'launch lockup in launch content')
        expectInside(compactMark, compactLockup, 'launch mark in lockup')
        expectInside(compactName, compactLockup, 'launch name in lockup')
        expectInside(compactAttribution, compactCard, 'launch attribution in launch content')
        expectInside(compactSpinner, compactCard, 'launch spinner in launch content')
      } finally {
        if (normalViewport !== null) await page.setViewportSize(normalViewport)
      }

      const prebootMarkImage = await launchMark.evaluate(element =>
        (element as HTMLElement).style.getPropertyValue('--dsh-product-mark-image'))
      expect(prebootMarkImage, 'the preboot mark source must be an inline SVG data URI')
        .toMatch(/^url\("data:image\/svg\+xml(?:;base64)?,/u)
      expect(prebootMarkImage, 'the preboot mark source must differ from the trusted Host mark')
        .not.toBe(`url("${OPENLOOP_MARK_DATA_URI}")`)

      releaseBootstrap()
      await expect.poll(async () => {
        return await launchLockupElement.evaluate((element) => {
          const mark = element.querySelector<HTMLElement>('[data-product-mark]')
          const name = element.querySelector<HTMLElement>('[data-product-lockup-name]')
          if (mark === null || name === null) return null
          const box = (target: Element): ElementBox => {
            const rect = target.getBoundingClientRect()
            return {
              x: rect.x,
              y: rect.y,
              width: rect.width,
              height: rect.height,
            }
          }
          return {
            markImage: mark.style.getPropertyValue('--dsh-product-mark-image'),
            geometry: {
              lockup: box(element),
              mark: box(mark),
              name: box(name),
            },
          }
        })
      }, {
        message: 'the trusted Host mark must commit without changing launch geometry',
        intervals: [0, 5, 10],
      }).toEqual({
        markImage: `url("${OPENLOOP_MARK_DATA_URI}")`,
        geometry: prebootGeometry,
      })

      await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
      await expect(page).toHaveTitle('Openloop')
      const brandButton = page.getByRole('button', { name: 'New session', exact: true }).first()
      await expect(brandButton).toContainText('Openloop')
      await expect(page.getByRole('main')).toContainText(/Openloop\s*预览版/u)
      const welcome = page.getByRole('dialog', { name: 'Internal Testing Notice' })
      if (await welcome.count() > 0) {
        await welcome.getByRole('button', { name: 'Continue' }).click()
      }
      const credentialOnboarding = page.getByRole('dialog', { name: 'Add an API key to get started' })
      if (await credentialOnboarding.count() > 0) {
        await credentialOnboarding.getByRole('button', { name: 'Configure later' }).click()
      }
      await expect(page.getByRole('button', { name: 'Settings', exact: true })).toBeVisible()

      const sidebarLockup = brandButton.locator('[data-product-lockup]')
      const sidebarMark = sidebarLockup.locator('[data-product-mark]')
      const sidebarName = sidebarLockup.getByText('Openloop', { exact: true })
      await expect(sidebarLockup, 'the expanded sidebar must expose its ProductLockup')
        .toBeVisible()
      await expect(sidebarMark).toBeVisible()
      await expect(sidebarName).toBeVisible()
      const sidebarGeometry = await lockupGeometry(
        sidebarLockup,
        sidebarMark,
        sidebarName,
        'sidebar',
      )
      const [sidebarGap, sidebarNameStyle, sidebarLetterSpacing] = await Promise.all([
        sidebarLockup.evaluate(element => getComputedStyle(element).gap),
        sidebarName.evaluate((element) => {
          const style = getComputedStyle(element)
          return {
            fontSize: style.fontSize,
            fontWeight: style.fontWeight,
            lineHeight: style.lineHeight,
          }
        }),
        sidebarName.evaluate(element => getComputedStyle(element).letterSpacing),
      ])
      expect(sidebarGeometry.mark.width).toBe(20)
      expect(sidebarGeometry.mark.height).toBe(20)
      expect(sidebarGap).toBe('7px')
      expect(sidebarNameStyle).toEqual({
        fontSize: '16px',
        fontWeight: '600',
        lineHeight: '20px',
      })
      expectZeroTracking(sidebarLetterSpacing, 'sidebar name')
      expectCentersAligned(sidebarGeometry.mark, sidebarGeometry.name, 'sidebar')
      const sidebarLogoRow = brandButton.locator('..')
      expect((await boxOf(sidebarLogoRow, 'sidebar logo row')).height).toBe(44)
      const sidebarRoot = sidebarLogoRow.locator('..')
      const sidebarRootBox = await boxOf(sidebarRoot, 'sidebar root')
      expect(sidebarGeometry.mark.x - sidebarRootBox.x, 'sidebar total left inset')
        .toBe(14)
      await expectMarkMatchesNameInBothThemes(
        page,
        sidebarMark,
        sidebarName,
        'sidebar lockup',
      )

      const normalSidebarViewport = page.viewportSize()
      expect(normalSidebarViewport, 'the browser test must use a restorable viewport')
        .not.toBeNull()
      await page.setViewportSize(COMPACT_VIEWPORT)
      try {
        const compactSidebarViewport = {
          x: 0,
          y: 0,
          width: COMPACT_VIEWPORT.width,
          height: COMPACT_VIEWPORT.height,
        }
        const compactSidebarLockup = await boxOf(sidebarLockup, 'compact sidebar lockup')
        const compactSidebarMark = await boxOf(sidebarMark, 'compact sidebar mark')
        const compactSidebarName = await boxOf(sidebarName, 'compact sidebar name')
        const compactBrandButton = await boxOf(brandButton, 'compact sidebar lockup parent')
        expectInside(
          compactSidebarLockup,
          compactSidebarViewport,
          'sidebar lockup in compact viewport',
        )
        expectInside(
          compactSidebarName,
          compactSidebarViewport,
          'sidebar name in compact viewport',
        )
        expectInside(
          compactSidebarLockup,
          compactBrandButton,
          'sidebar lockup in its compact parent',
        )
        expectInside(compactSidebarMark, compactSidebarLockup, 'sidebar mark in lockup')
        expectInside(compactSidebarName, compactSidebarLockup, 'sidebar name in lockup')
      } finally {
        if (normalSidebarViewport !== null) {
          await page.setViewportSize(normalSidebarViewport)
        }
      }

      const marks = page.locator('[data-product-mark]')
      await expect(marks).toHaveCount(2)
      for (const mark of await marks.all()) {
        expect(await mark.evaluate(element =>
          (element as HTMLElement).style.getPropertyValue('--dsh-product-mark-image')))
          .toBe(`url("${OPENLOOP_MARK_DATA_URI}")`)
        const box = await mark.boundingBox()
        expect(box?.width).toBeGreaterThan(0)
        expect(box?.height).toBeGreaterThan(0)
      }
      await page.getByRole('button', { name: 'Collapse sidebar', exact: true }).click()
      const collapsedToggle = page.getByRole('button', { name: 'Open sidebar', exact: true })
      await expect(collapsedToggle).toBeVisible()
      const collapsedMark = collapsedToggle.locator('[data-product-mark]')
      await expect(collapsedMark).toBeVisible()
      await expect.poll(
        async () => await collapsedToggle.evaluate(element => getComputedStyle(element).transform),
        { message: 'the collapsed rail entry animation must settle before geometry is measured' },
      ).toBe('none')
      const collapsedBox = await boxOf(collapsedMark, 'collapsed sidebar mark')
      expect(collapsedBox.width).toBe(24)
      expect(collapsedBox.height).toBe(24)
      const collapsedLogoRow = collapsedToggle.locator('..')
      const collapsedSidebarRoot = collapsedLogoRow.locator('..')
      await expect(collapsedSidebarRoot.locator('[data-product-lockup-name]')).toHaveCount(0)
      await expect(
        collapsedLogoRow.getByRole('button', { name: 'New session', exact: true }),
        'the expanded brand button must unmount after collapse settles',
      ).toHaveCount(0)
      await expect(
        collapsedLogoRow.locator('[data-product-lockup]'),
        'the expanded ProductLockup must unmount after collapse settles',
      ).toHaveCount(0)
      await collapsedToggle.click()
      await expect(page.getByRole('button', { name: 'Collapse sidebar', exact: true })).toBeVisible()

      const activeRows = new Set(ready.activeRows)
      expect(activeRows.has('ui-trajectory'), 'ui-trajectory must remain active').toBe(true)
      expect(activeRows.has('ui-conversation'), 'the details shell owner must remain active')
        .toBe(true)
      expect(activeRows.has('ui-tool'), 'the tool details renderer must remain active').toBe(true)
      for (const id of [
        'approval',
        'desktop-bridge-client',
        'openloop-settings-foundation',
        'openloop-settings-host',
        'openloop-workspace-client',
        'shell',
        'ui-settings-general',
        'ui-settings-models',
        'ui-settings-plugins',
        'ui-model-selection',
        'ui-plan',
        'ui-user-questions',
      ]) {
        expect(activeRows.has(id), `${id} must remain active`).toBe(true)
      }

      await expect.poll(async () => {
        const calls = await fixture.command('calls') as Array<{ readonly method: string }>
        return calls.filter(call => call.method === 'getUpdateStatus').length
      }).toBeGreaterThan(0)
      await page.getByRole('button', { name: 'Settings', exact: true }).click()
      const settings = page.getByRole('dialog', { name: 'Settings', exact: true })
      expect(await settings.getByRole('tab').allTextContents()).toEqual([
        'General',
        'Models & Credentials',
        'Plugins',
        'About & Updates',
      ])
      await expect(settings.getByRole('tab', { name: 'Workspace', exact: true })).toHaveCount(0)
      for (const [id, name] of [
        ['general', 'General'],
        ['models', 'Models & Credentials'],
        ['plugins', 'Plugins'],
      ] as const) {
        await settings.getByRole('tab', { name, exact: true }).click()
        const panel = settings.locator(`#openloop-settings-panel-${id}`)
        await expect(panel).toBeVisible()
        await expect(panel)
          .not.toContainText('This section is unavailable in this build.')
      }
      await settings.getByRole('tab', { name: 'About & Updates', exact: true }).click()

      await expect(settings.getByText('0.1.0', { exact: true })).toBeVisible()
      await expect(settings.getByText('Ready to check', { exact: true })).toBeVisible()

      await fixture.command('enqueue-check', {
        state: 'available',
        updateId: 'fixture-update-id',
        version: '0.2.0',
        releaseNotes: '<strong>Security fixes</strong> with deterministic notes.',
        lastCheckedAt: Date.UTC(2026, 8, 1, 8),
      })
      await settings.getByRole('button', { name: 'Check for updates' }).click()
      await expect(settings.getByText('Update available', { exact: true })).toBeVisible()
      await expect(settings.getByText('0.2.0', { exact: true })).toBeVisible()
      await expect(settings.getByText(
        '<strong>Security fixes</strong> with deterministic notes.',
        { exact: true },
      )).toBeVisible()
      expect(await settings.locator('strong').count()).toBe(0)

      await fixture.command('enqueue-install', 'cancelled')
      await settings.getByRole('button', { name: 'Install and restart' }).click()
      await expect(settings.getByText('Update available', { exact: true })).toBeVisible()
      const calls = await fixture.command('calls') as Array<{
        readonly method: string
        readonly payload: unknown
      }>
      expect(calls.filter(call => call.method === 'installUpdateAndRestart').at(-1))
        .toEqual({
          method: 'installUpdateAndRestart',
          payload: { updateId: 'fixture-update-id' },
        })

      await fixture.command('enqueue-check', {
        error: 'Deterministic update service failure',
      })
      await settings.getByRole('button', { name: 'Check for updates' }).click()
      await expect(settings.getByRole('alert')).toContainText(
        'Deterministic update service failure',
      )

      const snapshot = `${await stableAria(page, 'body')}\n`
      if (process.env.DSH_SNAPSHOT === 'refresh') {
        await mkdir(SNAPSHOT_DIR, { recursive: true })
        await writeFile(UI_EXPECTED, snapshot)
      } else {
        expect(snapshot).toBe(await readFile(UI_EXPECTED, 'utf8'))
      }
      await settings.getByRole('button', { name: 'Close Settings' }).click()
      await expect(page.getByRole('button', { name: 'Add Workspace' })).toBeVisible()
      expect(await readdir(SNAPSHOT_DIR)).toEqual(['ui.expected.md'])
    } finally {
      releaseBootstrap()
      await bootstrapHandlerCompletion
      await page.unroute(BOOTSTRAP_ROUTE, bootstrapHandler)
    }
  })
})
