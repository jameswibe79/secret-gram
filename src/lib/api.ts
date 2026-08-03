import { z, type ZodType } from 'zod'

import type {
  ClientMessageEnvelope,
  StoredMessageEnvelope,
  StoredRecallEvent,
  StoredRoomEvent,
} from '../shared/protocol'
import {
  storedMessageEnvelopeSchema,
  storedRecallEventSchema,
  storedRoomEventSchema,
  timestampMillisecondsSchema,
} from '../shared/protocol'
import { bytesToBase64Url } from './encoding'

interface ApiSuccess<T> {
  data: T
}

interface ApiFailure {
  error?: {
    code?: string
    message?: string
    requestId?: string
  }
}

interface JsonRequestOptions {
  method?: 'GET' | 'POST'
  token?: string
  body?: unknown
  signal?: AbortSignal
}

const roomInfoSchema = z.strictObject({
  createdAt: timestampMillisecondsSchema,
  expiresAt: timestampMillisecondsSchema,
  onlineCount: z.number().int().nonnegative(),
})
const createRoomResultSchema = z.strictObject({
  created: z.boolean(),
  expiresAt: timestampMillisecondsSchema,
})
const messageHistorySchema = z.strictObject({ messages: z.array(storedRoomEventSchema) })
const postedMessageSchema = z.strictObject({
  duplicate: z.boolean(),
  message: storedMessageEnvelopeSchema,
})
const recalledMessageSchema = z.strictObject({
  duplicate: z.boolean(),
  event: storedRecallEventSchema,
})
const socketTicketResultSchema = z.strictObject({
  ticket: z.string().regex(/^[A-Za-z0-9_-]{43}$/u),
  expiresAt: timestampMillisecondsSchema,
})
const beginUploadResultSchema = z.strictObject({ created: z.boolean() })
const completeUploadResultSchema = z.strictObject({ ready: z.boolean() })

function boundedSignal(signal?: AbortSignal, timeoutMilliseconds = 30_000): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMilliseconds)
  return signal === undefined ? timeout : AbortSignal.any([signal, timeout])
}

export class ApiError extends Error {
  readonly status: number
  readonly code: string
  readonly requestId?: string
  readonly retryAfterSeconds?: number

  constructor(
    status: number,
    code: string,
    message: string,
    requestId?: string,
    retryAfterSeconds?: number,
  ) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = code
    this.requestId = requestId
    this.retryAfterSeconds = retryAfterSeconds
  }
}

function roomPath(locator: string): string {
  return `/api/v1/rooms/${encodeURIComponent(locator)}`
}

async function apiError(response: Response): Promise<ApiError> {
  let failure: ApiFailure = {}
  try {
    failure = (await response.json()) as ApiFailure
  } catch {
    // Keep the generic error when an intermediary returns a non-JSON response.
  }
  const retryAfter = Number(response.headers.get('Retry-After'))
  return new ApiError(
    response.status,
    failure.error?.code ?? 'request_failed',
    failure.error?.message ?? 'The request failed. Try again later.',
    failure.error?.requestId ?? response.headers.get('X-Request-ID') ?? undefined,
    Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : undefined,
  )
}

async function requestJson<T>(
  path: string,
  schema: ZodType<T>,
  options: JsonRequestOptions = {},
): Promise<T> {
  const headers: Record<string, string> = { Accept: 'application/json' }
  if (options.token !== undefined) headers.Authorization = `Bearer ${options.token}`
  if (options.body !== undefined) headers['Content-Type'] = 'application/json'

  const response = await fetch(path, {
    method: options.method ?? 'GET',
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    signal: boundedSignal(options.signal),
  })
  if (!response.ok) throw await apiError(response)

  let payload: unknown
  try {
    payload = await response.json()
  } catch {
    throw new ApiError(response.status, 'invalid_response', 'The server returned an invalid response.')
  }
  if (typeof payload !== 'object' || payload === null || !('data' in payload)) {
    throw new ApiError(response.status, 'invalid_response', 'The server returned an invalid response.')
  }
  const parsed = schema.safeParse((payload as ApiSuccess<unknown>).data)
  if (!parsed.success) {
    throw new ApiError(response.status, 'invalid_response', 'The server returned an invalid response.')
  }
  return parsed.data
}

export interface RoomInfo {
  createdAt: number
  expiresAt: number
  onlineCount: number
}

export interface CreateRoomResult {
  created: boolean
  expiresAt: number
}

export function createRoom(
  locator: string,
  authVerifier: string,
  ttlSeconds: number,
  signal?: AbortSignal,
): Promise<CreateRoomResult> {
  return requestJson('/api/v1/rooms', createRoomResultSchema, {
    method: 'POST',
    body: { locator, authVerifier, ttlSeconds },
    signal,
  })
}

