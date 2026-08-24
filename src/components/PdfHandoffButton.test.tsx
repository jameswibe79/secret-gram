import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { handoffPdfToHeron } from '../lib/pdf-handoff'
import { PdfHandoffButton } from './PdfHandoffButton'
const toastMocks = vi.hoisted(() => ({
  success: vi.fn(),
  error: vi.fn(),
}))

vi.mock('sonner', () => ({ toast: toastMocks }))

vi.mock('../lib/pdf-handoff', () => ({
  handoffPdfToHeron: vi.fn(),
}))

describe('PdfHandoffButton', () => {
  beforeEach(() => {
    toastMocks.success.mockReset()
    toastMocks.error.mockReset()
    vi.mocked(handoffPdfToHeron).mockReset()
    vi.mocked(handoffPdfToHeron).mockResolvedValue()
  })

  it('requires explicit confirmation before handing decrypted PDF bytes to Heron Tools', async () => {
    const user = userEvent.setup()
    const data = new Blob(['pdf'], { type: 'application/pdf' })
    render(<PdfHandoffButton data={data} name="crooked-scan.pdf" tool="deskew" />)

    await user.click(screen.getByRole('button', { name: 'Adjust scan' }))
    expect(screen.getByRole('dialog', { name: 'Adjust scanned PDF in Heron Tools' })).toBeInTheDocument()
    expect(screen.getByText('This sends decrypted content to another website.')).toBeInTheDocument()
    expect(handoffPdfToHeron).not.toHaveBeenCalled()

    await user.click(screen.getByRole('button', { name: 'Send to Heron Tools' }))

    expect(handoffPdfToHeron).toHaveBeenCalledTimes(1)
    expect(handoffPdfToHeron).toHaveBeenCalledWith({
      data,
      name: 'crooked-scan.pdf',
      tool: 'deskew',
      signal: expect.any(AbortSignal),
    })
    await waitFor(() => expect(toastMocks.success).toHaveBeenCalledWith('PDF sent to Heron Tools'))
  })


  it('opens the dedicated PDF Workspace destination after confirmation', async () => {
    const user = userEvent.setup()
    const data = new Blob(['pdf'], { type: 'application/pdf' })
    render(<PdfHandoffButton data={data} name="pages.pdf" tool="workspace" />)

    await user.click(screen.getByRole('button', { name: 'PDF workspace' }))
    expect(screen.getByRole('dialog', { name: 'Open PDF Workspace in Heron Tools' })).toBeInTheDocument()
    expect(screen.getByText(/arrange, rotate, delete, and export pages/)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Send to Heron Tools' }))

    expect(handoffPdfToHeron).toHaveBeenCalledWith({
      data,
      name: 'pages.pdf',
      tool: 'workspace',
      signal: expect.any(AbortSignal),
    })
  })
  it('keeps the toolbar button footprint stable while the handoff is pending', async () => {
    const user = userEvent.setup()
    vi.mocked(handoffPdfToHeron).mockReturnValue(new Promise<void>(() => undefined))
    render(<PdfHandoffButton data={new Blob(['pdf'])} name="scan.pdf" tool="deskew" />)

    await user.click(screen.getByRole('button', { name: 'Adjust scan' }))
    await user.click(screen.getByRole('button', { name: 'Send to Heron Tools' }))

    expect(screen.getByRole('button', { name: 'Adjust scan' })).toBeDisabled()
    expect(screen.queryByText('Sending PDF…')).not.toBeInTheDocument()
    expect(document.querySelector('.pdf-handoff-control')).toBeNull()
  })
})
