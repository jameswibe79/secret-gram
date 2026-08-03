import { describe, expect, it, vi } from 'vitest'

import type { StoredMessageEnvelope } from '../shared/protocol'
import { drainRoomHistory, mergeTimeline, type TimelineMessage } from './useRoomChannel'

function stored(sequence: number): StoredMessageEnvelope {
  return {
    version: 2,
    id: crypto.randomUUID(),
    senderId: crypto.randomUUID(),
    senderEpochId: 'AAAAAAAAAAAAAAAAAAAAAA',
    counter: sequence,
    ciphertext: 'AAAAAAAAAAAAAAAAAAAAAA',
    sequence,
    serverCreatedAt: sequence,
  }
}

describe('drainRoomHistory', () => {
  it('drains every page so reconnects cannot skip a large backlog', async () => {
    const pages = [[stored(1), stored(2)], [stored(3), stored(4)], [stored(5)]]
    const fetchPage = vi.fn(async () => pages.shift() ?? [])
    const applied: number[] = []

    const cursor = await drainRoomHistory(
      0,
      2,
      fetchPage,
      async (message) => { applied.push(message.sequence) },
    )

    expect(cursor).toBe(5)
    expect(applied).toEqual([1, 2, 3, 4, 5])
    expect(fetchPage.mock.calls).toEqual([[0, 2], [2, 2], [4, 2]])
  })

  it('fails closed if a full page does not advance the sequence cursor', async () => {
    const fetchPage = vi.fn(async () => [stored(8), stored(9)])

    await expect(
      drainRoomHistory(10, 2, fetchPage, async () => undefined),
    ).rejects.toThrow('History cursor did not advance')
  })
})

describe('mergeTimeline', () => {
  it('does not preserve optimistic plaintext after stored ciphertext fails verification', () => {
    const envelope = stored(1)
    const optimistic: TimelineMessage = {
      id: envelope.id,
      senderId: envelope.senderId,
      envelope,
      sequence: null,
      serverCreatedAt: null,
      content: {
        version: 1,
        id: envelope.id,
        senderId: envelope.senderId,
        senderName: 'Alice',
        clientCreatedAt: 1,
        kind: 'text',
        text: 'optimistic plaintext',
      },
      delivery: 'sending',
    }

    const merged = mergeTimeline([optimistic], {
      ...optimistic,
      sequence: 1,
      serverCreatedAt: 1,
      content: null,
      delivery: 'stored',
      error: 'Integrity verification failed',
    })

    expect(merged[0]?.content).toBeNull()
    expect(merged[0]?.error).toBe('Integrity verification failed')
  })

  it('replaces recalled plaintext and its capability with a tombstone', () => {
    const envelope = stored(1)
    const current: TimelineMessage = {
      id: envelope.id,
      senderId: envelope.senderId,
      envelope,
      sequence: 1,
      serverCreatedAt: 1,
      content: {
        version: 1,
        id: envelope.id,
        senderId: envelope.senderId,
        senderName: 'Alice',
        clientCreatedAt: 1,
        kind: 'text',
        text: 'remove me',
      },
      delivery: 'stored',
      recallToken: 'A'.repeat(43),
    }

    const recalled = mergeTimeline([current], {
      id: envelope.id,
      senderId: envelope.senderId,
      envelope: null,
      sequence: 2,
      serverCreatedAt: 2,
      content: null,
      delivery: 'stored',
      recallToken: undefined,
      recalledAt: 2,
    })

    expect(recalled[0]).toMatchObject({
      id: envelope.id,
      envelope: null,
      sequence: 2,
      content: null,
      recalledAt: 2,
    })
    expect(recalled[0]?.recallToken).toBeUndefined()
  })
})
