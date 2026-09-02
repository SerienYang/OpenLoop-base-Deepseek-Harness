/**
 * Package-owned invariant companion for `@openloop/adapters`.
 * @module @openloop/adapters/invariant
 */

/* jscpd:ignore-start */
const PACKAGE_NAME = '@openloop/adapters'

/** Cordis companion plugin name. */
export const name = 'openloop-adapters-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: this pure adapter aggregate owns no event stream or
 * mutable runtime data; its stateless translations are enforced by unit tests.
 */
const install = (): void => {}

interface InvariantContext {
  readonly invariants: {
    register(packageName: string, installer: typeof install): () => void
  }
}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: InvariantContext): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
