import { Context } from '@deepseek-ai/cordis'
import { credentialRef, type CredentialProvider } from '@deepseek-ai/dsh-credentials'
import {
  createLaunchEnvironmentSnapshot,
  DSH_LAUNCH_ENVIRONMENT_KEY,
} from '@deepseek-ai/dsh-launch-environment'
import { MAX_BRIDGE_FRAME_BYTES } from '@openloop/desktop-bridge-host'
import {
  CREDENTIAL_CONSUMER_DISPLAY_KEYS,
  CredentialConsumerRegistry,
  DEEPSEEK_MODEL_OWNER_ID,
  DEEPSEEK_WEB_SEARCH_OWNER_ID,
  KeychainCredentialProvider,
  MAX_CREDENTIAL_CONSUMERS,
  MAX_CREDENTIAL_DELETION_PLAN_BYTES,
  MAX_OPENLOOP_CREDENTIAL_REFERENCE_BYTES,
  openloopCredentialRef,
  OpenloopCredentialOperations,
  piAiModelOwnerId,
  type KeychainCredentialBridge,
} from '@openloop/credentials-keychain'
import { describe, expect, it, vi } from 'vitest'

const REF = credentialRef('SHARED_API_KEY')

function bridge(
  outcome: 'cancelled' | 'deleted' = 'cancelled',
): KeychainCredentialBridge & {
  deleteCredentialWithConfirmation: ReturnType<typeof vi.fn>
} {
  return {
    describeCredential: vi.fn(() => Promise.resolve({
      configured: true,
      source: 'keychain' as const,
      writable: true,
    })),
    resolveCredential: vi.fn(() => Promise.resolve({
      bytes: [...new TextEncoder().encode('still-present')],
      source: 'keychain' as const,
    })),
    openCredentialReplacement: vi.fn(() => Promise.resolve('cancelled' as const)),
    deleteCredentialWithConfirmation: vi.fn(() => Promise.resolve(outcome)),
  }
}

