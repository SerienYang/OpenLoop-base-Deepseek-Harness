import { Context } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import {
  createLaunchEnvironmentSnapshot,
  DSH_LAUNCH_ENVIRONMENT_KEY,
} from '@deepseek-ai/dsh-launch-environment'
import {
  CREDENTIAL_CONSUMER_DISPLAY_KEYS,
  CredentialConsumerRegistry,
  DEEPSEEK_MODEL_OWNER_ID,
  DEEPSEEK_WEB_SEARCH_OWNER_ID,
  KeychainCredentialProvider,
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
    resolveCredential: vi.fn(() => Promise.resolve([...new TextEncoder().encode('still-present')])),
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

  it('removing a provider registration never deletes its shared credential', async () => {
    const registry = new CredentialConsumerRegistry()
    const keychain = bridge()
    const provider = new KeychainCredentialProvider(new Context(), { bridge: keychain })
    const remove = registry.registerDeepSeekModel(REF)

    remove()

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

  it('reports native-confirmed Keychain writability through browser operations only', async () => {
    const registry = new CredentialConsumerRegistry()
    registry.registerDeepSeekModel(REF)
    const keychain = bridge()
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
      writable: true,
    })
    await expect(operations.openCredentialReplacement(REF)).resolves.toBe('cancelled')
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
})
