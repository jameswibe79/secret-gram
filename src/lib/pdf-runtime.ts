import legacyPdfWorkerUrl from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?url'
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'

export type PdfBuild = 'modern' | 'legacy'

let modernPdfJsPromise: Promise<typeof import('pdfjs-dist')> | null = null
let legacyPdfJsPromise: Promise<typeof import('pdfjs-dist/legacy/build/pdf.mjs')> | null = null
let modernPdfViewerPromise: Promise<typeof import('pdfjs-dist/web/pdf_viewer.mjs')> | null = null
let legacyPdfViewerPromise: Promise<typeof import('pdfjs-dist/legacy/web/pdf_viewer.mjs')> | null = null

export function loadPdfJs(build: PdfBuild) {
  if (build === 'legacy') {
    legacyPdfJsPromise ??= import('pdfjs-dist/legacy/build/pdf.mjs').then((pdfJs) => {
      pdfJs.GlobalWorkerOptions.workerSrc = legacyPdfWorkerUrl
      return pdfJs
    })
    return legacyPdfJsPromise
  }

  modernPdfJsPromise ??= import('pdfjs-dist').then((pdfJs) => {
    pdfJs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl
    return pdfJs
  })
  return modernPdfJsPromise
}

export function loadPdfViewer(build: PdfBuild) {
  if (build === 'legacy') {
    legacyPdfViewerPromise ??= import('pdfjs-dist/legacy/web/pdf_viewer.mjs')
    return legacyPdfViewerPromise
  }

  modernPdfViewerPromise ??= import('pdfjs-dist/web/pdf_viewer.mjs')
  return modernPdfViewerPromise
}
