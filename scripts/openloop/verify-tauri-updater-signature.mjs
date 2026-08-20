import {
  createHash,
  createPublicKey,
  verify,
} from 'node:crypto'

const base64Pattern = /^[A-Za-z0-9+/]+={0,2}$/u
const ed25519SpkiPrefix = Buffer.from('302a300506032b6570032100', 'hex')

function decodeCanonicalBase64(value, label) {
  if (typeof value !== 'string'
    || value === ''
    || value.length % 4 !== 0
    || !base64Pattern.test(value)) {
    throw new Error(`${label} must be non-empty canonical base64`)
  }
  const decoded = Buffer.from(value, 'base64')
  if (decoded.toString('base64') !== value) {
    throw new Error(`${label} must be canonical base64`)
  }
  return decoded
}

function decodeUtf8(bytes, label) {
  const value = bytes.toString('utf8')
  if (!Buffer.from(value, 'utf8').equals(bytes)) {
    throw new Error(`${label} must decode to UTF-8`)
  }
  return value
}

function linesWithoutFinalNewline(value) {
  const lines = value.split(/\r?\n/u)
  if (lines.at(-1) === '') lines.pop()
  return lines
}

function supportedAlgorithm(bytes) {
  return bytes[0] === 0x45 && (bytes[1] === 0x64 || bytes[1] === 0x44)
}

function parseUpdaterPublicKey(value) {
  if (typeof value !== 'string' || value.trim() !== value) {
    throw new Error('Tauri updater public key must not contain surrounding whitespace')
  }
  const decoded = decodeUtf8(
    decodeCanonicalBase64(value, 'Tauri updater public key'),
    'Tauri updater public key',
  )
  const lines = linesWithoutFinalNewline(decoded)
  if (lines.length !== 2 || !lines[0].startsWith('untrusted comment: ')) {
    throw new Error('Tauri updater public key must contain Minisign public key data')
  }
  const keyBytes = decodeCanonicalBase64(lines[1], 'Minisign public key')
  if (keyBytes.length !== 42 || !supportedAlgorithm(keyBytes)) {
    throw new Error('Tauri updater public key uses invalid Minisign key data')
  }
  const key = createPublicKey({
    key: Buffer.concat([ed25519SpkiPrefix, keyBytes.subarray(10)]),
    format: 'der',
    type: 'spki',
  })
  return {
    key,
    keyId: keyBytes.subarray(2, 10),
  }
}

function parseUpdaterSignature(value) {
  const encoded = typeof value === 'string' ? value.trim() : ''
  const decoded = decodeUtf8(
    decodeCanonicalBase64(encoded, 'Tauri updater signature'),
    'Tauri updater signature',
  )
  const lines = linesWithoutFinalNewline(decoded)
  if (lines.length !== 4
    || !lines[0].startsWith('untrusted comment: ')
    || !lines[2].startsWith('trusted comment: ')) {
    throw new Error('Tauri updater signature must contain Minisign signature data')
  }
  const signatureBytes = decodeCanonicalBase64(lines[1], 'Minisign signature')
  const globalSignature = decodeCanonicalBase64(lines[3], 'Minisign global signature')
  if (signatureBytes.length !== 74
    || globalSignature.length !== 64
    || !supportedAlgorithm(signatureBytes)) {
    throw new Error('Tauri updater signature uses invalid Minisign signature data')
  }
  return {
    encoded,
    algorithm: signatureBytes.subarray(0, 2),
    keyId: signatureBytes.subarray(2, 10),
    signature: signatureBytes.subarray(10),
    trustedComment: lines[2].slice('trusted comment: '.length),
    globalSignature,
  }
}

export function assertTauriUpdaterPublicKey(value) {
  parseUpdaterPublicKey(value)
}

/** Match tauri-plugin-updater's Minisign verification, including legacy Ed signatures. */
export function verifyTauriUpdaterSignature({ artifactBytes, signature, publicKey }) {
  const parsedKey = parseUpdaterPublicKey(publicKey)
  const parsedSignature = parseUpdaterSignature(signature)
  if (!parsedKey.keyId.equals(parsedSignature.keyId)) {
    throw new Error('Tauri updater signature key ID does not match the public key')
  }
  const message = parsedSignature.algorithm[1] === 0x44
    ? createHash('blake2b512').update(artifactBytes).digest()
    : artifactBytes
  if (!verify(null, message, parsedKey.key, parsedSignature.signature)) {
    throw new Error('Tauri updater Minisign signature verification failed')
  }
  const globalMessage = Buffer.concat([
    parsedSignature.signature,
    Buffer.from(parsedSignature.trustedComment, 'utf8'),
  ])
  if (!verify(
    null,
    globalMessage,
    parsedKey.key,
    parsedSignature.globalSignature,
  )) {
    throw new Error('Tauri updater Minisign global signature verification failed')
  }
  return parsedSignature.encoded
}
