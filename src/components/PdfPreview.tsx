import { useEffect, useRef, useState } from 'react'
import type * as PdfJsModule from 'pdfjs-dist'
import type {
  PDFDocumentLoadingTask,
  PDFDocumentProxy,
  RenderTask,
} from 'pdfjs-dist'
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'

let pdfJsPromise: Promise<typeof PdfJsModule> | null = null

function loadPdfJs() {
  pdfJsPromise ??= import('pdfjs-dist').then((pdfJs) => {
    pdfJs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl
    return pdfJs
  })
  return pdfJsPromise
}

interface PdfPreviewProps {
  data: Blob
  name: string
  compact?: boolean
}

export function PdfPreview({ data, name, compact = false }: PdfPreviewProps) {
  const stageRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const renderTaskRef = useRef<RenderTask | null>(null)
  const [document, setDocument] = useState<PDFDocumentProxy | null>(null)
  const [pageNumber, setPageNumber] = useState(1)
  const [renderSize, setRenderSize] = useState({ width: 0, height: 0 })
  const [error, setError] = useState('')
  const [retryCount, setRetryCount] = useState(0)

  useEffect(() => {
    const stage = stageRef.current
    if (stage === null) return

    const updateSize = () => {
      const styles = window.getComputedStyle(stage)
      const horizontalPadding = Number.parseFloat(styles.paddingLeft) + Number.parseFloat(styles.paddingRight)
      const verticalPadding = Number.parseFloat(styles.paddingTop) + Number.parseFloat(styles.paddingBottom)
      const width = Math.max(0, Math.floor(stage.clientWidth - horizontalPadding))
      const height = Math.max(0, Math.floor(stage.clientHeight - verticalPadding))
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
    setPageNumber(1)
    setError('')
    void loadPdfJs().then(async (pdfJs) => {
      const buffer = await data.arrayBuffer()
      if (stopped) return
      loadingTask = pdfJs.getDocument({ data: new Uint8Array(buffer) })
      return loadingTask.promise.then((nextDocument) => {
        if (!stopped) setDocument(nextDocument)
      })
    }).catch(() => {
      if (!stopped) setError('This PDF could not be rendered.')
    })

    return () => {
      stopped = true
      renderTaskRef.current?.cancel()
      renderTaskRef.current = null
      if (loadingTask !== null) void loadingTask.destroy()
    }
  }, [data, retryCount])

  useEffect(() => {
    const canvas = canvasRef.current
    if (document === null || canvas === null || renderSize.width === 0) return

    let stopped = false
    void document.getPage(pageNumber).then(async (page) => {
      if (stopped) return
      const baseViewport = page.getViewport({ scale: 1 })
      const widthScale = renderSize.width / baseViewport.width
      const heightScale = renderSize.height / baseViewport.height
      const cssScale = compact && renderSize.height > 0
        ? Math.min(widthScale, heightScale)
        : widthScale
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
          setError('This PDF page could not be rendered.')
        }
      } finally {
        if (renderTaskRef.current === task) renderTaskRef.current = null
      }
    }).catch(() => {
      if (!stopped) setError('This PDF page could not be loaded.')
    })

    return () => {
      stopped = true
      renderTaskRef.current?.cancel()
      renderTaskRef.current = null
    }
  }, [compact, document, pageNumber, renderSize])

  return (
    <div
      className={compact ? 'pdf-canvas-preview compact' : 'pdf-canvas-preview'}
      aria-label={compact ? undefined : `${name} PDF viewer`}
    >
      <div ref={stageRef} className="pdf-page-stage">
        <canvas ref={canvasRef} aria-hidden="true" />
        {document === null && !error && <span className="pdf-loading">Rendering PDF…</span>}
        {error && (
          <span className="pdf-render-error" role="alert">
            {error}
            {!compact && (
              <button
                type="button"
                className="inline-button"
                onClick={() => setRetryCount((current) => current + 1)}
              >
                Try again
              </button>
            )}
          </span>
        )}
      </div>
      {!compact && document !== null && document.numPages > 1 && (
        <div className="pdf-page-controls" aria-label="PDF page navigation">
          <button
            type="button"
            className="small-button"
            disabled={pageNumber === 1}
            onClick={() => setPageNumber((current) => Math.max(1, current - 1))}
          >
            Previous
          </button>
          <span>Page {pageNumber} of {document.numPages}</span>
          <button
            type="button"
            className="small-button"
            disabled={pageNumber === document.numPages}
            onClick={() => setPageNumber((current) => Math.min(document.numPages, current + 1))}
          >
            Next
          </button>
        </div>
      )}
    </div>
  )
}
