/** Package-owned invariant companion for `@openloop/settings-foundation`. */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@openloop/settings-foundation'

export const name = 'openloop-settings-foundation-invariant'
export const inject = ['invariants']

// No runtime invariant: the focused test pins the complete inert service contract.
const install: InvariantInstaller = () => {}

export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
