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
            rows: [['Item', 'Amount'], ['Hosting', '48']],
            rowCount: 2,
            columnCount: 2,
            truncated: false,
          },
          {
            name: 'Forecast',
            rows: [['Quarter', 'Growth'], ['Q2', '12%']],
            rowCount: 2,
            columnCount: 2,
            truncated: true,
          },
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
