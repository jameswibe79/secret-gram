import JSZip from 'jszip'
import { SaxesParser, type SaxesTagPlain } from 'saxes'

import {
  MAX_SPREADSHEET_ENTRY_BYTES,
  MAX_SPREADSHEET_PREVIEW_BYTES,
  MAX_SPREADSHEET_UNCOMPRESSED_BYTES,
  type SpreadsheetPreviewSheet,
  type SpreadsheetPreviewWorkbook,
} from './spreadsheet-preview'

const END_OF_CENTRAL_DIRECTORY_SIGNATURE = 0x06054b50
const CENTRAL_DIRECTORY_SIGNATURE = 0x02014b50
const MAX_END_RECORD_SEARCH_BYTES = 65_557
const MAX_ARCHIVE_ENTRIES = 4_096
const MAX_SHEETS = 16
const MAX_ROWS_PER_SHEET = 200
const MAX_COLUMNS_PER_SHEET = 64
const MAX_PREVIEW_CELLS = 20_000
const MAX_CELL_CHARACTERS = 32_768
const MAX_SHARED_STRINGS = 100_000
const MAX_SHARED_STRING_CHARACTERS = 8 * 1024 * 1024
const MAX_STYLES = 65_536

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

interface ExpansionState {
  totalBytes: number
}

interface WorkbookSheetReference {
  name: string
  relationshipId: string
}

interface WorkbookDefinition {
  date1904: boolean
  sheets: WorkbookSheetReference[]
  truncated: boolean
}

interface CellFormatting {
  date1904: boolean
  dateStyles: boolean[]
}

function localName(name: string): string {
  const separator = name.indexOf(':')
  return separator === -1 ? name : name.slice(separator + 1)
}

function findEndOfCentralDirectory(view: DataView): number {
  const minimumOffset = Math.max(0, view.byteLength - MAX_END_RECORD_SEARCH_BYTES)
  for (let offset = view.byteLength - 22; offset >= minimumOffset; offset -= 1) {
    if (view.getUint32(offset, true) === END_OF_CENTRAL_DIRECTORY_SIGNATURE) return offset
  }
  throw new Error('XLSX central directory is missing')
}

export function assertSafeXlsxArchive(arrayBuffer: ArrayBuffer): void {
  if (arrayBuffer.byteLength < 22 || arrayBuffer.byteLength > MAX_SPREADSHEET_PREVIEW_BYTES) {
    throw new Error('XLSX size is outside the preview limit')
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
    throw new Error('XLSX archive layout is not supported')
  }

  const decoder = new TextDecoder('utf-8', { fatal: true })
  const names = new Set<string>()
  let offset = centralDirectoryOffset
  let uncompressedBytes = 0
  let hasContentTypes = false
  let hasWorkbook = false
  let hasWorkbookRelationships = false

  for (let entry = 0; entry < totalEntries; entry += 1) {
    if (offset + 46 > endOffset || view.getUint32(offset, true) !== CENTRAL_DIRECTORY_SIGNATURE) {
      throw new Error('XLSX central directory is invalid')
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
      uncompressedSize > MAX_SPREADSHEET_ENTRY_BYTES ||
      nextOffset > endOffset
    ) {
      throw new Error('XLSX entry is not safe to preview')
    }

    uncompressedBytes += uncompressedSize
    if (uncompressedBytes > MAX_SPREADSHEET_UNCOMPRESSED_BYTES) {
      throw new Error('XLSX expands beyond the preview limit')
    }

    const nameBytes = new Uint8Array(arrayBuffer, offset + 46, nameLength)
    const name = decoder.decode(nameBytes)
    if (
      name === '' ||
      name.includes('\0') ||
      name.includes('\\') ||
      name.startsWith('/') ||
      name.split('/').includes('..') ||
      names.has(name)
    ) {
      throw new Error('XLSX entry path is invalid')
    }
    names.add(name)
    if (name === '[Content_Types].xml') hasContentTypes = true
    if (name === 'xl/workbook.xml') hasWorkbook = true
    if (name === 'xl/_rels/workbook.xml.rels') hasWorkbookRelationships = true
    offset = nextOffset
  }

  if (
    offset !== centralDirectoryOffset + centralDirectorySize ||
    !hasContentTypes ||
    !hasWorkbook ||
    !hasWorkbookRelationships
  ) {
    throw new Error('XLSX package is incomplete')
  }
}

