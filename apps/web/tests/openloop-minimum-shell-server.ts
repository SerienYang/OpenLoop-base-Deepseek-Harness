import { createInterface } from 'node:readline'
import {
  launchWebScaffold,
  type WebScaffold,
} from './scaffold.ts'
import {
  AuthenticatedUnixBridgeServer,
  type FixtureUpdateStatus,
} from './openloop-bridge-server.ts'

const LAUNCH_ID = '8df91e3f-5a18-4ef5-b96c-59ecbde7f3f2'
const BOOTSTRAP_TOKEN = Uint8Array.from({ length: 32 }, (_, index) => index + 17)
const BRIDGE_SECRET = Uint8Array.from({ length: 32 }, (_, index) => index + 81)
const CORE_MANIFEST_SHA256 = 'c'.repeat(64)
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
let closing = false

function write(value: unknown): void {
  process.stdout.write(`OPENLOOP_FIXTURE:${JSON.stringify(value)}\n`)
}

function updateStatus(value: unknown): FixtureUpdateStatus {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('update status must be an object')
  }
  return value as FixtureUpdateStatus
}

async function close(): Promise<void> {
  if (closing) return
  closing = true
  const failures: unknown[] = []
  await scaffold?.close().catch((error: unknown) => failures.push(error))
  await bridge?.close().catch((error: unknown) => failures.push(error))
  if (failures.length > 0) throw new AggregateError(failures, 'fixture cleanup failed')
}

async function main(): Promise<void> {
  bridge = await AuthenticatedUnixBridgeServer.start({
    launchId: LAUNCH_ID,
    secret: BRIDGE_SECRET,
  })
  bridge.setUpdateStatus({ state: 'idle' })
  scaffold = await launchWebScaffold({
    openloop: {
      launchId: LAUNCH_ID,
      bootstrapToken: BOOTSTRAP_TOKEN,
      bridgeSecret: BRIDGE_SECRET,
      socketPath: bridge.socketPath,
      coreManifest: CORE_MANIFEST,
      coreManifestSha256: CORE_MANIFEST_SHA256,
    },
  })
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

process.once('SIGTERM', () => {
  void close().finally(() => process.exit())
})
process.once('SIGINT', () => {
  void close().finally(() => process.exit())
})

main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
