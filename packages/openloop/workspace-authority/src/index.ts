/** @openloop/workspace-authority Cordis plugin entry. */
import type { Context } from '@deepseek-ai/cordis'

export * from './types.ts'

/** Stable Cordis plugin name. */
export const name = 'workspace-authority'

/** Minimal lifecycle entry; add product contributions through this context. */
export function apply(_ctx: Context): void {}
