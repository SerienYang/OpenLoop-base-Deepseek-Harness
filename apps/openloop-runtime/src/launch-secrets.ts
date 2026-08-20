import { closeSync, readSync } from 'node:fs'

const MAGIC = Buffer.from('OLSP')
export const LAUNCH_SECRETS_PROTOCOL_VERSION = 1
export const LAUNCH_SECRETS_FD = 3
export const MAX_LAUNCH_SECRETS_FRAME_BYTES = 16 * 1024
const HEADER_BYTES = 10
const UUID_BYTES = 16
const MAX_TOKEN_BYTES = 4096
const MAX_SOCKET_PATH_BYTES = 1024

export interface LaunchSecrets {
  readonly launchId: string
  readonly bootstrapToken: Uint8Array
  readonly bridgeSecret: Uint8Array
  readonly socketPath: string
}

const consumedDescriptors = new Set<number>()

function fail(message: string): never {
  throw new Error(`openloop-runtime: invalid launch secret frame: ${message}`)
}

function uuidBytes(value: string): Buffer {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value)) {
    fail('launch id must be a UUID')
  }
  return Buffer.from(value.replaceAll('-', ''), 'hex')
}

function uuidString(value: Uint8Array): string {
  const hex = Buffer.from(value).toString('hex')
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join('-')
}

function fieldBytes(value: Uint8Array, label: string, maximum: number): Buffer {
  if (value.length === 0 || value.length > maximum) fail(`${label} length is out of bounds`)
  return Buffer.from(value)
}

export function encodeLaunchSecretsFrame(secrets: LaunchSecrets): Buffer {
  const launchId = uuidBytes(secrets.launchId.toLowerCase())
  const bootstrapToken = fieldBytes(secrets.bootstrapToken, 'bootstrap token', MAX_TOKEN_BYTES)
  const bridgeSecret = fieldBytes(secrets.bridgeSecret, 'bridge secret', MAX_TOKEN_BYTES)
  const socketPath = fieldBytes(Buffer.from(secrets.socketPath, 'utf8'), 'socket path', MAX_SOCKET_PATH_BYTES)
  const fields = [launchId, bootstrapToken, bridgeSecret, socketPath]
  const payloadBytes = fields.reduce((total, field) => total + 4 + field.length, 0)
  if (payloadBytes > MAX_LAUNCH_SECRETS_FRAME_BYTES - HEADER_BYTES) {
    fail('payload is oversized')
  }
  const frame = Buffer.alloc(HEADER_BYTES + payloadBytes)
  MAGIC.copy(frame, 0)
  frame.writeUInt16BE(LAUNCH_SECRETS_PROTOCOL_VERSION, 4)
  frame.writeUInt32BE(payloadBytes, 6)
  let offset = HEADER_BYTES
  for (const field of fields) {
    frame.writeUInt32BE(field.length, offset)
    offset += 4
    field.copy(frame, offset)
    offset += field.length
  }
  return frame
}

function copyField(frame: Buffer, offset: number, label: string, maximum: number): {
  bytes: Uint8Array
  offset: number
} {
  if (offset + 4 > frame.length) fail(`${label} length is truncated`)
  const length = frame.readUInt32BE(offset)
  offset += 4
  if (length === 0 || length > maximum || offset + length > frame.length) {
    fail(`${label} length is out of bounds`)
  }
  const bytes = Uint8Array.from(frame.subarray(offset, offset + length))
  return { bytes, offset: offset + length }
}

export function decodeLaunchSecretsFrame(input: Uint8Array): LaunchSecrets {
  const frame = Buffer.from(input)
  if (frame.length < HEADER_BYTES || frame.length > MAX_LAUNCH_SECRETS_FRAME_BYTES) {
    fail('frame length is out of bounds')
  }
  if (!frame.subarray(0, MAGIC.length).equals(MAGIC)) fail('magic is invalid')
  if (frame.readUInt16BE(4) !== LAUNCH_SECRETS_PROTOCOL_VERSION) fail('protocol version is unsupported')
  const payloadBytes = frame.readUInt32BE(6)
  if (payloadBytes > MAX_LAUNCH_SECRETS_FRAME_BYTES - HEADER_BYTES
    || HEADER_BYTES + payloadBytes !== frame.length) {
    fail('declared payload length does not match the frame')
  }
  let offset = HEADER_BYTES
  const launchId = copyField(frame, offset, 'launch id', UUID_BYTES)
  offset = launchId.offset
  if (launchId.bytes.length !== UUID_BYTES) fail('launch id length is invalid')
  const bootstrapToken = copyField(frame, offset, 'bootstrap token', MAX_TOKEN_BYTES)
  offset = bootstrapToken.offset
  const bridgeSecret = copyField(frame, offset, 'bridge secret', MAX_TOKEN_BYTES)
  offset = bridgeSecret.offset
  const socketPath = copyField(frame, offset, 'socket path', MAX_SOCKET_PATH_BYTES)
  offset = socketPath.offset
  if (offset !== frame.length) fail('trailing bytes are not allowed')
  let socket: string
  try {
    socket = new TextDecoder('utf-8', { fatal: true }).decode(socketPath.bytes)
  } catch {
    fail('socket path is not UTF-8')
  }
  if (socket.length === 0 || !socket.startsWith('/')) fail('socket path must be absolute')
  return {
    launchId: uuidString(launchId.bytes),
    bootstrapToken: bootstrapToken.bytes,
    bridgeSecret: bridgeSecret.bytes,
    socketPath: socket,
  }
}

export function readLaunchSecretsFromFd(fd = LAUNCH_SECRETS_FD): LaunchSecrets {
  if (consumedDescriptors.has(fd)) fail('descriptor has already been consumed')
  consumedDescriptors.add(fd)
  const chunks: Buffer[] = []
  let total = 0
  try {
    while (true) {
      const chunk = Buffer.allocUnsafe(Math.min(4096, MAX_LAUNCH_SECRETS_FRAME_BYTES + 1 - total))
      const bytesRead = readSync(fd, chunk, 0, chunk.length, null)
      if (bytesRead === 0) break
      chunks.push(chunk.subarray(0, bytesRead))
      total += bytesRead
      if (total > MAX_LAUNCH_SECRETS_FRAME_BYTES) fail('frame is oversized')
    }
    const frame = Buffer.concat(chunks, total)
    try {
      return decodeLaunchSecretsFrame(frame)
    } finally {
      frame.fill(0)
    }
  } finally {
    try { closeSync(fd) } catch {}
    for (const chunk of chunks) chunk.fill(0)
  }
}

export const readLaunchSecrets = readLaunchSecretsFromFd
