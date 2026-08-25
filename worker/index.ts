import { z } from 'zod'

import {
  MAX_FILE_BYTES,
  MAX_FILE_CHUNKS,
  clientMessageEnvelopeSchema,
  recallTokenSchema,
} from '../src/shared/protocol'
import {
  HttpError,
  bearerToken,
  deviceIdSchema,
  ensureSameOrigin,
  encryptedBinaryResponse,
  errorResponse,
  locatorSchema,
  normalizeApiPath,
  parseJson,
  successResponse,
  tokenVerifierSchema,
} from './http'

export { RateLimiterDurableObject } from './rate-limiter'
export { RoomDurableObject } from './room'

const createRoomSchema = z
  .object({
    locator: locatorSchema,
    authVerifier: tokenVerifierSchema,
    ttlSeconds: z.number().int().min(300).max(2_592_000),
  })
  .strict()

const postMessageSchema = z
  .object({
    deviceId: deviceIdSchema,
    envelope: clientMessageEnvelopeSchema,
  })
  .strict()

const recallMessageSchema = z
  .object({ deviceId: deviceIdSchema, recallToken: recallTokenSchema })
  .strict()

const pinMessageSchema = z.object({ pinned: z.boolean() }).strict()

const socketTicketSchema = z.object({ deviceId: deviceIdSchema }).strict()

const beginUploadSchema = z
  .object({
    deviceId: deviceIdSchema,
    fileId: z.string().uuid(),
    chunkCount: z.number().int().min(1).max(MAX_FILE_CHUNKS),
    encryptedSize: z
      .number()
      .int()
      .min(16)
      .max(MAX_FILE_BYTES + MAX_FILE_CHUNKS * 16),
  })
  .strict()

function base64Url(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '')
}

function decodeBase64Url(value: string): Uint8Array<ArrayBuffer> {
  const padded = value.replaceAll('-', '+').replaceAll('_', '/') + '='
  const binary = atob(padded)
  return Uint8Array.from(binary, (character) => character.charCodeAt(0))
}

function encryptedFileKey(
  locator: string,
  fileId: string,
  chunkIndex: number,
  ciphertextSha256: string,
): string {
  return `rooms/${locator}/${fileId}/${chunkIndex}-${ciphertextSha256}`
}

function matchesEncryptedChunk(
  object: R2Object,
  encryptedSize: number,
  ciphertextSha256: string,
): boolean {
  const checksum = object.checksums.sha256
  return (
    object.size === encryptedSize &&
    object.customMetadata?.ciphertextSha256 === ciphertextSha256 &&
    checksum !== undefined &&
    base64Url(new Uint8Array(checksum)) === ciphertextSha256
  )
}

function requestDeviceId(request: Request): string {
  const parsed = deviceIdSchema.safeParse(request.headers.get('X-Device-ID'))
  if (!parsed.success) throw new HttpError(400, 'invalid')
  return parsed.data
}

async function enforceRateLimit(
  request: Request,
  env: Env,
  scope: string,
  limit: number,
  windowSeconds: number,
): Promise<void> {
  const source = request.headers.get('CF-Connecting-IP') ?? 'local-development'
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(source))
  const limiter = env.RATE_LIMITERS.getByName(base64Url(new Uint8Array(digest)))
  const result = await limiter.consume(scope, limit, windowSeconds)
  if (!result.allowed) {
    throw new HttpError(429, 'rate_limited', {
      'Retry-After': String(result.retryAfterSeconds),
      'X-RateLimit-Remaining': '0',
      'X-RateLimit-Reset': String(Math.ceil(result.resetAt / 1_000)),
    })
  }
}

function roomFailure(reason: string): HttpError {
  switch (reason) {
    case 'unauthorized':
      return new HttpError(401, 'unauthorized')
    case 'expired':
      return new HttpError(410, 'expired')
    case 'conflict':
    case 'incomplete':
    case 'not_ready':
    case 'upload_conflict':
    case 'chunk_conflict':
    case 'message_id_conflict':
    case 'sender_counter_conflict':
      return new HttpError(409, 'conflict')
    case 'not_recallable':
      return new HttpError(409, 'not_recallable')
    case 'capacity':
    case 'rate_limited':
      return new HttpError(429, 'rate_limited')
    case 'forbidden':
      return new HttpError(403, 'forbidden')
    case 'not_found':
      return new HttpError(404, 'not_found')
    default:
      return new HttpError(400, 'invalid')
  }
}

function integerQuery(
  url: URL,
  name: string,
  defaultValue: number,
  minimum: number,
  maximum: number,
): number {
  const raw = url.searchParams.get(name)
  if (raw === null) return defaultValue
  if (!/^\d+$/u.test(raw)) throw new HttpError(400, 'invalid')
  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new HttpError(400, 'invalid')
  }
  return value
}

