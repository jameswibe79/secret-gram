import { exports } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'

import type { ClientMessageEnvelope } from '../src/shared/protocol'

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '')
}

async function sha256Base64Url(bytes: Uint8Array): Promise<string> {
  return bytesToBase64Url(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)))
}

async function roomFixture() {
  const tokenBytes = crypto.getRandomValues(new Uint8Array(32))
  const verifier = new Uint8Array(await crypto.subtle.digest('SHA-256', tokenBytes))
  return {
    locator: bytesToBase64Url(crypto.getRandomValues(new Uint8Array(32))),
    token: bytesToBase64Url(tokenBytes),
    verifier: bytesToBase64Url(verifier),
  }
}

function api(path: string, init?: RequestInit) {
  return exports.default.fetch(`https://secret-gram.test${path}`, init)
}

async function createRoomViaApi() {
  const room = await roomFixture()
  const response = await api('/api/v1/rooms', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'https://secret-gram.test' },
    body: JSON.stringify({
      locator: room.locator,
      authVerifier: room.verifier,
      ttlSeconds: 3_600,
    }),
  })
  expect(response.status).toBe(201)
  return room
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

describe('SecretGram Worker API', () => {
  it('creates a room and protects its metadata with the derived token', async () => {
    const room = await roomFixture()
    const created = await api('/api/v1/rooms', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'https://secret-gram.test' },
      body: JSON.stringify({
        locator: room.locator,
        authVerifier: room.verifier,
        ttlSeconds: 3_600,
      }),
    })

    expect(created.status).toBe(201)
    expect(created.headers.get('Cache-Control')).toBe('no-store')
    expect(created.headers.get('X-Content-Type-Options')).toBe('nosniff')
    await expect(created.json()).resolves.toMatchObject({
      data: { created: true, expiresAt: expect.any(Number) },
    })

    const info = await api(`/api/v1/rooms/${room.locator}`, {
      headers: { Authorization: `Bearer ${room.token}` },
    })
    expect(info.status).toBe(200)
    await expect(info.json()).resolves.toMatchObject({
      data: { onlineCount: 0, expiresAt: expect.any(Number) },
    })

    const unauthorized = await api(`/api/v1/rooms/${room.locator}`, {
      headers: { Authorization: `Bearer ${bytesToBase64Url(new Uint8Array(32))}` },
    })
    expect(unauthorized.status).toBe(401)
    await expect(unauthorized.json()).resolves.toMatchObject({
      error: { code: 'unauthorized', requestId: expect.any(String) },
    })
  })

  it('rejects cross-origin state changes before they reach a room', async () => {
    const room = await roomFixture()
    const response = await api('/api/v1/rooms', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'https://attacker.example' },
      body: JSON.stringify({
        locator: room.locator,
        authVerifier: room.verifier,
        ttlSeconds: 3_600,
      }),
    })

    expect(response.status).toBe(403)
    await expect(response.json()).resolves.toMatchObject({ error: { code: 'cross_origin' } })
  })

  it('supports authenticated message history and one-time socket ticket creation', async () => {
    const room = await createRoomViaApi()
    const deviceId = crypto.randomUUID()
    const message = envelope(deviceId)

    const posted = await api(`/api/v1/rooms/${room.locator}/messages`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${room.token}`,
        'Content-Type': 'application/json',
        Origin: 'https://secret-gram.test',
      },
      body: JSON.stringify({ deviceId, envelope: message }),
    })
    expect(posted.status).toBe(201)
    await expect(posted.json()).resolves.toMatchObject({
      data: { duplicate: false, message: { ...message, sequence: 1 } },
    })

    const history = await api(`/api/v1/rooms/${room.locator}/messages?after=0&limit=50`, {
      headers: { Authorization: `Bearer ${room.token}` },
    })
    expect(history.status).toBe(200)
    await expect(history.json()).resolves.toMatchObject({
      data: { messages: [{ ...message, sequence: 1 }] },
    })

    const ticket = await api(`/api/v1/rooms/${room.locator}/socket-ticket`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${room.token}`,
        'Content-Type': 'application/json',
        Origin: 'https://secret-gram.test',
      },
      body: JSON.stringify({ deviceId }),
    })
    expect(ticket.status).toBe(201)
    await expect(ticket.json()).resolves.toMatchObject({
      data: { ticket: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/u) },
    })
  })

  it('streams encrypted file chunks through R2 only after room authorization', async () => {
    const room = await createRoomViaApi()
    const deviceId = crypto.randomUUID()
    const fileId = crypto.randomUUID()
    const encryptedChunk = crypto.getRandomValues(new Uint8Array(64))
    const ciphertextHash = await sha256Base64Url(encryptedChunk)

    const begun = await api(`/api/v1/rooms/${room.locator}/uploads`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${room.token}`,
        'Content-Type': 'application/json',
        Origin: 'https://secret-gram.test',
      },
      body: JSON.stringify({ deviceId, fileId, chunkCount: 1, encryptedSize: 64 }),
    })
    expect(begun.status).toBe(201)

    const uploaded = await api(
      `/api/v1/rooms/${room.locator}/uploads/${fileId}/chunks/0`,
      {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${room.token}`,
          'Content-Length': String(encryptedChunk.byteLength),
          'Content-Type': 'application/octet-stream',
          Origin: 'https://secret-gram.test',
          'X-Ciphertext-SHA256': ciphertextHash,
          'X-Device-ID': deviceId,
        },
        body: encryptedChunk,
      },
    )
    expect(uploaded.status).toBe(201)

    const retry = await api(
      `/api/v1/rooms/${room.locator}/uploads/${fileId}/chunks/0`,
      {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${room.token}`,
          'Content-Length': String(encryptedChunk.byteLength),
          'Content-Type': 'application/octet-stream',
          Origin: 'https://secret-gram.test',
          'X-Ciphertext-SHA256': ciphertextHash,
          'X-Device-ID': deviceId,
        },
        body: encryptedChunk,
      },
    )
    expect(retry.status).toBe(200)

    const changedChunk = crypto.getRandomValues(new Uint8Array(64))
    const overwrite = await api(
      `/api/v1/rooms/${room.locator}/uploads/${fileId}/chunks/0`,
      {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${room.token}`,
          'Content-Length': String(changedChunk.byteLength),
          'Content-Type': 'application/octet-stream',
          Origin: 'https://secret-gram.test',
          'X-Ciphertext-SHA256': await sha256Base64Url(changedChunk),
          'X-Device-ID': deviceId,
        },
        body: changedChunk,
      },
    )
    expect(overwrite.status).toBe(409)

    const completed = await api(`/api/v1/rooms/${room.locator}/uploads/${fileId}/complete`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${room.token}`,
        'Content-Type': 'application/json',
        Origin: 'https://secret-gram.test',
      },
      body: JSON.stringify({ deviceId }),
    })
    expect(completed.status).toBe(200)

    const downloaded = await api(
      `/api/v1/rooms/${room.locator}/uploads/${fileId}/chunks/0`,
      { headers: { Authorization: `Bearer ${room.token}` } },
    )
    expect(downloaded.status).toBe(200)
    expect(downloaded.headers.get('Cache-Control')).toBe('private, no-store')
    expect([...new Uint8Array(await downloaded.arrayBuffer())]).toEqual([...encryptedChunk])

    const unauthorized = await api(
      `/api/v1/rooms/${room.locator}/uploads/${fileId}/chunks/0`,
      { headers: { Authorization: `Bearer ${bytesToBase64Url(new Uint8Array(32))}` } },
    )
    expect(unauthorized.status).toBe(401)
  })

  it('keeps the winning content-addressed chunk intact during conflicting concurrent uploads', async () => {
    const room = await createRoomViaApi()
    const deviceId = crypto.randomUUID()
    const fileId = crypto.randomUUID()
    const firstChunk = crypto.getRandomValues(new Uint8Array(64))
    const secondChunk = crypto.getRandomValues(new Uint8Array(64))
    const firstHash = await sha256Base64Url(firstChunk)
    const secondHash = await sha256Base64Url(secondChunk)

    const begun = await api(`/api/v1/rooms/${room.locator}/uploads`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${room.token}`,
        'Content-Type': 'application/json',
        Origin: 'https://secret-gram.test',
      },
      body: JSON.stringify({ deviceId, fileId, chunkCount: 1, encryptedSize: 64 }),
    })
    expect(begun.status).toBe(201)

    const putChunk = (chunk: Uint8Array, digest: string) =>
      api(`/api/v1/rooms/${room.locator}/uploads/${fileId}/chunks/0`, {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${room.token}`,
          'Content-Length': String(chunk.byteLength),
          'Content-Type': 'application/octet-stream',
          Origin: 'https://secret-gram.test',
          'X-Ciphertext-SHA256': digest,
          'X-Device-ID': deviceId,
        },
        body: chunk,
      })

    const [firstResponse, secondResponse] = await Promise.all([
      putChunk(firstChunk, firstHash),
      putChunk(secondChunk, secondHash),
    ])
    expect([firstResponse.status, secondResponse.status].sort()).toEqual([201, 409])
    const winningChunk = firstResponse.ok ? firstChunk : secondChunk

    const completed = await api(`/api/v1/rooms/${room.locator}/uploads/${fileId}/complete`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${room.token}`,
        'Content-Type': 'application/json',
        Origin: 'https://secret-gram.test',
      },
      body: JSON.stringify({ deviceId }),
    })
    expect(completed.status).toBe(200)

    const downloaded = await api(
      `/api/v1/rooms/${room.locator}/uploads/${fileId}/chunks/0`,
      { headers: { Authorization: `Bearer ${room.token}` } },
    )
    expect(downloaded.status).toBe(200)
    expect([...new Uint8Array(await downloaded.arrayBuffer())]).toEqual([...winningChunk])
  })
})
