import { createHmac, timingSafeEqual } from 'node:crypto'

export const BRIDGE_PROTOCOL_VERSION = 1 as const
export const MAX_BRIDGE_FRAME_BYTES = 64 * 1024
const BRIDGE_NONCE_BYTES = 32

const REQUEST_DOMAIN = Buffer.from('openloop.bridge.request.v1\0')
const RESPONSE_DOMAIN = Buffer.from('openloop.bridge.response.v1\0')
const LOWER_HEX_32_BYTES = /^[0-9a-f]{64}$/u

export interface BridgeRequest {
  readonly version: 1
  readonly requestId: string
  readonly launchId: string
  readonly method: string
  readonly payload: unknown
}

export interface AuthenticatedBridgeRequest {
  readonly request: BridgeRequest
  readonly nonce: string
  readonly mac: string
}

interface BridgeError {
  readonly code: string
  readonly message: string
}

export type BridgeResponse =
  | {
    readonly version: 1
    readonly requestId: string
    readonly ok: true
    readonly result: unknown
    readonly error?: never
  }
  | {
    readonly version: 1
    readonly requestId: string
    readonly ok: false
    readonly result?: never
    readonly error: BridgeError
  }

export interface AuthenticatedBridgeResponse {
  readonly response: BridgeResponse
  readonly nonce: string
  readonly mac: string
}

export interface BridgeVerification {
  readonly launchId: string
  readonly secret: Uint8Array
  readonly nonces: NonceReplayGuard
}

/** Bounded launch-local replay set. Claims are synchronous and therefore atomic in Node. */
export class NonceReplayGuard {
  readonly #maximum: number
  readonly #seen = new Set<string>()

  constructor(maximum = 4096) {
    if (!Number.isSafeInteger(maximum) || maximum <= 0) {
      throw new TypeError('bridge nonce cache size must be a positive safe integer')
    }
    this.#maximum = maximum
  }

