export const MAX_SPREADSHEET_PREVIEW_BYTES = 16 * 1024 * 1024
export const MAX_SPREADSHEET_ENTRY_BYTES = 16 * 1024 * 1024
export const MAX_SPREADSHEET_UNCOMPRESSED_BYTES = 64 * 1024 * 1024

export interface SpreadsheetPreviewSheet {
  name: string
  rows: string[][]
  rowCount: number
  columnCount: number
  truncated: boolean
}

export interface SpreadsheetPreviewWorkbook {
  sheets: SpreadsheetPreviewSheet[]
  truncated: boolean
}

export interface SpreadsheetPreviewWorkerRequest {
  arrayBuffer: ArrayBuffer
}

export type SpreadsheetPreviewWorkerResponse =
  | { type: 'ready'; workbook: SpreadsheetPreviewWorkbook }
  | { type: 'error' }
