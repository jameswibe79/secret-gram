import { Download, ExternalLink, RotateCcw, ShieldCheck } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import type { FileDescriptor } from '../shared/protocol'
import {
  downloadDecryptedFile,
  type FileTransferCredentials,
} from '../lib/file-transfer'
import { SecurityDialog } from './SecurityDialog'
import { PdfPreview } from './PdfPreview'
import { Button } from './ui/button'

interface AttachmentProps {
  descriptor: FileDescriptor
  credentials: FileTransferCredentials
  presentation?: 'card' | 'thumbnail' | 'viewer'
}

const PREVIEW_LIMIT_BYTES = 64 * 1024 * 1024
const TEXT_PREVIEW_LIMIT_BYTES = 1 * 1024 * 1024
const AUTO_PREVIEW_LIMIT_BYTES = 8 * 1024 * 1024
const AUTO_TEXT_PREVIEW_LIMIT_BYTES = 256 * 1024
const INLINE_TEXT_CHARACTERS = 4_000
const SAFE_IMAGE_TYPES: Record<string, true> = {
  'image/avif': true,
  'image/gif': true,
  'image/jpeg': true,
  'image/png': true,
  'image/webp': true,
}

function isPlainTextType(mimeType: string): boolean {
  return mimeType.toLowerCase().startsWith('text/')
}

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

