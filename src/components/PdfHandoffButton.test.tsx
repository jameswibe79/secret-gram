import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { handoffPdfToHeron } from '../lib/pdf-handoff'
import { PdfHandoffButton } from './PdfHandoffButton'

vi.mock('../lib/pdf-handoff', () => ({
  handoffPdfToHeron: vi.fn(),
}))

describe('PdfHandoffButton', () => {
  beforeEach(() => {
    vi.mocked(handoffPdfToHeron).mockReset()
    vi.mocked(handoffPdfToHeron).mockResolvedValue()
  })

  it('requires explicit confirmation before handing decrypted PDF bytes to Heron Tools', async () => {
    const user = userEvent.setup()
    const data = new Blob(['pdf'], { type: 'application/pdf' })
    render(<PdfHandoffButton data={data} name="crooked-scan.pdf" />)

    await user.click(screen.getByRole('button', { name: 'Adjust scan' }))
    expect(screen.getByRole('dialog', { name: 'Adjust scanned PDF in Heron Tools' })).toBeInTheDocument()
    expect(screen.getByText('This sends decrypted content to another website.')).toBeInTheDocument()
    expect(handoffPdfToHeron).not.toHaveBeenCalled()

    await user.click(screen.getByRole('button', { name: 'Send to Heron Tools' }))

    expect(handoffPdfToHeron).toHaveBeenCalledTimes(1)
    expect(handoffPdfToHeron).toHaveBeenCalledWith({
      data,
      name: 'crooked-scan.pdf',
      signal: expect.any(AbortSignal),
    })
    expect(await screen.findByText('Sent to Heron Tools')).toBeInTheDocument()
  })
})
