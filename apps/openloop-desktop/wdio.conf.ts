import type { Options } from '@wdio/types'
import { randomUUID } from 'node:crypto'
import { appendFileSync, mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const binary = process.env.OPENLOOP_WDIO_BINARY
  ?? resolve(
    import.meta.dirname,
    '../../.artifacts/openloop-e2e-target/aarch64-apple-darwin/release/bundle/macos/Openloop E2E.app/Contents/MacOS/openloop-desktop',
  )
const e2eRoot = process.env.OPENLOOP_E2E_ROOT ?? mkdtempSync(join(tmpdir(), 'openloop-wdio-'))
process.env.OPENLOOP_E2E_ROOT = e2eRoot
process.env.OPENLOOP_E2E_RUN_ID ??= randomUUID()
process.env.OPENLOOP_E2E_RUNTIME_AUDIT ??= join(e2eRoot, 'runtime-process.json')
process.env.OPENLOOP_WDIO_RESULT_AUDIT ??= join(e2eRoot, 'wdio-results.jsonl')
const dshHome = join(e2eRoot, 'Openloop-Test', 'dsh')
mkdirSync(dshHome, { recursive: true, mode: 0o700 })
process.env.DSH_HOME = dshHome
process.env.OPENLOOP_E2E_APPKIT_AUDIT = join(e2eRoot, 'appkit-audit.log')
process.env.OPENLOOP_E2E_AUTO_CANCEL_APPKIT = '1'
process.env.OPENLOOP_E2E_CREDENTIAL_PROBE = '1'

export const config: Options.Testrunner = {
  runner: 'local',
  specs: [],
  maxInstances: 1,
  services: [[
    '@wdio/tauri-service',
    {
      appBinaryPath: binary,
      driverProvider: 'embedded',
      captureBackendLogs: true,
      captureFrontendLogs: true,
      startTimeout: 60_000,
    },
  ]],
  capabilities: [{
    browserName: 'tauri',
    'tauri:options': {
      application: binary,
    },
  }],
  logLevel: 'warn',
  waitforTimeout: 15_000,
  connectionRetryTimeout: 90_000,
  connectionRetryCount: 1,
  framework: 'mocha',
  reporters: ['spec'],
  mochaOpts: {
    ui: 'bdd',
    timeout: 120_000,
  },
  afterTest: (test, _context, result) => {
    const audit = process.env.OPENLOOP_WDIO_RESULT_AUDIT
    if (audit === undefined) throw new Error('OPENLOOP_WDIO_RESULT_AUDIT is required')
    appendFileSync(audit, `${JSON.stringify({
      state: result.error === undefined ? 'passed' : 'failed',
      title: test.title,
    })}\n`)
  },
}
