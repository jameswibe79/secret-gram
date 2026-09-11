import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { FileDescriptor } from '../shared/protocol'
import {
  beginEncryptedUpload,
  completeEncryptedUpload,
  getEncryptedChunk,
  putEncryptedChunk,
} from './api'
import { downloadDecryptedFile, downloadDecryptedFileToWritable, uploadEncryptedFile } from './file-transfer'

vi.mock('./api', () => ({
  beginEncryptedUpload: vi.fn(),
  completeEncryptedUpload: vi.fn(),
  getEncryptedChunk: vi.fn(),
  putEncryptedChunk: vi.fn(),
}))

const credentials = {
  locator: 'room-locator',
  token: 'room-token',
  deviceId: crypto.randomUUID(),
}

beforeEach(() => {
  vi.mocked(beginEncryptedUpload).mockReset().mockResolvedValue({ created: true })
  vi.mocked(putEncryptedChunk).mockReset().mockResolvedValue(undefined)
  vi.mocked(completeEncryptedUpload).mockReset().mockResolvedValue({ ready: true })
  vi.mocked(getEncryptedChunk).mockReset()
})

describe('encrypted file transfer', () => {
  it('encrypts, uploads, and reports plaintext progress one chunk at a time', async () => {
    const file = new File([new Uint8Array([1, 2, 3, 4, 5, 6])], 'evidence.bin', {
      type: 'application/octet-stream',
    })
    const progress: number[] = []

    const descriptor = await uploadEncryptedFile(file, credentials, {
      chunkSize: 4,
      onProgress: (state) => progress.push(state.completedBytes),
    })

    expect(descriptor).toMatchObject({
      name: 'evidence.bin',
      size: 6,
      chunkCount: 2,
      chunkSize: 4,
    })
    expect(beginEncryptedUpload).toHaveBeenCalledWith(
      credentials.locator,
      credentials.token,
      expect.objectContaining({
        deviceId: credentials.deviceId,
        fileId: descriptor.fileId,
        chunkCount: 2,
        encryptedSize: 38,
      }),
      undefined,
    )
    expect(putEncryptedChunk).toHaveBeenCalledTimes(2)
    expect(progress.at(-1)).toBe(6)
  })

  it('retries a logical chunk with byte-identical ciphertext after a transient failure', async () => {
    const file = new File([new Uint8Array([1, 2, 3, 4])], 'retry.bin', {
      type: 'application/octet-stream',
    })
    vi.mocked(putEncryptedChunk)
      .mockRejectedValueOnce(new Error('connection reset'))
      .mockResolvedValueOnce(undefined)

    await uploadEncryptedFile(file, credentials, {
      chunkSize: 4,
      retryDelayMs: 0,
    })

    expect(putEncryptedChunk).toHaveBeenCalledTimes(2)
    const calls = vi.mocked(putEncryptedChunk).mock.calls
    const firstCiphertext = calls[0]?.[5]
    const retriedCiphertext = calls[1]?.[5]
    expect(retriedCiphertext).toBe(firstCiphertext)
  })

  it('downloads and authenticates every encrypted chunk before returning a Blob', async () => {
    const file = new File([new TextEncoder().encode('confidential')], 'note.txt', {
      type: 'text/plain',
    })
    const descriptor = await uploadEncryptedFile(file, credentials, { chunkSize: 4 })
    const chunks = vi
      .mocked(putEncryptedChunk)
      .mock.calls.map((call) => new Uint8Array(call[5] as Uint8Array<ArrayBuffer>))
    vi.mocked(getEncryptedChunk).mockImplementation(async (_locator, _token, _fileId, index) => {
      const chunk = chunks[index]
      if (chunk === undefined) throw new Error('missing chunk')
      return chunk
    })

    const blob = await downloadDecryptedFile(descriptor as FileDescriptor, credentials)

    expect(await blob.text()).toBe('confidential')
    expect(blob.type).toBe('text/plain')
  })

  it('waits for disk backpressure and commits only the fully authenticated file', async () => {
    const descriptor = await uploadEncryptedFile(new File(['abcdefgh'], 'stream.bin'), credentials, { chunkSize: 4 })
    const chunks = vi.mocked(putEncryptedChunk).mock.calls.map((call) => call[5])
    vi.mocked(getEncryptedChunk).mockImplementation(async (_locator, _token, _fileId, index) => chunks[index]!)
    let releaseWrite!: () => void
    const blocked = new Promise<void>((resolve) => { releaseWrite = resolve })
    const saved: BlobPart[] = []
    let committed = ''
    const operation = downloadDecryptedFileToWritable(descriptor, credentials, {
      async write(chunk) {
        await blocked
        if (!(chunk instanceof Uint8Array)) throw new Error('Expected binary chunk')
        saved.push(new Uint8Array(chunk))
      },
      async close() { committed = await new Blob(saved).text() },
      async abort() { saved.length = 0 },
    })
    await vi.waitFor(() => expect(getEncryptedChunk).toHaveBeenCalledTimes(1))
    expect(committed).toBe('')
    releaseWrite()
    await operation
    expect(committed).toBe('abcdefgh')
  })

  it('discards partial output when a later chunk fails authentication', async () => {
    const descriptor = await uploadEncryptedFile(new File(['abcdefgh'], 'tampered.bin'), credentials, { chunkSize: 4 })
    const chunks = vi.mocked(putEncryptedChunk).mock.calls.map((call) => new Uint8Array(call[5]))
    chunks[1]![0] ^= 1
    vi.mocked(getEncryptedChunk).mockImplementation(async (_locator, _token, _fileId, index) => chunks[index]!)
    let stagedBytes = 0
    let committed = false
    await expect(downloadDecryptedFileToWritable(descriptor, credentials, {
      async write(chunk) {
        if (!(chunk instanceof Uint8Array)) throw new Error('Expected binary chunk')
        stagedBytes += chunk.byteLength
      },
      async close() { committed = true },
      async abort() { stagedBytes = 0 },
    })).rejects.toThrow()
    expect(stagedBytes).toBe(0)
    expect(committed).toBe(false)
  })

  it('does not commit when canceled during the final disk write', async () => {
    const descriptor = await uploadEncryptedFile(new File(['abcd'], 'cancel.bin'), credentials, { chunkSize: 4 })
    vi.mocked(getEncryptedChunk).mockResolvedValue(vi.mocked(putEncryptedChunk).mock.calls[0]![5])
    const controller = new AbortController()
    let staged = false
    let committed = false
    await expect(downloadDecryptedFileToWritable(descriptor, credentials, {
      async write() {
        staged = true
        controller.abort()
      },
      async close() { committed = true },
      async abort() { staged = false },
    }, { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' })
    expect(staged).toBe(false)
    expect(committed).toBe(false)
  })
})
