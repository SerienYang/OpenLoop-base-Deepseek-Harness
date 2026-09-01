import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { expect, test, type Page } from '@playwright/test'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'

const SNAPSHOT_DIR = fileURLToPath(new URL(
  './snapshots/openloop-minimum-shell',
  import.meta.url,
))
const UI_EXPECTED = join(SNAPSHOT_DIR, 'ui.expected.md')

interface FixtureReady {
  readonly ready: true
  readonly url: string
  readonly workspaceCwd: string
  readonly activeRows: string[]
}

interface FixtureResponse {
  readonly id: number
  readonly ok: boolean
  readonly value?: unknown
  readonly error?: string
}

class FixtureProcess {
  readonly child: ChildProcessWithoutNullStreams
  readonly ready: Promise<FixtureReady>
  readonly #pending = new Map<number, {
    readonly resolve: (value: unknown) => void
    readonly reject: (reason: unknown) => void
  }>()
  #sequence = 0

  constructor() {
    this.child = spawn(
      'pnpm',
      ['exec', 'tsx', 'apps/web/tests/openloop-minimum-shell-server.ts'],
      {
        cwd: fileURLToPath(new URL('../../..', import.meta.url)),
        env: { ...process.env, DSH_SNAPSHOT: 'replay' },
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    )
    this.ready = new Promise<FixtureReady>((resolve, reject) => {
      this.child.once('error', reject)
      this.child.once('exit', (code) => {
        reject(new Error(`Openloop fixture exited before ready (${String(code)})`))
      })
      createInterface({ input: this.child.stdout }).on('line', (line) => {
        if (!line.startsWith('OPENLOOP_FIXTURE:')) return
        const message = JSON.parse(line.slice('OPENLOOP_FIXTURE:'.length)) as
          FixtureReady | FixtureResponse
        if ('ready' in message) {
          resolve(message)
          return
        }
        const pending = this.#pending.get(message.id)
        if (pending === undefined) return
        this.#pending.delete(message.id)
        if (message.ok) pending.resolve(message.value)
        else pending.reject(new Error(message.error ?? 'fixture command failed'))
      })
    })
  }

  command(command: string, value?: unknown): Promise<unknown> {
    const id = ++this.#sequence
    const result = new Promise<unknown>((resolve, reject) => {
      this.#pending.set(id, { resolve, reject })
    })
    this.child.stdin.write(`${JSON.stringify({ id, command, value })}\n`)
    return result
  }

  async close(): Promise<void> {
    if (this.child.exitCode !== null) return
    const exited = new Promise<void>((resolve) => {
      this.child.once('exit', () => { resolve() })
    })
    this.child.kill('SIGTERM')
    await exited
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
    await page.goto(ready.url, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    await expect(page).toHaveTitle('Openloop')
    await expect(page.getByRole('button', { name: 'New session', exact: true }).first())
      .toContainText('Openloop')
    await expect(page.getByRole('main')).toContainText(/Openloop\s*预览版/u)
    await expect(page.getByRole('button', { name: 'Settings', exact: true })).toBeVisible()

    const activeRows = new Set(ready.activeRows)
    for (const id of [
      'approval',
      'desktop-bridge-client',
      'openloop-settings-foundation',
      'openloop-workspace-client',
      'shell',
      'ui-conversation',
      'ui-model-selection',
      'ui-plan',
      'ui-tool',
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
    expect(await readdir(SNAPSHOT_DIR)).toEqual(['ui.expected.md'])
  })
})