describe('CredentialConsumerRegistry', () => {
  it('derives a deterministic detached deletion plan for two model routes and one plugin', () => {
    const registry = new CredentialConsumerRegistry()
    registry.registerDeepSeekModel(REF)
    registry.registerPiAiModel('openai/team', REF)
    registry.registerDeepSeekWebSearch(REF)

    const first = registry.planDeletion(REF)
    expect(first).toEqual({
      reference: REF,
      consumers: [
        {
          ownerId: DEEPSEEK_MODEL_OWNER_ID,
          kind: 'model-route',
          display: {
            key: CREDENTIAL_CONSUMER_DISPLAY_KEYS.modelRoute,
            values: { routeId: 'deepseek-official' },
          },
        },
        {
          ownerId: piAiModelOwnerId('openai/team'),
          kind: 'model-route',
          display: {
            key: CREDENTIAL_CONSUMER_DISPLAY_KEYS.modelRoute,
            values: { routeId: 'openai/team' },
          },
        },
        {
          ownerId: DEEPSEEK_WEB_SEARCH_OWNER_ID,
          kind: 'plugin',
          display: {
            key: CREDENTIAL_CONSUMER_DISPLAY_KEYS.deepseekWebSearch,
            values: {},
          },
        },
      ],
    })

    expect(Object.isFrozen(first)).toBe(true)
    expect(Object.isFrozen(first.consumers)).toBe(true)
    expect(Object.isFrozen(first.consumers[0])).toBe(true)
    const second = registry.planDeletion(REF)
    expect(second).not.toBe(first)
    expect(second.consumers).not.toBe(first.consumers)
  })

  it('is collision-safe and a stale disposer cannot remove a successor', () => {
    const registry = new CredentialConsumerRegistry()
    const first = registry.registerPiAiModel('openai', REF)

    expect(() => registry.registerPiAiModel('openai', credentialRef('OTHER_KEY')))
      .toThrow(/already registered/)
    first()
    const second = registry.registerPiAiModel('openai', credentialRef('OTHER_KEY'))
    first()

    expect(registry.planDeletion(credentialRef('OTHER_KEY')).consumers)
      .toHaveLength(1)
    second()
  })

  it('bounds pi-ai owner ids and Unicode display labels at the native 256-byte limit', () => {
    const registry = new CredentialConsumerRegistry()
    const asciiBoundary = 'a'.repeat(256)
    const unicodeBoundary = '\u754c'.repeat(256)
    const otherUnicodeBoundary = `${'\u754c'.repeat(255)}\u8a9e`

    registry.registerPiAiModel(otherUnicodeBoundary, REF)
    registry.registerPiAiModel(asciiBoundary, REF)
    registry.registerPiAiModel(unicodeBoundary, REF)
    expect(() => registry.registerPiAiModel('route\u0085control', REF))
      .toThrow('pi-ai route id is invalid')
    expect(() => registry.registerPiAiModel('route\uD800surrogate', REF))
      .toThrow('pi-ai route id is invalid')

    const plan = registry.planDeletion(REF)
    const ownerIds = plan.consumers.map(consumer => consumer.ownerId)
    expect(new Set(ownerIds).size).toBe(3)
    expect(ownerIds).toEqual([...ownerIds].sort())
    for (const ownerId of ownerIds) {
      expect(ownerId).toMatch(/^model-route:pi-ai:sha256:[0-9a-f]{64}$/u)
      expect(Buffer.byteLength(ownerId, 'utf8')).toBeLessThanOrEqual(256)
    }
    expect(piAiModelOwnerId(unicodeBoundary)).toBe(piAiModelOwnerId(unicodeBoundary))
    expect(piAiModelOwnerId(unicodeBoundary)).not.toBe(piAiModelOwnerId(otherUnicodeBoundary))

    const displays = plan.consumers.map(consumer => consumer.display.values.routeId)
    expect(displays).toContain(asciiBoundary)
    for (const routeId of displays) {
      expect(Buffer.byteLength(routeId!, 'utf8')).toBeLessThanOrEqual(256)
    }
  })

  it('registers and replaces pi-ai route consumers as one atomic batch', () => {
    const registry = new CredentialConsumerRegistry()
    const registration = registry.registerPiAiModels([
      { routeId: 'openai', reference: REF },
      { routeId: 'deepseek', reference: REF },
    ])
    const other = credentialRef('OTHER_KEY')

    registration.replace([
      { routeId: 'openai', reference: other },
      { routeId: 'anthropic', reference: other },
    ])

    expect(registry.planDeletion(REF).consumers).toEqual([])
    const expectedOwners = [
      piAiModelOwnerId('anthropic'),
      piAiModelOwnerId('openai'),
    ].sort()
    expect(registry.planDeletion(other).consumers.map(consumer => consumer.ownerId))
      .toEqual(expectedOwners)
    registration.dispose()
    expect(registry.planDeletion(other).consumers).toEqual([])
  })

  it('replaces the DeepSeek model reference atomically and remains reusable after refusal', () => {
    const registry = new CredentialConsumerRegistry()
    const other = credentialRef('OTHER_KEY')
    const blockers = registry.registerPiAiModels(
      Array.from({ length: MAX_CREDENTIAL_CONSUMERS }, (_, index) => ({
        routeId: `blocked-${index}`,
        reference: other,
      })),
    )
    const registration = registry.registerDeepSeekModel(REF)

    expect(() => { registration.replace(other) }).toThrow(/capacity/)
    expect(registry.planDeletion(REF).consumers.map(consumer => consumer.ownerId))
      .toEqual([DEEPSEEK_MODEL_OWNER_ID])

    blockers.replace([])
    registration.replace(other)
    expect(registry.planDeletion(REF).consumers).toEqual([])
    expect(registry.planDeletion(other).consumers.map(consumer => consumer.ownerId))
      .toEqual([DEEPSEEK_MODEL_OWNER_ID])
    registration.dispose()
    expect(registry.planDeletion(other).consumers).toEqual([])
  })

  it('replaces the DeepSeek Web Search reference atomically', () => {
    const registry = new CredentialConsumerRegistry()
    const other = credentialRef('OTHER_KEY')
    const registration = registry.registerDeepSeekWebSearch(REF)

    registration.replace(other)

    expect(registry.planDeletion(REF).consumers).toEqual([])
    expect(registry.planDeletion(other).consumers.map(consumer => consumer.ownerId))
      .toEqual([DEEPSEEK_WEB_SEARCH_OWNER_ID])
    registration.dispose()
    expect(registry.planDeletion(other).consumers).toEqual([])
  })

  it('rolls back an entire pi-ai batch when any owner collides', () => {
    const registry = new CredentialConsumerRegistry()
    registry.registerPiAiModel('taken', REF)
    const other = credentialRef('OTHER_KEY')

    expect(() => registry.registerPiAiModels([
      { routeId: 'free', reference: other },
      { routeId: 'taken', reference: other },
    ])).toThrow(/already registered/)

    expect(registry.planDeletion(other).consumers).toEqual([])
    expect(registry.planDeletion(REF).consumers.map(consumer => consumer.ownerId))
      .toEqual([piAiModelOwnerId('taken')])
  })

  it('keeps the previous pi-ai batch intact when a replacement collides', () => {
    const registry = new CredentialConsumerRegistry()
    const registration = registry.registerPiAiModels([
      { routeId: 'openai', reference: REF },
    ])
    registry.registerPiAiModel('taken', REF)
    const other = credentialRef('OTHER_KEY')

    expect(() => {
      registration.replace([
        { routeId: 'openai', reference: other },
        { routeId: 'taken', reference: other },
      ])
    }).toThrow(/already registered/)

    expect(registry.planDeletion(other).consumers).toEqual([])
    const expectedOwners = [
      piAiModelOwnerId('openai'),
      piAiModelOwnerId('taken'),
    ].sort()
    expect(registry.planDeletion(REF).consumers.map(consumer => consumer.ownerId))
      .toEqual(expectedOwners)
  })

  it('rejects 257 short consumers and an over-limit single registration atomically', () => {
    const registry = new CredentialConsumerRegistry()
    const tooMany = Array.from({ length: 257 }, (_, index) => ({
      routeId: `route-${index}`,
      reference: REF,
    }))

    expect(() => registry.registerPiAiModels(tooMany)).toThrow(/capacity/)
    expect(registry.planDeletion(REF).consumers).toEqual([])

    const accepted = Array.from({ length: MAX_CREDENTIAL_CONSUMERS }, (_, index) => ({
      routeId: `r${index}`,
      reference: REF,
    }))
    registry.registerPiAiModels(accepted)
    expect(registry.planDeletion(REF).consumers).toHaveLength(MAX_CREDENTIAL_CONSUMERS)
    expect(() => registry.registerDeepSeekModel(REF)).toThrow(/capacity/)
    expect(registry.planDeletion(REF).consumers).toHaveLength(MAX_CREDENTIAL_CONSUMERS)
  })

  it('rejects an oversized Unicode-label replacement before publishing it', () => {
    const registry = new CredentialConsumerRegistry()
    const registration = registry.registerPiAiModels([
      { routeId: 'retained', reference: REF },
    ])
    const oversized = Array.from({ length: MAX_CREDENTIAL_CONSUMERS }, (_, index) => ({
      routeId: `${'\u754c'.repeat(250)}${String(index).padStart(6, '0')}`,
      reference: REF,
    }))
    const labels = new CredentialConsumerRegistry()
    const consumers = oversized.map(({ routeId }) => {
      const dispose = labels.registerPiAiModel(routeId, REF)
      const consumer = labels.planDeletion(REF).consumers[0]!
      dispose()
      return consumer
    })
    expect(Buffer.byteLength(JSON.stringify({ reference: REF, consumers }), 'utf8'))
      .toBeGreaterThan(MAX_BRIDGE_FRAME_BYTES)

    expect(() => {
      registration.replace(oversized)
    }).toThrow(/capacity/)
    expect(registry.planDeletion(REF).consumers.map(consumer => consumer.display.values.routeId))
      .toEqual(['retained'])
  })

  it('keeps the largest accepted short-label plan within the shared JSON byte budget', () => {
    const registry = new CredentialConsumerRegistry()
    registry.registerPiAiModels(
      Array.from({ length: MAX_CREDENTIAL_CONSUMERS }, (_, index) => ({
        routeId: `r${index}`,
        reference: REF,
      })),
    )

    const plan = registry.planDeletion(REF)
    expect(plan.consumers).toHaveLength(MAX_CREDENTIAL_CONSUMERS)
    expect(Buffer.byteLength(JSON.stringify(plan), 'utf8'))
      .toBeLessThanOrEqual(MAX_CREDENTIAL_DELETION_PLAN_BYTES)
  })

  it('enforces the Openloop 128-byte ASCII reference boundary before registry state changes', () => {
    const registry = new CredentialConsumerRegistry()
    const boundaryText = `A${'b'.repeat(MAX_OPENLOOP_CREDENTIAL_REFERENCE_BYTES - 1)}`
    const boundary = openloopCredentialRef(boundaryText)
    const overlongText = `${boundaryText}c`
    const overlong = credentialRef(overlongText)
    const nonAscii = 'UNICOD\u00c9_KEY'

    registry.registerPiAiModel('accepted', boundary)
    expect(registry.planDeletion(boundary).consumers).toHaveLength(1)
    for (const invalid of [overlong, nonAscii as typeof REF]) {
      let failure: unknown
      try {
        registry.registerPiAiModel('rejected', invalid)
      } catch (error) {
        failure = error
      }
      expect(failure).toBeInstanceOf(TypeError)
      expect((failure as Error).message).toBe('credential reference is invalid')
      expect((failure as Error).message).not.toContain(String(invalid))
    }
    expect(registry.planDeletion(boundary).consumers).toHaveLength(1)
  })

  it('removing a provider registration never deletes its shared credential', async () => {
    const registry = new CredentialConsumerRegistry()
    const keychain = bridge()
    const provider = new KeychainCredentialProvider(new Context(), { bridge: keychain })
    const registration = registry.registerDeepSeekModel(REF)

    registration.dispose()

    await expect(provider.resolve(REF)).resolves.toMatchObject({ value: 'still-present' })
    expect(keychain.deleteCredentialWithConfirmation).not.toHaveBeenCalled()
  })

  it('accepts only a reference from the caller and sends Host-derived labels to confirmation', async () => {
    const registry = new CredentialConsumerRegistry()
    registry.registerDeepSeekModel(REF)
    registry.registerPiAiModel('openai', REF)
    registry.registerDeepSeekWebSearch(REF)
    const keychain = bridge('cancelled')
    const operations = new OpenloopCredentialOperations(
      new KeychainCredentialProvider(new Context(), { bridge: keychain }),
      registry,
      keychain,
    )

    await expect(operations.deleteCredential(REF)).resolves.toBe('cancelled')

    expect(keychain.deleteCredentialWithConfirmation).toHaveBeenCalledWith(
      registry.planDeletion(REF),
      undefined,
    )
    await expect(keychain.resolveCredential(REF)).resolves.toBeDefined()
  })

  it('surfaces a confirmed native deletion without mutating Keychain in the registry', async () => {
    const registry = new CredentialConsumerRegistry()
    registry.registerDeepSeekModel(REF)
    const keychain = bridge('deleted')
    const operations = new OpenloopCredentialOperations(
      new KeychainCredentialProvider(new Context(), { bridge: keychain }),
      registry,
      keychain,
    )

    await expect(operations.deleteCredential(REF)).resolves.toBe('deleted')
    expect(keychain.deleteCredentialWithConfirmation).toHaveBeenCalledTimes(1)
  })

  it('reports the native facade read-only until its mutation UI is installed', async () => {
    const registry = new CredentialConsumerRegistry()
    registry.registerDeepSeekModel(REF)
    const keychain = bridge()
    const describeCredential = vi.fn(() => Promise.resolve({
      configured: true,
      source: 'keychain' as const,
      writable: false,
    }))
    const openCredentialReplacement = vi.spyOn(keychain, 'openCredentialReplacement')
    const deleteCredentialWithConfirmation = vi.spyOn(keychain, 'deleteCredentialWithConfirmation')
    keychain.describeCredential = describeCredential
    const provider = new KeychainCredentialProvider(new Context(), { bridge: keychain })
    const operations = new OpenloopCredentialOperations(provider, registry, keychain)

    await expect(provider.describe(REF)).resolves.toMatchObject({
      configured: true,
      source: 'keychain',
      writable: false,
    })
    await expect(operations.describeCredential(REF)).resolves.toEqual({
      configured: true,
      source: 'keychain',
      writable: false,
    })
    await expect(operations.openCredentialReplacement(REF)).rejects.toThrow(/read-only/)
    await expect(operations.deleteCredential(REF)).rejects.toThrow(/read-only/)
    expect(openCredentialReplacement).not.toHaveBeenCalled()
    expect(deleteCredentialWithConfirmation).not.toHaveBeenCalled()
  })

  it('keeps a legacy-winning reference read-only in browser operations', async () => {
    const registry = new CredentialConsumerRegistry()
    registry.registerDeepSeekModel(REF)
    const keychain = bridge()
    keychain.describeCredential = vi.fn(() => Promise.resolve({
      configured: false,
      writable: true,
    }))
    const provider = new KeychainCredentialProvider(new Context(), {
      bridge: keychain,
      legacy: {
        resolve: vi.fn(() => Promise.resolve('legacy-value')),
        describe: vi.fn(() => Promise.resolve({
          configured: true,
          source: 'legacy-file',
          writable: false,
        })),
      },
    })
    const operations = new OpenloopCredentialOperations(provider, registry, keychain)

    await expect(operations.describeCredential(REF)).resolves.toEqual({
      configured: true,
      source: 'legacy-file',
      writable: false,
    })
    await expect(operations.openCredentialReplacement(REF)).rejects.toThrow(/read-only/)
  })

  it('rejects every browser operation for a reference no built-in Host consumer registered', async () => {
    const registry = new CredentialConsumerRegistry()
    const keychain = bridge()
    const describeCredential = vi.spyOn(keychain, 'describeCredential')
    const operations = new OpenloopCredentialOperations(
      new KeychainCredentialProvider(new Context(), { bridge: keychain }),
      registry,
      keychain,
    )

    await expect(operations.describeCredential('UNKNOWN_KEY')).rejects.toThrow(/not registered/)
    await expect(operations.openCredentialReplacement('UNKNOWN_KEY')).rejects.toThrow(/not registered/)
    await expect(operations.deleteCredential('UNKNOWN_KEY')).rejects.toThrow(/not registered/)
    expect(describeCredential).not.toHaveBeenCalled()
  })

  it('does not echo an invalid browser credential reference in errors', async () => {
    const registry = new CredentialConsumerRegistry()
    const keychain = bridge()
    const operations = new OpenloopCredentialOperations(
      new KeychainCredentialProvider(new Context(), { bridge: keychain }),
      registry,
      keychain,
    )
    const invalidReference = 'SECRET-REFERENCE'

    for (const operation of [
      operations.describeCredential(invalidReference),
      operations.openCredentialReplacement(invalidReference),
      operations.deleteCredential(invalidReference),
    ]) {
      const error = await operation.catch((failure: unknown) => failure)
      expect(error).toBeInstanceOf(Error)
      expect((error as Error).message).toBe('credential reference is invalid')
      expect((error as Error).message).not.toContain(invalidReference)
    }
  })

  it('rejects native mutation while the process environment shadows Keychain', async () => {
    const ctx = new Context()
    ctx.provide(DSH_LAUNCH_ENVIRONMENT_KEY, createLaunchEnvironmentSnapshot([
      { source: 'process', values: { SHARED_API_KEY: 'process-value' } },
    ]))
    const registry = new CredentialConsumerRegistry()
    registry.registerDeepSeekModel(REF)
    const keychain = bridge('deleted')
    const operations = new OpenloopCredentialOperations(
      new KeychainCredentialProvider(ctx, { bridge: keychain }),
      registry,
      keychain,
    )

    await expect(operations.openCredentialReplacement(REF)).rejects.toThrow(/read-only environment/)
    await expect(operations.deleteCredential(REF)).rejects.toThrow(/read-only environment/)
    expect(keychain.deleteCredentialWithConfirmation).not.toHaveBeenCalled()
  })

  it.each([
    ['describe', (operations: OpenloopCredentialOperations, signal: AbortSignal) =>
      operations.describeCredential(REF, signal)],
    ['replacement', (operations: OpenloopCredentialOperations, signal: AbortSignal) =>
      operations.openCredentialReplacement(REF, signal)],
    ['delete', (operations: OpenloopCredentialOperations, signal: AbortSignal) =>
      operations.deleteCredential(REF, signal)],
  ] as const)('aborts %s promptly while provider preflight stalls and observes late rejection', async (
    _name,
    start,
  ) => {
    const stalled: PromiseWithResolvers<never> = Promise.withResolvers()
    const describe = vi.fn(() => stalled.promise)
    const registry = new CredentialConsumerRegistry()
    registry.registerDeepSeekModel(REF)
    const keychain = bridge()
    const nativeDescribe = vi.spyOn(keychain, 'describeCredential')
    const openCredentialReplacement = vi.spyOn(keychain, 'openCredentialReplacement')
    const deleteCredentialWithConfirmation = vi.spyOn(keychain, 'deleteCredentialWithConfirmation')
    const operations = new OpenloopCredentialOperations(
      { describe } as unknown as CredentialProvider,
      registry,
      keychain,
    )
    const controller = new AbortController()
    const pending = start(operations, controller.signal)

    controller.abort(new Error('private abort reason'))

    const failure = await Promise.race([
      pending.then(() => undefined, (error: unknown) => error),
      new Promise<never>((_resolve, reject) => {
        setTimeout(() => { reject(new Error('credential preflight did not abort promptly')) }, 100)
      }),
    ])
    expect(failure).toBeInstanceOf(DOMException)
    expect(failure).toMatchObject({ name: 'AbortError' })
    expect(String(failure)).not.toContain('private abort reason')
    expect(nativeDescribe).not.toHaveBeenCalled()
    expect(openCredentialReplacement).not.toHaveBeenCalled()
    expect(deleteCredentialWithConfirmation).not.toHaveBeenCalled()

    stalled.reject(new Error('late private provider rejection'))
    await Promise.resolve()
  })

  it.each([
    ['describe', (operations: OpenloopCredentialOperations, signal: AbortSignal) =>
      operations.describeCredential(REF, signal)],
    ['replacement', (operations: OpenloopCredentialOperations, signal: AbortSignal) =>
      operations.openCredentialReplacement(REF, signal)],
    ['delete', (operations: OpenloopCredentialOperations, signal: AbortSignal) =>
      operations.deleteCredential(REF, signal)],
  ] as const)('aborts %s promptly while native preflight stalls and observes late rejection', async (
    _name,
    start,
  ) => {
    const stalled: PromiseWithResolvers<never> = Promise.withResolvers()
    const registry = new CredentialConsumerRegistry()
    registry.registerDeepSeekModel(REF)
    const keychain = bridge()
    const describeCredential = vi.fn(() => stalled.promise)
    const openCredentialReplacement = vi.spyOn(keychain, 'openCredentialReplacement')
    const deleteCredentialWithConfirmation = vi.spyOn(keychain, 'deleteCredentialWithConfirmation')
    keychain.describeCredential = describeCredential
    const provider = {
      describe: vi.fn(() => Promise.resolve({ configured: false, writable: false })),
    } as unknown as CredentialProvider
    const operations = new OpenloopCredentialOperations(
      provider,
      registry,
      keychain,
    )
    const controller = new AbortController()
    const pending = start(operations, controller.signal)
    await vi.waitFor(() => { expect(describeCredential).toHaveBeenCalledWith(REF, controller.signal) })

    controller.abort(new Error('private abort reason'))

    const failure = await Promise.race([
      pending.then(() => undefined, (error: unknown) => error),
      new Promise<never>((_resolve, reject) => {
        setTimeout(() => { reject(new Error('credential preflight did not abort promptly')) }, 100)
      }),
    ])
    expect(failure).toBeInstanceOf(DOMException)
    expect(failure).toMatchObject({ name: 'AbortError' })
    expect(String(failure)).not.toContain('private abort reason')
    expect(openCredentialReplacement).not.toHaveBeenCalled()
    expect(deleteCredentialWithConfirmation).not.toHaveBeenCalled()

    stalled.reject(new Error('late private native rejection'))
    await Promise.resolve()
  })

  it.each([
    ['describe', (operations: OpenloopCredentialOperations, signal: AbortSignal) =>
      operations.describeCredential(REF, signal)],
    ['replacement', (operations: OpenloopCredentialOperations, signal: AbortSignal) =>
      operations.openCredentialReplacement(REF, signal)],
    ['delete', (operations: OpenloopCredentialOperations, signal: AbortSignal) =>
      operations.deleteCredential(REF, signal)],
  ] as const)('rejects pre-aborted %s before starting preflight', async (_name, start) => {
    const describe = vi.fn(() => Promise.resolve({ configured: false, writable: false }))
    const registry = new CredentialConsumerRegistry()
    registry.registerDeepSeekModel(REF)
    const keychain = bridge()
    const nativeDescribe = vi.spyOn(keychain, 'describeCredential')
    const operations = new OpenloopCredentialOperations(
      { describe } as unknown as CredentialProvider,
      registry,
      keychain,
    )
    const controller = new AbortController()
    controller.abort(new Error('private abort reason'))

    const failure = await start(operations, controller.signal)
      .then(() => undefined, (error: unknown) => error)

    expect(failure).toBeInstanceOf(DOMException)
    expect(failure).toMatchObject({ name: 'AbortError' })
    expect(String(failure)).not.toContain('private abort reason')
    expect(describe).not.toHaveBeenCalled()
    expect(nativeDescribe).not.toHaveBeenCalled()
  })
})
