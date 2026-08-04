import { base64UrlToBytes, bytesToBase64Url } from './encoding'

const CROCKFORD_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
const ROOM_ID_LENGTH = 6
const ROOM_KEY_BYTES = 16
const PASSWORD_KDF_ITERATIONS = 600_000

const encoder = new TextEncoder()

export const ROOM_PASSWORD_MIN_LENGTH = 8

export interface RoomSecrets {
  locator: string
  authToken: string
  authVerifier: string
  messageRoot: CryptoKey
}

export interface RoomInvitation {
  roomId: string
  roomKey?: string
}

function normalizeSymbol(symbol: string): string {
  if (symbol === 'O') return '0'
  if (symbol === 'I' || symbol === 'L') return '1'
  return symbol
}

export function parseRoomId(input: string): string {
  let candidate = input.trim()
  if (candidate.includes('://')) {
    candidate = new URL(candidate).pathname
  }
  candidate = candidate.replace(/^\/?r\//iu, '').replace(/\/$/u, '')
  const normalized = [...candidate.toUpperCase()]
    .map(normalizeSymbol)
    .join('')

  if (
    normalized.length !== ROOM_ID_LENGTH ||
    [...normalized].some((symbol) => !CROCKFORD_ALPHABET.includes(symbol))
  ) {
    throw new Error('Room ID must contain six letters or numbers')
  }
  return normalized
}

export function parseRoomInvitation(input: string): RoomInvitation {
  const trimmed = input.trim()
  if (!trimmed.includes('://') && !trimmed.startsWith('/')) {
    return { roomId: parseRoomId(trimmed) }
  }
  const invitation = new URL(trimmed, 'https://secretgram.invalid')
  const roomId = parseRoomId(invitation.pathname)
  const candidateKey = new URLSearchParams(invitation.hash.slice(1)).get('key')
  return {
    roomId,
    ...(candidateKey === null ? {} : { roomKey: parseRoomKey(candidateKey) }),
  }
}

export function roomPath(roomId: string): string {
  return `/r/${parseRoomId(roomId)}`
}

export function generateRoomId(): string {
  const random = crypto.getRandomValues(new Uint8Array(ROOM_ID_LENGTH))
  return [...random]
    .map((value) => CROCKFORD_ALPHABET[value & 31])
    .join('')
}

export function generateRoomKey(): string {
  return bytesToBase64Url(crypto.getRandomValues(new Uint8Array(ROOM_KEY_BYTES)))
}

function roomKeyBytes(roomKey: string | Uint8Array): Uint8Array<ArrayBuffer> {
  const bytes = typeof roomKey === 'string'
    ? base64UrlToBytes(roomKey)
    : new Uint8Array(roomKey)
  if (bytes.byteLength !== ROOM_KEY_BYTES) {
    throw new Error('Room key must contain 128 bits')
  }
  return bytes
}

export function parseRoomKey(roomKey: string): string {
  return bytesToBase64Url(roomKeyBytes(roomKey))
}

export async function deriveRoomKeyFromPassword(
  roomId: string,
  password: string,
): Promise<string> {
  const canonicalRoomId = parseRoomId(roomId)
  if (password.length < ROOM_PASSWORD_MIN_LENGTH) {
    throw new Error(`Room password must contain at least ${ROOM_PASSWORD_MIN_LENGTH} characters`)
  }
  const passwordKey = await crypto.subtle.importKey(
    'raw',
    encoder.encode(password),
    'PBKDF2',
    false,
    ['deriveBits'],
  )
  const bits = await crypto.subtle.deriveBits(
    {
      name: 'PBKDF2',
      hash: 'SHA-256',
      salt: encoder.encode(`secretgram/v3/password\n${canonicalRoomId}`),
      iterations: PASSWORD_KDF_ITERATIONS,
    },
    passwordKey,
    ROOM_KEY_BYTES * 8,
  )
  return bytesToBase64Url(new Uint8Array(bits))
}

async function hkdfBits(
  roomId: string,
  roomKey: Uint8Array,
  label: string,
): Promise<Uint8Array<ArrayBuffer>> {
  const key = await crypto.subtle.importKey('raw', new Uint8Array(roomKey), 'HKDF', false, [
    'deriveBits',
  ])
  const bits = await crypto.subtle.deriveBits(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: encoder.encode(`secretgram/v3/hkdf-salt\n${roomId}`),
      info: encoder.encode(`secretgram/v3/${label}`),
    },
    key,
    256,
  )
  return new Uint8Array(bits)
}

export async function deriveRoomSecrets(
  roomId: string,
  roomKey: string | Uint8Array,
): Promise<RoomSecrets> {
  const canonicalRoomId = parseRoomId(roomId)
  const keyBytes = roomKeyBytes(roomKey)
  const locatorInput = encoder.encode(`secretgram/v3/room-locator\n${canonicalRoomId}`)
  const [locatorDigest, authBytes, messageRootBytes] = await Promise.all([
    crypto.subtle.digest('SHA-256', locatorInput),
    hkdfBits(canonicalRoomId, keyBytes, 'room-authentication'),
    hkdfBits(canonicalRoomId, keyBytes, 'message-content-root'),
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
    locator: bytesToBase64Url(new Uint8Array(locatorDigest)),
    authToken: bytesToBase64Url(authBytes),
    authVerifier: bytesToBase64Url(authVerifierBytes),
    messageRoot,
  }
}
