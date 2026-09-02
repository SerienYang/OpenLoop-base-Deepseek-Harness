import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import { apply, inject } from '../src/client/index.ts'

describe('ui-settings browser service', () => {
  it('provides the default Settings shell owner for the plugin lifetime', async () => {
    const ctx = new Context()
    const fiber = ctx.plugin({ inject: [...inject], apply })
    await fiber.await()

    expect(inject).toEqual([])
    expect(ctx.get('settingsShellOwner')).toEqual({
      id: '@deepseek-ai/dsh-client-ui-settings-general',
    })

    await fiber.dispose()
    expect(ctx.get('settingsShellOwner')).toBeUndefined()
  })
})