function hasInternalStream(entry: JSZip.JSZipObject): entry is StreamableZipObject {
  return 'internalStream' in entry && typeof entry.internalStream === 'function'
}

function safeXmlParser(): SaxesParser<{
  xmlns: false
}> {
  const parser = new SaxesParser({ xmlns: false })
  parser.on('doctype', () => {
    throw new Error('XLSX document types are not supported')
  })
  parser.on('error', (error) => {
    throw error
  })
  return parser
}

async function parseXmlEntry(
  archive: JSZip,
  path: string,
  expansion: ExpansionState,
  configure: (parser: SaxesParser<{ xmlns: false }>) => void,
): Promise<void> {
  const entry = archive.file(path)
  if (entry === null || entry.dir || !hasInternalStream(entry)) {
    throw new Error(`XLSX part is missing: ${path}`)
  }

  const parser = safeXmlParser()
  configure(parser)
  const decoder = new TextDecoder('utf-8', { fatal: true })

  await new Promise<void>((resolve, reject) => {
    const stream = entry.internalStream('uint8array')
    let entryBytes = 0
    let settled = false

    function fail(error: unknown) {
      if (settled) return
      settled = true
      stream.pause()
      reject(error instanceof Error ? error : new Error('XLSX XML parsing failed'))
    }

    stream
      .on('data', (chunk) => {
        if (settled) return
        entryBytes += chunk.byteLength
        expansion.totalBytes += chunk.byteLength
        if (
          entryBytes > MAX_SPREADSHEET_ENTRY_BYTES ||
          expansion.totalBytes > MAX_SPREADSHEET_UNCOMPRESSED_BYTES
        ) {
          fail(new Error('XLSX expands beyond the preview limit'))
          return
        }
        try {
          parser.write(decoder.decode(chunk, { stream: true }))
        } catch (error) {
          fail(error)
        }
      })
      .on('error', fail)
      .on('end', () => {
        if (settled) return
        try {
          parser.write(decoder.decode()).close()
          settled = true
          resolve()
        } catch (error) {
          fail(error)
        }
      })
      .resume()
  })
}

function normalizeRelationshipTarget(target: string): string {
  if (
    target === '' ||
    target.includes('\\') ||
    target.includes('?') ||
    target.includes('#') ||
    /^[a-z][a-z\d+.-]*:/i.test(target)
  ) {
    throw new Error('XLSX relationship target is invalid')
  }

  const parts = target.startsWith('/') ? [] : ['xl']
  for (const part of target.replace(/^\/+/, '').split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') {
      if (parts.length <= 1) throw new Error('XLSX relationship escapes the workbook')
      parts.pop()
    } else {
      parts.push(part)
    }
  }
  if (parts[0] !== 'xl' || parts.length < 2) {
    throw new Error('XLSX worksheet target is invalid')
  }
  return parts.join('/')
}

async function parseWorkbookRelationships(
  archive: JSZip,
  expansion: ExpansionState,
): Promise<Map<string, string>> {
  const relationships = new Map<string, string>()
  await parseXmlEntry(archive, 'xl/_rels/workbook.xml.rels', expansion, (parser) => {
    parser.on('opentag', (tag) => {
      if (localName(tag.name) !== 'Relationship') return
      const attributes = tag.attributes
      const id = attributes.Id
      const target = attributes.Target
      const type = attributes.Type
      if (
        typeof id !== 'string' ||
        typeof target !== 'string' ||
        typeof type !== 'string' ||
        !type.endsWith('/worksheet')
      ) return
      if (attributes.TargetMode === 'External') {
        throw new Error('External XLSX worksheet relationships are not supported')
      }
      if (relationships.has(id)) throw new Error('XLSX worksheet relationship is duplicated')
      relationships.set(id, normalizeRelationshipTarget(target))
    })
  })
  return relationships
}

