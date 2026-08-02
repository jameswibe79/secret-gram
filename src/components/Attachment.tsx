import { useEffect, useMemo, useRef, useState } from 'react'

import type { FileDescriptor } from '../shared/protocol'
import {
  downloadDecryptedFile,
  type FileTransferCredentials,
} from '../lib/file-transfer'

interface AttachmentProps {
  descriptor: FileDescriptor
  credentials: FileTransferCredentials
}

const PREVIEW_LIMIT_BYTES = 64 * 1024 * 1024
const SAFE_IMAGE_TYPES = new Set([
  'image/avif',
  'image/gif',
  'image/jpeg',
  'image/png',
  'image/webp',
])

function fileSize(bytes: number): string {
  if (bytes < 1_024) return `${bytes} B`
  if (bytes < 1_024 ** 2) return `${(bytes / 1_024).toFixed(1)} KB`
  if (bytes < 1_024 ** 3) return `${(bytes / 1_024 ** 2).toFixed(1)} MB`
  return `${(bytes / 1_024 ** 3).toFixed(1)} GB`
}

function safeDownloadName(name: string): string {
  const safeName = [...name].map((character) => {
    const codePoint = character.codePointAt(0) ?? 0
    return character === '\\' || character === '/' || codePoint < 32 || codePoint === 127
      ? '_'
      : character
  }).join('')
  return safeName || 'encrypted-file'
}

export function Attachment({ descriptor, credentials }: AttachmentProps) {
  const [objectUrl, setObjectUrl] = useState('')
  const [loading, setLoading] = useState(false)
  const [progress, setProgress] = useState(0)
  const [error, setError] = useState('')
  const abortRef = useRef<AbortController | null>(null)
  const blobPromiseRef = useRef<Promise<Blob> | null>(null)
  const objectUrlRef = useRef('')
  const mountedRef = useRef(true)
  const previewType = useMemo(() => {
    if (descriptor.size > PREVIEW_LIMIT_BYTES) return 'none'
    if (SAFE_IMAGE_TYPES.has(descriptor.mimeType)) return 'image'
    if (descriptor.mimeType === 'application/pdf') return 'pdf'
    return 'none'
  }, [descriptor.mimeType, descriptor.size])

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      abortRef.current?.abort()
      if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current)
      objectUrlRef.current = ''
    }
  }, [])

  async function getBlob(): Promise<Blob> {
    if (blobPromiseRef.current) return blobPromiseRef.current

    const controller = new AbortController()
    abortRef.current = controller
    setLoading(true)
    setProgress(0)
    setError('')
    const operation = (async () => {
      const blob = await downloadDecryptedFile(descriptor, credentials, {
        signal: controller.signal,
        onProgress: ({ completedBytes, totalBytes, completedChunks, totalChunks }) => {
          if (!mountedRef.current) return
          setProgress(
            totalBytes === 0 ? completedChunks / totalChunks : completedBytes / totalBytes,
          )
        },
      })
      if (controller.signal.aborted || !mountedRef.current) {
        throw new DOMException('Operation canceled', 'AbortError')
      }
      return blob
    })()
    blobPromiseRef.current = operation
    try {
      return await operation
    } catch {
      if (!controller.signal.aborted) {
        setError('The attachment could not be downloaded or failed its integrity check.')
      }
      throw new Error('attachment failed')
    } finally {
      if (blobPromiseRef.current === operation) blobPromiseRef.current = null
      if (abortRef.current === controller) abortRef.current = null
      if (mountedRef.current) setLoading(false)
    }
  }

  async function download() {
    let temporaryUrl = false
    let url = objectUrlRef.current
    try {
      if (!url) {
        url = URL.createObjectURL(await getBlob())
        temporaryUrl = true
      }
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = safeDownloadName(descriptor.name)
      anchor.rel = 'noopener'
      document.body.append(anchor)
      anchor.click()
      anchor.remove()
    } catch {
      // The inline error gives the user the recovery state.
    } finally {
      if (temporaryUrl && url) {
        window.setTimeout(() => URL.revokeObjectURL(url), 0)
      }
    }
  }

  async function preview() {
    try {
      if (objectUrlRef.current) return
      const blob = await getBlob()
      if (!mountedRef.current || objectUrlRef.current) return
      const nextUrl = URL.createObjectURL(blob)
      objectUrlRef.current = nextUrl
      setObjectUrl(nextUrl)
    } catch {
      // The inline error gives the user the recovery state.
    }
  }

  return (
    <section className="attachment" aria-label={`Attachment: ${descriptor.name}`}>
      <div className="attachment-summary">
        <span className="file-glyph" aria-hidden="true">
          {previewType === 'image' ? 'IMG' : previewType === 'pdf' ? 'PDF' : 'FILE'}
        </span>
        <div className="attachment-name">
          <strong>{descriptor.name}</strong>
          <span>{fileSize(descriptor.size)} · encrypted attachment</span>
        </div>
      </div>

      <div className="attachment-actions">
        {previewType !== 'none' && !objectUrl && (
          <button type="button" className="small-button" disabled={loading} onClick={preview}>
            Preview
          </button>
        )}
        <button type="button" className="small-button" disabled={loading} onClick={download}>
          Download
        </button>
      </div>

      {loading && (
        <div className="transfer-progress" aria-live="polite">
          <progress max={1} value={progress} aria-label={`${descriptor.name} download progress`} />
          <span>Downloading and decrypting… {Math.round(progress * 100)}%</span>
        </div>
      )}
      {error && <p className="inline-error" role="alert">{error}</p>}

      {objectUrl && previewType === 'image' && (
        <div className="image-preview">
          <img src={objectUrl} alt={descriptor.name} />
        </div>
      )}
      {objectUrl && previewType === 'pdf' && (
        <div className="pdf-preview">
          <iframe
            src={objectUrl}
            title={`${descriptor.name} PDF preview`}
            sandbox=""
            referrerPolicy="no-referrer"
          />
        </div>
      )}
      {previewType === 'none' && descriptor.size > PREVIEW_LIMIT_BYTES && (
        <p className="attachment-note">To limit memory use, attachments larger than 64 MB can only be downloaded.</p>
      )}
    </section>
  )
}
