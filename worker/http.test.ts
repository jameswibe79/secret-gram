import { describe, expect, it } from 'vitest'
import { z } from 'zod'

import { normalizeApiPath, parseJson } from './http'

describe('bounded JSON request parsing', () => {
  it('cancels an unbounded stream as soon as it exceeds the body limit', async () => {
    let pulls = 0
    let cancelled = false
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1
        if (pulls > 10) {
          controller.close()
          return
        }
        controller.enqueue(new Uint8Array(16 * 1024).fill(0x20))
      },
      cancel() {
        cancelled = true
      },
    })
    const request = new Request('https://secret-gram.test/api/v1/rooms', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    })

    await expect(parseJson(request, z.unknown())).rejects.toMatchObject({
      status: 413,
      code: 'payload_too_large',
    })
    expect(cancelled).toBe(true)
    expect(pulls).toBeLessThan(10)
  })
})

describe('safe operational paths', () => {
  it('removes stable room and file identifiers before logging', () => {
    expect(normalizeApiPath(
      '/api/v1/rooms/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA/files/123e4567-e89b-12d3-a456-426614174000/chunks/42',
    )).toBe('/api/v1/rooms/:room/files/:id/chunks/:number')
  })
})