async function parseWorkbook(
  archive: JSZip,
  expansion: ExpansionState,
): Promise<WorkbookDefinition> {
  const workbook: WorkbookDefinition = { date1904: false, sheets: [], truncated: false }
  await parseXmlEntry(archive, 'xl/workbook.xml', expansion, (parser) => {
    parser.on('opentag', (tag) => {
      const name = localName(tag.name)
      if (name === 'workbookPr') {
        workbook.date1904 = tag.attributes.date1904 === '1' || tag.attributes.date1904 === 'true'
        return
      }
      if (name !== 'sheet') return
      if (tag.attributes.state === 'hidden' || tag.attributes.state === 'veryHidden') return
      const sheetName = tag.attributes.name
      const relationshipId = tag.attributes['r:id']
      if (typeof sheetName !== 'string' || typeof relationshipId !== 'string') return
      if (workbook.sheets.length >= MAX_SHEETS) {
        workbook.truncated = true
        return
      }
      workbook.sheets.push({
        name: sheetName.slice(0, 128) || `Sheet ${workbook.sheets.length + 1}`,
        relationshipId,
      })
    })
  })
  if (workbook.sheets.length === 0) throw new Error('XLSX workbook has no visible sheets')
  return workbook
}

function isDateFormat(formatCode: string): boolean {
  const normalized = formatCode
    .replace(/"[^"]*"/g, '')
    .replace(/\\./g, '')
    .replace(/\[[^\]]*]/g, '')
    .toLowerCase()
  return /[yd]/.test(normalized) || /h+[^a-z]*m|m+[^a-z]*s|s+/.test(normalized)
}

async function parseDateStyles(
  archive: JSZip,
  expansion: ExpansionState,
  date1904: boolean,
): Promise<CellFormatting> {
  if (archive.file('xl/styles.xml') === null) return { date1904, dateStyles: [] }

  const customDateFormats = new Set<number>()
  const dateStyles: boolean[] = []
  let inCellFormats = false
  await parseXmlEntry(archive, 'xl/styles.xml', expansion, (parser) => {
    parser.on('opentag', (tag) => {
      const name = localName(tag.name)
      if (name === 'cellXfs') {
        inCellFormats = true
        return
      }
      if (name === 'numFmt') {
        const id = Number(tag.attributes.numFmtId)
        const code = tag.attributes.formatCode
        if (Number.isInteger(id) && typeof code === 'string' && isDateFormat(code)) {
          customDateFormats.add(id)
        }
        return
      }
      if (name !== 'xf' || !inCellFormats) return
      if (dateStyles.length >= MAX_STYLES) throw new Error('XLSX contains too many styles')
      const formatId = Number(tag.attributes.numFmtId)
      const builtInDate = Number.isInteger(formatId) && (
        (formatId >= 14 && formatId <= 22) ||
        (formatId >= 27 && formatId <= 36) ||
        (formatId >= 45 && formatId <= 47) ||
        (formatId >= 50 && formatId <= 58)
      )
      dateStyles.push(builtInDate || customDateFormats.has(formatId))
    })
    parser.on('closetag', (tag) => {
      if (localName(tag.name) === 'cellXfs') inCellFormats = false
    })
  })
  return { date1904, dateStyles }
}

async function parseSharedStrings(
  archive: JSZip,
  expansion: ExpansionState,
): Promise<string[]> {
  if (archive.file('xl/sharedStrings.xml') === null) return []

  const strings: string[] = []
  let inString = false
  let inText = false
  let current = ''
  let totalCharacters = 0
  await parseXmlEntry(archive, 'xl/sharedStrings.xml', expansion, (parser) => {
    parser.on('opentag', (tag) => {
      const name = localName(tag.name)
      if (name === 'si') {
        if (strings.length >= MAX_SHARED_STRINGS) throw new Error('XLSX contains too many shared strings')
        inString = true
        current = ''
      } else if (name === 't' && inString) {
        inText = true
      }
    })
    parser.on('text', (text) => {
      if (!inText) return
      current += text
      totalCharacters += text.length
      if (
        current.length > MAX_CELL_CHARACTERS ||
        totalCharacters > MAX_SHARED_STRING_CHARACTERS
      ) {
        throw new Error('XLSX shared strings exceed preview limits')
      }
    })
    parser.on('closetag', (tag) => {
      const name = localName(tag.name)
      if (name === 't') inText = false
      if (name === 'si') {
        strings.push(current)
        current = ''
        inString = false
      }
    })
  })
  return strings
}

