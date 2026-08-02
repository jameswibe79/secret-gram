import { describe, expect, it } from 'vitest'

import {
  createFileEncryptionPlan,
  decryptFileChunk,
  encryptFileChunk,
  fileDescriptorFromPlan,
} from './file-crypto'

function join(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((size, chunk) => size + chunk.byteLength, 0)
  const joined = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    joined.set(chunk, offset)
    offset += chunk.byteLength
  }
  return joined
}

describe('chunked file encryption', () => {
  it('encrypts and decrypts every chunk without loading an unbounded file at once', async () => {
    const plaintext = new TextEncoder().encode('0123456789')
    const plan = await createFileEncryptionPlan(plaintext.byteLength, 4)
    const descriptor = fileDescriptorFromPlan(plan, 'evidence.pdf', 'application/pdf')
    const decrypted: Uint8Array[] = []

    expect(plan.chunkCount).toBe(3)

    for (let index = 0; index < plan.chunkCount; index += 1) {
      const start = index * plan.chunkSize
      const chunk = plaintext.slice(start, start + plan.chunkSize)
      const ciphertext = await encryptFileChunk(plan, 'room-locator', index, chunk)
      decrypted.push(
        await decryptFileChunk(descriptor, 'room-locator', index, ciphertext),
      )
    }

    expect([...join(decrypted)]).toEqual([...plaintext])
  })

  it('uses a unique authenticated nonce for each chunk', async () => {
    const plan = await createFileEncryptionPlan(8, 4)
    const chunk = new TextEncoder().encode('same')

    const first = await encryptFileChunk(plan, 'room-locator', 0, chunk)
    const second = await encryptFileChunk(plan, 'room-locator', 1, chunk)

    expect(first).not.toEqual(second)
  })

  it('rejects reordered chunks and wrong rooms', async () => {
    const plan = await createFileEncryptionPlan(8, 4)
    const descriptor = fileDescriptorFromPlan(plan, 'notes.txt', 'text/plain')
    const ciphertext = await encryptFileChunk(
      plan,
      'correct-room',
      0,
      new TextEncoder().encode('data'),
    )

    await expect(
      decryptFileChunk(descriptor, 'correct-room', 1, ciphertext),
    ).rejects.toThrow('File chunk integrity check failed')
    await expect(
      decryptFileChunk(descriptor, 'wrong-room', 0, ciphertext),
    ).rejects.toThrow('File chunk integrity check failed')
  })

  it('rejects a chunk whose plaintext length does not match the manifest', async () => {
    const plan = await createFileEncryptionPlan(8, 4)

    await expect(
      encryptFileChunk(plan, 'room-locator', 0, new Uint8Array(3)),
    ).rejects.toThrow('File chunk size does not match the manifest')
  })

  it('reuses cached ciphertext for an identical retry and rejects changed plaintext', async () => {
    const plan = await createFileEncryptionPlan(4, 4)
    const original = new TextEncoder().encode('same')

    const first = await encryptFileChunk(plan, 'room-locator', 0, original)
    const retry = await encryptFileChunk(plan, 'room-locator', 0, original)

    expect([...retry]).toEqual([...first])
    await expect(
      encryptFileChunk(plan, 'room-locator', 0, new TextEncoder().encode('diff')),
    ).rejects.toThrow('An upload chunk cannot be re-encrypted with different content')
  })
})
