import { existsSync } from 'node:fs'
import { join } from 'node:path'
import {
  initProfile,
  resolveProfileDir,
} from '@deepseek-ai/dsh-app-boot'

/** Ordered DSH bundle layers for the OpenLoop desktop profile. */
export const OPENLOOP_PROFILE_BUNDLES = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', '@openloop/bundle'] as const

/**
 * Resolve and, when absent, initialize the OpenLoop profile.
 * An existing manifest makes the whole profile user-owned and read-only here.
 * @param home - optional DSH home override.
 * @returns the absolute OpenLoop profile directory.
 */
export function ensureOpenloopProfile(home?: string): string {
  const dir = resolveProfileDir('openloop', home)
  if (!existsSync(join(dir, 'package.json'))) {
    initProfile(dir, OPENLOOP_PROFILE_BUNDLES)
  }
  return dir
}
