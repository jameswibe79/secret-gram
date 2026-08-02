import { bytesToBase64Url } from './encoding'

const CROCKFORD_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
const ROOM_SECRET_BYTES = 15
const ROOM_DATA_SYMBOLS = 24
const ROOM_CHECK_SYMBOLS = 2
const ROOM_TOTAL_SYMBOLS = ROOM_DATA_SYMBOLS + ROOM_CHECK_SYMBOLS
const ROOM_CODE_GROUP_SIZE = 4

const encoder = new TextEncoder()

export interface RoomSecrets {
  locator: string
  authToken: string
  authVerifier: string
  messageRoot: CryptoKey
}

function normalizeSymbol(symbol: string): string {
  if (symbol === 'O') return '0'
  if (symbol === 'I' || symbol === 'L') return '1'
  return symbol
}

function alphabetIndex(symbol: string): number {
  return CROCKFORD_ALPHABET.indexOf(normalizeSymbol(symbol))
}

function encodeBase32(bytes: Uint8Array): string {
  let accumulator = 0
  let bits = 0
  let output = ''

  for (const byte of bytes) {
    accumulator = (accumulator << 8) | byte
    bits += 8

    while (bits >= 5) {
      bits -= 5
      output += CROCKFORD_ALPHABET[(accumulator >>> bits) & 31]
      accumulator &= (1 << bits) - 1
    }
  }

  if (bits > 0) {
    output += CROCKFORD_ALPHABET[(accumulator << (5 - bits)) & 31]
  }

  return output
}

function decodeBase32(value: string): Uint8Array {
  let accumulator = 0
  let bits = 0
  const bytes: number[] = []

  for (const symbol of value) {
    const index = alphabetIndex(symbol)
    if (index < 0) {
      throw new Error('Room code contains invalid characters')
    }

    accumulator = (accumulator << 5) | index
    bits += 5

    while (bits >= 8) {
      bits -= 8
      bytes.push((accumulator >>> bits) & 0xff)
      accumulator &= (1 << bits) - 1
    }
  }

  return new Uint8Array(bytes)
}

function checksum(secret: Uint8Array): string {
  // CRC-10/ATM catches all one-bit errors and all bursts up to 10 bits.
  let crc = 0
  for (const byte of secret) {
    crc ^= byte << 2
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc & 0x200) !== 0 ? ((crc << 1) ^ 0x233) & 0x3ff : (crc << 1) & 0x3ff
    }
  }

  return `${CROCKFORD_ALPHABET[(crc >>> 5) & 31]}${CROCKFORD_ALPHABET[crc & 31]}`
}

function formatGroups(symbols: string): string {
  const groups: string[] = []
  for (let index = 0; index < symbols.length; index += ROOM_CODE_GROUP_SIZE) {
    groups.push(symbols.slice(index, index + ROOM_CODE_GROUP_SIZE))
  }
  return groups.join('-')
}

async function hkdfBits(
  secret: Uint8Array,
  label: string,
): Promise<Uint8Array<ArrayBuffer>> {
  const key = await crypto.subtle.importKey('raw', new Uint8Array(secret), 'HKDF', false, [
    'deriveBits',
  ])
  const bits = await crypto.subtle.deriveBits(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: encoder.encode('secretgram/v1/hkdf-salt'),
      info: encoder.encode(`secretgram/v1/${label}`),
    },
    key,
    256,
  )
  return new Uint8Array(bits)
}

export async function formatRoomCodeFromSecret(secret: Uint8Array): Promise<string> {
  if (secret.byteLength !== ROOM_SECRET_BYTES) {
    throw new Error('Room secret must contain 120 bits')
  }

  const encoded = encodeBase32(secret)
  if (encoded.length !== ROOM_DATA_SYMBOLS) {
    throw new Error('Unable to encode room code')
  }

  return formatGroups(`${encoded}${checksum(secret)}`)
}

export async function generateRoomCode(): Promise<string> {
  const secret = crypto.getRandomValues(new Uint8Array(ROOM_SECRET_BYTES))
  return formatRoomCodeFromSecret(secret)
}

export function parseRoomCode(input: string): Uint8Array {
  const normalized = [...input.toUpperCase().replace(/[\s-]/gu, '')]
    .map(normalizeSymbol)
    .join('')

  if (normalized.length !== ROOM_TOTAL_SYMBOLS) {
    throw new Error('Room code must contain 26 characters')
  }
  if ([...normalized].some((symbol) => alphabetIndex(symbol) < 0)) {
    throw new Error('Room code contains invalid characters')
  }

  const encodedSecret = normalized.slice(0, ROOM_DATA_SYMBOLS)
  const suppliedChecksum = normalized.slice(ROOM_DATA_SYMBOLS)
  const secret = decodeBase32(encodedSecret)

  if (secret.byteLength !== ROOM_SECRET_BYTES || checksum(secret) !== suppliedChecksum) {
    throw new Error('Room code checksum failed')
  }

  return secret
}

export async function deriveRoomSecrets(secret: Uint8Array): Promise<RoomSecrets> {
  if (secret.byteLength !== ROOM_SECRET_BYTES) {
    throw new Error('Room secret must contain 120 bits')
  }

  const [locatorBytes, authBytes, messageRootBytes] = await Promise.all([
    hkdfBits(secret, 'room-locator'),
    hkdfBits(secret, 'room-authentication'),
    hkdfBits(secret, 'message-content-root'),
  ])
  const authVerifierBytes = new Uint8Array(await crypto.subtle.digest('SHA-256', authBytes))
  const messageRoot = await crypto.subtle.importKey(
    'raw',
    messageRootBytes,
    'HKDF',
    false,
    ['deriveKey'],
  )

  return {
    locator: bytesToBase64Url(locatorBytes),
    authToken: bytesToBase64Url(authBytes),
    authVerifier: bytesToBase64Url(authVerifierBytes),
    messageRoot,
  }
}
