import { describe, expect, it, vi } from 'vitest'
import {
  cleanupFixtureWorld,
  startFixtureWorld,
} from './openloop-fixture-lifecycle.ts'

describe('Openloop Web fixture lifecycle', () => {
  it('closes an already-started bridge when scaffold startup fails', async () => {
    const closeBridge = vi.fn(async () => {})

    await expect(startFixtureWorld({
      startBridge: async () => ({ close: closeBridge }),
      launchScaffold: async () => {
        throw new Error('scaffold startup failed')
      },
    })).rejects.toThrow('scaffold startup failed')

    expect(closeBridge).toHaveBeenCalledOnce()
  })

  it('attempts both cleanup steps and reports every failure', async () => {
    const errors: string[] = []

    const code = await cleanupFixtureWorld({
      scaffold: {
        close: async () => { throw new Error('scaffold cleanup failed') },
      },
      bridge: {
        close: async () => { throw new Error('bridge cleanup failed') },
      },
    }, message => errors.push(message))

    expect(code).toBe(1)
    expect(errors).toHaveLength(1)
    expect(errors[0]).toContain('fixture cleanup failed')
    expect(errors[0]).toContain('scaffold cleanup failed')
    expect(errors[0]).toContain('bridge cleanup failed')
  })
})
