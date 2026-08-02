import {
  MAX_MESSAGE_COUNTER,
  clientMessageEnvelopeSchema,
  plainMessageSchema,
  storedMessageEnvelopeSchema,
  type ClientMessageEnvelope,
  type PlainMessage,
  type StoredMessageEnvelope,
} from '../shared/protocol'
import { base64UrlToBytes, bytesToBase64Url } from './encoding'

const encoder = new TextEncoder()
const decoder = new TextDecoder('utf-8', { fatal: true })
const SENDER_EPOCH_BYTES = 16

export interface MessageSenderContext {
  readonly senderEpochId: string
  readonly locator: string
  readonly key: CryptoKey
  nextCounter: number
}

function authenticatedMetadata(
  locator: string,
  envelope: {
    version: 2
    id: string
    senderId: string
    senderEpochId: string
    counter: number
  },
): Uint8Array<ArrayBuffer> {
  return encoder.encode(
    [
      'secretgram/message/v2',
      locator,
      envelope.id,
      envelope.senderId,
      envelope.senderEpochId,
      String(envelope.counter),
    ].join('\n'),
  )
}

function counterNonce(counter: number): Uint8Array<ArrayBuffer> {
  if (!Number.isSafeInteger(counter) || counter < 0 || counter > MAX_MESSAGE_COUNTER) {
    throw new Error('Message counter exhausted; start a new sending session')
  }
  const nonce = new Uint8Array(12)
  new DataView(nonce.buffer).setBigUint64(4, BigInt(counter), false)
  return nonce
}

async function deriveSenderKey(
  messageRoot: CryptoKey,
  locator: string,
  senderEpochId: string,
): Promise<CryptoKey> {
  const epoch = base64UrlToBytes(senderEpochId)
  if (epoch.byteLength !== SENDER_EPOCH_BYTES) throw new Error('Invalid message sending epoch')
  return crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: encoder.encode('secretgram/v2/message-sender-salt'),
      info: encoder.encode(`secretgram/v2/message-sender\n${locator}\n${senderEpochId}`),
    },
    messageRoot,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  )
}

export async function createMessageSender(
  messageRoot: CryptoKey,
  locator: string,
): Promise<MessageSenderContext> {
  const senderEpochId = bytesToBase64Url(
    crypto.getRandomValues(new Uint8Array(SENDER_EPOCH_BYTES)),
  )
  return {
    senderEpochId,
    locator,
    key: await deriveSenderKey(messageRoot, locator, senderEpochId),
    nextCounter: 0,
  }
}

export async function encryptMessage(
  sender: MessageSenderContext,
  locator: string,
  message: PlainMessage,
): Promise<ClientMessageEnvelope> {
  if (sender.locator !== locator) throw new Error('Sending session does not belong to this room')
  const validated = plainMessageSchema.parse(message)
  const counter = sender.nextCounter
  counterNonce(counter)
  sender.nextCounter += 1

  const metadata = {
    version: 2 as const,
    id: validated.id,
    senderId: validated.senderId,
    senderEpochId: sender.senderEpochId,
    counter,
  }
  const ciphertext = await crypto.subtle.encrypt(
    {
      name: 'AES-GCM',
      iv: counterNonce(counter),
      additionalData: authenticatedMetadata(locator, metadata),
      tagLength: 128,
    },
    sender.key,
    encoder.encode(JSON.stringify(validated)),
  )

  return {
    ...metadata,
    ciphertext: bytesToBase64Url(new Uint8Array(ciphertext)),
  }
}

export async function decryptMessage(
  messageRoot: CryptoKey,
  locator: string,
  envelope: ClientMessageEnvelope | StoredMessageEnvelope,
): Promise<PlainMessage> {
  const validatedEnvelope = 'sequence' in envelope
    ? storedMessageEnvelopeSchema.parse(envelope)
    : clientMessageEnvelopeSchema.parse(envelope)
  const ciphertext = base64UrlToBytes(validatedEnvelope.ciphertext)

  let plaintext: ArrayBuffer
  try {
    const key = await deriveSenderKey(
      messageRoot,
      locator,
      validatedEnvelope.senderEpochId,
    )
    plaintext = await crypto.subtle.decrypt(
      {
        name: 'AES-GCM',
        iv: counterNonce(validatedEnvelope.counter),
        additionalData: authenticatedMetadata(locator, validatedEnvelope),
        tagLength: 128,
      },
      key,
      ciphertext,
    )
  } catch {
    throw new Error('Message integrity check failed')
  }

  let message: PlainMessage
  try {
    message = plainMessageSchema.parse(JSON.parse(decoder.decode(plaintext)))
  } catch {
    throw new Error('Invalid message content format')
  }

  if (message.id !== validatedEnvelope.id || message.senderId !== validatedEnvelope.senderId) {
    throw new Error('Message metadata mismatch')
  }

  return message
}