/** @openloop/shell Cordis plugin entry. */
import type { Context } from '@deepseek-ai/cordis'
export { parseOpenloopBrand } from './client/brand.ts'
export type { OpenloopBrand } from './client/brand.ts'

/** Stable Cordis plugin name. */
export const name = 'shell'

/** Minimal lifecycle entry; add product contributions through this context. */
export function apply(_ctx: Context): void {}
