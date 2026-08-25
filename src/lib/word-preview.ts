const END_OF_CENTRAL_DIRECTORY_SIGNATURE = 0x06054b50
const CENTRAL_DIRECTORY_SIGNATURE = 0x02014b50
const MAX_END_RECORD_SEARCH_BYTES = 65_557
const MAX_ARCHIVE_ENTRIES = 2_048
export const MAX_WORD_UNCOMPRESSED_BYTES = 96 * 1024 * 1024
export const MAX_WORD_ENTRY_BYTES = 64 * 1024 * 1024

export const MAX_WORD_PREVIEW_BYTES = 16 * 1024 * 1024

export interface WordPreviewWorkerRequest {
  arrayBuffer: ArrayBuffer
}

export type WordPreviewWorkerResponse =
  | { type: 'ready' }
  | { type: 'error' }

function findEndOfCentralDirectory(view: DataView): number {
  const minimumOffset = Math.max(0, view.byteLength - MAX_END_RECORD_SEARCH_BYTES)
  for (let offset = view.byteLength - 22; offset >= minimumOffset; offset -= 1) {
    if (view.getUint32(offset, true) === END_OF_CENTRAL_DIRECTORY_SIGNATURE) return offset
  }
  throw new Error('DOCX central directory is missing')
}

export function assertSafeDocxArchive(arrayBuffer: ArrayBuffer): void {
  if (arrayBuffer.byteLength < 22 || arrayBuffer.byteLength > MAX_WORD_PREVIEW_BYTES) {
    throw new Error('DOCX size is outside the preview limit')
  }

  const view = new DataView(arrayBuffer)
  const endOffset = findEndOfCentralDirectory(view)
  const diskNumber = view.getUint16(endOffset + 4, true)
  const centralDirectoryDisk = view.getUint16(endOffset + 6, true)
  const diskEntries = view.getUint16(endOffset + 8, true)
  const totalEntries = view.getUint16(endOffset + 10, true)
  const centralDirectorySize = view.getUint32(endOffset + 12, true)
  const centralDirectoryOffset = view.getUint32(endOffset + 16, true)

  if (
    diskNumber !== 0 ||
    centralDirectoryDisk !== 0 ||
    diskEntries !== totalEntries ||
    totalEntries === 0 ||
    totalEntries === 0xffff ||
    totalEntries > MAX_ARCHIVE_ENTRIES ||
    centralDirectorySize === 0xffffffff ||
    centralDirectoryOffset === 0xffffffff ||
    centralDirectoryOffset + centralDirectorySize > endOffset
  ) {
    throw new Error('DOCX archive layout is not supported')
  }

  const decoder = new TextDecoder()
  let offset = centralDirectoryOffset
  let uncompressedBytes = 0
  let hasContentTypes = false
  let hasDocument = false

  for (let entry = 0; entry < totalEntries; entry += 1) {
    if (offset + 46 > endOffset || view.getUint32(offset, true) !== CENTRAL_DIRECTORY_SIGNATURE) {
      throw new Error('DOCX central directory is invalid')
    }

    const flags = view.getUint16(offset + 8, true)
    const compression = view.getUint16(offset + 10, true)
    const uncompressedSize = view.getUint32(offset + 24, true)
    const nameLength = view.getUint16(offset + 28, true)
    const extraLength = view.getUint16(offset + 30, true)
    const commentLength = view.getUint16(offset + 32, true)
    const nextOffset = offset + 46 + nameLength + extraLength + commentLength

    if (
      flags & 0x1 ||
      (compression !== 0 && compression !== 8) ||
      uncompressedSize === 0xffffffff ||
      uncompressedSize > MAX_WORD_ENTRY_BYTES ||
      nextOffset > endOffset
    ) {
      throw new Error('DOCX entry is not safe to preview')
    }

    uncompressedBytes += uncompressedSize
    if (uncompressedBytes > MAX_WORD_UNCOMPRESSED_BYTES) {
      throw new Error('DOCX expands beyond the preview limit')
    }

    const nameBytes = new Uint8Array(arrayBuffer, offset + 46, nameLength)
    const name = decoder.decode(nameBytes)
    if (name === '[Content_Types].xml') hasContentTypes = true
    if (name === 'word/document.xml') hasDocument = true
    offset = nextOffset
  }

  if (offset !== centralDirectoryOffset + centralDirectorySize || !hasContentTypes || !hasDocument) {
    throw new Error('DOCX package is incomplete')
  }
}