export function getRoomInfo(
  locator: string,
  token: string,
  signal?: AbortSignal,
): Promise<RoomInfo> {
  return requestJson(roomPath(locator), roomInfoSchema, { token, signal })
}

export async function getRoomMessages(
  locator: string,
  token: string,
  after = 0,
  limit = 50,
  signal?: AbortSignal,
): Promise<StoredRoomEvent[]> {
  const query = new URLSearchParams({ after: String(after), limit: String(limit) })
  const result = await requestJson(
    `${roomPath(locator)}/messages?${query.toString()}`,
    messageHistorySchema,
    { token, signal },
  )
  return result.messages
}

export interface PostedMessageResult {
  duplicate: boolean
  message: StoredMessageEnvelope
}

export function postRoomMessage(
  locator: string,
  token: string,
  deviceId: string,
  envelope: ClientMessageEnvelope,
  signal?: AbortSignal,
): Promise<PostedMessageResult> {
  return requestJson(`${roomPath(locator)}/messages`, postedMessageSchema, {
    method: 'POST',
    token,
    body: { deviceId, envelope },
    signal,
  })
}

export interface RecalledMessageResult {
  duplicate: boolean
  event: StoredRecallEvent
}

export function recallRoomMessage(
  locator: string,
  token: string,
  deviceId: string,
  messageId: string,
  recallToken: string,
  signal?: AbortSignal,
): Promise<RecalledMessageResult> {
  return requestJson(
    `${roomPath(locator)}/messages/${encodeURIComponent(messageId)}/recall`,
    recalledMessageSchema,
    {
      method: 'POST',
      token,
      body: { deviceId, recallToken },
      signal,
    },
  )
}

export interface SocketTicketResult {
  ticket: string
  expiresAt: number
}

export function createSocketTicket(
  locator: string,
  token: string,
  deviceId: string,
  signal?: AbortSignal,
): Promise<SocketTicketResult> {
  return requestJson(`${roomPath(locator)}/socket-ticket`, socketTicketResultSchema, {
    method: 'POST',
    token,
    body: { deviceId },
    signal,
  })
}

export function roomWebSocketUrl(locator: string, ticket: string): string {
  const url = new URL(`${roomPath(locator)}/websocket`, window.location.href)
  url.searchParams.set('ticket', ticket)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  return url.toString()
}

export interface BeginUploadInput {
  deviceId: string
  fileId: string
  chunkCount: number
  encryptedSize: number
}

export function beginEncryptedUpload(
  locator: string,
  token: string,
  input: BeginUploadInput,
  signal?: AbortSignal,
): Promise<{ created: boolean }> {
  return requestJson(`${roomPath(locator)}/uploads`, beginUploadResultSchema, {
    method: 'POST',
    token,
    body: input,
    signal,
  })
}

export async function putEncryptedChunk(
  locator: string,
  token: string,
  deviceId: string,
  fileId: string,
  chunkIndex: number,
  ciphertext: Uint8Array<ArrayBuffer>,
  signal?: AbortSignal,
): Promise<void> {
  const ciphertextSha256 = bytesToBase64Url(
    new Uint8Array(await crypto.subtle.digest('SHA-256', ciphertext)),
  )
  const response = await fetch(
    `${roomPath(locator)}/uploads/${encodeURIComponent(fileId)}/chunks/${chunkIndex}`,
    {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/octet-stream',
        'X-Ciphertext-SHA256': ciphertextSha256,
        'X-Device-ID': deviceId,
      },
      body: new Blob([ciphertext], { type: 'application/octet-stream' }),
      signal: boundedSignal(signal, 120_000),
    },
  )
  if (!response.ok) throw await apiError(response)
}

export function completeEncryptedUpload(
  locator: string,
  token: string,
  deviceId: string,
  fileId: string,
  signal?: AbortSignal,
): Promise<{ ready: boolean }> {
  return requestJson(
    `${roomPath(locator)}/uploads/${encodeURIComponent(fileId)}/complete`,
    completeUploadResultSchema,
    {
      method: 'POST',
      token,
      body: { deviceId },
      signal,
    },
  )
}

export async function getEncryptedChunk(
  locator: string,
  token: string,
  fileId: string,
  chunkIndex: number,
  signal?: AbortSignal,
): Promise<Uint8Array<ArrayBuffer>> {
  const response = await fetch(
    `${roomPath(locator)}/uploads/${encodeURIComponent(fileId)}/chunks/${chunkIndex}`,
    {
      headers: { Authorization: `Bearer ${token}` },
      signal: boundedSignal(signal, 120_000),
    },
  )
  if (!response.ok) throw await apiError(response)
  return new Uint8Array(await response.arrayBuffer())
}
