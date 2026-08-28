import { useEffect, useMemo, useState, type CSSProperties } from 'react'

import type {
  SpreadsheetPreviewBorder,
  SpreadsheetPreviewStyle,
  SpreadsheetPreviewWorkbook,
  SpreadsheetPreviewWorkerResponse,
} from '../lib/spreadsheet-preview'
import { Tabs, TabsContent, TabsList, TabsTrigger } from './ui/tabs'

interface SpreadsheetPreviewProps {
  data: Blob
  name: string
  compact?: boolean
}

type PreviewStatus = 'loading' | 'ready' | 'error'

const parsedWorkbooks = new WeakMap<Blob, Promise<SpreadsheetPreviewWorkbook>>()

function loadWorkbook(data: Blob): Promise<SpreadsheetPreviewWorkbook> {
  const existing = parsedWorkbooks.get(data)
  if (existing) return existing

  const request = new Promise<SpreadsheetPreviewWorkbook>((resolve, reject) => {
    const worker = new Worker(new URL('../workers/spreadsheet-preview.worker.ts', import.meta.url), {
      type: 'module',
    })
    let settled = false

    function finish(action: () => void) {
      if (settled) return
      settled = true
      worker.terminate()
      action()
    }

    worker.onmessage = (event: MessageEvent<SpreadsheetPreviewWorkerResponse>) => {
      const response = event.data
      if (response.type === 'ready') {
        finish(() => resolve(response.workbook))
      } else {
        finish(() => reject(new Error('Spreadsheet preview parsing failed')))
      }
    }
    worker.onerror = () => finish(() => reject(new Error('Spreadsheet preview worker failed')))

    void data.arrayBuffer().then((arrayBuffer) => {
      if (settled) return
      worker.postMessage({ arrayBuffer }, [arrayBuffer])
    }).catch(() => finish(() => reject(new Error('Spreadsheet could not be read'))))
  })

  parsedWorkbooks.set(data, request)
  void request.catch(() => parsedWorkbooks.delete(data))
  return request
}

function columnLabel(column: number): string {
  let value = column
  let label = ''
  while (value > 0) {
    value -= 1
    label = String.fromCharCode(65 + value % 26) + label
    value = Math.floor(value / 26)
  }
  return label
}

function borderCss(border: SpreadsheetPreviewBorder | undefined): string | undefined {
  return border === undefined
    ? undefined
    : `${border.width}px ${border.style} ${border.color}`
}

function cellCss(style: SpreadsheetPreviewStyle | undefined): CSSProperties {
  if (style === undefined) return {}
  return {
    backgroundColor: style.backgroundColor,
    borderTop: borderCss(style.borderTop),
    borderRight: borderCss(style.borderRight),
    borderBottom: borderCss(style.borderBottom),
    borderLeft: borderCss(style.borderLeft),
    color: style.color,
    fontFamily: style.fontFamily,
    fontSize: style.fontSize === undefined ? undefined : `${style.fontSize}pt`,
    fontStyle: style.fontStyle,
    fontWeight: style.fontWeight,
    textAlign: style.textAlign,
    textDecoration: style.textDecoration,
    verticalAlign: style.verticalAlign,
    whiteSpace: style.whiteSpace,
  }
}

