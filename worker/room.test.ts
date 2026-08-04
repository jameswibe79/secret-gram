import { env } from 'cloudflare:workers'
import { runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'

import {
  webSocketServerFrameSchema,
  type ClientMessageEnvelope,
  type WebSocketServerFrame,
} from '../src/shared/protocol'

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '')
}

async function authFixture(): Promise<{ token: string; verifier: string }> {
  const tokenBytes = crypto.getRandomValues(new Uint8Array(32))
  const verifierBytes = new Uint8Array(await crypto.subtle.digest('SHA-256', tokenBytes))
  return {
    token: bytesToBase64Url(tokenBytes),
    verifier: bytesToBase64Url(verifierBytes),
  }
}

function roomStub(name: string) {
  return env.ROOMS.getByName(name)
}

function envelope(senderId: string): ClientMessageEnvelope {
  return {
    version: 2,
    id: crypto.randomUUID(),
    senderId,
    senderEpochId: bytesToBase64Url(crypto.getRandomValues(new Uint8Array(16))),
    counter: 0,
    ciphertext: bytesToBase64Url(crypto.getRandomValues(new Uint8Array(32))),
  }
}

function waitForFrame(socket: WebSocket, type: WebSocketServerFrame['type']) {
  return new Promise<WebSocketServerFrame>((resolve, reject) => {
    const timeout = setTimeout(() => {
      socket.removeEventListener('message', onMessage)
      reject(new Error(`Timed out waiting for WebSocket frame: ${type}`))
    }, 2_000)
    const onMessage = (event: MessageEvent) => {
      if (typeof event.data !== 'string') return
      const parsed = webSocketServerFrameSchema.safeParse(JSON.parse(event.data))
      if (!parsed.success || parsed.data.type !== type) return
      clearTimeout(timeout)
      socket.removeEventListener('message', onMessage)
      resolve(parsed.data)
    }
    socket.addEventListener('message', onMessage)
  })
}

