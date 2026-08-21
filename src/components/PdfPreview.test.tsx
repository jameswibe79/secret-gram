import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { PdfPreview } from './PdfPreview'

const pdfMocks = vi.hoisted(() => ({
  modernGetDocument: vi.fn(),
  legacyGetDocument: vi.fn(),
}))
const runtimeMocks = vi.hoisted(() => ({
  loadPdfJs: vi.fn(),
  loadPdfViewer: vi.fn(),
}))

const viewerModule = vi.hoisted(() => {
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

vi.mock('../lib/pdf-runtime', () => runtimeMocks)

function loadingTask(result: Promise<{ numPages: number }>) {
  return {
    destroy: vi.fn(),
    promise: result,
  }
}

function pdfBlob() {
  const data = new Blob(['pdf'])
  Object.defineProperty(data, 'arrayBuffer', {
    value: vi.fn().mockResolvedValue(new Uint8Array([1, 2, 3]).buffer),
  })
  return data
}

describe('PdfPreview', () => {
  beforeEach(() => {
    pdfMocks.modernGetDocument.mockReset()
    pdfMocks.legacyGetDocument.mockReset()
    runtimeMocks.loadPdfJs.mockReset()
    runtimeMocks.loadPdfViewer.mockReset()
    pdfMocks.modernGetDocument.mockReturnValue(loadingTask(Promise.resolve({ numPages: 3 })))
    pdfMocks.legacyGetDocument.mockReturnValue(loadingTask(Promise.resolve({ numPages: 3 })))
    runtimeMocks.loadPdfJs.mockImplementation(async (build: 'modern' | 'legacy') => ({
      AnnotationMode: { ENABLE: 1 },
      getDocument: build === 'modern'
        ? pdfMocks.modernGetDocument
        : pdfMocks.legacyGetDocument,
    }))
    runtimeMocks.loadPdfViewer.mockImplementation(async () => viewerModule)
  })

  it('renders a compact branded reader with selectable-viewer controls and no native iframe', async () => {
    const user = userEvent.setup()
    const data = pdfBlob()
    render(<PdfPreview data={data} name="brief.pdf" />)

    expect(await screen.findByLabelText('brief.pdf PDF preview')).toBeInTheDocument()
    await waitFor(() => expect(runtimeMocks.loadPdfJs).toHaveBeenCalledWith('modern'))
    await waitFor(() => expect(pdfMocks.modernGetDocument).toHaveBeenCalledTimes(1))
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

  it('falls back to the legacy renderer when the modern PDF build fails', async () => {
    pdfMocks.modernGetDocument.mockImplementationOnce(() => (
      loadingTask(Promise.reject(new Error('Unsupported WebKit runtime')))
    ))
    const data = pdfBlob()
    render(<PdfPreview data={data} name="ios.pdf" />)
    const pageInput = await screen.findByRole('spinbutton', { name: 'Current PDF page' })
    await waitFor(() => expect(runtimeMocks.loadPdfJs).toHaveBeenCalledWith('modern'))
    await waitFor(() => expect(pdfMocks.modernGetDocument).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(pageInput).toBeEnabled())
    await waitFor(() => expect(data.arrayBuffer).toHaveBeenCalled())

    expect(pdfMocks.modernGetDocument).toHaveBeenCalledTimes(1)
    expect(pdfMocks.legacyGetDocument).toHaveBeenCalledTimes(1)
    expect(screen.getByText('/ 3')).toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })
})
