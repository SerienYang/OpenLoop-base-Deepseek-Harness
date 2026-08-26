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
