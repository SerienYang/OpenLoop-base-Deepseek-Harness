import { describe, expect, test } from 'vitest'
import { awaitDshPreboot } from '../src/boot.tsx'

describe('Web shell preboot gate', () => {
  test('waits for the Host bootstrap promise before client plugin boot', async () => {
    let release!: () => void
    const target = globalThis as { __DSH_PREBOOT__?: Promise<void> }
    const previous = target.__DSH_PREBOOT__
    target.__DSH_PREBOOT__ = new Promise<void>((resolve) => {
      release = resolve
    })
    let settled = false
    const pending = awaitDshPreboot().then(() => { settled = true })

    await Promise.resolve()
    expect(settled).toBe(false)
    release()
    await pending
    expect(settled).toBe(true)
    if (previous === undefined) delete target.__DSH_PREBOOT__
    else target.__DSH_PREBOOT__ = previous
  })
})
