import { describe, expect, it } from 'vitest'

import {
  deriveRoomKeyFromPassword,
  deriveRoomSecrets,
  generateRoomId,
  generateRoomKey,
  parseRoomId,
  parseRoomInvitation,
  parseRoomKey,
  roomPath,
} from './room-crypto'

describe('room addressing', () => {
  it('generates a six-character Crockford room ID', () => {
    const roomId = generateRoomId()

    expect(roomId).toMatch(/^[0-9A-HJKMNP-TV-Z]{6}$/)
    expect(roomPath(roomId)).toBe(`/r/${roomId}`)
  })

  it('accepts paths, lowercase input, and Crockford aliases', () => {
    expect(parseRoomId('/r/oilabc')).toBe('011ABC')
    expect(parseRoomId('https://secret.example/r/abc123')).toBe('ABC123')
  })

  it('rejects malformed or short room IDs', () => {
    expect(() => parseRoomId('1234')).toThrow('six letters or numbers')
    expect(() => parseRoomId('/rooms/ABC123')).toThrow('six letters or numbers')
  })

  it('keeps the 128-bit invitation key in the URL fragment', () => {
    const roomKey = generateRoomKey()
    const invitation = parseRoomInvitation(
      `https://secret.example/r/ABC123#${new URLSearchParams({ key: roomKey })}`,
    )

    expect(parseRoomKey(roomKey)).toBe(roomKey)
    expect(roomKey).toMatch(/^[A-Za-z0-9_-]{22}$/)
    expect(invitation).toEqual({ roomId: 'ABC123', roomKey })
  })
})

describe('room key derivation', () => {
  it('matches the protocol-v3 zero-key release vector', async () => {
    const derived = await deriveRoomSecrets('000000', 'A'.repeat(22))

    expect(derived.locator).toBe('P879icD8_cUFt9vhqkmXQoQtRZYNO_hrSpsv1kGvBR0')
    expect(derived.authToken).toBe('rw0hBg1j7YKxfKbobDf5nbpidxL3XaJhV81Bkm5aexw')
    expect(derived.authVerifier).toBe('IKMILNdgp8hp5MW6rEPYmoSzWbDn-EquhO2GUDARGi8')
  })

  it('derives a room-bound key from a password without exposing the password', async () => {
    const first = await deriveRoomKeyFromPassword('ABC123', 'correct horse battery staple')
    const second = await deriveRoomKeyFromPassword('ABC123', 'correct horse battery staple')
    const otherRoom = await deriveRoomKeyFromPassword('XYZ789', 'correct horse battery staple')

    expect(first).toBe(second)
    expect(first).not.toBe(otherRoom)
    expect(first).not.toContain('correct')
  })

  it('domain-separates routing, authentication, and content keys', async () => {
    const roomKey = generateRoomKey()
    const first = await deriveRoomSecrets('ABC123', roomKey)
    const second = await deriveRoomSecrets('ABC123', roomKey)
    const wrongKey = await deriveRoomSecrets('ABC123', generateRoomKey())

    expect(first.locator).toBe(second.locator)
    expect(first.locator).toBe(wrongKey.locator)
    expect(first.authToken).toBe(second.authToken)
    expect(first.authToken).not.toBe(wrongKey.authToken)
    expect(first.locator).not.toBe(first.authToken)
    expect(first.messageRoot.type).toBe('secret')
    expect(first.messageRoot.algorithm.name).toBe('HKDF')
    expect(first.messageRoot.extractable).toBe(false)
  })
})