export function Attachment({ descriptor, credentials, presentation = 'card' }: AttachmentProps) {
  const [objectUrl, setObjectUrl] = useState('')
  const [previewBlob, setPreviewBlob] = useState<Blob | null>(null)
  const [previewText, setPreviewText] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [progress, setProgress] = useState(0)
  const [previewOpen, setPreviewOpen] = useState(false)
  const [error, setError] = useState('')
  const [autoPreviewRequested, setAutoPreviewRequested] = useState(false)
  const abortRef = useRef<AbortController | null>(null)
  const blobPromiseRef = useRef<Promise<Blob> | null>(null)
  const previewBlobRef = useRef<Blob | null>(null)
  const previewTextRef = useRef<string | null>(null)
  const objectUrlRef = useRef('')
  const attachmentRef = useRef<HTMLElement | null>(null)
  const mountedRef = useRef(true)
  const previewType = useMemo(() => {
    if (isPlainTextType(descriptor.mimeType)) {
      return descriptor.size <= TEXT_PREVIEW_LIMIT_BYTES ? 'text' : 'none'
    }
    if (descriptor.size > PREVIEW_LIMIT_BYTES) return 'none'
    if (SAFE_IMAGE_TYPES[descriptor.mimeType] === true) return 'image'
    if (descriptor.mimeType === 'application/pdf') return 'pdf'
    return 'none'
  }, [descriptor.mimeType, descriptor.size])
  const autoPreviewLimit = previewType === 'text'
    ? AUTO_TEXT_PREVIEW_LIMIT_BYTES
    : AUTO_PREVIEW_LIMIT_BYTES
  const autoPreviewEnabled = previewType !== 'none' && descriptor.size <= autoPreviewLimit
  const previewGlyph = previewType === 'image' ? 'IMG' : previewType === 'pdf' ? 'PDF' : 'TXT'

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      abortRef.current?.abort()
      if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current)
      objectUrlRef.current = ''
      previewBlobRef.current = null
      previewTextRef.current = null
    }
  }, [])

  const getBlob = useCallback(async (): Promise<Blob> => {
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
  }, [credentials, descriptor])

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

  const ensurePreviewUrl = useCallback(async (): Promise<string> => {
    if (
      objectUrlRef.current &&
      previewBlobRef.current &&
      (previewType !== 'text' || previewTextRef.current !== null)
    ) {
      return objectUrlRef.current
    }
    const blob = previewBlobRef.current ?? await getBlob()
    if (!mountedRef.current) throw new DOMException('Operation canceled', 'AbortError')
    previewBlobRef.current = blob
    setPreviewBlob(blob)
    if (previewType === 'text' && previewTextRef.current === null) {
      const text = await blob.text()
      if (!mountedRef.current) throw new DOMException('Operation canceled', 'AbortError')
      previewTextRef.current = text
      setPreviewText(text)
    }
    if (objectUrlRef.current) return objectUrlRef.current
    const nextUrl = URL.createObjectURL(blob)
    objectUrlRef.current = nextUrl
    setObjectUrl(nextUrl)
    return nextUrl
  }, [getBlob, previewType])

  useEffect(() => {
    if (!autoPreviewEnabled) return
    const attachment = attachmentRef.current
    if (attachment === null || typeof IntersectionObserver === 'undefined') {
      setAutoPreviewRequested(true)
      return
    }
    const observer = new IntersectionObserver((entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return
      setAutoPreviewRequested(true)
      observer.disconnect()
    }, { rootMargin: '160px' })
    observer.observe(attachment)
    return () => observer.disconnect()
  }, [autoPreviewEnabled])

  useEffect(() => {
    if (!autoPreviewEnabled || !autoPreviewRequested) return
    let stopped = false
    void ensurePreviewUrl().catch(() => {
      if (stopped || !mountedRef.current) return
      void ensurePreviewUrl().catch(() => {
        // The inline preview keeps a clickable recovery state.
      })
    })
    return () => {
      stopped = true
    }
  }, [autoPreviewEnabled, autoPreviewRequested, ensurePreviewUrl])

  async function openPreview() {
    setPreviewOpen(true)
    try {
      await ensurePreviewUrl()
    } catch {
      // The open preview keeps a clear retry state visible.
    }
  }

  function cancelLoad() {
    abortRef.current?.abort()
    if (mountedRef.current) {
      setError('Preview canceled. You can try again when you are ready.')
    }
  }

  function closePreview() {
    abortRef.current?.abort()
    setPreviewOpen(false)
  }

  async function prepareInlinePreview() {
    try {
      await ensurePreviewUrl()
    } catch {
      // The viewer keeps a clear retry state visible.
    }
  }

  if (presentation === 'thumbnail') {
    return (
      <span
        ref={attachmentRef}
        className={`resource-file-thumbnail ${previewType}${loading ? ' loading' : ''}`}
        aria-hidden="true"
      >
        {previewType === 'image' && objectUrl ? (
          <img src={objectUrl} alt="" />
        ) : previewType === 'pdf' && objectUrl && previewBlob ? (
          <PdfPreview data={previewBlob} name={descriptor.name} compact />
        ) : (
          <span>{loading ? '…' : previewGlyph}</span>
        )}
      </span>
    )
  }

  if (presentation === 'viewer') {
    return (
      <section ref={attachmentRef} className="attachment attachment-viewer" aria-label={`File: ${descriptor.name}`}>
        <header className="attachment-viewer-toolbar">
          <div className="attachment-viewer-title">
            <span className="file-glyph" aria-hidden="true">{previewGlyph}</span>
            <span>
              <strong title={descriptor.name}>{descriptor.name}</strong>
              <small>{fileSize(descriptor.size)} · encrypted file</small>
            </span>
          </div>
          <div className="attachment-viewer-actions">
            <Button variant="outline" size="sm" type="button" disabled={loading} onClick={download}>
              <Download />
              Download
            </Button>
            {objectUrl && previewBlob && (
              <Button asChild size="sm">
                <a href={objectUrl} target="_blank" rel="noopener noreferrer">
                  <ExternalLink />
                  {previewType === 'pdf' ? 'Open in browser / OCR' : 'Open separately'}
                </a>
              </Button>
            )}
          </div>
        </header>

        <div className="attachment-viewer-stage">
          {loading && (
            <div className="preview-loading-state" aria-live="polite">
              <span className="preview-loading-art" aria-hidden="true"><i /></span>
              <h3>Preparing local preview</h3>
              <p>Downloading encrypted pieces, checking integrity, then decrypting them here.</p>
              <div className="preview-loading-progress">
                <progress max={1} value={progress} aria-label={`${descriptor.name} preview progress`} />
                <span>{Math.round(progress * 100)}%</span>
              </div>
              <Button type="button" variant="outline" size="sm" onClick={cancelLoad}>Cancel preview</Button>
            </div>
          )}
          {!loading && error && (!objectUrl || !previewBlob) && (
            <div className="preview-error-state" role="alert">
              <span aria-hidden="true">!</span>
              <h3>Preview could not be prepared</h3>
              <p>{error}</p>
              <Button type="button" size="sm" onClick={prepareInlinePreview}>
                <RotateCcw />
                Try again
              </Button>
            </div>
          )}
          {!loading && !error && previewType === 'none' && (
            <div className="attachment-no-preview">
              <span className="viewer-file-glyph" aria-hidden="true">{previewGlyph}</span>
              <h3>Download to open this file</h3>
              <p>
                {descriptor.size > PREVIEW_LIMIT_BYTES
                  ? 'Files over 64 MB are not previewed to protect browser memory.'
                  : 'This file type does not have a safe browser-local preview.'}
              </p>
              <Button type="button" onClick={download}><Download /> Download file</Button>
            </div>
          )}
          {!loading && !error && previewType !== 'none' && !objectUrl && (
            <div className="attachment-no-preview">
              <span className="viewer-file-glyph" aria-hidden="true">{previewGlyph}</span>
              <h3>Preview in this browser</h3>
              <p>The file will be downloaded, integrity-checked, and decrypted only on this device.</p>
              <Button type="button" onClick={prepareInlinePreview}>Load preview</Button>
            </div>
          )}
          {!loading && previewType === 'image' && objectUrl && previewBlob && (
            <div className="viewer-image-preview">
              <img src={objectUrl} alt={descriptor.name} />
            </div>
          )}
          {!loading && previewType === 'pdf' && objectUrl && previewBlob && (
            <PdfPreview data={previewBlob} name={descriptor.name} />
          )}
          {!loading && previewType === 'text' && objectUrl && previewBlob && previewText !== null && (
            <div className="viewer-text-preview">
              <pre tabIndex={0} dir="auto" aria-label={`${descriptor.name} text content`}>
                {previewText === '' ? 'This text file is empty.' : previewText}
              </pre>
            </div>
          )}
        </div>
        <p className="attachment-viewer-privacy"><ShieldCheck /> Preview decrypted only in this browser</p>
      </section>
    )
  }

  return (
    <section ref={attachmentRef} className="attachment" aria-label={`Attachment: ${descriptor.name}`}>
      <div className={previewType === 'none' ? 'attachment-card' : 'attachment-card has-preview'}>
        {previewType !== 'none' && (
          <div className="attachment-preview">
            <button
              type="button"
              className="preview-thumb"
              disabled={loading}
              aria-label={`Open ${descriptor.name} preview`}
              onClick={openPreview}
            >
              {previewType === 'image' && objectUrl ? (
                <img src={objectUrl} alt="" />
              ) : previewType === 'pdf' && objectUrl && previewBlob ? (
                <PdfPreview data={previewBlob} name={descriptor.name} compact />
              ) : previewType === 'text' && previewText !== null ? (
                <span className="text-preview-snippet" dir="auto">
                  {previewText === '' ? 'Empty text file' : previewText.slice(0, INLINE_TEXT_CHARACTERS)}
                </span>
              ) : loading ? (
                <span className="preview-placeholder is-loading">
                  <span className="preview-glyph" aria-hidden="true">{previewGlyph}</span>
                  <strong>Preparing preview</strong>
                  <span className="inline-preview-progress">
                    <progress max={1} value={progress} aria-label={`${descriptor.name} inline preview progress`} />
                    <small>{Math.round(progress * 100)}%</small>
                  </span>
                </span>
              ) : (
                <span className="preview-placeholder">
                  <span className="preview-glyph" aria-hidden="true">{previewGlyph}</span>
                  <strong>{error ? 'Try preview again' : 'Open preview'}</strong>
                  <small>{autoPreviewEnabled ? 'Preview unavailable' : 'Loads when requested'}</small>
                </span>
              )}
              {objectUrl && <span className="preview-overlay">Open preview</span>}
            </button>
            <span className="preview-privacy">Browser-only preview</span>
          </div>
        )}

        <div className="attachment-details">
          <div className="attachment-summary">
            <span className="file-glyph" aria-hidden="true">
              {previewGlyph}
            </span>
            <div className="attachment-name">
              <strong title={descriptor.name}>{descriptor.name}</strong>
              <span>{fileSize(descriptor.size)} · encrypted attachment</span>
            </div>
          </div>
          <div className="attachment-actions">
            <Button variant="secondary" size="sm" type="button" disabled={loading} onClick={download}>
              <Download />
              Download
            </Button>
          </div>
        </div>
      </div>

      {loading && !previewOpen && previewType === 'none' && (
        <div className="transfer-progress" aria-live="polite">
          <progress max={1} value={progress} aria-label={`${descriptor.name} download progress`} />
          <span>Downloading and decrypting… {Math.round(progress * 100)}%</span>
          <button className="inline-button" type="button" onClick={cancelLoad}>Cancel</button>
        </div>
      )}
      {error && !previewOpen && <p className="inline-error" role="alert">{error}</p>}

      {previewOpen && (
        <SecurityDialog
          title={descriptor.name}
          backdropClassName="preview-backdrop"
          className="preview-modal"
          onClose={closePreview}
        >
          <div className="preview-toolbar">
            <div>
              <strong>
                {previewType === 'image'
                  ? 'Image preview'
                  : previewType === 'pdf'
                    ? 'PDF preview · local reader'
                    : 'Plain-text preview'}
              </strong>
              <span>{fileSize(descriptor.size)} · decrypted only in this browser</span>
            </div>
            {objectUrl && previewBlob && (
              <div className="preview-toolbar-actions">
                <Button variant="outline" size="sm" type="button" onClick={download}>
                  <Download />
                  Download
                </Button>
                <Button asChild size="sm">
                  <a href={objectUrl} target="_blank" rel="noopener noreferrer">
                    <ExternalLink />
                    {previewType === 'image' ? 'Open full size' : previewType === 'pdf' ? 'Open in browser / OCR' : 'Open in new tab'}
                  </a>
                </Button>
              </div>
            )}
          </div>
          {loading && (
            <div className="preview-loading-state" aria-live="polite">
              <span className="preview-loading-art" aria-hidden="true"><i /></span>
              <h3>Preparing your preview</h3>
              <p>Downloading encrypted pieces, checking integrity, then decrypting them here.</p>
              <div className="preview-loading-progress">
                <progress max={1} value={progress} aria-label={`${descriptor.name} preview progress`} />
                <span>{Math.round(progress * 100)}%</span>
              </div>
              <Button type="button" variant="outline" size="sm" onClick={cancelLoad}>Cancel preview</Button>
            </div>
          )}
          {!loading && error && (!objectUrl || !previewBlob) && (
            <div className="preview-error-state" role="alert">
              <span aria-hidden="true">!</span>
              <h3>Preview could not be prepared</h3>
              <p>{error}</p>
              <Button type="button" size="sm" onClick={openPreview}>
                <RotateCcw />
                Try again
              </Button>
            </div>
          )}
          {!loading && previewType === 'image' && objectUrl && previewBlob && (
            <div className="modal-image-preview">
              <img src={objectUrl} alt={descriptor.name} />
            </div>
          )}
          {!loading && previewType === 'pdf' && objectUrl && previewBlob && (
            <PdfPreview data={previewBlob} name={descriptor.name} />
          )}
          {!loading && previewType === 'text' && objectUrl && previewBlob && previewText !== null && (
            <div className="modal-text-preview">
              <pre tabIndex={0} dir="auto" aria-label={`${descriptor.name} text content`}>
                {previewText === '' ? 'This text file is empty.' : previewText}
              </pre>
            </div>
          )}
        </SecurityDialog>
      )}
      {previewType === 'none' && descriptor.size > PREVIEW_LIMIT_BYTES && (
        <p className="attachment-note">To protect browser memory, files over 64 MB are available as downloads only.</p>
      )}
      {previewType === 'none' &&
        isPlainTextType(descriptor.mimeType) &&
        descriptor.size > TEXT_PREVIEW_LIMIT_BYTES &&
        descriptor.size <= PREVIEW_LIMIT_BYTES && (
          <p className="attachment-note">Text previews are limited to 1 MB. Download this file to read it in full.</p>
        )}
    </section>
  )
}
