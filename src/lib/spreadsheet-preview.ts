export const MAX_SPREADSHEET_PREVIEW_BYTES = 16 * 1024 * 1024
export const MAX_SPREADSHEET_ENTRY_BYTES = 16 * 1024 * 1024
export const MAX_SPREADSHEET_UNCOMPRESSED_BYTES = 64 * 1024 * 1024

export interface SpreadsheetPreviewCell {
  value: string
  style: number
}

export interface SpreadsheetPreviewBorder {
  color: string
  style: 'dashed' | 'dotted' | 'double' | 'solid'
  width: number
}

export interface SpreadsheetPreviewStyle {
  backgroundColor?: string
  color?: string
  fontFamily?: string
  fontSize?: number
  fontStyle?: 'italic'
  fontWeight?: number
  textDecoration?: 'underline'
  textAlign?: 'center' | 'left' | 'right'
  verticalAlign?: 'bottom' | 'middle' | 'top'
  whiteSpace?: 'normal'
  borderTop?: SpreadsheetPreviewBorder
  borderRight?: SpreadsheetPreviewBorder
  borderBottom?: SpreadsheetPreviewBorder
  borderLeft?: SpreadsheetPreviewBorder
}

export interface SpreadsheetPreviewMerge {
  startRow: number
  startColumn: number
  endRow: number
  endColumn: number
}

export interface SpreadsheetPreviewSheet {
  name: string
  rows: Array<Array<SpreadsheetPreviewCell | null>>
  rowCount: number
  columnCount: number
  columnWidths: number[]
  rowHeights: number[]
  columnStyles: number[]
  rowStyles: number[]
  merges: SpreadsheetPreviewMerge[]
  truncated: boolean
}

export interface SpreadsheetPreviewWorkbook {
  sheets: SpreadsheetPreviewSheet[]
  styles: SpreadsheetPreviewStyle[]
  truncated: boolean
}

export interface SpreadsheetPreviewWorkerRequest {
  arrayBuffer: ArrayBuffer
}

export type SpreadsheetPreviewWorkerResponse =
  | { type: 'ready'; workbook: SpreadsheetPreviewWorkbook }
  | { type: 'error' }
