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

type PdfPreviewProps =
  | { data: Blob; name: string; compact: true; url?: never }
  | { url: string; name: string; compact?: false; data?: never }

export function PdfPreview(props: PdfPreviewProps) {
  if (props.compact) return <PdfThumbnail data={props.data} name={props.name} />

  return (
    <iframe
      className="native-pdf-preview"
      src={props.url}
      title={`${props.name} browser PDF viewer`}
      referrerPolicy="no-referrer"
    />
  )
}