function columnIndex(reference: string): number | null {
  const match = /^([A-Za-z]+)\d+$/.exec(reference)
  if (match === null) return null
  let column = 0
  for (const character of match[1].toUpperCase()) {
    column = column * 26 + character.charCodeAt(0) - 64
    if (column > 16_384) return null
  }
  return column
}

function rowIndex(reference: string): number | null {
  const match = /^[A-Za-z]+(\d+)$/.exec(reference)
  if (match === null) return null
  const row = Number(match[1])
  return Number.isInteger(row) && row >= 1 && row <= 1_048_576 ? row : null
}

function excelDate(serial: number, formatting: CellFormatting): string | null {
  if (!Number.isFinite(serial) || serial < 0 || serial > 2_958_465) return null
  const wholeDays = Math.floor(serial)
  const milliseconds = Math.round((serial - wholeDays) * 86_400_000)
  const epoch = formatting.date1904
    ? Date.UTC(1904, 0, 1)
    : Date.UTC(1899, 11, 30)
  const date = new Date(epoch + wholeDays * 86_400_000 + milliseconds)
  if (!Number.isFinite(date.getTime())) return null
  const datePart = date.toISOString().slice(0, 10)
  if (milliseconds === 0) return datePart
  return `${datePart} ${date.toISOString().slice(11, 19)}`
}

function displayCellValue(
  rawValue: string,
  type: string,
  styleIndex: number,
  sharedStrings: string[],
  formatting: CellFormatting,
): string {
  if (type === 's') {
    const index = Number(rawValue)
    return Number.isInteger(index) && index >= 0 && index < sharedStrings.length
      ? sharedStrings[index]
      : ''
  }
  if (type === 'b') return rawValue === '1' ? 'TRUE' : 'FALSE'
  if (type === 'e' || type === 'str' || type === 'inlineStr') return rawValue
  const number = Number(rawValue)
  if (rawValue !== '' && Number.isFinite(number) && formatting.dateStyles[styleIndex] === true) {
    return excelDate(number, formatting) ?? rawValue
  }
  return rawValue
}

function parseDimension(reference: string): { rows: number; columns: number } | null {
  const lastCell = reference.split(':').at(-1)
  if (lastCell === undefined) return null
  const rows = rowIndex(lastCell)
  const columns = columnIndex(lastCell)
  return rows === null || columns === null ? null : { rows, columns }
}

