/** Package-owned invariant companion for `@openloop/workspace-authority`. */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

export const name = 'openloop-workspace-authority-invariant'
export const inject = ['invariants']

// No runtime invariant: Workspace authority behavior is enforced by its focused tests.
const install: InvariantInstaller = () => {}

export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register('@openloop/workspace-authority', install))
