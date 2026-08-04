import { z } from 'zod'

export const MAX_TEXT_CHARACTERS = 16_384
export const MAX_ENCRYPTED_MESSAGE_CHARACTERS = 196_608
export const DEFAULT_FILE_CHUNK_SIZE = 4 * 1024 * 1024
// Downloads are assembled into a browser Blob; keep the production ceiling memory-safe.
export const MAX_FILE_BYTES = 64 * 1024 * 1024
export const MAX_FILE_CHUNKS = 4_096
export const MAX_MESSAGE_COUNTER = 0xffff_ffff
export const MAX_ECMASCRIPT_TIMESTAMP_MS = 8_640_000_000_000_000

const uuidSchema = z.string().uuid()
const base64UrlSchema = z.string().regex(/^[A-Za-z0-9_-]+$/u)
export const recallTokenSchema = base64UrlSchema.length(43)
export const timestampMillisecondsSchema = z
  .number()
  .int()
  .nonnegative()
  .max(MAX_ECMASCRIPT_TIMESTAMP_MS)

export const fileDescriptorSchema = z.strictObject({
  fileId: uuidSchema,
  name: z.string().min(1).max(255).refine((name) => !name.includes('\0')),
  mimeType: z.string().min(1).max(127),
  size: z.number().int().min(0).max(MAX_FILE_BYTES),
  chunkSize: z.number().int().positive().max(8 * 1024 * 1024),
  chunkCount: z.number().int().positive().max(MAX_FILE_CHUNKS),
  key: base64UrlSchema.length(43),
  noncePrefix: base64UrlSchema.length(11),
})

const basePlainMessageSchema = z.strictObject({
  version: z.literal(1),
  id: uuidSchema,
  senderId: uuidSchema,
  senderName: z.string().trim().min(1).max(64),
  clientCreatedAt: timestampMillisecondsSchema,
})

export const plainMessageSchema = z.discriminatedUnion('kind', [
  basePlainMessageSchema.extend({
    kind: z.literal('text'),
    text: z.string().min(1).max(MAX_TEXT_CHARACTERS),
  }).strict(),
  basePlainMessageSchema.extend({
    kind: z.literal('file'),
    file: fileDescriptorSchema,
    caption: z.string().max(2_000).optional(),
  }).strict(),
])

export const clientMessageEnvelopeSchema = z.strictObject({
  version: z.literal(2),
  id: uuidSchema,
  senderId: uuidSchema,
  senderEpochId: base64UrlSchema.length(22),
  counter: z.number().int().nonnegative().max(MAX_MESSAGE_COUNTER),
  ciphertext: base64UrlSchema.min(22).max(MAX_ENCRYPTED_MESSAGE_CHARACTERS),
  recallVerifier: recallTokenSchema.optional(),
})

export const storedMessageEnvelopeSchema = clientMessageEnvelopeSchema.extend({
  sequence: z.number().int().positive(),
  serverCreatedAt: timestampMillisecondsSchema,
})

export const storedRecallEventSchema = z.strictObject({
  type: z.literal('recall'),
  messageId: uuidSchema,
  senderId: uuidSchema,
  sequence: z.number().int().positive(),
  recalledAt: timestampMillisecondsSchema,
})

export const roomPinStateSchema = z.strictObject({
  messageId: uuidSchema.nullable(),
  version: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  updatedAt: timestampMillisecondsSchema.nullable(),
})

export const storedRoomEventSchema = z.union([
  storedMessageEnvelopeSchema,
  storedRecallEventSchema,
])

export const webSocketClientFrameSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('message'), envelope: clientMessageEnvelopeSchema }),
  z.strictObject({ type: z.literal('ping') }),
])

export const webSocketServerFrameSchema = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('ready'),
    onlineCount: z.number().int().nonnegative(),
    expiresAt: timestampMillisecondsSchema,
  }),
  z.strictObject({ type: z.literal('presence'), onlineCount: z.number().int().nonnegative() }),
  z.strictObject({ type: z.literal('message'), message: storedMessageEnvelopeSchema }),
  z.strictObject({
    type: z.literal('ack'),
    id: uuidSchema,
    sequence: z.number().int().positive(),
    duplicate: z.boolean(),
  }),
  z.strictObject({
    type: z.literal('recall'),
    messageId: uuidSchema,
    senderId: uuidSchema,
    sequence: z.number().int().positive(),
    recalledAt: timestampMillisecondsSchema,
  }),
  z.strictObject({ type: z.literal('pin'), pin: roomPinStateSchema }),
  z.strictObject({ type: z.literal('pong'), at: timestampMillisecondsSchema }),
  z.strictObject({
    type: z.literal('error'),
    code: z.string().min(1).max(64),
    messageId: uuidSchema.optional(),
  }),
])

export type FileDescriptor = z.infer<typeof fileDescriptorSchema>
export type PlainMessage = z.infer<typeof plainMessageSchema>
export type ClientMessageEnvelope = z.infer<typeof clientMessageEnvelopeSchema>
export type StoredMessageEnvelope = z.infer<typeof storedMessageEnvelopeSchema>
export type StoredRecallEvent = z.infer<typeof storedRecallEventSchema>
export type RoomPinState = z.infer<typeof roomPinStateSchema>
export type StoredRoomEvent = z.infer<typeof storedRoomEventSchema>
export type WebSocketClientFrame = z.infer<typeof webSocketClientFrameSchema>
export type WebSocketServerFrame = z.infer<typeof webSocketServerFrameSchema>
