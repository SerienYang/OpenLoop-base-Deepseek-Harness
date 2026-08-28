/**
 * Explicit release capability for Workspace process execution.
 * @module @openloop/sandbox-workspace
 */

import type { Context } from '@deepseek-ai/cordis'

/** Stable Cordis plugin name shown in the signed Openloop profile. */
export const name = 'sandbox-workspace'

/** Fail-closed process capability published by this release. */
export const WORKSPACE_PROCESS_CAPABILITY = Object.freeze({
  status: 'disabled',
  code: 'not_implemented',
  registersSubprocess: false,
  pathFallback: false,
  diagnostic: 'Descriptor-anchored Workspace process execution is unavailable; this release is fail-closed.',
} as const)

/**
 * Mount the diagnostic row without registering `ctx.subprocess` or any other
 * execution service.
 */
export function apply(_ctx: Context): void {}
