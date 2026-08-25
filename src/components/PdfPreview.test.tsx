import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { PdfPreview } from './PdfPreview'

const pdfMocks = vi.hoisted(() => ({
  modernGetDocument: vi.fn(),
  legacyGetDocument: vi.fn(),
  pageTextItems: [{ str: 'Selectable digital PDF text' }] as Array<{ str: string }>,
  scaleModes: [] as string[],
}))
const runtimeMocks = vi.hoisted(() => ({
  loadPdfJs: vi.fn(),
  loadPdfViewer: vi.fn(),
}))
const ocrMocks = vi.hoisted(() => ({
  recognizeImage: vi.fn(),
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
    private readonly viewerElement: HTMLElement

    constructor({ eventBus, viewer }: { eventBus: EventBus; viewer: HTMLElement }) {
      this.eventBus = eventBus
      this.viewerElement = viewer
    }

    set currentPageNumber(value: number) {
      this.pageNumber = value
      this.eventBus.dispatch('pagechanging', { pageNumber: value })
    }

    get currentPageNumber() {
      return this.pageNumber
    }

    set currentScaleValue(value: string) {
      pdfMocks.scaleModes.push(value)
      this.currentScale = value === 'page-fit' ? 0.75 : 1.25
      this.eventBus.dispatch('scalechanging', { scale: this.currentScale })
    }

    get currentScaleValue() {
      return String(this.currentScale)
    }

    setDocument() {
      const page = document.createElement('div')
      page.className = 'page'
      page.dataset.pageNumber = '1'
      this.viewerElement.replaceChildren(page)
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
vi.mock('../lib/ocr-client', () => ocrMocks)

function pdfDocument() {
  const renderTask = { promise: Promise.resolve(), cancel: vi.fn() }
  const page = {
    getTextContent: vi.fn(async () => ({ items: pdfMocks.pageTextItems })),
    getViewport: vi.fn(({ scale }: { scale: number }) => ({ width: 600 * scale, height: 800 * scale })),
    render: vi.fn(() => renderTask),
  }
  return {
    numPages: 3,
    getPage: vi.fn(async () => page),
  }
}

function loadingTask(result: Promise<unknown>) {
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
    ocrMocks.recognizeImage.mockReset()
    pdfMocks.pageTextItems = [{ str: 'Selectable digital PDF text' }]
    pdfMocks.scaleModes.length = 0
    vi.stubGlobal('matchMedia', vi.fn(() => ({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })))
    pdfMocks.modernGetDocument.mockReturnValue(loadingTask(Promise.resolve(pdfDocument())))
    pdfMocks.legacyGetDocument.mockReturnValue(loadingTask(Promise.resolve(pdfDocument())))
    runtimeMocks.loadPdfJs.mockImplementation(async (build: 'modern' | 'legacy') => ({
      AnnotationMode: { ENABLE: 1 },
      getDocument: build === 'modern'
        ? pdfMocks.modernGetDocument
        : pdfMocks.legacyGetDocument,
    }))
    runtimeMocks.loadPdfViewer.mockImplementation(async () => viewerModule)
    ocrMocks.recognizeImage.mockResolvedValue({ lines: [] })
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
      getImageData: () => ({
        data: new Uint8ClampedArray(4),
        width: 1,
        height: 1,
      }),
    } as never)
  })

  it('renders selectable digital PDF text with viewer controls and no OCR', async () => {
    const user = userEvent.setup()
    const data = pdfBlob()
    render(<PdfPreview data={data} name="brief.pdf" />)

    expect(await screen.findByLabelText('brief.pdf PDF preview')).toBeInTheDocument()
    await waitFor(() => expect(pdfMocks.modernGetDocument).toHaveBeenCalledTimes(1))
    const pageInput = screen.getByRole('spinbutton', { name: 'Current PDF page' })
    await waitFor(() => expect(pageInput).toBeEnabled())
    expect(await screen.findByText('Drag to select PDF text')).toBeInTheDocument()
    expect(ocrMocks.recognizeImage).not.toHaveBeenCalled()
    expect(document.querySelector('iframe')).toBeNull()

    await user.click(screen.getByRole('button', { name: 'Next PDF page' }))
    expect(pageInput).toHaveValue(2)
    expect(screen.getByRole('button', { name: 'Zoom in' })).toBeEnabled()
    expect(screen.getByRole('button', { name: 'Zoom out' })).toBeEnabled()
  })

  it('fits the entire PDF page by default on phone-sized viewports', async () => {
    vi.stubGlobal('matchMedia', vi.fn((query: string) => ({
      matches: query === '(max-width: 640px)',
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })))
    const user = userEvent.setup()
    render(<PdfPreview data={pdfBlob()} name="mobile.pdf" />)

    const fitButton = await screen.findByRole('button', { name: 'Fit PDF page to viewer' })
    await waitFor(() => expect(fitButton).toBeEnabled())
    expect(pdfMocks.scaleModes).toContain('page-fit')
    expect(fitButton).toHaveTextContent('75%')

    await user.click(fitButton)
    expect(pdfMocks.scaleModes.at(-1)).toBe('page-fit')
  })

  it('adds selectable OCR text over a scanned PDF page', async () => {
    pdfMocks.pageTextItems = []
    ocrMocks.recognizeImage.mockResolvedValue({
      lines: [{
        text: '中文 OCR text',
        confidence: 0.95,
        box: { x: 0.1, y: 0.2, width: 0.4, height: 0.08 },
      }],
    })
    render(<PdfPreview data={pdfBlob()} name="scan.pdf" />)

    expect(await screen.findByText('Drag to select · 1 OCR lines')).toBeInTheDocument()
    const line = screen.getByText('中文 OCR text')
    expect(line).toHaveClass('selectable-text-line')
    expect(line.closest('.selectable-text-layer')).toHaveAttribute(
      'aria-label',
      'scan.pdf page 1 recognized selectable text',
    )
    expect(ocrMocks.recognizeImage).toHaveBeenCalledTimes(1)
  })

  it('falls back to the legacy renderer when the modern PDF build fails', async () => {
    pdfMocks.modernGetDocument.mockImplementationOnce(() => (
      loadingTask(Promise.reject(new Error('Unsupported WebKit runtime')))
    ))
    const data = pdfBlob()
    render(<PdfPreview data={data} name="ios.pdf" />)
    const pageInput = await screen.findByRole('spinbutton', { name: 'Current PDF page' })
    await waitFor(() => expect(pdfMocks.modernGetDocument).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(pageInput).toBeEnabled())
    await waitFor(() => expect(data.arrayBuffer).toHaveBeenCalled())

    expect(pdfMocks.legacyGetDocument).toHaveBeenCalledTimes(1)
    expect(screen.getByText('/ 3')).toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })
})
