import { render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { WordPreviewWorkerResponse } from '../lib/word-preview'
import { WordPreview } from './WordPreview'

let workerResponse: WordPreviewWorkerResponse

class PreviewWorker {
  onmessage: ((event: MessageEvent<WordPreviewWorkerResponse>) => void) | null = null
  onerror: (() => void) | null = null

  postMessage() {
    queueMicrotask(() => {
      this.onmessage?.(new MessageEvent('message', { data: workerResponse }))
    })
  }

  terminate() {}
}

beforeEach(() => {
  vi.stubGlobal('Worker', PreviewWorker)
})

describe('WordPreview', () => {
  it('renders semantic DOCX content without executable or remote markup', async () => {
    workerResponse = {
      type: 'ready',
      html: `
        <h1 id="plan">Launch plan</h1>
        <p onclick="alert('no')">Keep <strong>formatting</strong>.
          <a href="javascript:alert('no')">Unsafe link</a>
          <script>document.body.textContent = 'compromised'</script>
        </p>
        <img src="https://tracker.example/pixel" alt="Remote diagram">
        <img src="data:image/png;base64,AA==" alt="Embedded chart" onerror="alert('no')">
      `,
    }

    const { container } = render(
      <WordPreview data={new Blob(['docx'])} name="proposal.docx" />,
    )

    expect(await screen.findByRole('heading', { name: 'Launch plan' })).toBeInTheDocument()
    expect(screen.getByText('formatting')).toBeInTheDocument()
    expect(screen.getByText('Unsafe link').closest('a')).toBeNull()
    expect(screen.getByText('[Image: Remote diagram]')).toBeInTheDocument()
    expect(screen.getByRole('img', { name: 'Embedded chart' })).toHaveAttribute('src', 'data:image/png;base64,AA==')
    expect(container.querySelector('script')).toBeNull()
    expect(container.querySelector('[onclick], [onerror]')).toBeNull()
  })

  it('shows a fail-safe state when the local DOCX parser rejects a document', async () => {
    workerResponse = { type: 'error' }

    render(<WordPreview data={new Blob(['not a docx'])} name="broken.docx" />)

    expect(await screen.findByRole('alert')).toHaveTextContent('Word preview unavailable')
    expect(screen.getByText('The document is unsupported, damaged, or exceeds safe preview limits.')).toBeInTheDocument()
  })
})
