import { ChevronLeft, ChevronRight, Minus, Plus, RotateCcw } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type * as LegacyPdfViewerModule from 'pdfjs-dist/legacy/web/pdf_viewer.mjs'
import type {
  PDFDocumentLoadingTask,
  PDFDocumentProxy,
  RenderTask,
} from 'pdfjs-dist'
import type * as PdfViewerModule from 'pdfjs-dist/web/pdf_viewer.mjs'
import 'pdfjs-dist/web/pdf_viewer.css'
import { recognizeImage } from '../lib/ocr-client'
import type { OcrLine, OcrProgress } from '../lib/ocr-types'
import { loadPdfJs, loadPdfViewer, type PdfBuild } from '../lib/pdf-runtime'
import { SelectableTextLayer } from './SelectableTextLayer'

import { Button } from './ui/button'

type PdfViewerInstance = PdfViewerModule.PDFViewer | LegacyPdfViewerModule.PDFViewer
type PdfViewerEventBus = PdfViewerModule.EventBus | LegacyPdfViewerModule.EventBus

const PDF_RENDER_TIMEOUT_MS = 12_000
const MOBILE_PDF_MAX_CANVAS_PIXELS = 8 * 1024 * 1024
const DESKTOP_PDF_MAX_CANVAS_PIXELS = 24 * 1024 * 1024
const PDF_OCR_LONG_SIDE = 1600


function withTimeout<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timeout = window.setTimeout(() => reject(new Error('PDF preview timed out')), timeoutMs)
    operation.then(
      (value) => {
        window.clearTimeout(timeout)
        resolve(value)
      },
      (error: unknown) => {
        window.clearTimeout(timeout)
        reject(error instanceof Error ? error : new Error('PDF preview failed'))
      },
    )
  })
}

