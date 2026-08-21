import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

import { PdfPreview } from './PdfPreview'

vi.mock('pdfjs-dist', () => ({
  AnnotationMode: { ENABLE: 1 },
  GlobalWorkerOptions: { workerSrc: '' },
  getDocument: vi.fn(() => ({
    destroy: vi.fn(),
    promise: Promise.resolve({ numPages: 3 }),
  })),
}))

vi.mock('pdfjs-dist/web/pdf_viewer.mjs', () => {
  class EventBus {
    private readonly listeners = new Map<string, Set<(event?: unknown) => void>>()

    on(name: string, listener: (event?: unknown) => void) {
      const listeners = this.listeners.get(name) ?? new Set<(event?: unknown) => void>()
      listeners.add(listener)
      this.listeners.set(name, listeners)
    }

    off(name: string, listener: (event?: unknown) => void) {
      this.listeners.get(name)?.delete(listener)
    }

    dispatch(name: string, event?: unknown) {
      for (const listener of this.listeners.get(name) ?? []) listener(event)
    }
  }

  class PDFLinkService {
    setViewer() {}
    setDocument() {}
  }

  class PDFViewer {
    currentScale = 1
    private pageNumber = 1
    private readonly eventBus: EventBus

    constructor({ eventBus }: { eventBus: EventBus }) {
      this.eventBus = eventBus
    }

    set currentPageNumber(value: number) {
      this.pageNumber = value
      this.eventBus.dispatch('pagechanging', { pageNumber: value })
    }

    get currentPageNumber() {
      return this.pageNumber
    }

    set currentScaleValue(_value: string) {
      this.currentScale = 1.25
      this.eventBus.dispatch('scalechanging', { scale: this.currentScale })
    }

    get currentScaleValue() {
      return String(this.currentScale)
    }

    setDocument() {
      this.eventBus.dispatch('pagesinit')
    }

    updateScale({ steps = 0 }: { steps?: number } = {}) {
      this.currentScale += steps * 0.1
      this.eventBus.dispatch('scalechanging', { scale: this.currentScale })
    }
  }

  return { EventBus, PDFLinkService, PDFViewer }
})

describe('PdfPreview', () => {
  it('renders a compact branded reader with selectable-viewer controls and no native iframe', async () => {
    const user = userEvent.setup()
    render(<PdfPreview data={new Blob(['pdf'])} name="brief.pdf" />)

    expect(await screen.findByLabelText('brief.pdf PDF preview')).toBeInTheDocument()
    const pageInput = screen.getByRole('spinbutton', { name: 'Current PDF page' })
    await waitFor(() => expect(pageInput).toBeEnabled())
    expect(pageInput).toHaveValue(1)
    expect(screen.getByText('/ 3')).toBeInTheDocument()
    expect(document.querySelector('iframe')).toBeNull()

    await user.click(screen.getByRole('button', { name: 'Next PDF page' }))
    expect(pageInput).toHaveValue(2)
    expect(screen.getByRole('button', { name: 'Zoom in' })).toBeEnabled()
    expect(screen.getByRole('button', { name: 'Zoom out' })).toBeEnabled()
  })
})
