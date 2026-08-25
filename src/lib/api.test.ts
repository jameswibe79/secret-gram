import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  ApiError,
  getRoomInfo,
  getRoomPin,
  putEncryptedChunk,
  recallRoomMessage,
  setRoomPin,
} from './api'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('room API client', () => {
  it('keeps the room token in the Authorization header', async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({
        data: { createdAt: 1, expiresAt: 2, onlineCount: 0, remainingEvents: 10_000 },
      }),
    )
    vi.stubGlobal('fetch', fetchMock)

    await expect(getRoomInfo('locator', 'secret-token')).resolves.toEqual({
      createdAt: 1,
      expiresAt: 2,
      onlineCount: 0,
      remainingEvents: 10_000,
    })
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/v1/rooms/locator',
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer secret-token' }),
      }),
    )
  })

  it('surfaces structured API failures without losing the request ID', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json(
          {
            error: {
              code: 'unauthorized',
              message: 'Room authentication failed.',
              requestId: 'request-123',
            },
          },
          { status: 401 },
        ),
      ),
    )

    const error = await getRoomInfo('locator', 'bad-token').catch((reason: unknown) => reason)
    expect(error).toBeInstanceOf(ApiError)
    expect(error).toMatchObject({ status: 401, code: 'unauthorized', requestId: 'request-123' })
  })

  it('rejects a malformed successful response instead of trusting its shape', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ data: { expiresAt: 'later' } })))

    const error = await getRoomInfo('locator', 'token').catch((reason: unknown) => reason)

    expect(error).toBeInstanceOf(ApiError)
    expect(error).toMatchObject({ code: 'invalid_response' })
  })

  it('binds encrypted chunk retries to a ciphertext digest', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ data: { stored: true, etag: 'etag' } }), {
        status: 201,
        headers: { 'Content-Type': 'application/json' },
      }),
    )
    vi.stubGlobal('fetch', fetchMock)

    await putEncryptedChunk(
      'locator',
      'token',
      'device-id',
      'file-id',
      0,
      new Uint8Array([1, 2, 3]),
    )

    const headers = new Headers(fetchMock.mock.calls[0]?.[1]?.headers)
    expect(headers.get('X-Ciphertext-SHA256')).toMatch(/^[A-Za-z0-9_-]{43}$/)
  })

  it('sends a device-bound recall credential and validates the tombstone', async () => {
    const messageId = '00000000-0000-4000-8000-000000000001'
    const deviceId = '00000000-0000-4000-8000-000000000002'
    const fetchMock = vi.fn().mockResolvedValue(
      Response.json(
        {
          data: {
            duplicate: false,
            event: {
              type: 'recall',
              messageId,
              senderId: deviceId,
              sequence: 2,
              recalledAt: 1,
            },
          },
        },
        { status: 201 },
      ),
    )
    vi.stubGlobal('fetch', fetchMock)

    await expect(
      recallRoomMessage('locator', 'room-token', deviceId, messageId, 'A'.repeat(43)),
    ).resolves.toMatchObject({ event: { type: 'recall', messageId, senderId: deviceId } })
    expect(fetchMock).toHaveBeenCalledWith(
      `/api/v1/rooms/locator/messages/${messageId}/recall`,
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ Authorization: 'Bearer room-token' }),
        body: JSON.stringify({ deviceId, recallToken: 'A'.repeat(43) }),
      }),
    )
  })

  it('validates pin state and sends idempotent pin updates', async () => {
    const messageId = '00000000-0000-4000-8000-000000000001'
    const pin = { messageId, version: 3, updatedAt: 1 }
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json({ data: { pin } }))
      .mockResolvedValueOnce(Response.json({ data: { duplicate: false, pin } }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(getRoomPin('locator', 'room-token')).resolves.toEqual(pin)
    await expect(
      setRoomPin('locator', 'room-token', messageId, true),
    ).resolves.toEqual({ duplicate: false, pin })
    expect(fetchMock).toHaveBeenLastCalledWith(
      `/api/v1/rooms/locator/messages/${messageId}/pin`,
      expect.objectContaining({
        method: 'PUT',
        headers: expect.objectContaining({ Authorization: 'Bearer room-token' }),
        body: JSON.stringify({ pinned: true }),
      }),
    )
  })
})
