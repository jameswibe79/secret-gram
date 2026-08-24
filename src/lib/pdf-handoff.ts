const HERON_ORIGIN = 'https://heron.tools'
export type HeronPdfTool = 'deskew' | 'workspace'

const HERON_PDF_PATH_BY_TOOL: Record<HeronPdfTool, string> = {
  deskew: '/tools/pdf-rotate-pages/',
  workspace: '/tools/pdf-workspace/',
}
const PDF_HANDOFF_VERSION = 1
const PDF_HANDOFF_READY_TYPE = 'heron.tools:pdf-handoff:ready'
const PDF_HANDOFF_FILE_TYPE = 'heron.tools:pdf-handoff:file'
const PDF_HANDOFF_TIMEOUT_MS = 30_000

interface PdfHandoffOptions {
  data: Blob
  name: string
  tool: HeronPdfTool
  signal?: AbortSignal
}

function isReadyMessage(value: unknown, expectedToken: string): boolean {
  if (typeof value !== 'object' || value === null) return false
  return (
    Reflect.get(value, 'type') === PDF_HANDOFF_READY_TYPE &&
    Reflect.get(value, 'version') === PDF_HANDOFF_VERSION &&
    Reflect.get(value, 'token') === expectedToken
  )
}

export function handoffPdfToHeron({ data, name, tool, signal }: PdfHandoffOptions): Promise<void> {
  if (signal?.aborted) return Promise.reject(new DOMException('PDF handoff canceled', 'AbortError'))

  const token = crypto.randomUUID()
  const destination = new URL(HERON_PDF_PATH_BY_TOOL[tool], HERON_ORIGIN)
  destination.searchParams.set('handoff', 'pdf')
  destination.hash = new URLSearchParams({ token }).toString()
  const editor = window.open(destination.toString(), '_blank')
  if (editor === null) {
    return Promise.reject(new Error('The browser blocked the Heron Tools window.'))
  }

  const bytesPromise = data.arrayBuffer()
  return new Promise((resolve, reject) => {
    let settled = false
    let readyReceived = false

    const finish = (error?: Error) => {
      if (settled) return
      settled = true
      window.clearTimeout(timeout)
      window.removeEventListener('message', receiveReady)
      signal?.removeEventListener('abort', abort)
      if (error === undefined) resolve()
      else reject(error)
    }
    const abort = () => finish(new DOMException('PDF handoff canceled', 'AbortError'))
    const receiveReady = (event: MessageEvent) => {
      if (
        readyReceived ||
        event.source !== editor ||
        event.origin !== HERON_ORIGIN ||
        !isReadyMessage(event.data, token)
      ) {
        return
      }
      readyReceived = true
      window.removeEventListener('message', receiveReady)
      void bytesPromise.then((bytes) => {
        if (settled) return
        if (editor.closed) {
          finish(new Error('The Heron Tools window was closed before the PDF was sent.'))
          return
        }
        try {
          editor.postMessage(
            {
              type: PDF_HANDOFF_FILE_TYPE,
              version: PDF_HANDOFF_VERSION,
              token,
              name,
              bytes,
            },
            HERON_ORIGIN,
            [bytes],
          )
          finish()
        } catch {
          finish(new Error('The decrypted PDF could not be sent to Heron Tools.'))
        }
      }).catch(() => finish(new Error('The decrypted PDF could not be read for handoff.')))
    }
    const timeout = window.setTimeout(() => {
      finish(new Error('Heron Tools did not become ready within 30 seconds.'))
    }, PDF_HANDOFF_TIMEOUT_MS)

    signal?.addEventListener('abort', abort, { once: true })
    window.addEventListener('message', receiveReady)
  })
}
