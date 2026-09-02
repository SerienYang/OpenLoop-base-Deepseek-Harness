/** Package-owned invariant companion for `@openloop/fs-workspace`. */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

export const name = 'openloop-fs-workspace-invariant'
export const inject = ['invariants']

// No runtime invariant: broker boundary behavior is enforced by focused filesystem tests.
const install: InvariantInstaller = () => {}

export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register('@openloop/fs-workspace', install))
