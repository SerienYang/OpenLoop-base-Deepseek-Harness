/**
 * Package-owned invariant companion for `@openloop/desktop-bridge-host`.
 * @module @openloop/desktop-bridge-host/invariant
 */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@openloop/desktop-bridge-host'

/** Cordis companion plugin name. */
export const name = 'openloop-desktop-bridge-host-invariant'
/** Service required before the companion can register. */
export const inject = ['invariants']

// No runtime invariant: the manifest parser and boundary tests enforce the
// fixed policy, which owns no independent mutable state to inspect.
const install: InvariantInstaller = () => {}

/** Register this package's invariant companion. */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
