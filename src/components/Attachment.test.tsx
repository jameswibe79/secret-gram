import { StrictMode } from 'react'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { downloadDecryptedFile } from '../lib/file-transfer'
import type { FileDescriptor } from '../shared/protocol'
import { Attachment } from './Attachment'

vi.mock('../lib/file-transfer', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/file-transfer')>()
  return { ...actual, downloadDecryptedFile: vi.fn() }
})

vi.mock('./PdfPreview', () => ({
  PdfPreview: ({ compact, name }: { compact?: boolean; name: string }) => compact
    ? <canvas aria-label={`${name} PDF thumbnail`} />
    : <section aria-label={`${name} PDF preview`}>Styled PDF reader</section>,
}))
vi.mock('./ImagePreview', () => ({
  ImagePreview: ({ name, url }: { name: string; url: string }) => (
    <div aria-label={`${name} selectable image preview`}>
      <img src={url} alt={name} />
      <span>{name} selectable text</span>
    </div>
  ),
}))
vi.mock('./VideoPreview', () => ({
  VideoPreview: ({ name, variant }: { name: string; variant: string }) => (
    <div aria-label={`${name} custom video preview`} data-variant={variant}>
      Styled video controls
    </div>
  ),
}))


const descriptor: FileDescriptor = {
  fileId: '00000000-0000-4000-8000-000000000001',
  name: 'evidence.txt',
  mimeType: 'application/octet-stream',
  size: 4,
  chunkSize: 4,
  chunkCount: 1,
  key: 'A'.repeat(43),
  noncePrefix: 'A'.repeat(11),
}

const credentials = {
  locator: 'A'.repeat(43),
  token: 'B'.repeat(43),
  deviceId: '00000000-0000-4000-8000-000000000002',
}

beforeEach(() => {
  vi.mocked(downloadDecryptedFile).mockReset()
  vi.stubGlobal('URL', {
    ...URL,
    createObjectURL: vi.fn(() => 'blob:test'),
    revokeObjectURL: vi.fn(),
  })
})

