import { describe, expect, it } from 'vitest'

import { assertSafeDocxArchive } from './word-preview'

interface ArchiveEntry {
  name: string
  uncompressedSize: number
}

function centralDirectoryArchive(entries: ArchiveEntry[]): ArrayBuffer {
  const encoder = new TextEncoder()
  const names = entries.map((entry) => encoder.encode(entry.name))
  const centralDirectorySize = names.reduce((total, name) => total + 46 + name.length, 0)
  const bytes = new Uint8Array(centralDirectorySize + 22)
  const view = new DataView(bytes.buffer)
  let offset = 0

  entries.forEach((entry, index) => {
    const name = names[index]
    view.setUint32(offset, 0x02014b50, true)
    view.setUint16(offset + 10, 8, true)
    view.setUint32(offset + 24, entry.uncompressedSize, true)
    view.setUint16(offset + 28, name.length, true)
    bytes.set(name, offset + 46)
    offset += 46 + name.length
  })

  view.setUint32(offset, 0x06054b50, true)
  view.setUint16(offset + 8, entries.length, true)
  view.setUint16(offset + 10, entries.length, true)
  view.setUint32(offset + 12, centralDirectorySize, true)
  view.setUint32(offset + 16, 0, true)
  return bytes.buffer
}

describe('assertSafeDocxArchive', () => {
  it('accepts a bounded DOCX package with the required parts', () => {
    const archive = centralDirectoryArchive([
      { name: '[Content_Types].xml', uncompressedSize: 800 },
      { name: 'word/document.xml', uncompressedSize: 4_000 },
    ])

    expect(() => assertSafeDocxArchive(archive)).not.toThrow()
  })

  it('rejects packages whose entries expand beyond the memory ceiling', () => {
    const archive = centralDirectoryArchive([
      { name: '[Content_Types].xml', uncompressedSize: 50 * 1024 * 1024 },
      { name: 'word/document.xml', uncompressedSize: 50 * 1024 * 1024 },
    ])

    expect(() => assertSafeDocxArchive(archive)).toThrow('DOCX expands beyond the preview limit')
  })

  it('rejects ZIP-shaped input without the required Word document part', () => {
    const archive = centralDirectoryArchive([
      { name: '[Content_Types].xml', uncompressedSize: 800 },
      { name: 'word/styles.xml', uncompressedSize: 1_000 },
    ])

    expect(() => assertSafeDocxArchive(archive)).toThrow('DOCX package is incomplete')
  })
})
