/**
 * Package-owned companion for `@openloop/runtime-bootstrap`.
 * @module @openloop/runtime-bootstrap/invariant
 */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@openloop/runtime-bootstrap'

/** Cordis companion plugin name. */
export const name = 'openloop-runtime-bootstrap-invariant'
/** Service required before the companion can register. */
export const inject = ['invariants']

// No runtime invariant: this package owns an ephemeral process handoff. Its
// security contract is enforced by the private service and pipe parser.
const install: InvariantInstaller = () => {}

/** Register this package's empty invariant companion. */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