async function route(request: Request, env: Env, requestId: string): Promise<Response> {
  const url = new URL(request.url)
  ensureSameOrigin(request)

  if (request.method === 'GET' && url.pathname === '/api/v1/health') {
    return successResponse({ status: 'ok', version: 1 }, 200, requestId)
  }

  if (request.method === 'POST' && url.pathname === '/api/v1/rooms') {
    await enforceRateLimit(request, env, 'room-create', 10, 3_600)
    const input = await parseJson(request, createRoomSchema)
    const result = await env.ROOMS.getByName(input.locator).initialize(input)
    if (!result.ok) throw roomFailure(result.reason)
    return successResponse(
      { created: result.created, expiresAt: result.expiresAt },
      result.created ? 201 : 200,
      requestId,
    )
  }

  const messagesMatch =
    /^\/api\/v1\/rooms\/([A-Za-z0-9_-]{43})\/messages$/u.exec(url.pathname)
  if (messagesMatch !== null && request.method === 'GET') {
    await enforceRateLimit(request, env, 'room-history', 120, 60)
    const token = bearerToken(request)
    const after = integerQuery(url, 'after', 0, 0, Number.MAX_SAFE_INTEGER)
    const limit = integerQuery(url, 'limit', 50, 1, 100)
    const result = await env.ROOMS.getByName(messagesMatch[1]).getMessages(token, after, limit)
    if (!result.ok) throw roomFailure(result.reason)
    return successResponse({ messages: result.messages }, 200, requestId)
  }
  if (messagesMatch !== null && request.method === 'POST') {
    await enforceRateLimit(request, env, 'room-message', 120, 60)
    const token = bearerToken(request)
    const input = await parseJson(request, postMessageSchema)
    const result = await env.ROOMS.getByName(messagesMatch[1]).appendMessage(
      token,
      input.deviceId,
      input.envelope,
    )
    if (!result.ok) throw roomFailure(result.reason)
    return successResponse(
      {
        duplicate: result.duplicate,
        message: result.message,
        remainingEvents: result.remainingEvents,
      },
      result.duplicate ? 200 : 201,
      requestId,
    )
  }

  const pinStateMatch =
    /^\/api\/v1\/rooms\/([A-Za-z0-9_-]{43})\/pin$/u.exec(url.pathname)
  if (pinStateMatch !== null && request.method === 'GET') {
    await enforceRateLimit(request, env, 'room-pin', 120, 60)
    const token = bearerToken(request)
    const result = await env.ROOMS.getByName(pinStateMatch[1]).getPin(token)
    if (!result.ok) throw roomFailure(result.reason)
    return successResponse({ pin: result.pin }, 200, requestId)
  }

  const pinMessageMatch =
    /^\/api\/v1\/rooms\/([A-Za-z0-9_-]{43})\/messages\/([0-9a-f-]{36})\/pin$/iu.exec(
      url.pathname,
    )
  if (pinMessageMatch !== null && request.method === 'PUT') {
    await enforceRateLimit(request, env, 'message-pin', 60, 60)
    const token = bearerToken(request)
    const input = await parseJson(request, pinMessageSchema)
    const result = await env.ROOMS.getByName(pinMessageMatch[1]).setPin(
      token,
      pinMessageMatch[2],
      input.pinned,
    )
    if (!result.ok) throw roomFailure(result.reason)
    return successResponse({ duplicate: result.duplicate, pin: result.pin }, 200, requestId)
  }

  const recallMatch =
    /^\/api\/v1\/rooms\/([A-Za-z0-9_-]{43})\/messages\/([0-9a-f-]{36})\/recall$/iu.exec(
      url.pathname,
    )
  if (recallMatch !== null && request.method === 'POST') {
    await enforceRateLimit(request, env, 'message-recall', 60, 60)
    const token = bearerToken(request)
    const input = await parseJson(request, recallMessageSchema)
    const result = await env.ROOMS.getByName(recallMatch[1]).recallMessage(
      token,
      input.deviceId,
      recallMatch[2],
      input.recallToken,
    )
    if (!result.ok) throw roomFailure(result.reason)
    return successResponse(
      { duplicate: result.duplicate, event: result.event },
      result.duplicate ? 200 : 201,
      requestId,
    )
  }

  const ticketMatch =
    /^\/api\/v1\/rooms\/([A-Za-z0-9_-]{43})\/socket-ticket$/u.exec(url.pathname)
  if (ticketMatch !== null && request.method === 'POST') {
    await enforceRateLimit(request, env, 'socket-ticket', 60, 60)
    const token = bearerToken(request)
    const input = await parseJson(request, socketTicketSchema)
    const result = await env.ROOMS.getByName(ticketMatch[1]).createSocketTicket(
      token,
      input.deviceId,
    )
    if (!result.ok) throw roomFailure(result.reason)
    return successResponse(
      { ticket: result.ticket, expiresAt: result.expiresAt },
      201,
      requestId,
    )
  }

  const webSocketMatch =
    /^\/api\/v1\/rooms\/([A-Za-z0-9_-]{43})\/websocket$/u.exec(url.pathname)
  if (webSocketMatch !== null && request.method === 'GET') {
    const origin = request.headers.get('Origin')
    if (origin !== null && origin !== url.origin) throw new HttpError(403, 'cross_origin')
    await enforceRateLimit(request, env, 'socket-connect', 60, 60)
    const ticket = url.searchParams.get('ticket')
    if (ticket === null || !/^[A-Za-z0-9_-]{43}$/u.test(ticket)) {
      throw new HttpError(401, 'unauthorized')
    }
    const internalUrl = new URL('https://room.internal/websocket')
    internalUrl.searchParams.set('ticket', ticket)
    return env.ROOMS.getByName(webSocketMatch[1]).fetch(
      new Request(internalUrl, { headers: request.headers }),
    )
  }

  const uploadsMatch =
    /^\/api\/v1\/rooms\/([A-Za-z0-9_-]{43})\/uploads$/u.exec(url.pathname)
  if (uploadsMatch !== null && request.method === 'POST') {
    await enforceRateLimit(request, env, 'upload-create', 60, 60)
    const token = bearerToken(request)
    const input = await parseJson(request, beginUploadSchema)
    const result = await env.ROOMS.getByName(uploadsMatch[1]).beginUpload(
      token,
      input.deviceId,
      {
        fileId: input.fileId,
        chunkCount: input.chunkCount,
        encryptedSize: input.encryptedSize,
      },
    )
    if (!result.ok) throw roomFailure(result.reason)
    return successResponse(
      { created: result.created },
      result.created ? 201 : 200,
      requestId,
    )
  }

  const completeUploadMatch =
    /^\/api\/v1\/rooms\/([A-Za-z0-9_-]{43})\/uploads\/([0-9a-f-]{36})\/complete$/iu.exec(
      url.pathname,
    )
  if (completeUploadMatch !== null && request.method === 'POST') {
    await enforceRateLimit(request, env, 'upload-complete', 120, 60)
    const token = bearerToken(request)
    const input = await parseJson(request, socketTicketSchema)
    const fileId = z.string().uuid().safeParse(completeUploadMatch[2])
    if (!fileId.success) throw new HttpError(400, 'invalid')
    const result = await env.ROOMS.getByName(completeUploadMatch[1]).completeUpload(
      token,
      input.deviceId,
      fileId.data,
    )
    if (!result.ok) throw roomFailure(result.reason)
    return successResponse({ ready: true }, 200, requestId)
  }

  const uploadChunkMatch =
    /^\/api\/v1\/rooms\/([A-Za-z0-9_-]{43})\/uploads\/([0-9a-f-]{36})\/chunks\/(\d{1,4})$/iu.exec(
      url.pathname,
    )
  if (uploadChunkMatch !== null && request.method === 'PUT') {
    await enforceRateLimit(request, env, 'upload-chunk', 240, 60)
    const token = bearerToken(request)
    const deviceId = requestDeviceId(request)
    const fileId = z.string().uuid().safeParse(uploadChunkMatch[2])
    const chunkIndex = Number(uploadChunkMatch[3])
    const lengthHeader = request.headers.get('Content-Length') ?? ''
    const contentType = request.headers.get('Content-Type')?.split(';', 1)[0]?.trim().toLowerCase()
    const ciphertextSha256 = request.headers.get('X-Ciphertext-SHA256') ?? ''
    if (
      !fileId.success ||
      !Number.isSafeInteger(chunkIndex) ||
      !/^\d+$/u.test(lengthHeader) ||
      !/^[A-Za-z0-9_-]{43}$/u.test(ciphertextSha256) ||
      contentType !== 'application/octet-stream' ||
      request.body === null
    ) {
      throw new HttpError(400, 'invalid')
    }
    const encryptedSize = Number(lengthHeader)
    if (encryptedSize < 16 || encryptedSize > 8 * 1024 * 1024 + 16) {
      throw new HttpError(413, 'invalid')
    }

    const room = env.ROOMS.getByName(uploadChunkMatch[1])
    const authorized = await room.authorizeUploadChunk(
      token,
      deviceId,
      fileId.data,
      chunkIndex,
      encryptedSize,
      ciphertextSha256,
    )
    if (!authorized.ok) throw roomFailure(authorized.reason)

    const key = encryptedFileKey(
      uploadChunkMatch[1],
      fileId.data,
      chunkIndex,
      ciphertextSha256,
    )
    if (authorized.recorded) {
      let existing: R2Object | null
      try {
        existing = await env.FILES.head(key)
      } catch {
        throw new HttpError(503, 'storage_unavailable')
      }
      if (existing !== null && matchesEncryptedChunk(existing, encryptedSize, ciphertextSha256)) {
        return successResponse({ stored: true, etag: existing.etag }, 200, requestId)
      }
      if (existing !== null) throw new HttpError(503, 'storage_unavailable')
    }

    let uploaded: R2Object | null
    try {
      uploaded = await env.FILES.put(key, request.body, {
        onlyIf: new Headers({ 'If-None-Match': '*' }),
        httpMetadata: { contentType: 'application/octet-stream' },
        customMetadata: { ciphertextSha256 },
        sha256: decodeBase64Url(ciphertextSha256),
      })
    } catch {
      throw new HttpError(503, 'storage_unavailable')
    }
    let created = uploaded !== null
    if (uploaded === null) {
      try {
        uploaded = await env.FILES.head(key)
      } catch {
        throw new HttpError(503, 'storage_unavailable')
      }
      if (
        uploaded === null ||
        !matchesEncryptedChunk(uploaded, encryptedSize, ciphertextSha256)
      ) {
        throw new HttpError(409, 'conflict')
      }
      created = false
    }
    if (!matchesEncryptedChunk(uploaded, encryptedSize, ciphertextSha256)) {
      await env.FILES.delete(key)
      throw new HttpError(503, 'storage_unavailable')
    }
    let recorded
    try {
      recorded = await room.recordUploadChunk(
        token,
        deviceId,
        fileId.data,
        chunkIndex,
        encryptedSize,
        uploaded.etag,
        ciphertextSha256,
      )
    } catch {
      // The RPC may have committed before its response was lost. Retain the
      // content-addressed object so an identical retry can reconcile safely.
      throw new HttpError(503, 'storage_unavailable')
    }
    if (!recorded.ok) {
      if (created) await env.FILES.delete(key)
      throw roomFailure(recorded.reason)
    }
    return successResponse({ stored: true, etag: uploaded.etag }, created ? 201 : 200, requestId)
  }

  if (uploadChunkMatch !== null && request.method === 'GET') {
    await enforceRateLimit(request, env, 'download-chunk', 600, 60)
    const token = bearerToken(request)
    const fileId = z.string().uuid().safeParse(uploadChunkMatch[2])
    const chunkIndex = Number(uploadChunkMatch[3])
    if (!fileId.success || !Number.isSafeInteger(chunkIndex)) {
      throw new HttpError(400, 'invalid')
    }
    const authorized = await env.ROOMS.getByName(uploadChunkMatch[1]).authorizeDownloadChunk(
      token,
      fileId.data,
      chunkIndex,
    )
    if (!authorized.ok) throw roomFailure(authorized.reason)

    const key = encryptedFileKey(
      uploadChunkMatch[1],
      fileId.data,
      chunkIndex,
      authorized.ciphertextSha256,
    )
    let object: R2ObjectBody | null
    try {
      object = await env.FILES.get(key)
    } catch {
      throw new HttpError(503, 'storage_unavailable')
    }
    if (
      object === null ||
      !matchesEncryptedChunk(object, authorized.encryptedSize, authorized.ciphertextSha256)
    ) {
      throw new HttpError(503, 'storage_unavailable')
    }
    return encryptedBinaryResponse(object.body, requestId, {
      'Content-Disposition': `attachment; filename="chunk-${chunkIndex}.bin"`,
      'Content-Length': String(object.size),
      ETag: object.httpEtag,
    })
  }

  const roomMatch = /^\/api\/v1\/rooms\/([A-Za-z0-9_-]{43})$/u.exec(url.pathname)
  if (request.method === 'GET' && roomMatch !== null) {
    await enforceRateLimit(request, env, 'room-access', 120, 60)
    const token = bearerToken(request)
    const result = await env.ROOMS.getByName(roomMatch[1]).getInfo(token)
    if (!result.ok) throw roomFailure(result.reason)
    return successResponse(
      {
        createdAt: result.createdAt,
        expiresAt: result.expiresAt,
        onlineCount: result.onlineCount,
        remainingEvents: result.remainingEvents,
      },
      200,
      requestId,
    )
  }

  throw new HttpError(404, 'not_found')
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const requestId = crypto.randomUUID()
    try {
      return await route(request, env, requestId)
    } catch (error) {
      if (error instanceof HttpError) {
        return errorResponse(error.code, error.status, requestId, error.headers)
      }
      console.error(
        JSON.stringify({
          event: 'request_failed',
          requestId,
          method: request.method,
          path: normalizeApiPath(new URL(request.url).pathname),
          errorType: error instanceof Error ? error.name : 'UnknownError',
        }),
      )
      return errorResponse('internal_error', 500, requestId)
    }
  },
} satisfies ExportedHandler<Env>