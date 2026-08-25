import { useEffect, useRef, useState } from 'react'
import type { HElement, Options, WordDocument } from 'docx-preview'

import type {
  WordPreviewWorkerRequest,
  WordPreviewWorkerResponse,
} from '../lib/word-preview'

interface WordPreviewProps {
  data: Blob
  name: string
  compact?: boolean
}

type PreviewStatus = 'loading' | 'ready' | 'error'
interface DocxPreviewModule {
  defaultOptions: Options
  renderAsync(
    data: Blob,
    bodyContainer: HTMLElement,
    styleContainer?: HTMLElement,
    options?: Partial<Options>,
  ): Promise<WordDocument>
}

const SAFE_LINK_PROTOCOLS: Record<string, true> = {
  'http:': true,
  'https:': true,
}
const REMOTE_CSS_URL = /url\(\s*(['"]?)(?:(?:https?:)?\/\/|javascript:)[^)]*\)/gi
const validatedDocuments = new WeakMap<Blob, Promise<void>>()
let rendererPromise: Promise<DocxPreviewModule> | null = null

function validateWordDocument(data: Blob): Promise<void> {
  const existing = validatedDocuments.get(data)
  if (existing) return existing

  const validation = new Promise<void>((resolve, reject) => {
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
        finish(resolve)
      } else {
        finish(() => reject(new Error('Word preview validation failed')))
      }
    }
    worker.onerror = () => finish(() => reject(new Error('Word preview worker failed')))

    void data.arrayBuffer().then((arrayBuffer) => {
      if (settled) return
      const request: WordPreviewWorkerRequest = { arrayBuffer }
      worker.postMessage(request, [arrayBuffer])
    }).catch(() => finish(() => reject(new Error('Word document could not be read'))))
  })

  validatedDocuments.set(data, validation)
  void validation.catch(() => validatedDocuments.delete(data))
  return validation
}

function secureRenderedDocument(root: ShadowRoot) {
  root.querySelectorAll('iframe, object, embed, form, script').forEach((element) => element.remove())

  root.querySelectorAll('a').forEach((link) => {
    const href = link.getAttribute('href') ?? ''
    if (href.startsWith('#')) return

    try {
      const url = new URL(href)
      if (SAFE_LINK_PROTOCOLS[url.protocol] !== true) throw new Error('unsafe link')
      link.target = '_blank'
      link.rel = 'noopener noreferrer'
    } catch {
      link.removeAttribute('href')
      link.removeAttribute('target')
      link.removeAttribute('rel')
    }
  })

  root.querySelectorAll('img').forEach((image) => {
    const source = image.getAttribute('src') ?? ''
    if (source !== '' && !source.startsWith('data:image/')) image.removeAttribute('src')
    image.loading = 'lazy'
    image.decoding = 'async'
  })

  const canAdoptStyles = 'adoptedStyleSheets' in root &&
    typeof CSSStyleSheet !== 'undefined' &&
    typeof CSSStyleSheet.prototype.replaceSync === 'function'
  const styleSheets: CSSStyleSheet[] = []
  root.querySelectorAll('style').forEach((style) => {
    const css = (style.textContent ?? '').replace(REMOTE_CSS_URL, 'url("")')
    style.textContent = css
    if (!canAdoptStyles) return
    try {
      const styleSheet = new CSSStyleSheet()
      styleSheet.replaceSync(css)
      styleSheets.push(styleSheet)
      style.remove()
    } catch {
      // Keep the sanitized style element as a compatibility fallback.
    }
  })
  if (canAdoptStyles) root.adoptedStyleSheets = styleSheets
}

function safeElementFactory(renderer: DocxPreviewModule) {
  return (element: HElement | Node | string): Node => {
    const node = renderer.defaultOptions.h(element)
    if (node instanceof HTMLIFrameElement) return document.createComment('DOCX altChunk removed')
    if (node instanceof HTMLAnchorElement) {
      const href = node.getAttribute('href') ?? ''
      if (href !== '' && !href.startsWith('#')) {
        try {
          const url = new URL(href)
          if (SAFE_LINK_PROTOCOLS[url.protocol] !== true) throw new Error('unsafe link')
          node.target = '_blank'
          node.rel = 'noopener noreferrer'
        } catch {
          node.removeAttribute('href')
        }
      }
    }
    return node
  }
}

export function WordPreview({ data, name, compact = false }: WordPreviewProps) {
  const [status, setStatus] = useState<PreviewStatus>('loading')
  const surfaceRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (compact) return
    const surface = surfaceRef.current
    if (surface === null) return

    let active = true
    setStatus('loading')
    const shadowRoot = surface.shadowRoot ?? surface.attachShadow({ mode: 'open' })
    if ('adoptedStyleSheets' in shadowRoot) shadowRoot.adoptedStyleSheets = []
    const styleContainer = document.createElement('div')
    const bodyContainer = document.createElement('div')
    shadowRoot.replaceChildren(styleContainer, bodyContainer)

    void (async () => {
      try {
        await validateWordDocument(data)
        if (!active) return
        rendererPromise ??= import('docx-preview')
        const renderer = await rendererPromise
        if (!active) return

        await renderer.renderAsync(data, bodyContainer, styleContainer, {
          breakPages: true,
          className: 'word-docx',
          experimental: true,
          h: safeElementFactory(renderer),
          hideWrapperOnPrint: true,
          ignoreFonts: false,
          ignoreHeight: false,
          ignoreLastRenderedPageBreak: false,
          ignoreWidth: false,
          inWrapper: true,
          renderAltChunks: false,
          renderChanges: false,
          renderComments: false,
          renderEndnotes: true,
          renderFooters: true,
          renderFootnotes: true,
          renderHeaders: true,
          trimXmlDeclaration: true,
          useBase64URL: true,
        })
        if (!active) return
        secureRenderedDocument(shadowRoot)
        setStatus('ready')
      } catch {
        if (active) setStatus('error')
      }
    })()

    return () => {
      active = false
      shadowRoot.replaceChildren()
      if ('adoptedStyleSheets' in shadowRoot) shadowRoot.adoptedStyleSheets = []
    }
  }, [compact, data])

  if (compact) {
    return (
      <section className="word-document-preview compact" aria-label={`${name} Word thumbnail`}>
        <span className="word-preview-compact-page" aria-hidden="true">
          <strong>DOCX</strong>
          <i />
          <i />
          <i />
        </span>
      </section>
    )
  }

  return (
    <section className="word-document-preview" aria-label={`${name} Word preview`}>
      {status === 'loading' && (
        <div className="word-preview-message" aria-live="polite">
          <strong>Reconstructing Word layout</strong>
          <span>Pages, typography, spacing, tables, and embedded media stay on this device.</span>
        </div>
      )}
      {status === 'error' && (
        <div className="word-preview-message is-error" role="alert">
          <strong>Word preview unavailable</strong>
          <span>The document is unsupported, damaged, or exceeds safe preview limits.</span>
        </div>
      )}
      <div
        ref={surfaceRef}
        className="word-document-surface"
        hidden={status !== 'ready'}
        tabIndex={status === 'ready' ? 0 : undefined}
      />
    </section>
  )
}
