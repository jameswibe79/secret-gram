import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { SpreadsheetPreviewWorkerResponse } from '../lib/spreadsheet-preview'
import { SpreadsheetPreview } from './SpreadsheetPreview'

let workerResponse: SpreadsheetPreviewWorkerResponse

class PreviewWorker {
  onmessage: ((event: MessageEvent<SpreadsheetPreviewWorkerResponse>) => void) | null = null
  onerror: (() => void) | null = null

  postMessage() {
    queueMicrotask(() => {
      this.onmessage?.(new MessageEvent('message', { data: workerResponse }))
    })
  }

  terminate() {}
}

beforeEach(() => {
  vi.stubGlobal('Worker', PreviewWorker)
})

describe('SpreadsheetPreview', () => {
  it('renders a keyboard-operable worksheet grid and switches sheets', async () => {
    workerResponse = {
      type: 'ready',
      workbook: {
        sheets: [
          {
            name: 'Budget',
            rows: [
              [{ value: 'Quarterly plan', style: 1 }, null],
              [{ value: 'Hosting', style: 0 }, { value: '$48.00', style: 2 }],
            ],
            rowCount: 2,
            columnCount: 2,
            columnWidths: [160, 90],
            rowHeights: [32, 0],
            columnStyles: [-1, -1],
            rowStyles: [-1, -1],
            merges: [{
              startRow: 1,
              startColumn: 1,
              endRow: 1,
              endColumn: 2,
            }],
            truncated: false,
          },
          {
            name: 'Forecast',
            rows: [
              [{ value: 'Quarter', style: 0 }, { value: 'Growth', style: 0 }],
              [{ value: 'Q2', style: 0 }, { value: '12%', style: 0 }],
            ],
            rowCount: 2,
            columnCount: 2,
            columnWidths: [112, 112],
            rowHeights: [0, 0],
            columnStyles: [-1, -1],
            rowStyles: [-1, -1],
            merges: [],
            truncated: true,
          },
        ],
        styles: [
          {},
          { backgroundColor: '#1F4E78', color: '#FFFFFF', fontWeight: 700 },
          { textAlign: 'right' },
        ],
        truncated: true,
      },
    }
    const user = userEvent.setup()

    render(<SpreadsheetPreview data={new Blob(['xlsx'])} name="plan.xlsx" />)

    expect(await screen.findByRole('table', { name: 'Budget cell values' })).toBeInTheDocument()
    expect(screen.getByRole('cell', { name: 'Hosting' })).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: 'Budget' })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByText('Preview is limited to the first cells and sheets.')).toBeInTheDocument()
    expect(screen.getByRole('cell', { name: 'Quarterly plan' })).toHaveAttribute('colspan', '2')
    expect(screen.getByRole('cell', { name: 'Quarterly plan' })).toHaveStyle({
      backgroundColor: '#1F4E78',
      color: '#FFFFFF',
      fontWeight: '700',
    })
    expect(screen.getByRole('cell', { name: '$48.00' })).toHaveStyle({ textAlign: 'right' })

    await user.click(screen.getByRole('tab', { name: 'Forecast' }))

    expect(screen.getByRole('table', { name: 'Forecast cell values' })).toBeInTheDocument()
    expect(screen.getByRole('cell', { name: '12%' })).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: 'Forecast' })).toHaveAttribute('aria-selected', 'true')
  })

  it('shows a fail-safe state when local parsing rejects the workbook', async () => {
    workerResponse = { type: 'error' }

    render(<SpreadsheetPreview data={new Blob(['broken'])} name="broken.xlsx" />)

    expect(await screen.findByRole('alert')).toHaveTextContent('Spreadsheet preview unavailable')
    expect(screen.getByText('The workbook is unsupported, damaged, or exceeds safe preview limits.')).toBeInTheDocument()
  })

  it('uses a static local thumbnail without parsing the workbook', () => {
    const worker = vi.fn(PreviewWorker)
    vi.stubGlobal('Worker', worker)

    render(<SpreadsheetPreview data={new Blob(['xlsx'])} name="table.xlsx" compact />)

    expect(screen.getByLabelText('table.xlsx spreadsheet thumbnail')).toBeInTheDocument()
    expect(worker).not.toHaveBeenCalled()
  })
})