  claim(nonceHex: string): void {
    if (this.#seen.has(nonceHex)) throw new Error('bridge nonce replay rejected')
    if (this.#seen.size >= this.#maximum) {
      throw new Error('bridge nonce cache is exhausted')
    }
    this.#seen.add(nonceHex)
  }
}

export function canonicalRequestBytes(
  request: BridgeRequest,
  nonce: Uint8Array,
): Uint8Array {
  validateRequest(request)
  if (nonce.length !== BRIDGE_NONCE_BYTES) {
    throw new TypeError('bridge nonce must contain exactly 32 bytes')
  }
  return Buffer.concat([
    REQUEST_DOMAIN,
    nonce,
    uint32(request.version),
    field(request.requestId),
    field(request.launchId),
    field(request.method),
    field(canonicalJson(request.payload)),
  ])
}

export function authenticateBridgeRequest(
  request: BridgeRequest,
  nonce: Uint8Array,
  secret: Uint8Array,
): AuthenticatedBridgeRequest {
  requireSecret(secret)
  return {
    request,
    nonce: Buffer.from(nonce).toString('hex'),
    mac: createHmac('sha256', secret)
      .update(canonicalRequestBytes(request, nonce))
      .digest('hex'),
  }
}

export function verifyBridgeRequest(
  value: unknown,
  expected: BridgeVerification,
): BridgeRequest {
  const envelope = parseAuthenticatedRequest(value)
  if (envelope.request.launchId !== expected.launchId) {
    throw new Error('bridge launch is not current')
  }
  const nonce = Buffer.from(envelope.nonce, 'hex')
  const signed = authenticateBridgeRequest(envelope.request, nonce, expected.secret)
  if (!constantTimeHexEqual(envelope.mac, signed.mac)) {
    throw new Error('bridge request authentication failed')
  }
  expected.nonces.claim(envelope.nonce)
  return envelope.request
}

export function authenticateBridgeResponse(
  response: BridgeResponse,
  nonce: Uint8Array,
  secret: Uint8Array,
): AuthenticatedBridgeResponse {
  validateResponse(response)
  requireSecret(secret)
  if (nonce.length !== BRIDGE_NONCE_BYTES) {
    throw new TypeError('bridge nonce must contain exactly 32 bytes')
  }
  return {
    response,
    nonce: Buffer.from(nonce).toString('hex'),
    mac: createHmac('sha256', secret)
      .update(canonicalResponseBytes(response, nonce))
      .digest('hex'),
  }
}

export function verifyBridgeResponse(
  value: unknown,
  expected: {
    readonly requestId: string
    readonly nonce: Uint8Array
    readonly secret: Uint8Array
  },
): BridgeResponse {
  const envelope = parseAuthenticatedResponse(value)
  if (envelope.response.requestId !== expected.requestId) {
    throw new Error('bridge response request id does not match')
  }
  const expectedNonce = Buffer.from(expected.nonce).toString('hex')
  if (!constantTimeHexEqual(envelope.nonce, expectedNonce)) {
    throw new Error('bridge response nonce does not match')
  }
  const signed = authenticateBridgeResponse(envelope.response, expected.nonce, expected.secret)
  if (!constantTimeHexEqual(envelope.mac, signed.mac)) {
    throw new Error('bridge response authentication failed')
  }
  return envelope.response
}

export function encodeBridgeFrame(value: unknown): Uint8Array {
  const body = Buffer.from(canonicalJson(value))
  if (body.length === 0 || body.length > MAX_BRIDGE_FRAME_BYTES) {
    throw new Error('bridge frame is oversized or empty')
  }
  const header = Buffer.allocUnsafe(4)
  header.writeUInt32BE(body.length)
  return Buffer.concat([header, body])
}

export function decodeBridgeFrame(frame: Uint8Array): unknown {
  if (frame.length < 4) throw new Error('bridge frame header is truncated')
  const bytes = Buffer.from(frame.buffer, frame.byteOffset, frame.byteLength)
  const bodyLength = bytes.readUInt32BE(0)
  if (bodyLength === 0 || bodyLength > MAX_BRIDGE_FRAME_BYTES) {
    throw new Error('bridge frame is oversized or empty')
  }
  if (bytes.length !== bodyLength + 4) {
    throw new Error('bridge frame length does not match')
  }
  return JSON.parse(bytes.subarray(4).toString('utf8')) as unknown
}

function canonicalResponseBytes(response: BridgeResponse, nonce: Uint8Array): Uint8Array {
  const body = response.ok
    ? { ok: true, result: response.result }
    : { error: response.error, ok: false }
  return Buffer.concat([
    RESPONSE_DOMAIN,
    nonce,
    uint32(response.version),
    field(response.requestId),
    field(canonicalJson(body)),
  ])
}

function parseAuthenticatedRequest(value: unknown): AuthenticatedBridgeRequest {
  const envelope = exactRecord(value, ['request', 'nonce', 'mac'], 'bridge request envelope')
  if (typeof envelope.nonce !== 'string' || !LOWER_HEX_32_BYTES.test(envelope.nonce)
    || typeof envelope.mac !== 'string' || !LOWER_HEX_32_BYTES.test(envelope.mac)) {
    throw new TypeError('bridge request authentication fields are invalid')
  }
  const parsed = exactRecord(
    envelope.request,
    ['version', 'requestId', 'launchId', 'method', 'payload'],
    'bridge request',
  )
  const request = parsed as unknown as BridgeRequest
  validateRequest(request)
  return { request, nonce: envelope.nonce, mac: envelope.mac }
}

function parseAuthenticatedResponse(value: unknown): AuthenticatedBridgeResponse {
  const envelope = exactRecord(value, ['response', 'nonce', 'mac'], 'bridge response envelope')
  if (typeof envelope.nonce !== 'string' || !LOWER_HEX_32_BYTES.test(envelope.nonce)
    || typeof envelope.mac !== 'string' || !LOWER_HEX_32_BYTES.test(envelope.mac)) {
    throw new TypeError('bridge response authentication fields are invalid')
  }
  const response = envelope.response as BridgeResponse
  validateResponse(response)
  return { response, nonce: envelope.nonce, mac: envelope.mac }
}

function validateRequest(request: BridgeRequest): void {
  if ((request as { readonly version: unknown }).version !== BRIDGE_PROTOCOL_VERSION) {
    throw new TypeError('bridge protocol version is unsupported')
  }
  if (typeof request.requestId !== 'string' || request.requestId.length === 0
    || typeof request.launchId !== 'string' || request.launchId.length === 0
    || typeof request.method !== 'string' || request.method.length === 0) {
    throw new TypeError('bridge request fields are invalid')
  }
  canonicalJson(request.payload)
}

function validateResponse(response: BridgeResponse): void {
  const fields = response.ok
    ? ['version', 'requestId', 'ok', 'result']
    : ['version', 'requestId', 'ok', 'error']
  exactRecord(response, fields, 'bridge response')
  if ((response as { readonly version: unknown }).version !== BRIDGE_PROTOCOL_VERSION
    || typeof response.requestId !== 'string' || response.requestId.length === 0) {
    throw new TypeError('bridge response fields are invalid')
  }
  if (response.ok) {
    canonicalJson(response.result)
  } else if (typeof response.error.code !== 'string'
    || response.error.code.length === 0
    || typeof response.error.message !== 'string') {
    throw new TypeError('bridge response error is invalid')
  } else {
    exactRecord(response.error, ['code', 'message'], 'bridge response error')
  }
}

function exactRecord(value: unknown, fields: readonly string[], label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`)
  }
  const actual = Reflect.ownKeys(value)
  if (actual.length !== fields.length
    || actual.some(key => typeof key !== 'string' || !fields.includes(key))) {
    throw new TypeError(`${label} fields are invalid`)
  }
  return value as Record<string, unknown>
}

function canonicalJson(value: unknown, ancestors = new Set<object>()): string {
  if (value === null) return 'null'
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (typeof value === 'string') {
    if (/[\uD800-\uDFFF]/u.test(value)) {
      throw new TypeError('bridge JSON strings must not contain UTF-16 surrogate code units')
    }
    return JSON.stringify(value)
  }
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) {
      throw new TypeError('bridge JSON numbers must be safe integers')
    }
    return String(value)
  }
  if (typeof value !== 'object') {
    throw new TypeError('bridge values must be canonical JSON')
  }
  if (ancestors.has(value)) throw new TypeError('bridge values must not be cyclic')
  ancestors.add(value)
  try {
    if (Array.isArray(value)) {
      return `[${value.map(entry => canonicalJson(entry, ancestors)).join(',')}]`
    }
    const prototype = Object.getPrototypeOf(value) as object | null
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError('bridge JSON objects must be plain records')
    }
    const record = value as Record<string, unknown>
    const keys = Reflect.ownKeys(record)
    if (keys.some(key => typeof key !== 'string')) {
      throw new TypeError('bridge JSON objects must have string keys')
    }
    const sorted = (keys as string[]).sort()
    return `{${sorted.map(key => `${canonicalJson(key)}:${canonicalJson(record[key], ancestors)}`).join(',')}}`
  } finally {
    ancestors.delete(value)
  }
}

function field(value: string): Buffer {
  const bytes = Buffer.from(value)
  return Buffer.concat([uint32(bytes.length), bytes])
}

function uint32(value: number): Buffer {
  if (!Number.isSafeInteger(value) || value < 0 || value > 0xffff_ffff) {
    throw new TypeError('bridge canonical field length is out of bounds')
  }
  const bytes = Buffer.allocUnsafe(4)
  bytes.writeUInt32BE(value)
  return bytes
}

function requireSecret(secret: Uint8Array): void {
  if (secret.length < 32) throw new TypeError('bridge secret must contain at least 32 bytes')
}

function constantTimeHexEqual(actual: string, expected: string): boolean {
  if (!LOWER_HEX_32_BYTES.test(actual) || !LOWER_HEX_32_BYTES.test(expected)) return false
  return timingSafeEqual(Buffer.from(actual, 'hex'), Buffer.from(expected, 'hex'))
}