async function parseWorksheet(
  archive: JSZip,
  path: string,
  name: string,
  expansion: ExpansionState,
  sharedStrings: string[],
  formatting: CellFormatting,
  outputCells: { count: number },
): Promise<SpreadsheetPreviewSheet> {
  const sparseRows: Array<string[] | undefined> = []
  let declaredRows = 0
  let declaredColumns = 0
  let maximumSeenRow = 0
  let maximumSeenColumn = 0
  let currentRow = 0
  let nextColumn = 1
  let cellRow = 0
  let cellColumn = 0
  let cellType = ''
  let cellStyle = 0
  let cellValue = ''
  let captureValue = false
  let captureInlineText = false
  let truncated = false

  await parseXmlEntry(archive, path, expansion, (parser) => {
    parser.on('opentag', (tag: SaxesTagPlain) => {
      const tagName = localName(tag.name)
      if (tagName === 'dimension') {
        const reference = tag.attributes.ref
        if (typeof reference === 'string') {
          const dimension = parseDimension(reference)
          if (dimension !== null) {
            declaredRows = dimension.rows
            declaredColumns = dimension.columns
            if (declaredRows > MAX_ROWS_PER_SHEET || declaredColumns > MAX_COLUMNS_PER_SHEET) {
              truncated = true
            }
          }
        }
        return
      }
      if (tagName === 'row') {
        const explicitRow = Number(tag.attributes.r)
        currentRow = Number.isInteger(explicitRow) && explicitRow >= 1
          ? explicitRow
          : currentRow + 1
        nextColumn = 1
        maximumSeenRow = Math.max(maximumSeenRow, currentRow)
        if (currentRow > MAX_ROWS_PER_SHEET) truncated = true
        return
      }
      if (tagName === 'c') {
        const reference = tag.attributes.r
        const referencedRow = typeof reference === 'string' ? rowIndex(reference) : null
        const referencedColumn = typeof reference === 'string' ? columnIndex(reference) : null
        cellRow = referencedRow ?? currentRow
        cellColumn = referencedColumn ?? nextColumn
        nextColumn = cellColumn + 1
        cellType = typeof tag.attributes.t === 'string' ? tag.attributes.t : ''
        const parsedStyle = Number(tag.attributes.s)
        cellStyle = Number.isInteger(parsedStyle) && parsedStyle >= 0 ? parsedStyle : 0
        cellValue = ''
        maximumSeenRow = Math.max(maximumSeenRow, cellRow)
        maximumSeenColumn = Math.max(maximumSeenColumn, cellColumn)
        if (cellRow > MAX_ROWS_PER_SHEET || cellColumn > MAX_COLUMNS_PER_SHEET) truncated = true
        return
      }
      if (tagName === 'v') {
        captureValue = true
      } else if (tagName === 't' && cellType === 'inlineStr') {
        captureInlineText = true
      }
    })
    parser.on('text', (text) => {
      if (!captureValue && !captureInlineText) return
      const remaining = MAX_CELL_CHARACTERS - cellValue.length
      if (remaining <= 0) {
        truncated = true
        return
      }
      cellValue += text.slice(0, remaining)
      if (text.length > remaining) truncated = true
    })
    parser.on('closetag', (tag) => {
      const tagName = localName(tag.name)
      if (tagName === 'v') captureValue = false
      if (tagName === 't') captureInlineText = false
      if (tagName !== 'c') return

      const value = displayCellValue(
        cellValue,
        cellType,
        cellStyle,
        sharedStrings,
        formatting,
      )
      if (
        value !== '' &&
        cellRow >= 1 &&
        cellRow <= MAX_ROWS_PER_SHEET &&
        cellColumn >= 1 &&
        cellColumn <= MAX_COLUMNS_PER_SHEET
      ) {
        if (outputCells.count >= MAX_PREVIEW_CELLS) {
          truncated = true
        } else {
          const row = sparseRows[cellRow - 1] ?? []
          row[cellColumn - 1] = value
          sparseRows[cellRow - 1] = row
          outputCells.count += 1
        }
      }
      cellValue = ''
    })
  })

  const renderedRows = Math.min(maximumSeenRow, MAX_ROWS_PER_SHEET)
  const rows = Array.from({ length: renderedRows }, (_, index) => sparseRows[index] ?? [])
  return {
    name,
    rows,
    rowCount: Math.max(declaredRows, maximumSeenRow),
    columnCount: Math.max(declaredColumns, maximumSeenColumn),
    truncated,
  }
}

export async function parseSpreadsheet(arrayBuffer: ArrayBuffer): Promise<SpreadsheetPreviewWorkbook> {
  assertSafeXlsxArchive(arrayBuffer)
  const archive = await JSZip.loadAsync(arrayBuffer, { createFolders: false })
  const expansion: ExpansionState = { totalBytes: 0 }
  const relationships = await parseWorkbookRelationships(archive, expansion)
  const definition = await parseWorkbook(archive, expansion)
  const sharedStrings = await parseSharedStrings(archive, expansion)
  const formatting = await parseDateStyles(archive, expansion, definition.date1904)
  const outputCells = { count: 0 }
  const sheets: SpreadsheetPreviewSheet[] = []
  let truncated = definition.truncated

  for (const sheet of definition.sheets) {
    const path = relationships.get(sheet.relationshipId)
    if (path === undefined) {
      truncated = true
      continue
    }
    const parsed = await parseWorksheet(
      archive,
      path,
      sheet.name,
      expansion,
      sharedStrings,
      formatting,
      outputCells,
    )
    sheets.push(parsed)
    truncated ||= parsed.truncated
  }

  if (sheets.length === 0) throw new Error('XLSX workbook has no readable sheets')
  return { sheets, truncated }
}
