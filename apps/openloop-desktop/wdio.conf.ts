import type { Options } from '@wdio/types'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

const binary = process.env.OPENLOOP_WDIO_BINARY
  ?? './src-tauri/target/aarch64-apple-darwin/release/bundle/macos/Openloop.app/Contents/MacOS/openloop-desktop'
const ownsE2eRoot = process.env.OPENLOOP_E2E_ROOT === undefined
const e2eRoot = process.env.OPENLOOP_E2E_ROOT ?? mkdtempSync(join(tmpdir(), 'openloop-wdio-'))
process.env.OPENLOOP_E2E_ROOT = e2eRoot
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
  onComplete: () => {
    try {
      const runtime = join(dirname(binary), 'openloop-runtime')
      const pids = execFileSync('pgrep', ['-f', runtime], { encoding: 'utf8' })
        .trim()
        .split('\n')
        .filter(Boolean)
      for (const pid of pids) process.kill(Number(pid), 'SIGTERM')
    } catch {
      // No matching sidecar remains.
    }
    if (ownsE2eRoot) rmSync(e2eRoot, { recursive: true, force: true })
  },
}
