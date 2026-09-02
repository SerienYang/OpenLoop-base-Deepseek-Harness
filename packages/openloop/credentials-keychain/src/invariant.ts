/** Package-owned invariant companion for the Keychain credential provider. */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@openloop/credentials-keychain'

export const name = 'openloop-credentials-keychain-invariant'
export const inject = ['invariants']

// No runtime invariant: provider precedence, registry ownership, and Remote
// exclusion are enforced at their explicit boundaries and in package tests.
const install: InvariantInstaller = () => {}

export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
