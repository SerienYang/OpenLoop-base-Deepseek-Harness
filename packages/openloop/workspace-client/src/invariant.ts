/** Package-owned invariant companion for `@openloop/workspace-client`. */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@openloop/workspace-client'

export const name = 'openloop-workspace-client-invariant'
export const inject = ['invariants']

// No runtime invariant: this package contributes browser-only UI through typed services.
const install: InvariantInstaller = () => {}

export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
