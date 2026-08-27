import { Context } from '@deepseek-ai/cordis'
import { credentialRef, type CredentialRef } from '@deepseek-ai/dsh-credentials'
import {
  createLaunchEnvironmentSnapshot,
  DSH_LAUNCH_ENVIRONMENT_KEY,
} from '@deepseek-ai/dsh-launch-environment'
import { remoteMethods } from '@deepseek-ai/dsh-typert-protocol'
import { OpenloopDesktopRemoteService } from '@openloop/desktop-bridge-host'
import {
  KeychainCredentialProvider,
  MAX_OPENLOOP_SECRET_BYTES,
  MAX_OPENLOOP_CREDENTIAL_REFERENCE_BYTES,
  openloopCredentialRef,
  type KeychainCredentialBridge,
  type LegacyCredentialSource,
} from '@openloop/credentials-keychain'
import { describe, expect, it, vi } from 'vitest'

const REF = credentialRef('DEEPSEEK_API_KEY')

function secret(value: string): number[] {
  return [...new TextEncoder().encode(value)]
}

function resolved(value: string | number[], source: 'keychain' | 'legacy-file' = 'keychain') {
  return {
    bytes: typeof value === 'string' ? secret(value) : value,
    source,
  } as const
}

function bridge(
  overrides: Partial<KeychainCredentialBridge> = {},
): KeychainCredentialBridge {
  return {
    describeCredential: vi.fn(() => Promise.resolve({
      configured: false,
      writable: false,
    })),
    resolveCredential: vi.fn(() => Promise.resolve(undefined)),
    openCredentialReplacement: vi.fn(() => Promise.resolve('cancelled' as const)),
    deleteCredentialWithConfirmation: vi.fn(() => Promise.resolve('cancelled' as const)),
    ...overrides,
  }
}

function provider(options: {
  readonly process?: Readonly<Record<string, string>>
  readonly keychain?: KeychainCredentialBridge
  readonly legacy?: LegacyCredentialSource
} = {}): KeychainCredentialProvider {
  const ctx = new Context()
  ctx.provide(DSH_LAUNCH_ENVIRONMENT_KEY, createLaunchEnvironmentSnapshot([
    { source: 'process', values: options.process ?? {} },
  ]))
  return new KeychainCredentialProvider(ctx, {
    bridge: options.keychain ?? bridge(),
    ...options.legacy === undefined ? {} : { legacy: options.legacy },
  })
}

