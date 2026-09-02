/** Package-owned invariant companion for `@openloop/shell`. */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

export const name = 'openloop-shell-invariant'
export const inject = ['invariants']

// No runtime invariant: package behavior is enforced by its focused tests.
const install: InvariantInstaller = () => {}

export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register('@openloop/shell', install))
