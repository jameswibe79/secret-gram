import { useEffect, useRef, useState } from 'react'

import type {
  WordPreviewWorkerRequest,
  WordPreviewWorkerResponse,
} from '../lib/word-preview'

interface WordPreviewProps {
  data: Blob
  name: string
  compact?: boolean
}

interface SanitizeLimit {
  nodes: number
  textCharacters: number
  truncated: boolean
}

const SAFE_ELEMENTS: Record<string, true> = {
  blockquote: true,
  br: true,
  code: true,
  dd: true,
  div: true,
  dl: true,
  dt: true,
  em: true,
  figcaption: true,
  figure: true,
  h1: true,
  h2: true,
  h3: true,
  h4: true,
  h5: true,
  h6: true,
  hr: true,
  img: true,
  li: true,
  ol: true,
  p: true,
  pre: true,
  s: true,
  strong: true,
  sub: true,
  sup: true,
  table: true,
  tbody: true,
  td: true,
  tfoot: true,
  th: true,
  thead: true,
  tr: true,
  u: true,
  ul: true,
}
const DROP_WITH_CONTENT: Record<string, true> = {
  audio: true,
  button: true,
  embed: true,
  form: true,
  iframe: true,
  input: true,
  math: true,
  object: true,
  script: true,
  source: true,
  style: true,
  svg: true,
  video: true,
}
const SAFE_IMAGE_SOURCE = /^data:image\/(?:gif|jpeg|png|webp);base64,[a-z0-9+/=]+$/i
const SAFE_FRAGMENT = /^#[a-z][\w:.-]{0,127}$/i
const SAFE_ID = /^[a-z][\w:.-]{0,127}$/i
const MAX_IMAGE_SOURCE_CHARACTERS = 24 * 1024 * 1024
const conversions = new WeakMap<Blob, Promise<string>>()

function convertWordDocument(data: Blob): Promise<string> {
  const existing = conversions.get(data)
  if (existing) return existing

  const conversion = new Promise<string>((resolve, reject) => {
    const worker = new Worker(new URL('../workers/word-preview.worker.ts', import.meta.url), {
      type: 'module',
    })
    let settled = false

    function finish(action: () => void) {
      if (settled) return
      settled = true
      worker.terminate()
      action()
    }

    worker.onmessage = (event: MessageEvent<WordPreviewWorkerResponse>) => {
      if (event.data.type === 'ready') {
        const { html } = event.data
        finish(() => resolve(html))
      } else {
        finish(() => reject(new Error('Word preview failed')))
      }
    }
    worker.onerror = () => finish(() => reject(new Error('Word preview worker failed')))

    void data.arrayBuffer().then((arrayBuffer) => {
      if (settled) return
      const request: WordPreviewWorkerRequest = { arrayBuffer }
      worker.postMessage(request, [arrayBuffer])
    }).catch(() => finish(() => reject(new Error('Word document could not be read'))))
  })

  conversions.set(data, conversion)
  void conversion.catch(() => conversions.delete(data))
  return conversion
}

function copySafeAttributes(source: Element, target: HTMLElement) {
  const id = source.getAttribute('id')
  if (id && SAFE_ID.test(id)) target.id = id

  const direction = source.getAttribute('dir')
  if (direction === 'ltr' || direction === 'rtl' || direction === 'auto') {
    target.dir = direction
  }

  if (target instanceof HTMLTableCellElement) {
    const columnSpan = Number.parseInt(source.getAttribute('colspan') ?? '', 10)
    const rowSpan = Number.parseInt(source.getAttribute('rowspan') ?? '', 10)
    if (columnSpan >= 1 && columnSpan <= 100) target.colSpan = columnSpan
    if (rowSpan >= 1 && rowSpan <= 100) target.rowSpan = rowSpan
  }
}

