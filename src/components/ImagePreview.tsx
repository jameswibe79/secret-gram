import { RotateCcw } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'

import { recognizeImage } from '../lib/ocr-client'
import type { OcrLine, OcrProgress } from '../lib/ocr-types'
import { SelectableTextLayer } from './SelectableTextLayer'
import { Button } from './ui/button'

const OCR_IMAGE_LONG_SIDE = 1600

interface ImagePreviewProps {
  url: string
  name: string
  variant: 'viewer' | 'modal'
}

function progressLabel(progress: OcrProgress | null): string {
  if (progress === null || progress.stage === 'loading-models') {
    return 'Loading local Chinese and English text recognition…'
  }
  if (progress.stage === 'detecting') return 'Finding text in this image…'
  return progress.total === 0
    ? 'Reading text in this image…'
    : `Reading text ${progress.completed} of ${progress.total}…`
}

export function ImagePreview({ url, name, variant }: ImagePreviewProps) {
  const imageRef = useRef<HTMLImageElement>(null)
  const abortRef = useRef<AbortController | null>(null)
  const [lines, setLines] = useState<OcrLine[]>([])
  const [progress, setProgress] = useState<OcrProgress | null>(null)
  const [recognizing, setRecognizing] = useState(false)
  const [recognized, setRecognized] = useState(false)
  const [error, setError] = useState('')
  const [retryCount, setRetryCount] = useState(0)

  const recognize = useCallback(async (image: HTMLImageElement) => {
    abortRef.current?.abort()
    const controller = new AbortController()
    abortRef.current = controller
    setLines([])
    setProgress(null)
    setRecognizing(true)
    setRecognized(false)
    setError('')
    try {
      const scale = Math.min(1, OCR_IMAGE_LONG_SIDE / Math.max(image.naturalWidth, image.naturalHeight))
      const width = Math.max(1, Math.round(image.naturalWidth * scale))
      const height = Math.max(1, Math.round(image.naturalHeight * scale))
      const canvas = document.createElement('canvas')
      canvas.width = width
      canvas.height = height
      const context = canvas.getContext('2d', { willReadFrequently: true })
      if (context === null) throw new Error('Image pixels are unavailable')
      context.drawImage(image, 0, 0, width, height)
      const result = await recognizeImage(context.getImageData(0, 0, width, height), {
        signal: controller.signal,
        onProgress: setProgress,
      })
      if (controller.signal.aborted) return
      setLines(result.lines)
      setRecognized(true)
    } catch (recognitionError) {
      if (controller.signal.aborted) return
      setError(
        recognitionError instanceof Error
          ? recognitionError.message
          : 'Text selection could not be prepared.',
      )
    } finally {
      if (!controller.signal.aborted) setRecognizing(false)
      if (abortRef.current === controller) abortRef.current = null
    }
  }, [])

  useEffect(() => {
    const image = imageRef.current
    if (image?.complete && image.naturalWidth > 0) void recognize(image)
    return () => abortRef.current?.abort()
  }, [recognize, retryCount, url])

  return (
    <div className={`${variant === 'viewer' ? 'viewer-image-preview' : 'modal-image-preview'} selectable-image-preview`}>
      <div className="selectable-image-surface">
        <img
          ref={imageRef}
          src={url}
          alt={name}
          draggable={false}
          onLoad={(event) => void recognize(event.currentTarget)}
        />
        {lines.length > 0 && (
          <SelectableTextLayer lines={lines} label={`${name} recognized selectable text`} />
        )}
      </div>
      {(recognizing || recognized || error) && (
        <div className={`ocr-preview-status${error ? ' is-error' : ''}`} aria-live="polite">
          {recognizing && <span>{progressLabel(progress)}</span>}
          {!recognizing && recognized && (
            <span>{lines.length === 0 ? 'No text found' : `Drag to select · ${lines.length} text lines`}</span>
          )}
          {!recognizing && error && (
            <>
              <span title={error}>Text selection unavailable</span>
              <Button type="button" variant="outline" size="sm" onClick={() => setRetryCount((count) => count + 1)}>
                <RotateCcw />
                Retry
              </Button>
            </>
          )}
        </div>
      )}
    </div>
  )
}