describe('Attachment lifecycle', () => {
  it('does not create an object URL after an in-flight download is unmounted', async () => {
    let resolveDownload!: (blob: Blob) => void
    vi.mocked(downloadDecryptedFile).mockImplementation(
      () => new Promise((resolve) => { resolveDownload = resolve }),
    )
    const user = userEvent.setup()
    const rendered = render(<Attachment descriptor={descriptor} credentials={credentials} />)

    await user.click(screen.getByRole('button', { name: 'Download' }))
    await waitFor(() => expect(downloadDecryptedFile).toHaveBeenCalledOnce())
    rendered.unmount()
    resolveDownload(new Blob(['test'], { type: 'text/plain' }))
    await Promise.resolve()
    await Promise.resolve()
    await waitFor(() => {
      expect(URL.createObjectURL).not.toHaveBeenCalled()
    })
  })

  it('promptly revokes a download-only object URL while the attachment remains mounted', async () => {
    vi.mocked(downloadDecryptedFile).mockResolvedValue(new Blob(['test'], { type: 'text/plain' }))
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined)
    const user = userEvent.setup()
    render(<Attachment descriptor={descriptor} credentials={credentials} />)

    await user.click(screen.getByRole('button', { name: 'Download' }))

    await waitFor(() => expect(URL.createObjectURL).toHaveBeenCalledOnce())
    await waitFor(() => expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:test'))
    expect(click).toHaveBeenCalledOnce()
    click.mockRestore()
  })

  it('opens a progress-focused preview immediately and supports cancellation', async () => {
    vi.mocked(downloadDecryptedFile).mockImplementation((_descriptor, _credentials, options) => {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          options?.signal?.addEventListener(
            'abort',
            () => controller.error(new DOMException('Operation canceled', 'AbortError')),
            { once: true },
          )
        },
      })
      return new Response(stream).blob()
    })
    const user = userEvent.setup()
    render(
      <Attachment
        descriptor={{ ...descriptor, name: 'diagram.png', mimeType: 'image/png', size: 9 * 1024 * 1024 }}
        credentials={credentials}
      />,
    )
    expect(downloadDecryptedFile).not.toHaveBeenCalled()

    await user.click(screen.getByRole('button', { name: 'Open diagram.png preview' }))
    expect(screen.getByRole('dialog', { name: 'diagram.png' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Preparing your preview' })).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Cancel preview' }))
    expect(await screen.findByRole('heading', { name: 'Preview could not be prepared' })).toBeInTheDocument()
    expect(URL.createObjectURL).not.toHaveBeenCalled()
  })

  it('shows escaped plain text inline and in the full browser-local viewer', async () => {
    const text = 'A quiet line from the meadow.\n<script>alert("not markup")</script>\n終わり'
    vi.mocked(downloadDecryptedFile).mockResolvedValue(new Blob([text], { type: 'text/plain' }))
    const user = userEvent.setup()
    render(
      <Attachment
        descriptor={{ ...descriptor, name: 'notes.txt', mimeType: 'text/plain', size: text.length }}
        credentials={credentials}
      />,
    )

    await waitFor(() => {
      expect(document.querySelector('.text-preview-snippet')).toHaveTextContent('A quiet line from the meadow.')
    })
    expect(document.querySelector('.text-preview-snippet script')).toBeNull()
    expect(downloadDecryptedFile).toHaveBeenCalled()

    await user.click(screen.getByRole('button', { name: 'Open notes.txt preview' }))
    expect(await screen.findByRole('dialog', { name: 'notes.txt' })).toBeInTheDocument()
    expect(screen.getByText('Plain-text preview')).toBeInTheDocument()
    expect(screen.getByLabelText('notes.txt text content')).toHaveTextContent('<script>alert("not markup")</script>')
    expect(screen.getByRole('link', { name: 'Open in new tab' })).toHaveAttribute('href', 'blob:test')
    expect(document.querySelector('.modal-text-preview script')).toBeNull()
  })

  it('renders selected plain-text files directly in the workspace viewer', async () => {
    const text = 'Shared workspace preview'
    vi.mocked(downloadDecryptedFile).mockResolvedValue(new Blob([text], { type: 'text/plain' }))

    render(
      <Attachment
        descriptor={{ ...descriptor, name: 'workspace.txt', mimeType: 'text/plain', size: text.length }}
        credentials={credentials}
        presentation="viewer"
      />,
    )

    expect(await screen.findByLabelText('workspace.txt text content')).toHaveTextContent(text)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Open separately' })).toHaveAttribute('href', 'blob:test')
    expect(screen.getByText('Preview decrypted only in this browser')).toBeInTheDocument()
  })

  it('keeps plain-text files over 1 MB download-only', () => {
    render(
      <Attachment
        descriptor={{
          ...descriptor,
          name: 'large.txt',
          mimeType: 'text/plain',
          size: 1024 * 1024 + 1,
        }}
        credentials={credentials}
      />,
    )

    expect(screen.getByText('Text previews are limited to 1 MB. Download this file to read it in full.')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Open large.txt preview' })).not.toBeInTheDocument()
    expect(downloadDecryptedFile).not.toHaveBeenCalled()
  })

  it('shows a local PDF thumbnail, styled reader, and browser OCR escape hatch', async () => {
    vi.mocked(downloadDecryptedFile).mockResolvedValue(new Blob(['pdf'], { type: 'application/pdf' }))
    const user = userEvent.setup()
    render(
      <Attachment
        descriptor={{ ...descriptor, name: 'document.pdf', mimeType: 'application/pdf' }}
        credentials={credentials}
      />,
    )

    expect(await screen.findByLabelText('document.pdf PDF thumbnail')).toBeInTheDocument()
    expect(downloadDecryptedFile).toHaveBeenCalled()
    await user.click(screen.getByRole('button', { name: 'Open document.pdf preview' }))

    expect(screen.getByLabelText('document.pdf PDF preview')).toHaveTextContent('Styled PDF reader')
    expect(screen.getByLabelText('document.pdf PDF thumbnail')).toBeInTheDocument()
    expect(screen.getByText('PDF preview · local reader')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Open in browser' })).toHaveAttribute('href', 'blob:test')
    expect(screen.getByRole('button', { name: 'Adjust scan' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'PDF workspace' })).toBeInTheDocument()
  })

  it('shows MP4 thumbnails and browser-local playback controls', async () => {
    vi.mocked(downloadDecryptedFile).mockResolvedValue(new Blob(['video'], { type: 'video/mp4' }))
    const user = userEvent.setup()
    const mp4Descriptor = {
      ...descriptor,
      name: 'recording.mp4',
      mimeType: 'video/mp4',
    }
    const rendered = render(<Attachment descriptor={mp4Descriptor} credentials={credentials} />)

    await waitFor(() => {
      expect(document.querySelector('.preview-thumb video')).toHaveAttribute('src', 'blob:test')
    })
    expect(document.querySelector('.preview-thumb video')).toHaveAttribute('preload', 'metadata')
    await user.click(screen.getByRole('button', { name: 'Open recording.mp4 preview' }))

    expect(screen.getByText('MP4 video preview')).toBeInTheDocument()
    expect(screen.getByLabelText('recording.mp4 custom video preview')).toHaveAttribute('data-variant', 'modal')
    rendered.unmount()

    render(
      <Attachment descriptor={mp4Descriptor} credentials={credentials} presentation="viewer" />,
    )
    expect(await screen.findByLabelText('recording.mp4 custom video preview')).toHaveAttribute('data-variant', 'viewer')
  })

  it('renders decrypted image thumbnails in resource-list presentation', async () => {
    vi.mocked(downloadDecryptedFile).mockResolvedValue(new Blob(['image'], { type: 'image/png' }))

    render(
      <Attachment
        descriptor={{ ...descriptor, name: 'photo.png', mimeType: 'image/png' }}
        credentials={credentials}
        presentation="thumbnail"
      />,
    )

    await waitFor(() => {
      expect(document.querySelector('.resource-file-thumbnail img')).toHaveAttribute('src', 'blob:test')
    })
    expect(downloadDecryptedFile).toHaveBeenCalledOnce()
  })

  it('shows automatic image previews, opens the full viewer, and releases the blob', async () => {
    vi.mocked(downloadDecryptedFile).mockResolvedValue(new Blob(['image'], { type: 'image/png' }))
    const user = userEvent.setup()

    const rendered = render(
      <StrictMode>
        <Attachment
          descriptor={{ ...descriptor, name: 'diagram.png', mimeType: 'image/png' }}
          credentials={credentials}
        />
      </StrictMode>,
    )

    await waitFor(() => {
      expect(document.querySelector('.preview-thumb img')).toHaveAttribute('src', 'blob:test')
    })
    expect(downloadDecryptedFile).toHaveBeenCalled()
    await user.click(screen.getByRole('button', { name: 'Open diagram.png preview' }))

    expect(await screen.findByRole('dialog', { name: 'diagram.png' })).toBeInTheDocument()
    expect(screen.getByRole('img', { name: 'diagram.png' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Open full size' })).toHaveAttribute('href', 'blob:test')
    await user.click(screen.getByRole('button', { name: 'Close' }))
    expect(screen.queryByRole('dialog', { name: 'diagram.png' })).not.toBeInTheDocument()
    rendered.unmount()
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:test')
  })
})