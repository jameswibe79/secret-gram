import { describe, expect, it } from 'vitest'

import { plainMessageSchema, storedMessageEnvelopeSchema, type PlainMessage } from '../shared/protocol'
import {
  createMessageSender,
  decryptMessage,
  encryptMessage,
} from './message-crypto'
import { deriveRoomSecrets } from './room-crypto'

function textMessage(): Extract<PlainMessage, { kind: 'text' }> {
  return {
    version: 1,
    id: crypto.randomUUID(),
    senderId: crypto.randomUUID(),
    senderName: 'Security tester',
    clientCreatedAt: 1_777_777_777_777,
    kind: 'text',
    text: 'Only room participants can read this message.',
  }
}

describe('message encryption', () => {
  it('rejects timestamps outside the ECMAScript Date range', () => {
    expect(plainMessageSchema.safeParse({
      ...textMessage(),
      clientCreatedAt: 8_640_000_000_000_001,
    }).success).toBe(false)
    expect(storedMessageEnvelopeSchema.safeParse({
      version: 2,
      id: crypto.randomUUID(),
      senderId: crypto.randomUUID(),
      senderEpochId: 'A'.repeat(22),
      counter: 0,
      ciphertext: 'A'.repeat(22),
      sequence: 1,
      serverCreatedAt: 8_640_000_000_000_001,
    }).success).toBe(false)
  })

  it('round-trips a structured message with a per-sender AES-256-GCM key', async () => {
    const keys = await deriveRoomSecrets(crypto.getRandomValues(new Uint8Array(15)))
    const message = textMessage()
    const sender = await createMessageSender(keys.messageRoot, keys.locator)

    const envelope = await encryptMessage(sender, keys.locator, message)

    expect(envelope.ciphertext).not.toContain(message.text)
    expect(envelope.senderEpochId).toMatch(/^[A-Za-z0-9_-]{22}$/)
    expect(envelope.counter).toBe(0)
    expect(await decryptMessage(keys.messageRoot, keys.locator, envelope)).toEqual(message)
  })

  it('rejects tampered ciphertext', async () => {
    const keys = await deriveRoomSecrets(crypto.getRandomValues(new Uint8Array(15)))
    const sender = await createMessageSender(keys.messageRoot, keys.locator)
    const envelope = await encryptMessage(sender, keys.locator, textMessage())
    const replacement = envelope.ciphertext.endsWith('A') ? 'B' : 'A'

    await expect(
      decryptMessage(keys.messageRoot, keys.locator, {
        ...envelope,
        ciphertext: `${envelope.ciphertext.slice(0, -1)}${replacement}`,
      }),
    ).rejects.toThrow('Message integrity check failed')
  })

  it('binds visible metadata and the room locator into authenticated data', async () => {
    const keys = await deriveRoomSecrets(crypto.getRandomValues(new Uint8Array(15)))
    const sender = await createMessageSender(keys.messageRoot, keys.locator)
    const envelope = await encryptMessage(sender, keys.locator, textMessage())

    await expect(
      decryptMessage(keys.messageRoot, `${keys.locator}x`, envelope),
    ).rejects.toThrow('Message integrity check failed')
    await expect(
      decryptMessage(keys.messageRoot, keys.locator, {
        ...envelope,
        senderId: crypto.randomUUID(),
      }),
    ).rejects.toThrow('Message integrity check failed')
    await expect(
      decryptMessage(keys.messageRoot, keys.locator, {
        ...envelope,
        counter: envelope.counter + 1,
      }),
    ).rejects.toThrow('Message integrity check failed')
  })

  it('allocates a unique counter before concurrent encryption starts', async () => {
    const keys = await deriveRoomSecrets(crypto.getRandomValues(new Uint8Array(15)))
    const sender = await createMessageSender(keys.messageRoot, keys.locator)
    const envelopes = await Promise.all(
      Array.from({ length: 32 }, () => encryptMessage(sender, keys.locator, textMessage())),
    )

    expect(new Set(envelopes.map((envelope) => envelope.counter)).size).toBe(32)
    expect(envelopes.map((envelope) => envelope.counter).sort((a, b) => a - b)).toEqual(
      Array.from({ length: 32 }, (_, index) => index),
    )
  })

  it('decrypts after re-deriving the room root on a second device', async () => {
    const roomSecret = crypto.getRandomValues(new Uint8Array(15))
    const firstDevice = await deriveRoomSecrets(roomSecret)
    const secondDevice = await deriveRoomSecrets(roomSecret)
    const sender = await createMessageSender(firstDevice.messageRoot, firstDevice.locator)
    const message = textMessage()

    const envelope = await encryptMessage(sender, firstDevice.locator, message)
    const storedEnvelope = {
      ...envelope,
      sequence: 1,
      serverCreatedAt: Date.now(),
    }

    await expect(
      decryptMessage(secondDevice.messageRoot, secondDevice.locator, storedEnvelope),
    ).resolves.toEqual(message)
  })
})
