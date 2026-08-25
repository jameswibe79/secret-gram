import JSZip from 'jszip'

import {
  assertSafeDocxArchive,
  MAX_WORD_ENTRY_BYTES,
  MAX_WORD_UNCOMPRESSED_BYTES,
  type WordPreviewWorkerRequest,
  type WordPreviewWorkerResponse,
} from '../lib/word-preview'

interface Uint8ArrayStream {
  on(event: 'data', callback: (chunk: Uint8Array) => void): Uint8ArrayStream
  on(event: 'end', callback: () => void): Uint8ArrayStream
  on(event: 'error', callback: (error: Error) => void): Uint8ArrayStream
  pause(): Uint8ArrayStream
  resume(): Uint8ArrayStream
}

interface StreamableZipObject extends JSZip.JSZipObject {
  internalStream(type: 'uint8array'): Uint8ArrayStream
}

const workerScope = self as unknown as {
  onmessage: ((event: MessageEvent<WordPreviewWorkerRequest>) => void) | null
  postMessage(message: WordPreviewWorkerResponse): void
}

function hasInternalStream(entry: JSZip.JSZipObject): entry is StreamableZipObject {
  return 'internalStream' in entry && typeof entry.internalStream === 'function'
}

async function assertActualExpansion(arrayBuffer: ArrayBuffer): Promise<void> {
  const archive = await JSZip.loadAsync(arrayBuffer, { createFolders: false })
  let totalBytes = 0

  for (const entry of Object.values(archive.files)) {
    if (entry.dir) continue
    if (!hasInternalStream(entry)) throw new Error('DOCX entry stream is unavailable')

    await new Promise<void>((resolve, reject) => {
      const stream = entry.internalStream('uint8array')
      let entryBytes = 0
      let settled = false

      function fail() {
        if (settled) return
        settled = true
        stream.pause()
        reject(new Error('DOCX expands beyond the preview limit'))
      }

      stream
        .on('data', (chunk) => {
          if (settled) return
          entryBytes += chunk.byteLength
          totalBytes += chunk.byteLength
          if (
            entryBytes > MAX_WORD_ENTRY_BYTES ||
            totalBytes > MAX_WORD_UNCOMPRESSED_BYTES
          ) {
            fail()
          }
        })
        .on('error', fail)
        .on('end', () => {
          if (settled) return
          settled = true
          resolve()
        })
        .resume()
    })
  }
}

workerScope.onmessage = (event) => {
  void (async () => {
    try {
      assertSafeDocxArchive(event.data.arrayBuffer)
      await assertActualExpansion(event.data.arrayBuffer)
      workerScope.postMessage({ type: 'ready' })
    } catch {
      workerScope.postMessage({ type: 'error' })
    }
  })()
}
