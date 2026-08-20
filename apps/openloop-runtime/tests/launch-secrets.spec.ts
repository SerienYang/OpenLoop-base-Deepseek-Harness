import { describe, expect, test } from 'vitest'
import {
  decodeLaunchSecretsFrame,
  encodeLaunchSecretsFrame,
  type LaunchSecrets,
} from '../src/launch-secrets.ts'

const launchId = '8f5d7e17-9b2b-4b2c-9c2a-1f3e6b2a4d90'

function secrets(): LaunchSecrets {
  return {
    launchId,
    bootstrapToken: Uint8Array.from([1, 2, 3, 4]),
    bridgeSecret: Uint8Array.from([5, 6, 7, 8]),
    socketPath: '/tmp/openloop-test.sock',
  }
}

describe('launch secrets frame', () => {
  test('round-trips one bounded frame without exposing secrets in metadata', () => {
    const frame = encodeLaunchSecretsFrame(secrets())
    const decoded = decodeLaunchSecretsFrame(frame)

    expect(decoded.launchId).toBe(launchId)
    expect(decoded.bootstrapToken).toEqual(Uint8Array.from([1, 2, 3, 4]))
    expect(decoded.bridgeSecret).toEqual(Uint8Array.from([5, 6, 7, 8]))
    expect(decoded.socketPath).toBe('/tmp/openloop-test.sock')
    expect(JSON.stringify(decoded)).not.toContain('1,2,3,4')
  })

  test.each([
    ['wrong protocol version', (frame: Buffer) => { frame.writeUInt16BE(99, 4) }],
    ['oversized field', (frame: Buffer) => { frame.writeUInt32BE(65_537, 10) }],
  ])('rejects %s', (_label, mutate) => {
    const frame = Buffer.from(encodeLaunchSecretsFrame(secrets()))
    mutate(frame)
    expect(() => decodeLaunchSecretsFrame(frame)).toThrow()
  })

  test('rejects a frame with bytes after its declared payload', () => {
    const frame = Buffer.from(encodeLaunchSecretsFrame(secrets()))
    const trailing = Buffer.concat([frame, Buffer.from([0xaa])])
    expect(() => decodeLaunchSecretsFrame(trailing)).toThrow(/trailing|length/iu)
  })
})