function eventNumber(event: unknown, key: string): number | null {
  if (typeof event !== 'object' || event === null) return null
  const value = Reflect.get(event, key)
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function pdfMaxCanvasPixels(): number {
  const narrowViewport = typeof window.matchMedia === 'function'
    ? window.matchMedia('(max-width: 1024px)').matches
    : window.innerWidth <= 1024
  return narrowViewport && navigator.maxTouchPoints > 0
    ? MOBILE_PDF_MAX_CANVAS_PIXELS
    : DESKTOP_PDF_MAX_CANVAS_PIXELS
}
function pdfPageHasSelectableText(items: unknown): boolean {
  if (typeof items !== 'object' || items === null) return false
  const values = Reflect.get(items, 'items')
  if (!Array.isArray(values)) return false
  let characters = 0
  let textItems = 0
  for (const item of values) {
    if (typeof item !== 'object' || item === null) continue
    const value = Reflect.get(item, 'str')
    if (typeof value !== 'string' || value.trim() === '') continue
    characters += value.trim().length
    textItems += 1
  }
  return characters >= 12 || textItems >= 3
}

function pdfOcrProgressLabel(progress: OcrProgress | null): string {
  if (progress === null || progress.stage === 'loading-models') return 'Loading local Chinese and English OCR…'
  if (progress.stage === 'detecting') return 'Finding text on this scanned page…'
  return progress.total === 0
    ? 'Reading this scanned page…'
    : `Reading line ${progress.completed} of ${progress.total}…`
}

interface PdfThumbnailProps {
  data: Blob
  name: string
}

function PdfThumbnail({ data, name }: PdfThumbnailProps) {
  const stageRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const renderTaskRef = useRef<RenderTask | null>(null)
  const [document, setDocument] = useState<PDFDocumentProxy | null>(null)
  const [renderSize, setRenderSize] = useState({ width: 0, height: 0 })
  const [build, setBuild] = useState<PdfBuild>('modern')
  const [error, setError] = useState('')

  useEffect(() => {
    setBuild('modern')
  }, [data])

  useEffect(() => {
    const stage = stageRef.current
    if (stage === null) return

    const updateSize = () => {
      const width = Math.max(0, Math.floor(stage.clientWidth))
      const height = Math.max(0, Math.floor(stage.clientHeight))
      setRenderSize((current) => current.width === width && current.height === height
        ? current
        : { width, height })
    }
    updateSize()
    const observer = new ResizeObserver(updateSize)
    observer.observe(stage)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    let stopped = false
    let loadingTask: PDFDocumentLoadingTask | null = null
    setDocument(null)
    setError('')
    const operation = (async () => {
      const pdfJs = await loadPdfJs(build)
      const buffer = await data.arrayBuffer()
      if (stopped) return
      loadingTask = pdfJs.getDocument({ data: new Uint8Array(buffer) })
      const nextDocument = await loadingTask.promise
      if (!stopped) setDocument(nextDocument)
    })()
    void withTimeout(operation, PDF_RENDER_TIMEOUT_MS).catch(() => {
      if (stopped) return
      if (build === 'modern') setBuild('legacy')
      else setError('PDF')
    })

    return () => {
      stopped = true
      renderTaskRef.current?.cancel()
      renderTaskRef.current = null
      if (loadingTask !== null) void loadingTask.destroy()
    }
  }, [build, data])

  useEffect(() => {
    const canvas = canvasRef.current
    if (document === null || canvas === null || renderSize.width === 0 || renderSize.height === 0) return

    let stopped = false
    void document.getPage(1).then(async (page) => {
      if (stopped) return
      const baseViewport = page.getViewport({ scale: 1 })
      const cssScale = Math.min(
        renderSize.width / baseViewport.width,
        renderSize.height / baseViewport.height,
      )
      const pixelRatio = Math.min(window.devicePixelRatio || 1, 2)
      const viewport = page.getViewport({ scale: cssScale * pixelRatio })
      canvas.width = Math.ceil(viewport.width)
      canvas.height = Math.ceil(viewport.height)
      canvas.style.width = `${Math.floor(baseViewport.width * cssScale)}px`
      canvas.style.height = `${Math.floor(baseViewport.height * cssScale)}px`

      renderTaskRef.current?.cancel()
      const task = page.render({ canvas, viewport })
      renderTaskRef.current = task
      try {
        await withTimeout(task.promise, PDF_RENDER_TIMEOUT_MS)
      } catch (renderError) {
        if (
          !stopped &&
          !(renderError instanceof Error && renderError.name === 'RenderingCancelledException')
        ) {
          if (build === 'modern') setBuild('legacy')
          else setError('PDF')
        }
      } finally {
        if (renderTaskRef.current === task) renderTaskRef.current = null
      }
    }).catch(() => {
      if (stopped) return
      if (build === 'modern') setBuild('legacy')
      else setError('PDF')
    })

    return () => {
      stopped = true
      renderTaskRef.current?.cancel()
      renderTaskRef.current = null
    }
  }, [build, document, renderSize])

  return (
    <div className="pdf-thumbnail-preview" aria-label={`${name} PDF thumbnail`}>
      <div ref={stageRef} className="pdf-thumbnail-stage">
        <canvas ref={canvasRef} aria-hidden="true" />
        {document === null && !error && (
          <span className="pdf-thumbnail-status">
            {build === 'legacy' ? 'Compatible PDF…' : 'Rendering PDF…'}
          </span>
        )}
        {error && <span className="pdf-thumbnail-status is-error">PDF</span>}
      </div>
    </div>
  )
}

interface PdfDocumentPreviewProps {
  data: Blob
  name: string
}

function PdfDocumentPreview({ data, name }: PdfDocumentPreviewProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const viewerElementRef = useRef<HTMLDivElement>(null)
  const viewerRef = useRef<PdfViewerInstance | null>(null)
  const [pageNumber, setPageNumber] = useState(1)
  const [pageCount, setPageCount] = useState(0)
  const [scalePercent, setScalePercent] = useState(100)
  const [loading, setLoading] = useState(true)
  const [build, setBuild] = useState<PdfBuild>('modern')
  const [retryCount, setRetryCount] = useState(0)
  const [error, setError] = useState('')
  const [pdfDocument, setPdfDocument] = useState<PDFDocumentProxy | null>(null)
  const [ocrLines, setOcrLines] = useState<OcrLine[]>([])
  const [ocrProgress, setOcrProgress] = useState<OcrProgress | null>(null)
  const [ocrStatus, setOcrStatus] = useState<'idle' | 'native' | 'recognizing' | 'ready' | 'empty' | 'error'>('idle')
  const [ocrRetryCount, setOcrRetryCount] = useState(0)

  useEffect(() => {
    setBuild('modern')
    setRetryCount(0)
    setOcrRetryCount(0)
  }, [data])

  useEffect(() => {
    const container = containerRef.current
    const viewerElement = viewerElementRef.current
    if (container === null || viewerElement === null) return

    let stopped = false
    let loadingTask: PDFDocumentLoadingTask | null = null
    let eventBus: PdfViewerEventBus | null = null
    let onPagesInit: (() => void) | null = null
    let onPageChanging: ((event: unknown) => void) | null = null
    let onScaleChanging: ((event: unknown) => void) | null = null
    let resolvePagesReady: (() => void) | null = null
    setLoading(true)
    setError('')
    setPageNumber(1)
    setPageCount(0)
    setPdfDocument(null)
    viewerElement.replaceChildren()

    const operation = (async () => {
      const [pdfJs, pdfViewer] = await Promise.all([loadPdfJs(build), loadPdfViewer(build)])
      if (stopped) return
      eventBus = new pdfViewer.EventBus()
      const linkService = new pdfViewer.PDFLinkService({ eventBus })
      const viewer = new pdfViewer.PDFViewer({
        container,
        viewer: viewerElement,
        eventBus,
        linkService,
        removePageBorders: true,
        annotationMode: pdfJs.AnnotationMode.ENABLE,
        enableSelectionRendering: true,
        maxCanvasPixels: pdfMaxCanvasPixels(),
        capCanvasAreaFactor: 100,
      })
      viewerRef.current = viewer
      linkService.setViewer(viewer)
      const pagesReady = new Promise<void>((resolve) => {
        resolvePagesReady = resolve
      })

      onPagesInit = () => {
        if (stopped) return
        viewer.currentScaleValue = 'page-width'
        setScalePercent(Math.round(viewer.currentScale * 100))
        setLoading(false)
        resolvePagesReady?.()
      }
      onPageChanging = (event: unknown) => {
        const nextPage = eventNumber(event, 'pageNumber')
        if (!stopped && nextPage !== null) setPageNumber(nextPage)
      }
      onScaleChanging = (event: unknown) => {
        const nextScale = eventNumber(event, 'scale')
        if (!stopped && nextScale !== null) setScalePercent(Math.round(nextScale * 100))
      }
      eventBus.on('pagesinit', onPagesInit)
      eventBus.on('pagechanging', onPageChanging)
      eventBus.on('scalechanging', onScaleChanging)

      const buffer = await data.arrayBuffer()
      if (stopped) return
      loadingTask = pdfJs.getDocument({ data: new Uint8Array(buffer) })
      const document = await loadingTask.promise
      if (stopped) return
      setPdfDocument(document)
      setPageCount(document.numPages)
      viewer.setDocument(document)
      linkService.setDocument(document)
      await pagesReady
    })()

    void withTimeout(operation, PDF_RENDER_TIMEOUT_MS).catch(() => {
      if (stopped) return
      if (build === 'modern') setBuild('legacy')
      else {
        setLoading(false)
        setError('This PDF could not be rendered locally on this browser.')
      }
    })

    return () => {
      stopped = true
      resolvePagesReady?.()
      if (eventBus !== null) {
        if (onPagesInit !== null) eventBus.off('pagesinit', onPagesInit)
        if (onPageChanging !== null) eventBus.off('pagechanging', onPageChanging)
        if (onScaleChanging !== null) eventBus.off('scalechanging', onScaleChanging)
      }
      viewerRef.current = null
      setPdfDocument(null)
      if (loadingTask !== null) void loadingTask.destroy()
      viewerElement.replaceChildren()
    }
  }, [build, data, retryCount])
  useEffect(() => {
    if (loading || pdfDocument === null) return
    const controller = new AbortController()
    let renderTask: RenderTask | null = null
    setOcrLines([])
    setOcrProgress(null)
    setOcrStatus('idle')

    const operation = (async () => {
      const page = await pdfDocument.getPage(pageNumber)
      const textContent = await page.getTextContent()
      if (controller.signal.aborted) return
      if (pdfPageHasSelectableText(textContent)) {
        setOcrStatus('native')
        return
      }

      setOcrStatus('recognizing')
      const baseViewport = page.getViewport({ scale: 1 })
      const scale = Math.min(2, PDF_OCR_LONG_SIDE / Math.max(baseViewport.width, baseViewport.height))
      const viewport = page.getViewport({ scale })
      const canvas = document.createElement('canvas')
      canvas.width = Math.max(1, Math.ceil(viewport.width))
      canvas.height = Math.max(1, Math.ceil(viewport.height))
      const context = canvas.getContext('2d', { willReadFrequently: true })
      if (context === null) throw new Error('PDF page pixels are unavailable')
      renderTask = page.render({ canvas, viewport })
      await renderTask.promise
      if (controller.signal.aborted) return
      const result = await recognizeImage(
        context.getImageData(0, 0, canvas.width, canvas.height),
        {
          signal: controller.signal,
          onProgress: setOcrProgress,
        },
      )
      if (controller.signal.aborted) return
      setOcrLines(result.lines)
      setOcrStatus(result.lines.length === 0 ? 'empty' : 'ready')
    })()

    void operation.catch((ocrError: unknown) => {
      if (
        controller.signal.aborted ||
        (ocrError instanceof Error && ocrError.name === 'RenderingCancelledException')
      ) {
        return
      }
      setOcrStatus('error')
    })

    return () => {
      controller.abort()
      renderTask?.cancel()
    }
  }, [loading, ocrRetryCount, pageNumber, pdfDocument])

  function moveToPage(nextPage: number) {
    const viewer = viewerRef.current
    if (viewer === null || pageCount === 0) return
    const boundedPage = Math.min(pageCount, Math.max(1, nextPage))
    viewer.currentPageNumber = boundedPage
    setPageNumber(boundedPage)
  }

  function zoom(steps: number) {
    viewerRef.current?.updateScale({ steps })
  }

  function fitWidth() {
    const viewer = viewerRef.current
    if (viewer === null) return
    viewer.currentScaleValue = 'page-width'
  }

  function retryCompatibilityPreview() {
    setError('')
    setBuild('legacy')
    setRetryCount((count) => count + 1)
  }
  const ocrPageElement = viewerElementRef.current?.querySelector<HTMLElement>(
    `.page[data-page-number="${pageNumber}"]`,
  ) ?? null

  return (
    <section className="pdf-document-preview" aria-label={`${name} PDF preview`}>
      <div className="pdf-document-toolbar">
        <div className="pdf-page-controls" aria-label="PDF page navigation">
          <Button
            variant="ghost"
            size="icon-sm"
            type="button"
            aria-label="Previous PDF page"
            disabled={loading || pageNumber <= 1}
            onClick={() => moveToPage(pageNumber - 1)}
          >
            <ChevronLeft />
          </Button>
          <label>
            <span className="visually-hidden">Current PDF page</span>
            <input
              type="number"
              min={1}
              max={Math.max(1, pageCount)}
              value={pageNumber}
              disabled={loading || pageCount === 0}
              aria-label="Current PDF page"
              onChange={(event) => moveToPage(Number(event.target.value))}
            />
            <span>/ {pageCount || '—'}</span>
          </label>
          <Button
            variant="ghost"
            size="icon-sm"
            type="button"
            aria-label="Next PDF page"
            disabled={loading || pageNumber >= pageCount}
            onClick={() => moveToPage(pageNumber + 1)}
          >
            <ChevronRight />
          </Button>
        </div>
        {ocrStatus !== 'idle' && (
          <div className={`pdf-ocr-status${ocrStatus === 'error' ? ' is-error' : ''}`} aria-live="polite">
            {ocrStatus === 'native' && <span>Drag to select PDF text</span>}
            {ocrStatus === 'recognizing' && <span>{pdfOcrProgressLabel(ocrProgress)}</span>}
            {ocrStatus === 'ready' && <span>Drag to select · {ocrLines.length} OCR lines</span>}
            {ocrStatus === 'empty' && <span>No selectable text found</span>}
            {ocrStatus === 'error' && (
              <button type="button" onClick={() => setOcrRetryCount((count) => count + 1)}>
                Retry text recognition
              </button>
            )}
          </div>
        )}
        <div className="pdf-zoom-controls" aria-label="PDF zoom controls">
          <Button variant="ghost" size="icon-sm" type="button" aria-label="Zoom out" disabled={loading} onClick={() => zoom(-1)}>
            <Minus />
          </Button>
          <button type="button" disabled={loading} onClick={fitWidth}>{scalePercent}%</button>
          <Button variant="ghost" size="icon-sm" type="button" aria-label="Zoom in" disabled={loading} onClick={() => zoom(1)}>
            <Plus />
          </Button>
        </div>
      </div>
      <div ref={containerRef} className="pdf-document-scroll" tabIndex={0}>
        <div ref={viewerElementRef} className="pdfViewer" />
        {loading && !error && (
          <span className="pdf-document-status">
            {build === 'legacy' ? 'Trying iOS-compatible PDF renderer…' : 'Preparing PDF pages…'}
          </span>
        )}
        {error && (
          <div className="pdf-document-status is-error" role="alert">
            <span>{error}</span>
            <small>Use Open in browser or Download above, or retry the compatible renderer.</small>
            <Button type="button" size="sm" onClick={retryCompatibilityPreview}>
              <RotateCcw />
              Retry compatible preview
            </Button>
          </div>
        )}
      </div>
      {ocrPageElement !== null && ocrLines.length > 0 && createPortal(
        <SelectableTextLayer lines={ocrLines} label={`${name} page ${pageNumber} recognized selectable text`} />,
        ocrPageElement,
      )}
    </section>
  )
}

type PdfPreviewProps =
  | { data: Blob; name: string; compact: true }
  | { data: Blob; name: string; compact?: false }

export function PdfPreview(props: PdfPreviewProps) {
  if (props.compact) return <PdfThumbnail data={props.data} name={props.name} />
  return <PdfDocumentPreview data={props.data} name={props.name} />
}