export function SpreadsheetPreview({ data, name, compact = false }: SpreadsheetPreviewProps) {
  const [status, setStatus] = useState<PreviewStatus>('loading')
  const [workbook, setWorkbook] = useState<SpreadsheetPreviewWorkbook | null>(null)
  const [activeSheet, setActiveSheet] = useState('0')

  useEffect(() => {
    if (compact) return
    let active = true
    setStatus('loading')
    setWorkbook(null)
    setActiveSheet('0')

    void loadWorkbook(data).then((parsed) => {
      if (!active) return
      setWorkbook(parsed)
      setStatus('ready')
    }).catch(() => {
      if (active) setStatus('error')
    })

    return () => {
      active = false
    }
  }, [compact, data])

  const activeSheetIndex = Number(activeSheet)
  const sheet = workbook?.sheets[activeSheetIndex] ?? null
  const visibleColumnCount = Math.max(1, sheet?.columnWidths.length ?? 1)
  const columns = useMemo(
    () => Array.from({ length: visibleColumnCount }, (_, index) => columnLabel(index + 1)),
    [visibleColumnCount],
  )
  const mergeLayout = useMemo(() => {
    const anchors = new Map<string, { rowSpan: number; columnSpan: number }>()
    const covered = new Set<string>()
    for (const merge of sheet?.merges ?? []) {
      anchors.set(`${merge.startRow}:${merge.startColumn}`, {
        rowSpan: merge.endRow - merge.startRow + 1,
        columnSpan: merge.endColumn - merge.startColumn + 1,
      })
      for (let row = merge.startRow; row <= merge.endRow; row += 1) {
        for (let column = merge.startColumn; column <= merge.endColumn; column += 1) {
          if (row !== merge.startRow || column !== merge.startColumn) {
            covered.add(`${row}:${column}`)
          }
        }
      }
    }
    return { anchors, covered }
  }, [sheet])
  const tableWidth = useMemo(
    () => 44 + (sheet?.columnWidths.reduce((total, width) => total + width, 0) ?? 112),
    [sheet],
  )

  if (compact) {
    return (
      <section className="spreadsheet-preview compact" aria-label={`${name} spreadsheet thumbnail`}>
        <span className="spreadsheet-compact-sheet" aria-hidden="true">
          <strong>XLSX</strong>
          <span><i /><i /><i /></span>
          <span><i /><i /><i /></span>
          <span><i /><i /><i /></span>
        </span>
      </section>
    )
  }

  return (
    <section className="spreadsheet-preview" aria-label={`${name} spreadsheet preview`}>
      {status === 'loading' && (
        <div className="spreadsheet-preview-message" aria-live="polite">
          <strong>Reading workbook locally</strong>
          <span>Cell values and worksheet structure stay on this device.</span>
        </div>
      )}
      {status === 'error' && (
        <div className="spreadsheet-preview-message is-error" role="alert">
          <strong>Spreadsheet preview unavailable</strong>
          <span>The workbook is unsupported, damaged, or exceeds safe preview limits.</span>
        </div>
      )}
      {status === 'ready' && workbook !== null && sheet !== null && (
        <Tabs
          className="spreadsheet-workbook"
          value={activeSheet}
          onValueChange={setActiveSheet}
        >
          <div className="spreadsheet-sheet-bar">
            <TabsList className="spreadsheet-sheet-tabs" aria-label={`${name} worksheets`}>
              {workbook.sheets.map((workbookSheet, index) => (
                <TabsTrigger key={`${workbookSheet.name}-${index}`} value={String(index)}>
                  {workbookSheet.name}
                </TabsTrigger>
              ))}
            </TabsList>
            {(workbook.truncated || sheet.truncated) && (
              <span className="spreadsheet-limit-note">Preview is limited to the first cells and sheets.</span>
            )}
          </div>
          <TabsContent className="spreadsheet-sheet-content" value={activeSheet} forceMount>
            {sheet.rows.length === 0 ? (
              <div className="spreadsheet-empty-sheet">This worksheet is empty.</div>
            ) : (
              <div className="spreadsheet-table-scroll" tabIndex={0}>
                <table style={{ width: tableWidth }}>
                  <caption className="sr-only">{sheet.name} cell values</caption>
                  <colgroup>
                    <col style={{ width: 44 }} />
                    {sheet.columnWidths.map((width, index) => (
                      <col key={columns[index]} style={{ width }} />
                    ))}
                  </colgroup>
                  <thead>
                    <tr>
                      <th className="spreadsheet-corner" aria-hidden="true" />
                      {columns.map((column) => <th key={column} scope="col">{column}</th>)}
                    </tr>
                  </thead>
                  <tbody>
                    {sheet.rows.map((row, rowIndex) => (
                      <tr
                        key={rowIndex}
                        style={sheet.rowHeights[rowIndex] > 0
                          ? { height: sheet.rowHeights[rowIndex] }
                          : undefined}
                      >
                        <th scope="row">{rowIndex + 1}</th>
                        {columns.map((column, columnIndex) => {
                          const position = `${rowIndex + 1}:${columnIndex + 1}`
                          if (mergeLayout.covered.has(position)) return null
                          const cell = row[columnIndex]
                          const rowStyle = sheet.rowStyles[rowIndex]
                          const columnStyle = sheet.columnStyles[columnIndex]
                          const styleIndex = cell?.style ??
                            (rowStyle >= 0 ? rowStyle : columnStyle >= 0 ? columnStyle : 0)
                          const merge = mergeLayout.anchors.get(position)
                          return (
                            <td
                              key={column}
                              dir="auto"
                              rowSpan={merge?.rowSpan}
                              colSpan={merge?.columnSpan}
                              style={cellCss(workbook.styles[styleIndex])}
                            >
                              {cell?.value ?? ''}
                            </td>
                          )
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <p className="spreadsheet-sheet-summary">
              {sheet.rowCount.toLocaleString()} rows · {sheet.columnCount.toLocaleString()} columns in worksheet
            </p>
          </TabsContent>
        </Tabs>
      )}
    </section>
  )
}
