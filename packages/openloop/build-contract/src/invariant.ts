/**
 * Package-owned invariant companion for `@openloop/build-contract`.
 * @module @openloop/build-contract/invariant
 */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@openloop/build-contract'

/** Cordis companion plugin name. */
export const name = 'openloop-build-contract-invariant'
/** Service required before the companion can register. */
export const inject = ['invariants']

// No runtime invariant: this package owns pure build-manifest schemas and
// parsers, with no events or mutable runtime relation to observe. Exact field
// and value validation is enforced synchronously at each parser boundary.
const install: InvariantInstaller = () => {}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
