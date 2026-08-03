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
  PdfPreview: ({ compact, name, data }: { compact?: boolean; name: string; data: Blob }) => compact
    ? <canvas data-testid="pdf-thumbnail" data-preview-bytes={data.size} />
    : <div aria-label={`${name} PDF viewer`} data-preview-bytes={data.size}>Rendered PDF page</div>,
}))

const descriptor: FileDescriptor = {
  fileId: '00000000-0000-4000-8000-000000000001',
  name: 'evidence.txt',
  mimeType: 'text/plain',
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

  it('shows a real PDF thumbnail and opens the responsive PDF viewer', async () => {
    vi.mocked(downloadDecryptedFile).mockResolvedValue(new Blob(['pdf'], { type: 'application/pdf' }))
    const user = userEvent.setup()
    render(
      <Attachment
        descriptor={{ ...descriptor, name: 'document.pdf', mimeType: 'application/pdf' }}
        credentials={credentials}
      />,
    )
    expect(await screen.findByTestId('pdf-thumbnail')).toHaveAttribute('data-preview-bytes', '3')
    expect(await screen.findByTestId('pdf-thumbnail')).toBeInTheDocument()
    const trigger = screen.getByRole('button', { name: 'Open document.pdf preview' })
    await waitFor(() => expect(trigger).toBeEnabled())
    await user.click(trigger)

    expect(screen.getByLabelText('document.pdf PDF viewer')).toHaveAttribute('data-preview-bytes', '3')
    expect(screen.getByLabelText('document.pdf PDF viewer')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Open in new tab' })).toHaveAttribute('href', 'blob:test')
  })

  it('opens image previews from the compact tile and releases the blob on unmount', async () => {
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
    const trigger = screen.getByRole('button', { name: 'Open diagram.png preview' })
    await waitFor(() => expect(trigger).toBeEnabled())
    await user.click(trigger)

    expect(await screen.findByRole('dialog', { name: 'diagram.png' })).toBeInTheDocument()
    expect(screen.getByRole('img', { name: 'diagram.png' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Open full size' })).toHaveAttribute('href', 'blob:test')
    await user.click(screen.getByRole('button', { name: 'Close' }))
    expect(screen.queryByRole('dialog', { name: 'diagram.png' })).not.toBeInTheDocument()
    rendered.unmount()
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:test')
  })
})