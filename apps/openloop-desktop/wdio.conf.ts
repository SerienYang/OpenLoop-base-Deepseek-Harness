import type { Options } from '@wdio/types'

const binary = process.env.OPENLOOP_WDIO_BINARY
  ?? './src-tauri/target/aarch64-apple-darwin/release/openloop-desktop'

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
}
