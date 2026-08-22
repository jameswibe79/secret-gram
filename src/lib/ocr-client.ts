import type {
  OcrProgress,
  OcrResult,
  OcrWorkerRequest,
  OcrWorkerResponse,
} from './ocr-types'

interface PendingRequest {
  resolve(result: OcrResult): void
  reject(error: Error): void
  onProgress?: (progress: OcrProgress) => void
  detachAbort?: () => void
}

interface RecognizeOptions {
  signal?: AbortSignal
  onProgress?: (progress: OcrProgress) => void
}
const OCR_IDLE_DISPOSE_MS = 60_000

let worker: Worker | null = null
let nextRequestId = 1
const pendingRequests = new Map<number, PendingRequest>()
let idleDisposeTimer: number | null = null

function rejectAll(error: Error) {
  for (const pending of pendingRequests.values()) {
    pending.detachAbort?.()
    pending.reject(error)
  }
  pendingRequests.clear()
}
function clearIdleDisposal() {
  if (idleDisposeTimer === null) return
  window.clearTimeout(idleDisposeTimer)
  idleDisposeTimer = null
}

function scheduleIdleDisposal() {
  clearIdleDisposal()
  if (pendingRequests.size !== 0 || worker === null) return
  idleDisposeTimer = window.setTimeout(() => {
    idleDisposeTimer = null
    resetWorker()
  }, OCR_IDLE_DISPOSE_MS)
}

function resetWorker(error?: Error) {
  clearIdleDisposal()
  worker?.terminate()
  worker = null
  if (error !== undefined) rejectAll(error)
}

function getWorker(): Worker {
  clearIdleDisposal()
  if (worker !== null) return worker
  const nextWorker = new Worker(new URL('../workers/ocr.worker.ts', import.meta.url), { type: 'module' })
  nextWorker.onmessage = (event: MessageEvent<OcrWorkerResponse>) => {
    const message = event.data
    const pending = pendingRequests.get(message.id)
    if (pending === undefined) return
    if (message.type === 'progress') {
      pending.onProgress?.(message.progress)
      return
    }
    pendingRequests.delete(message.id)
    pending.detachAbort?.()
    if (message.type === 'result') {
      pending.resolve(message.result)
      scheduleIdleDisposal()
    } else {
      const error = new Error(message.message)
      pending.reject(error)
      resetWorker(error)
    }
  }
  nextWorker.onerror = (event) => {
    resetWorker(new Error(event.message || 'The local text-recognition worker stopped unexpectedly.'))
  }
  worker = nextWorker
  return nextWorker
}

export function recognizeImage(
  image: ImageData,
  { signal, onProgress }: RecognizeOptions = {},
): Promise<OcrResult> {
  if (signal?.aborted) return Promise.reject(new DOMException('OCR canceled', 'AbortError'))
  const requestId = nextRequestId
  nextRequestId += 1
  const activeWorker = getWorker()

  return new Promise((resolve, reject) => {
    const pending: PendingRequest = { resolve, reject, onProgress }
    if (signal !== undefined) {
      const abort = () => {
        if (!pendingRequests.delete(requestId)) return
        const error = new DOMException('OCR canceled', 'AbortError')
        reject(error)
        resetWorker(error)
      }
      signal.addEventListener('abort', abort, { once: true })
      pending.detachAbort = () => signal.removeEventListener('abort', abort)
    }
    pendingRequests.set(requestId, pending)
    const data = image.data.buffer as ArrayBuffer
    const message: OcrWorkerRequest = {
      type: 'recognize',
      id: requestId,
      image: { width: image.width, height: image.height, data },
    }
    activeWorker.postMessage(message, [data])
  })
}

export function disposeOcrWorker() {
  resetWorker(new DOMException('OCR worker disposed', 'AbortError'))
}
