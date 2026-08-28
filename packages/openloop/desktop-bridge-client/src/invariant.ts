/** Package-owned invariant companion for `@openloop/desktop-bridge-client`. */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@openloop/desktop-bridge-client'

export const name = 'openloop-desktop-bridge-client-invariant'
export const inject = ['invariants']

// No runtime invariant: focused tests enforce the path-free browser boundary.
const install: InvariantInstaller = () => {}

export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
