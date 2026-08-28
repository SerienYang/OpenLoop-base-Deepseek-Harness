/** Package-owned invariant companion for `@openloop/sandbox-workspace`. */

import type { Context } from '@deepseek-ai/cordis'
import type {
  InvariantFailure,
  InvariantInstaller,
} from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@openloop/sandbox-workspace'

export const name = 'openloop-sandbox-workspace-invariant'
export const inject = ['invariants']

function assertSubprocessAbsent(ctx: Context, fail: InvariantFailure): void {
  if (ctx.root.reflect.get('subprocess', false) !== undefined) {
    fail('Workspace process execution is disabled but ctx.subprocess is registered')
  }
}

const install: InvariantInstaller = (ctx: Context, fail: InvariantFailure) => {
  assertSubprocessAbsent(ctx, fail)
  ctx.on('internal/service', function (this: Context, service, value) {
    if (service === 'subprocess' && value !== undefined) {
      fail('Workspace process execution is disabled but ctx.subprocess is registered')
    }
  }, { global: true })
}

export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