describe('Keychain credential provider', () => {
  it('uses inherited process environment first and reports it read-only', async () => {
    const describeCredential = vi.fn(() => Promise.resolve({
      configured: true,
      source: 'keychain' as const,
      writable: true,
    }))
    const resolveCredential = vi.fn(() => Promise.resolve(resolved('keychain-value')))
    const keychain = bridge({
      describeCredential,
      resolveCredential,
    })
    const credentials = provider({
      process: { DEEPSEEK_API_KEY: 'process-value' },
      keychain,
      legacy: {
        resolve: vi.fn(() => Promise.resolve('legacy-value')),
        describe: vi.fn(() => Promise.resolve({ configured: true, writable: false })),
      },
    })

    await expect(credentials.resolve(REF)).resolves.toEqual({
      value: 'process-value',
      source: 'environment',
    })
    await expect(credentials.describe(REF)).resolves.toEqual({
      configured: true,
      source: 'environment',
      writable: false,
    })
    await expect(credentials.set(REF, 'replacement')).rejects.toThrow(/read-only environment/)
    await expect(credentials.unset(REF)).rejects.toThrow(/read-only environment/)
    expect(resolveCredential).not.toHaveBeenCalled()
    expect(describeCredential).not.toHaveBeenCalled()
  })

  it('reports a Keychain hit as read-only through the direct provider contract', async () => {
    const keychain = bridge({
      describeCredential: vi.fn(() => Promise.resolve({
        configured: true,
        source: 'keychain' as const,
        writable: true,
      })),
      resolveCredential: vi.fn(() => Promise.resolve(resolved('keychain-value'))),
    })
    const credentials = provider({ keychain })

    await expect(credentials.describe(REF)).resolves.toEqual({
      configured: true,
      source: 'keychain',
      writable: false,
    })
    await expect(credentials.set(REF, 'replacement')).rejects.toThrow(/native-confirmed/)
    await expect(credentials.unset(REF)).rejects.toThrow(/native-confirmed/)
    await expect(credentials.resolve(REF)).resolves.toEqual({
      value: 'keychain-value',
      source: 'keychain',
    })
  })

  it('reports an unconfigured reference as read-only when direct writes are unsupported', async () => {
    const credentials = provider()

    await expect(credentials.describe(REF)).resolves.toEqual({
      configured: false,
      writable: false,
    })
    await expect(credentials.set(REF, 'replacement')).rejects.toThrow(/native-confirmed/)
  })

  it('uses an optional legacy source only after an absent Keychain and keeps it read-only', async () => {
    const legacy = {
      resolve: vi.fn(() => Promise.resolve('legacy-value')),
      describe: vi.fn(() => Promise.resolve({ configured: true, writable: false })),
    } satisfies LegacyCredentialSource
    const credentials = provider({ legacy })

    await expect(credentials.resolve(REF)).resolves.toEqual({
      value: 'legacy-value',
      source: 'legacy-file',
    })
    await expect(credentials.describe(REF)).resolves.toEqual({
      configured: true,
      source: 'legacy-file',
      writable: false,
    })
  })

  it('preserves the native legacy-file source for a legacy-first bridge resolution', async () => {
    const bytes = secret('legacy-authority')
    const credentials = provider({
      keychain: bridge({
        resolveCredential: vi.fn(() => Promise.resolve(resolved(bytes, 'legacy-file'))),
        describeCredential: vi.fn(() => Promise.resolve({
          configured: true,
          source: 'legacy-file' as const,
          writable: false,
        })),
      }),
    })

    await expect(credentials.resolve(REF)).resolves.toEqual({
      value: 'legacy-authority',
      source: 'legacy-file',
    })
    await expect(credentials.describe(REF)).resolves.toEqual({
      configured: true,
      source: 'legacy-file',
      writable: false,
    })
    expect(bytes).toEqual(new Array(bytes.length).fill(0))
  })

  it('resolves through the bridge on every call and does not cache plaintext', async () => {
    const resolveCredential = vi.fn()
      .mockResolvedValueOnce(resolved('first-value'))
      .mockResolvedValueOnce(resolved('rotated-value'))
    const credentials = provider({ keychain: bridge({ resolveCredential }) })

    await expect(credentials.resolve(REF)).resolves.toMatchObject({ value: 'first-value' })
    await expect(credentials.resolve(REF)).resolves.toMatchObject({ value: 'rotated-value' })
    expect(resolveCredential).toHaveBeenCalledTimes(2)
    expect(Object.keys(credentials)).not.toContain('value')
  })

  it('rejects invalid Openloop references before environment or bridge access without echoing them', async () => {
    const boundaryText = `A${'b'.repeat(MAX_OPENLOOP_CREDENTIAL_REFERENCE_BYTES - 1)}`
    const boundary = openloopCredentialRef(boundaryText)
    const overlongText = `${boundaryText}c`
    const overlong = credentialRef(overlongText)
    const nonAscii = 'UNICOD\u00c9_KEY' as CredentialRef
    const resolveCredential = vi.fn(() => Promise.resolve(resolved('keychain-value')))
    const credentials = provider({
      process: { [overlongText]: 'environment-value' },
      keychain: bridge({ resolveCredential }),
    })

    await expect(credentials.resolve(boundary)).resolves.toMatchObject({
      value: 'keychain-value',
    })
    for (const invalid of [overlong, nonAscii]) {
      const failure = await credentials.resolve(invalid)
        .then(() => undefined, (error: unknown) => error)
      expect(failure).toBeInstanceOf(TypeError)
      expect((failure as Error).message).toBe('credential reference is invalid')
      expect((failure as Error).message).not.toContain(String(invalid))
    }
    expect(resolveCredential).toHaveBeenCalledTimes(1)
  })

  it('zeroizes both bridge bytes and the temporary typed-array decode copy', async () => {
    const originalTextDecoder = globalThis.TextDecoder
    const bytes = secret('temporary-value')
    let decodedCopy: Uint8Array | undefined
    class InspectingTextDecoder {
      readonly #decoder = new originalTextDecoder('utf-8', { fatal: true })

      decode(input?: AllowSharedBufferSource): string {
        decodedCopy = input as Uint8Array
        return this.#decoder.decode(input)
      }
    }
    vi.stubGlobal('TextDecoder', InspectingTextDecoder)
    const credentials = provider({
      keychain: bridge({
        resolveCredential: vi.fn(() => Promise.resolve(resolved(bytes))),
      }),
    })

    try {
      await expect(credentials.resolve(REF)).resolves.toMatchObject({
        value: 'temporary-value',
      })
    } finally {
      vi.unstubAllGlobals()
    }
    expect(bytes).toEqual(new Array(bytes.length).fill(0))
    expect(decodedCopy).toBeDefined()
    expect([...decodedCopy!]).toEqual(new Array(decodedCopy!.length).fill(0))
  })

  it('accepts only bridge-safe Keychain payload sizes', async () => {
    const maximum = new Array<number>(MAX_OPENLOOP_SECRET_BYTES).fill(65)
    const oversized = new Array<number>(MAX_OPENLOOP_SECRET_BYTES + 1).fill(65)
    const resolveCredential = vi.fn()
      .mockResolvedValueOnce(resolved(maximum))
      .mockResolvedValueOnce(resolved(oversized))
    const credentials = provider({ keychain: bridge({ resolveCredential }) })

    await expect(credentials.resolve(REF)).resolves.toMatchObject({
      value: 'A'.repeat(MAX_OPENLOOP_SECRET_BYTES),
    })
    await expect(credentials.resolve(REF)).rejects.toThrow(/invalid credential payload/)
    expect(maximum).toEqual(new Array(maximum.length).fill(0))
    expect(oversized).toEqual(new Array(oversized.length).fill(0))
  })

  it('keeps resolve absent from the Browser Remote surface', () => {
    const service = new OpenloopDesktopRemoteService(new Context(), {
      call: vi.fn(() => Promise.resolve(null)),
    } as never)
    const methods = remoteMethods(service).map(marker => marker.exportName ?? marker.method)

    expect(methods).toContain('describeCredential')
    expect(methods).not.toContain('resolveCredential')
  })

  it('routes Browser credential actions through the Host-owned operations facade', async () => {
    const ctx = new Context()
    const deleteCredential = vi.fn(() => Promise.resolve('cancelled' as const))
    ctx.provide('openloopCredentialOperations', {
      describeCredential: vi.fn(() => Promise.resolve({ configured: false, writable: false })),
      openCredentialReplacement: vi.fn(() => Promise.resolve('cancelled' as const)),
      deleteCredential,
    })
    const call = vi.fn(() => Promise.resolve(null))
    const service = new OpenloopDesktopRemoteService(ctx, { call } as never)
    const signal = new AbortController().signal

    await expect(service.unsetCredential('DEEPSEEK_API_KEY', signal))
      .resolves.toBe('cancelled')
    expect(deleteCredential).toHaveBeenCalledWith('DEEPSEEK_API_KEY', signal)
    expect(call).not.toHaveBeenCalled()
  })
})