function copySafeNode(source: Node, document: Document, limit: SanitizeLimit): Node | null {
  if (limit.nodes <= 0 || limit.textCharacters <= 0) {
    limit.truncated = true
    return null
  }

  if (source.nodeType === Node.TEXT_NODE) {
    const text = source.textContent ?? ''
    const copied = text.slice(0, limit.textCharacters)
    limit.textCharacters -= copied.length
    if (copied.length !== text.length) limit.truncated = true
    return document.createTextNode(copied)
  }
  if (source.nodeType !== Node.ELEMENT_NODE) return null

  const sourceElement = source as Element
  const tagName = sourceElement.tagName.toLowerCase()
  if (DROP_WITH_CONTENT[tagName] === true) return null

  if (tagName === 'a') {
    const href = sourceElement.getAttribute('href') ?? ''
    const target = document.createElement(SAFE_FRAGMENT.test(href) ? 'a' : 'span')
    if (target instanceof HTMLAnchorElement) target.href = href
    limit.nodes -= 1
    for (const child of sourceElement.childNodes) {
      const safeChild = copySafeNode(child, document, limit)
      if (safeChild) target.append(safeChild)
    }
    return target
  }

  if (tagName === 'img') {
    const sourceUrl = sourceElement.getAttribute('src') ?? ''
    const alt = (sourceElement.getAttribute('alt') ?? '').slice(0, 500)
    if (
      sourceUrl.length > MAX_IMAGE_SOURCE_CHARACTERS ||
      !SAFE_IMAGE_SOURCE.test(sourceUrl)
    ) {
      return alt ? document.createTextNode(`[Image: ${alt}]`) : null
    }
    const image = document.createElement('img')
    image.src = sourceUrl
    image.alt = alt
    image.loading = 'lazy'
    image.decoding = 'async'
    limit.nodes -= 1
    return image
  }

  const outputTag = SAFE_ELEMENTS[tagName] === true ? tagName : 'span'
  const target = document.createElement(outputTag)
  copySafeAttributes(sourceElement, target)
  limit.nodes -= 1
  for (const child of sourceElement.childNodes) {
    const safeChild = copySafeNode(child, document, limit)
    if (safeChild) target.append(safeChild)
  }
  return target
}

function renderSafeDocument(container: HTMLElement, html: string, compact: boolean) {
  const parsed = new DOMParser().parseFromString(html, 'text/html')
  const fragment = document.createDocumentFragment()
  const limit: SanitizeLimit = {
    nodes: compact ? 220 : 20_000,
    textCharacters: compact ? 1_800 : 2_000_000,
    truncated: false,
  }

  for (const child of parsed.body.childNodes) {
    const safeChild = copySafeNode(child, document, limit)
    if (safeChild) fragment.append(safeChild)
  }
  if (limit.truncated && !compact) {
    const notice = document.createElement('p')
    notice.className = 'word-preview-truncated'
    notice.textContent = 'Preview truncated to protect browser memory. Download the document to read it in full.'
    fragment.append(notice)
  }
  if (!fragment.hasChildNodes()) {
    const empty = document.createElement('p')
    empty.textContent = 'This document has no previewable content.'
    fragment.append(empty)
  }
  container.replaceChildren(fragment)
}

export function WordPreview({ data, name, compact = false }: WordPreviewProps) {
  const [html, setHtml] = useState<string | null>(null)
  const [error, setError] = useState(false)
  const contentRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    let active = true
    setHtml(null)
    setError(false)
    void convertWordDocument(data).then((result) => {
      if (active) setHtml(result)
    }).catch(() => {
      if (active) setError(true)
    })
    return () => {
      active = false
    }
  }, [data])

  useEffect(() => {
    if (html === null || contentRef.current === null) return
    renderSafeDocument(contentRef.current, html, compact)
  }, [compact, html])

  return (
    <section
      className={`word-document-preview${compact ? ' compact' : ''}`}
      aria-label={`${name} Word preview`}
    >
      {html === null && !error && (
        <div className="word-preview-message" aria-live="polite">
          <strong>Rendering Word document</strong>
          {!compact && <span>Formatting is being reconstructed locally in this browser.</span>}
        </div>
      )}
      {error && (
        <div className="word-preview-message is-error" role="alert">
          <strong>Word preview unavailable</strong>
          {!compact && <span>The document is unsupported, damaged, or exceeds safe preview limits.</span>}
        </div>
      )}
      {html !== null && (
        <div className="word-document-page" ref={contentRef} tabIndex={compact ? undefined : 0} />
      )}
    </section>
  )
}
