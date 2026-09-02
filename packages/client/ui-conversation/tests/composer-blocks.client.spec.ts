import type { SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import { describe, expect, it, vi } from 'vitest'
import { ComposerBlockRegistry } from '../src/client/input/blocks.ts'

const sid = (value: string): SessionId => value as SessionId

describe('ComposerBlockRegistry ownership', () => {
  it('keeps independent blockers and reveals the remaining reason when one clears', () => {
    const registry = new ComposerBlockRegistry()
    const store = registry.storeFor(sid('session-1'))
    const listener = vi.fn()
    store.subscribe(listener)

    registry.setOwned(sid('session-1'), 'model', { reason: 'Choose a model' })
    registry.setOwned(sid('session-1'), 'workspace', { reason: 'Reauthorize Workspace' })
    expect(store.getSnapshot()).toEqual({ reason: 'Choose a model' })

    registry.setOwned(sid('session-1'), 'model', undefined)
    expect(store.getSnapshot()).toEqual({ reason: 'Reauthorize Workspace' })
    expect(listener).toHaveBeenCalledTimes(2)
  })

  it('preserves the legacy set API as one replaceable owner', () => {
    const registry = new ComposerBlockRegistry()
    registry.setOwned(sid('session-1'), 'workspace', { reason: 'Workspace' })
    registry.set(sid('session-1'), { reason: 'First' })
    registry.set(sid('session-1'), { reason: 'Second' })
    expect(registry.storeFor(sid('session-1')).getSnapshot()).toEqual({ reason: 'Second' })

    registry.set(sid('session-1'), undefined)
    expect(registry.storeFor(sid('session-1')).getSnapshot()).toEqual({ reason: 'Workspace' })
  })

  it('clears every owner when the session is forgotten', () => {
    const registry = new ComposerBlockRegistry()
    const before = registry.storeFor(sid('session-1'))
    registry.setOwned(sid('session-1'), 'workspace', { reason: 'Workspace' })

    registry.forget(sid('session-1'))

    expect(registry.storeFor(sid('session-1'))).not.toBe(before)
    expect(registry.storeFor(sid('session-1')).getSnapshot()).toBeUndefined()
  })
})
