import { ChevronLeft, ChevronRight, Minus, Plus } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type * as PdfJsModule from 'pdfjs-dist'
import type {
  PDFDocumentLoadingTask,
  PDFDocumentProxy,
  RenderTask,
} from 'pdfjs-dist'
import type * as PdfViewerModule from 'pdfjs-dist/web/pdf_viewer.mjs'
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'

import { Button } from './ui/button'

let pdfJsPromise: Promise<typeof PdfJsModule> | null = null
let pdfViewerPromise: Promise<typeof PdfViewerModule> | null = null

function loadPdfJs() {
  pdfJsPromise ??= import('pdfjs-dist').then((pdfJs) => {
    pdfJs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl
    return pdfJs
  })
  return pdfJsPromise
}

function loadPdfViewer() {
  pdfViewerPromise ??= Promise.all([
    import('pdfjs-dist/web/pdf_viewer.mjs'),
    import('pdfjs-dist/web/pdf_viewer.css'),
  ]).then(([pdfViewer]) => pdfViewer)
  return pdfViewerPromise
}

function eventNumber(event: unknown, key: string): number | null {
  if (typeof event !== 'object' || event === null) return null
  const value = Reflect.get(event, key)
  return typeof value === 'number' && Number.isFinite(value) ? value : null
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
  const [error, setError] = useState('')

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
    void loadPdfJs().then(async (pdfJs) => {
      const buffer = await data.arrayBuffer()
      if (stopped) return
      loadingTask = pdfJs.getDocument({ data: new Uint8Array(buffer) })
      const nextDocument = await loadingTask.promise
      if (!stopped) setDocument(nextDocument)
    }).catch(() => {
      if (!stopped) setError('Preview unavailable')
    })

    return () => {
      stopped = true
      renderTaskRef.current?.cancel()
      renderTaskRef.current = null
      if (loadingTask !== null) void loadingTask.destroy()
    }
  }, [data])

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
        await task.promise
      } catch (renderError) {
        if (!stopped && !(renderError instanceof Error && renderError.name === 'RenderingCancelledException')) {
          setError('Preview unavailable')
        }
      } finally {
        if (renderTaskRef.current === task) renderTaskRef.current = null
      }
    }).catch(() => {
      if (!stopped) setError('Preview unavailable')
    })

    return () => {
      stopped = true
      renderTaskRef.current?.cancel()
      renderTaskRef.current = null
    }
  }, [document, renderSize])

  return (
    <div className="pdf-thumbnail-preview" aria-label={`${name} PDF thumbnail`}>
      <div ref={stageRef} className="pdf-thumbnail-stage">
        <canvas ref={canvasRef} aria-hidden="true" />
        {document === null && !error && <span className="pdf-thumbnail-status">Rendering PDF…</span>}
        {error && <span className="pdf-thumbnail-status is-error">{error}</span>}
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
  const viewerRef = useRef<PdfViewerModule.PDFViewer | null>(null)
  const [pageNumber, setPageNumber] = useState(1)
  const [pageCount, setPageCount] = useState(0)
  const [scalePercent, setScalePercent] = useState(100)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => {
    const container = containerRef.current
    const viewerElement = viewerElementRef.current
    if (container === null || viewerElement === null) return

    let stopped = false
    let loadingTask: PDFDocumentLoadingTask | null = null
    let document: PDFDocumentProxy | null = null
    let eventBus: PdfViewerModule.EventBus | null = null
    let onPagesInit: (() => void) | null = null
    let onPageChanging: ((event: unknown) => void) | null = null
    let onScaleChanging: ((event: unknown) => void) | null = null
    setLoading(true)
    setError('')
    setPageNumber(1)
    setPageCount(0)

    void Promise.all([loadPdfJs(), loadPdfViewer()]).then(async ([pdfJs, pdfViewer]) => {
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
        maxCanvasPixels: 24 * 1024 * 1024,
      })
      viewerRef.current = viewer
      linkService.setViewer(viewer)

      onPagesInit = () => {
        if (stopped) return
        viewer.currentScaleValue = 'page-width'
        setScalePercent(Math.round(viewer.currentScale * 100))
        setLoading(false)
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
      document = await loadingTask.promise
      if (stopped) return
      setPageCount(document.numPages)
      viewer.setDocument(document)
      linkService.setDocument(document)
    }).catch(() => {
      if (!stopped) {
        setLoading(false)
        setError('This PDF could not be rendered locally. Use Open in browser / OCR or Download.')
      }
    })

    return () => {
      stopped = true
      if (eventBus !== null) {
        if (onPagesInit !== null) eventBus.off('pagesinit', onPagesInit)
        if (onPageChanging !== null) eventBus.off('pagechanging', onPageChanging)
        if (onScaleChanging !== null) eventBus.off('scalechanging', onScaleChanging)
      }
      viewerRef.current = null
      if (loadingTask !== null) void loadingTask.destroy()
      viewerElement.replaceChildren()
    }
  }, [data])

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
        {loading && <span className="pdf-document-status">Preparing PDF pages…</span>}
        {error && <span className="pdf-document-status is-error">{error}</span>}
      </div>
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
