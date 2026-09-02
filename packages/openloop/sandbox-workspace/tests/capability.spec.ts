import { readFileSync } from 'node:fs'
import { Context } from '@deepseek-ai/cordis'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import { describe, expect, it } from 'vitest'
import {
  apply,
  name,
  WORKSPACE_PROCESS_CAPABILITY,
} from '@openloop/sandbox-workspace'
import * as SandboxWorkspaceInvariant from '@openloop/sandbox-workspace/invariant'

interface PackageManifest {
  readonly name?: string
  readonly private?: boolean
  readonly openloop?: {
    readonly face?: string
    readonly cordisPlugin?: boolean
  }
  readonly exports?: Readonly<Record<string, unknown>>
}

describe('Openloop Workspace process capability', () => {
  it('publishes an explicit fail-closed diagnostic without a path fallback', () => {
    expect(WORKSPACE_PROCESS_CAPABILITY).toMatchObject({
      status: 'disabled',
      code: 'not_implemented',
      registersSubprocess: false,
      pathFallback: false,
    })
    expect(WORKSPACE_PROCESS_CAPABILITY.diagnostic)
      .toMatch(/descriptor.*unavailable.*fail.closed/iu)
    expect(Object.isFrozen(WORKSPACE_PROCESS_CAPABILITY)).toBe(true)
  })

  it('mounts only a diagnostic plugin and never registers ctx.subprocess', async () => {
    const ctx = new Context()

    await ctx.plugin({ name, apply })

    expect(ctx.get('subprocess')).toBeUndefined()
  })

  it('ships as a private Host package with an invariant companion', () => {
    const manifest = JSON.parse(
      readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
    ) as PackageManifest

    expect(manifest).toMatchObject({
      name: '@openloop/sandbox-workspace',
      private: true,
      openloop: {
        face: 'host',
        cordisPlugin: true,
      },
      exports: {
        '.': {
          types: './lib/types/index.d.ts',
          default: './lib/index.js',
        },
        './invariant': {
          types: './lib/types/invariant.d.ts',
          default: './lib/invariant.js',
        },
      },
    })
  })

  it('fails its invariant if another row registered ctx.subprocess', async () => {
    const ctx = new Context()
    await ctx.plugin(InvariantRegistry)
    await ctx.plugin(SandboxWorkspaceInvariant)

    let failure: unknown
    try {
      ctx.provide('subprocess', {})
    } catch (error) {
      failure = error
    }
    expect(String(failure))
      .toMatch(/Workspace process execution is disabled.*ctx\.subprocess/iu)
  })
})
