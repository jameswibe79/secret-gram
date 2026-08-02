import { z, type ZodType } from 'zod'

const MAX_JSON_BYTES = 64 * 1024
const AUTHORIZATION_PATTERN = /^Bearer ([A-Za-z0-9_-]{43})$/u
const LOG_ROOM_SEGMENT_PATTERN = /^[A-Za-z0-9_-]{43}$/u
const LOG_UUID_SEGMENT_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu

const ERROR_MESSAGES: Record<string, string> = {
  bad_request: 'The request is invalid.',
  conflict: 'The requested resource conflicts with existing state.',
  cross_origin: 'Cross-origin state changes are not allowed.',
  expired: 'The room has expired.',
  forbidden: 'The request is not permitted.',
  internal_error: 'An unexpected error occurred.',
  invalid: 'The request is invalid.',
  method_not_allowed: 'The HTTP method is not allowed for this route.',
  not_found: 'The requested resource was not found.',
  payload_too_large: 'The request body is too large.',
  rate_limited: 'Too many requests. Try again later.',
  storage_unavailable: 'Encrypted file storage is temporarily unavailable.',
  unauthorized: 'Room authentication failed.',
  unsupported_media_type: 'Expected an application/json request body.',
}

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly headers?: HeadersInit,
  ) {
    super(ERROR_MESSAGES[code] ?? ERROR_MESSAGES.internal_error)
  }
}

function secureHeaders(requestId: string, headers?: HeadersInit): Headers {
  const result = new Headers(headers)
  result.set('Cache-Control', 'no-store')
  result.set('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'")
  result.set('Cross-Origin-Resource-Policy', 'same-origin')
  result.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=()')
  result.set('Referrer-Policy', 'no-referrer')
  result.set('Strict-Transport-Security', 'max-age=31536000')
  result.set('X-Content-Type-Options', 'nosniff')
  result.set('X-Frame-Options', 'DENY')
  result.set('X-Request-ID', requestId)
  return result
}

export function successResponse(
  data: unknown,
  status: number,
  requestId: string,
  headers?: HeadersInit,
): Response {
  return Response.json(
    { data },
    { status, headers: secureHeaders(requestId, headers) },
  )
}

export function errorResponse(
  code: string,
  status: number,
  requestId: string,
  headers?: HeadersInit,
): Response {
  return Response.json(
    {
      error: {
        code,
        message: ERROR_MESSAGES[code] ?? ERROR_MESSAGES.internal_error,
        requestId,
      },
    },
    { status, headers: secureHeaders(requestId, headers) },
  )
}

export function encryptedBinaryResponse(
  body: ReadableStream,
  requestId: string,
  headers?: HeadersInit,
): Response {
  const responseHeaders = secureHeaders(requestId, headers)
  responseHeaders.set('Cache-Control', 'private, no-store')
  responseHeaders.set('Content-Type', 'application/octet-stream')
  return new Response(body, { status: 200, headers: responseHeaders })
}

export function ensureSameOrigin(request: Request): void {
  if (request.method === 'GET' || request.method === 'HEAD') return
  if (request.headers.get('Sec-Fetch-Site')?.toLowerCase() === 'cross-site') {
    throw new HttpError(403, 'cross_origin')
  }
  const origin = request.headers.get('Origin')
  if (origin !== null && origin !== new URL(request.url).origin) {
    throw new HttpError(403, 'cross_origin')
  }
}

export function bearerToken(request: Request): string {
  const match = AUTHORIZATION_PATTERN.exec(request.headers.get('Authorization') ?? '')
  if (match === null) throw new HttpError(401, 'unauthorized')
  return match[1]
}

export function normalizeApiPath(pathname: string): string {
  return pathname.split('/').map((segment) => {
    if (LOG_ROOM_SEGMENT_PATTERN.test(segment)) return ':room'
    if (LOG_UUID_SEGMENT_PATTERN.test(segment)) return ':id'
    if (/^\d+$/u.test(segment)) return ':number'
    if (segment.length > 64) return ':value'
    return segment
  }).join('/')
}

export async function parseJson<T>(request: Request, schema: ZodType<T>): Promise<T> {
  const contentType = request.headers.get('Content-Type')?.split(';', 1)[0]?.trim().toLowerCase()
  if (contentType !== 'application/json') {
    throw new HttpError(415, 'unsupported_media_type')
  }
  const declaredLength = Number(request.headers.get('Content-Length') ?? 0)
  if (Number.isFinite(declaredLength) && declaredLength > MAX_JSON_BYTES) {
    throw new HttpError(413, 'payload_too_large')
  }

  const reader = request.body?.getReader()
  const chunks: Uint8Array[] = []
  let totalBytes = 0
  if (reader) {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      totalBytes += value.byteLength
      if (totalBytes > MAX_JSON_BYTES) {
        await reader.cancel().catch(() => undefined)
        throw new HttpError(413, 'payload_too_large')
      }
      chunks.push(value)
    }
  }

  const bytes = new Uint8Array(totalBytes)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  let value: unknown
  try {
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes))
  } catch {
    throw new HttpError(400, 'bad_request')
  }
  const result = schema.safeParse(value)
  if (!result.success) throw new HttpError(400, 'bad_request')
  return result.data
}

export const locatorSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/u)
export const tokenVerifierSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/u)
export const deviceIdSchema = z.string().uuid()