describe('RoomDurableObject authentication', () => {
  it('does not allocate persistent tables for a missing-room probe', async () => {
    const locator = bytesToBase64Url(crypto.getRandomValues(new Uint8Array(32)))
    const auth = await authFixture()
    const room = roomStub(locator)

    expect(await room.getInfo(auth.token)).toMatchObject({ ok: false, reason: 'not_found' })
    const tableNames = await runInDurableObject(room, (_instance, state) =>
      state.storage.sql
        .exec<{ name: string }>(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
        )
        .toArray()
        .map((row) => row.name),
    )

    expect(tableNames).toEqual([])
  })

  it('initializes once and authenticates only the room-derived token', async () => {
    const locator = bytesToBase64Url(crypto.getRandomValues(new Uint8Array(32)))
    const auth = await authFixture()
    const room = roomStub(locator)

    const initialized = await room.initialize({
      locator,
      authVerifier: auth.verifier,
      ttlSeconds: 3_600,
    })

    expect(initialized.ok).toBe(true)
    expect(initialized.created).toBe(true)
    expect((await room.getInfo(auth.token)).ok).toBe(true)
    expect((await room.getInfo(bytesToBase64Url(new Uint8Array(32)))).ok).toBe(false)

    await runInDurableObject(room, (_instance, state) => state.storage.deleteAlarm())
    const repeated = await room.initialize({
      locator,
      authVerifier: auth.verifier,
      ttlSeconds: 86_400,
    })
    const recoveredAlarm = await runInDurableObject(
      room,
      (_instance, state) => state.storage.getAlarm(),
    )
    expect(repeated.ok).toBe(true)
    expect(repeated.created).toBe(false)
    expect(repeated.expiresAt).toBe(initialized.expiresAt)
    expect(recoveredAlarm).not.toBeNull()
  })

  it('schedules hourly maintenance before a long-lived room expires', async () => {
    const locator = bytesToBase64Url(crypto.getRandomValues(new Uint8Array(32)))
    const auth = await authFixture()
    const room = roomStub(locator)
    const initializedAt = Date.now()

    await room.initialize({ locator, authVerifier: auth.verifier, ttlSeconds: 86_400 })
    const alarm = await runInDurableObject(room, (_instance, state) => state.storage.getAlarm())

    expect(alarm).not.toBeNull()
    expect(alarm).toBeGreaterThanOrEqual(initializedAt + 3_590_000)
    expect(alarm).toBeLessThanOrEqual(initializedAt + 3_610_000)
  })

  it('stores opaque envelopes idempotently and rejects message ID conflicts', async () => {
    const locator = bytesToBase64Url(crypto.getRandomValues(new Uint8Array(32)))
    const auth = await authFixture()
    const room = roomStub(locator)
    const senderId = crypto.randomUUID()
    const message = envelope(senderId)
    await room.initialize({ locator, authVerifier: auth.verifier, ttlSeconds: 3_600 })

    const first = await room.appendMessage(auth.token, senderId, message)
    const retry = await room.appendMessage(auth.token, senderId, message)
    const conflict = await room.appendMessage(auth.token, senderId, {
      ...message,
      ciphertext: bytesToBase64Url(crypto.getRandomValues(new Uint8Array(32))),
    })
    const counterReuse = await room.appendMessage(auth.token, senderId, {
      ...envelope(senderId),
      senderEpochId: message.senderEpochId,
      counter: message.counter,
    })
    const history = await room.getMessages(auth.token, 0, 50)

    expect(first.ok).toBe(true)
    expect(first.duplicate).toBe(false)
    expect(first.message?.sequence).toBe(1)
    expect(retry.ok).toBe(true)
    expect(retry.duplicate).toBe(true)
    expect(retry.message?.sequence).toBe(1)
    expect(conflict).toMatchObject({ ok: false, reason: 'message_id_conflict' })
    expect(counterReuse).toMatchObject({ ok: false, reason: 'sender_counter_conflict' })
    expect(history.ok).toBe(true)
    expect(history.messages).toEqual([first.message])
  })

  it('recalls a stored message only with its sender capability and is idempotent', async () => {
    const locator = bytesToBase64Url(crypto.getRandomValues(new Uint8Array(32)))
    const auth = await authFixture()
    const recall = await authFixture()
    const wrongRecall = await authFixture()
    const room = roomStub(locator)
    const senderId = crypto.randomUUID()
    const otherDeviceId = crypto.randomUUID()
    const message = { ...envelope(senderId), recallVerifier: recall.verifier }
    await room.initialize({ locator, authVerifier: auth.verifier, ttlSeconds: 3_600 })
    expect((await room.appendMessage(auth.token, senderId, message)).ok).toBe(true)

    await expect(
      room.recallMessage(auth.token, senderId, message.id, wrongRecall.token),
    ).resolves.toMatchObject({ ok: false, reason: 'forbidden' })
    await expect(
      room.recallMessage(auth.token, otherDeviceId, message.id, recall.token),
    ).resolves.toMatchObject({ ok: false, reason: 'forbidden' })

    const recalled = await room.recallMessage(auth.token, senderId, message.id, recall.token)
    const repeated = await room.recallMessage(auth.token, senderId, message.id, recall.token)
    expect(recalled).toMatchObject({
      ok: true,
      duplicate: false,
      event: {
        type: 'recall',
        messageId: message.id,
        senderId,
        sequence: 2,
      },
    })
    expect(repeated).toMatchObject({
      ok: true,
      duplicate: true,
      event: recalled.event,
    })

    const history = await room.getMessages(auth.token, 0, 50)
    expect(history.messages).toEqual([recalled.event])
  })

  it('paginates retained history from the oldest message without gaps', async () => {
    const locator = bytesToBase64Url(crypto.getRandomValues(new Uint8Array(32)))
    const auth = await authFixture()
    const room = roomStub(locator)
    await room.initialize({ locator, authVerifier: auth.verifier, ttlSeconds: 3_600 })

    for (let index = 0; index < 101; index += 1) {
      const senderId = crypto.randomUUID()
      expect((await room.appendMessage(auth.token, senderId, envelope(senderId))).ok).toBe(true)
    }

    const firstPage = await room.getMessages(auth.token, 0, 100)
    expect(firstPage.ok).toBe(true)
    expect(firstPage.messages.map((message) => message.sequence)).toEqual(
      Array.from({ length: 100 }, (_, index) => index + 1),
    )
    const secondPage = await room.getMessages(auth.token, 100, 100)
    expect(secondPage.ok).toBe(true)
    expect(secondPage.messages.map((message) => message.sequence)).toEqual([101])
  })

  it('logically excludes messages older than the configured retention window', async () => {
    const locator = bytesToBase64Url(crypto.getRandomValues(new Uint8Array(32)))
    const auth = await authFixture()
    const room = roomStub(locator)
    const senderId = crypto.randomUUID()
    await room.initialize({ locator, authVerifier: auth.verifier, ttlSeconds: 86_400 })
    const stored = await room.appendMessage(auth.token, senderId, envelope(senderId))
    expect(stored.ok).toBe(true)

    await runInDurableObject(room, (_instance, state) => {
      state.storage.sql.exec(
        'UPDATE messages SET server_created_at = ?',
        Date.now() - Number(env.MESSAGE_RETENTION_SECONDS) * 1_000 - 1,
      )
    })

    const history = await room.getMessages(auth.token, 0, 50)
    expect(history).toMatchObject({ ok: true, messages: [] })
  })

  it('rate limits message floods per room device', async () => {
    const locator = bytesToBase64Url(crypto.getRandomValues(new Uint8Array(32)))
    const auth = await authFixture()
    const room = roomStub(locator)
    const senderId = crypto.randomUUID()
    await room.initialize({ locator, authVerifier: auth.verifier, ttlSeconds: 3_600 })

    for (let index = 0; index < 60; index += 1) {
      expect((await room.appendMessage(auth.token, senderId, envelope(senderId))).ok).toBe(true)
    }
    expect(await room.appendMessage(auth.token, senderId, envelope(senderId))).toMatchObject({
      ok: false,
      reason: 'rate_limited',
    })
  })

  it('enforces a room-wide message ceiling even when device identifiers rotate', async () => {
    const locator = bytesToBase64Url(crypto.getRandomValues(new Uint8Array(32)))
    const auth = await authFixture()
    const room = roomStub(locator)
    await room.initialize({ locator, authVerifier: auth.verifier, ttlSeconds: 3_600 })
    await runInDurableObject(room, (_instance, state) => {
      const windowStart = Math.floor(Date.now() / 60_000) * 60_000
      state.storage.sql.exec(
        `INSERT INTO message_rate_windows (device_id, window_start, message_count)
         VALUES ('__room__', ?, 600)`,
        windowStart,
      )
    })

    const senderId = crypto.randomUUID()
    expect(await room.appendMessage(auth.token, senderId, envelope(senderId))).toMatchObject({
      ok: false,
      reason: 'rate_limited',
    })
  })

  it('rejects new messages when the retained room budget is exhausted', async () => {
    const locator = bytesToBase64Url(crypto.getRandomValues(new Uint8Array(32)))
    const auth = await authFixture()
    const room = roomStub(locator)
    const senderId = crypto.randomUUID()
    await room.initialize({ locator, authVerifier: auth.verifier, ttlSeconds: 3_600 })
    await runInDurableObject(room, (_instance, state) => {
      state.storage.sql.exec('UPDATE room_usage SET message_count = 10000 WHERE singleton = 1')
    })

    expect(await room.appendMessage(auth.token, senderId, envelope(senderId))).toMatchObject({
      ok: false,
      reason: 'capacity',
    })
  })

  it('caps encrypted file reservations across one room', async () => {
    const locator = bytesToBase64Url(crypto.getRandomValues(new Uint8Array(32)))
    const auth = await authFixture()
    const room = roomStub(locator)
    const deviceId = crypto.randomUUID()
    await room.initialize({ locator, authVerifier: auth.verifier, ttlSeconds: 3_600 })

    for (let index = 0; index < 8; index += 1) {
      const result = await room.beginUpload(auth.token, deviceId, {
        fileId: crypto.randomUUID(),
        chunkCount: 1,
        encryptedSize: Number(env.MAX_FILE_BYTES),
      })
      expect(result.ok).toBe(true)
    }
    expect(await room.beginUpload(auth.token, deviceId, {
      fileId: crypto.randomUUID(),
      chunkCount: 1,
      encryptedSize: Number(env.MAX_FILE_BYTES),
    })).toMatchObject({ ok: false, reason: 'capacity' })
  })

  it('caps pending-upload and chunk reservations independently of byte size', async () => {
    const locator = bytesToBase64Url(crypto.getRandomValues(new Uint8Array(32)))
    const auth = await authFixture()
    const room = roomStub(locator)
    const deviceId = crypto.randomUUID()
    await room.initialize({ locator, authVerifier: auth.verifier, ttlSeconds: 3_600 })

    for (let index = 0; index < 32; index += 1) {
      expect(await room.beginUpload(auth.token, deviceId, {
        fileId: crypto.randomUUID(),
        chunkCount: 1,
        encryptedSize: 16,
      })).toMatchObject({ ok: true })
    }
    expect(await room.beginUpload(auth.token, deviceId, {
      fileId: crypto.randomUUID(),
      chunkCount: 1,
      encryptedSize: 16,
    })).toMatchObject({ ok: false, reason: 'capacity' })

    const chunkRoom = roomStub(`${locator}-chunks`)
    await chunkRoom.initialize({ locator, authVerifier: auth.verifier, ttlSeconds: 3_600 })
    expect(await chunkRoom.beginUpload(auth.token, deviceId, {
      fileId: crypto.randomUUID(),
      chunkCount: 4_096,
      encryptedSize: 65_536,
    })).toMatchObject({ ok: true })
    expect(await chunkRoom.beginUpload(auth.token, deviceId, {
      fileId: crypto.randomUUID(),
      chunkCount: 1,
      encryptedSize: 16,
    })).toMatchObject({ ok: false, reason: 'capacity' })
  })

  it('requires every encrypted file chunk before making an upload downloadable', async () => {
    const locator = bytesToBase64Url(crypto.getRandomValues(new Uint8Array(32)))
    const auth = await authFixture()
    const room = roomStub(locator)
    const deviceId = crypto.randomUUID()
    const fileId = crypto.randomUUID()
    await room.initialize({ locator, authVerifier: auth.verifier, ttlSeconds: 3_600 })

    expect(
      await room.beginUpload(auth.token, deviceId, {
        fileId,
        chunkCount: 2,
        encryptedSize: 64,
      }),
    ).toMatchObject({ ok: true, created: true })
    const firstDigest = bytesToBase64Url(new Uint8Array(32))
    expect(
      await room.authorizeUploadChunk(auth.token, deviceId, fileId, 0, 32, firstDigest),
    ).toEqual({ ok: true, recorded: false })
    expect(
      await room.recordUploadChunk(
        auth.token,
        deviceId,
        fileId,
        0,
        32,
        'etag-0',
        firstDigest,
      ),
    ).toEqual({ ok: true })
    expect(
      await room.authorizeUploadChunk(auth.token, deviceId, fileId, 0, 32, firstDigest),
    ).toEqual({ ok: true, recorded: true, etag: 'etag-0' })
    expect(
      await room.authorizeUploadChunk(
        auth.token,
        deviceId,
        fileId,
        0,
        32,
        bytesToBase64Url(new Uint8Array(32).fill(2)),
      ),
    ).toMatchObject({ ok: false, reason: 'chunk_conflict' })
    expect(await room.completeUpload(auth.token, deviceId, fileId)).toMatchObject({
      ok: false,
      reason: 'incomplete',
    })

    await room.recordUploadChunk(
      auth.token,
      deviceId,
      fileId,
      1,
      32,
      'etag-1',
      bytesToBase64Url(new Uint8Array(32).fill(1)),
    )

    expect(await room.completeUpload(auth.token, deviceId, fileId)).toEqual({ ok: true })
    expect(await room.canDownload(auth.token, fileId)).toEqual({
      ok: true,
      chunkCount: 2,
    })
    expect(await room.authorizeDownloadChunk(auth.token, fileId, 0)).toEqual({
      ok: true,
      encryptedSize: 32,
      ciphertextSha256: firstDigest,
    })
    expect(await room.canDownload(bytesToBase64Url(new Uint8Array(32)), fileId)).toMatchObject({
      ok: false,
      reason: 'unauthorized',
    })
  })

  it('accepts a late identical chunk registration after the upload becomes ready', async () => {
    const locator = bytesToBase64Url(crypto.getRandomValues(new Uint8Array(32)))
    const auth = await authFixture()
    const room = roomStub(locator)
    const deviceId = crypto.randomUUID()
    const fileId = crypto.randomUUID()
    const digest = bytesToBase64Url(new Uint8Array(32).fill(3))
    await room.initialize({ locator, authVerifier: auth.verifier, ttlSeconds: 3_600 })
    await room.beginUpload(auth.token, deviceId, {
      fileId,
      chunkCount: 1,
      encryptedSize: 32,
    })

    expect(
      await room.authorizeUploadChunk(auth.token, deviceId, fileId, 0, 32, digest),
    ).toEqual({ ok: true, recorded: false })
    expect(
      await room.recordUploadChunk(auth.token, deviceId, fileId, 0, 32, 'etag-0', digest),
    ).toEqual({ ok: true })
    expect(await room.completeUpload(auth.token, deviceId, fileId)).toEqual({ ok: true })

    expect(
      await room.recordUploadChunk(auth.token, deviceId, fileId, 0, 32, 'etag-0', digest),
    ).toEqual({ ok: true })
    expect(
      await room.authorizeUploadChunk(auth.token, deviceId, fileId, 0, 32, digest),
    ).toEqual({ ok: true, recorded: true, etag: 'etag-0' })
  })

  it('exchanges an authenticated request for a one-time WebSocket ticket', async () => {
    const locator = bytesToBase64Url(crypto.getRandomValues(new Uint8Array(32)))
    const auth = await authFixture()
    const room = roomStub(locator)
    const deviceId = crypto.randomUUID()
    await room.initialize({ locator, authVerifier: auth.verifier, ttlSeconds: 3_600 })

    const issued = await room.createSocketTicket(auth.token, deviceId)
    expect(issued.ok).toBe(true)
    if (!issued.ok) throw new Error('Expected a socket ticket')

    const response = await room.fetch(`https://room.internal/websocket?ticket=${issued.ticket}`, {
      headers: { Upgrade: 'websocket' },
    })
    expect(response.status).toBe(101)
    if (response.webSocket === null) throw new Error('Expected a WebSocket')
    response.webSocket.accept()

    const replay = await room.fetch(`https://room.internal/websocket?ticket=${issued.ticket}`, {
      headers: { Upgrade: 'websocket' },
    })
    expect(replay.status).toBe(401)
    response.webSocket.close(1000, 'test complete')
  })

  it('allows exactly one concurrent consumer of a WebSocket ticket', async () => {
    const locator = bytesToBase64Url(crypto.getRandomValues(new Uint8Array(32)))
    const auth = await authFixture()
    const room = roomStub(locator)
    await room.initialize({ locator, authVerifier: auth.verifier, ttlSeconds: 3_600 })
    const issued = await room.createSocketTicket(auth.token, crypto.randomUUID())
    if (!issued.ok) throw new Error('Expected a socket ticket')

    const [first, second] = await Promise.all([
      room.fetch(`https://room.internal/websocket?ticket=${issued.ticket}`, {
        headers: { Upgrade: 'websocket' },
      }),
      room.fetch(`https://room.internal/websocket?ticket=${issued.ticket}`, {
        headers: { Upgrade: 'websocket' },
      }),
    ])

    expect([first.status, second.status].sort((left, right) => left - right)).toEqual([101, 401])
    for (const response of [first, second]) {
      if (response.webSocket !== null) {
        response.webSocket.accept()
        response.webSocket.close(1000, 'test complete')
      }
    }
  })

  it('persists and broadcasts opaque messages over authenticated sockets', async () => {
    const locator = bytesToBase64Url(crypto.getRandomValues(new Uint8Array(32)))
    const auth = await authFixture()
    const recall = await authFixture()
    const room = roomStub(locator)
    const firstDevice = crypto.randomUUID()
    const secondDevice = crypto.randomUUID()
    await room.initialize({ locator, authVerifier: auth.verifier, ttlSeconds: 3_600 })

    const firstTicket = await room.createSocketTicket(auth.token, firstDevice)
    const secondTicket = await room.createSocketTicket(auth.token, secondDevice)
    if (!firstTicket.ok || !secondTicket.ok) throw new Error('Expected socket tickets')
    const firstResponse = await room.fetch(
      `https://room.internal/websocket?ticket=${firstTicket.ticket}`,
      { headers: { Upgrade: 'websocket' } },
    )
    const secondResponse = await room.fetch(
      `https://room.internal/websocket?ticket=${secondTicket.ticket}`,
      { headers: { Upgrade: 'websocket' } },
    )
    if (firstResponse.webSocket === null || secondResponse.webSocket === null) {
      throw new Error('Expected WebSockets')
    }
    const firstSocket = firstResponse.webSocket
    const secondSocket = secondResponse.webSocket
    const firstReady = waitForFrame(firstSocket, 'ready')
    const secondReady = waitForFrame(secondSocket, 'ready')
    firstSocket.accept()
    secondSocket.accept()
    await Promise.all([firstReady, secondReady])

    const outbound = { ...envelope(firstDevice), recallVerifier: recall.verifier }
    const firstDelivery = waitForFrame(firstSocket, 'message')
    const secondDelivery = waitForFrame(secondSocket, 'message')
    const acknowledgement = waitForFrame(firstSocket, 'ack')
    firstSocket.send(JSON.stringify({ type: 'message', envelope: outbound }))

    await expect(firstDelivery).resolves.toMatchObject({ type: 'message', message: outbound })
    await expect(secondDelivery).resolves.toMatchObject({ type: 'message', message: outbound })
    await expect(acknowledgement).resolves.toMatchObject({
      type: 'ack',
      id: outbound.id,
      sequence: 1,
      duplicate: false,
    })
    const firstRecall = waitForFrame(firstSocket, 'recall')
    const secondRecall = waitForFrame(secondSocket, 'recall')
    const recalled = await room.recallMessage(auth.token, firstDevice, outbound.id, recall.token)
    expect(recalled.ok).toBe(true)
    await expect(firstRecall).resolves.toMatchObject({
      type: 'recall',
      messageId: outbound.id,
      senderId: firstDevice,
      sequence: 2,
    })
    await expect(secondRecall).resolves.toMatchObject({
      type: 'recall',
      messageId: outbound.id,
      senderId: firstDevice,
      sequence: 2,
    })
    const history = await room.getMessages(auth.token, 0, 50)
    expect(history.messages).toMatchObject([
      { type: 'recall', messageId: outbound.id, senderId: firstDevice, sequence: 2 },
    ])

    firstSocket.close(1000, 'test complete')
    secondSocket.close(1000, 'test complete')
  })

  it('deletes room metadata and encrypted R2 objects when the room expires', async () => {
    const locator = bytesToBase64Url(crypto.getRandomValues(new Uint8Array(32)))
    const auth = await authFixture()
    const room = roomStub(locator)
    const fileId = crypto.randomUUID()
    await room.initialize({ locator, authVerifier: auth.verifier, ttlSeconds: 3_600 })
    await env.FILES.put(`rooms/${locator}/${fileId}/0`, new Uint8Array(32))

    await runInDurableObject(room, (_instance, state) => {
      state.storage.sql.exec('UPDATE room SET expires_at = ? WHERE singleton = 1', Date.now() - 1)
    })
    expect(await runDurableObjectAlarm(room)).toBe(true)

    expect(await env.FILES.get(`rooms/${locator}/${fileId}/0`)).toBeNull()
    expect(await room.getInfo(auth.token)).toEqual({ ok: false, reason: 'not_found' })
  })
})
