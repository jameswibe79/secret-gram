import { describe, expect, it } from 'vitest'

import {
  deriveRoomSecrets,
  formatRoomCodeFromSecret,
  generateRoomCode,
  parseRoomCode,
} from './room-crypto'

describe('room codes', () => {
  it('generates a 120-bit human-readable room code with a checksum', async () => {
    const code = await generateRoomCode()

    expect(code).toMatch(
      /^[0-9A-HJKMNP-TV-Z]{4}(?:-[0-9A-HJKMNP-TV-Z]{4}){5}-[0-9A-HJKMNP-TV-Z]{2}$/,
    )
    expect(parseRoomCode(code)).toHaveLength(15)
  })

  it('accepts lowercase, whitespace, and Crockford aliases', async () => {
    const secret = new Uint8Array(15)
    const code = await formatRoomCodeFromSecret(secret)
    const humanInput = code.toLowerCase().replaceAll('0', 'o').replaceAll('-', ' ')

    expect(parseRoomCode(humanInput)).toEqual(secret)
  })

  it('rejects a mistyped checksum', async () => {
    const code = await generateRoomCode()
    const replacement = code.endsWith('0') ? '1' : '0'

    expect(() => parseRoomCode(`${code.slice(0, -1)}${replacement}`)).toThrow(
      'Room code checksum failed',
    )
  })
})

describe('room key derivation', () => {
  it('matches the protocol-v2 zero-secret release vector', async () => {
    const secret = new Uint8Array(15)
    const derived = await deriveRoomSecrets(secret)

    expect(await formatRoomCodeFromSecret(secret)).toBe('0000-0000-0000-0000-0000-0000-00')
    expect(derived.locator).toBe('cayZeEBmy_ieNL0qWzAIpl_ItaAE_YRuuDcyrk9wOJ8')
    expect(derived.authToken).toBe('zmWmVOTMgu2cIkelbxWq9xepoUC5BplpZXDNXbLuFes')
    expect(derived.authVerifier).toBe('h3gl9VyVIVK08mGPMCvBp7FPGJepDR6ggMpgxzhRfWk')
  })

  it('is deterministic and domain-separates routing, authentication, and content keys', async () => {
    const secret = crypto.getRandomValues(new Uint8Array(15))
    const first = await deriveRoomSecrets(secret)
    const second = await deriveRoomSecrets(secret)

    expect(first.locator).toBe(second.locator)
    expect(first.authToken).toBe(second.authToken)
    expect(first.authVerifier).toBe(second.authVerifier)
    expect(first.locator).not.toBe(first.authToken)
    expect(first.authVerifier).not.toBe(first.authToken)
    expect(first.messageRoot.type).toBe('secret')
    expect(first.messageRoot.algorithm.name).toBe('HKDF')
    expect(first.messageRoot.extractable).toBe(false)
  })
})
