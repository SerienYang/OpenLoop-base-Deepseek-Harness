import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@openloop/chat-zoom'

export const name = 'openloop-chat-zoom-invariant'
export const inject = ['invariants']

// No runtime invariant: focused tests enforce the bounded zoom state and UI integration.
const install: InvariantInstaller = () => {}

export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
