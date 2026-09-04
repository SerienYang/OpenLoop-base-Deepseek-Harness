import { createInterface } from 'node:readline'
import { readFileSync } from 'node:fs'
import {
  launchWebScaffold,
  type WebScaffold,
} from './scaffold.ts'
import {
  AuthenticatedUnixBridgeServer,
  type FixtureUpdateStatus,
} from './openloop-bridge-server.ts'
import {
  cleanupFixtureWorld,
  startFixtureWorld,
} from './openloop-fixture-lifecycle.ts'

const LAUNCH_ID = '8df91e3f-5a18-4ef5-b96c-59ecbde7f3f2'
const BOOTSTRAP_TOKEN = Uint8Array.from({ length: 32 }, (_, index) => index + 17)
const BRIDGE_SECRET = Uint8Array.from({ length: 32 }, (_, index) => index + 81)
const CORE_MANIFEST_SHA256 = 'c'.repeat(64)
const OPENLOOP_MARK_DATA_URI = `data:image/svg+xml;base64,${
  readFileSync(new URL('../../../assets/brand/openloop-mark.svg', import.meta.url))
    .toString('base64')
}`
const CORE_MANIFEST = {
  appVersion: '0.1.0',
  channel: 'test',
  dshTag: 'dsh-v0.1.0-rc.7',
  dshCommit: '99f6f02fecdb7dff40c3fbc9470f5907c29f74ca',
  brand: {
    productName: 'Openloop',
    documentSuffix: 'Openloop',
    markAsset: OPENLOOP_MARK_DATA_URI,
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

interface FixtureCommand {
  readonly id: number
  readonly command:
    | 'enqueue-check'
    | 'enqueue-install'
    | 'calls'
  readonly value?: unknown
}

let scaffold: WebScaffold | undefined
let bridge: AuthenticatedUnixBridgeServer | undefined
let closePromise: Promise<0 | 1> | undefined

function write(value: unknown): void {
  process.stdout.write(`OPENLOOP_FIXTURE:${JSON.stringify(value)}\n`)
}

function updateStatus(value: unknown): FixtureUpdateStatus {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('update status must be an object')
  }
  return value as FixtureUpdateStatus
}

function close(): Promise<0 | 1> {
  closePromise ??= cleanupFixtureWorld({ scaffold, bridge })
  return closePromise
}

async function main(): Promise<void> {
  const world = await startFixtureWorld({
    startBridge: async () => await AuthenticatedUnixBridgeServer.start({
      launchId: LAUNCH_ID,
      secret: BRIDGE_SECRET,
    }),
    launchScaffold: async (startedBridge) => {
      startedBridge.setUpdateStatus({ state: 'idle' })
      return await launchWebScaffold({
        openloop: {
          launchId: LAUNCH_ID,
          bootstrapToken: BOOTSTRAP_TOKEN,
          bridgeSecret: BRIDGE_SECRET,
          socketPath: startedBridge.socketPath,
          coreManifest: CORE_MANIFEST,
          coreManifestSha256: CORE_MANIFEST_SHA256,
        },
      })
    },
  })
  bridge = world.bridge
  scaffold = world.scaffold
  const activeRows = [...scaffold.ctx.loader.entries()]
    .filter(entry => entry.fiber !== undefined && !entry.disabled)
    .map(entry => entry.options.id)
  write({
    ready: true,
    url: `${scaffold.baseUrl}/#bootstrap=${Buffer.from(BOOTSTRAP_TOKEN).toString('hex')}&launch=${LAUNCH_ID}`,
    workspaceCwd: scaffold.workspaceCwd,
    activeRows,
  })

  createInterface({ input: process.stdin }).on('line', (line) => {
    let input: FixtureCommand
    try {
      input = JSON.parse(line) as FixtureCommand
      switch (input.command) {
        case 'enqueue-check': {
          const value = input.value as { readonly error?: unknown }
          if (typeof value?.error === 'string') {
            bridge?.enqueueUpdateCheck(new Error(value.error))
          } else {
            bridge?.enqueueUpdateCheck(updateStatus(input.value))
          }
          write({ id: input.id, ok: true })
          break
        }
        case 'enqueue-install':
          if (input.value !== 'cancelled' && input.value !== 'restarting') {
            throw new TypeError('update install outcome is invalid')
          }
          bridge?.enqueueUpdateInstall(input.value)
          write({ id: input.id, ok: true })
          break
        case 'calls':
          write({ id: input.id, ok: true, value: bridge?.calls ?? [] })
          break
      }
    } catch (error) {
      write({
        id: typeof input! === 'object' ? input.id : -1,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  })
}

async function exitAfterCleanup(): Promise<void> {
  process.exit(await close())
}

process.once('SIGTERM', () => { void exitAfterCleanup() })
process.once('SIGINT', () => { void exitAfterCleanup() })

main().catch(async (error: unknown) => {
  console.error(error)
  await close()
  process.exit(1)
})
