import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { recognizeImage } from '../lib/ocr-client'
import { ImagePreview } from './ImagePreview'

vi.mock('../lib/ocr-client', () => ({
  recognizeImage: vi.fn(),
}))

function loadedImage() {
  const image = screen.getByRole('img')
  Object.defineProperties(image, {
    naturalWidth: { value: 1200, configurable: true },
    naturalHeight: { value: 500, configurable: true },
    complete: { value: true, configurable: true },
  })
  return image
}

describe('ImagePreview', () => {
  beforeEach(() => {
    vi.mocked(recognizeImage).mockReset()
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
      drawImage: vi.fn(),
      getImageData: () => ({
        data: new Uint8ClampedArray(16),
        width: 2,
        height: 2,
      }),
    } as never)
  })

  it('renders recognized Chinese and English as a selectable overlay', async () => {
    vi.mocked(recognizeImage).mockResolvedValue({
      lines: [
        {
          text: '中文识别',
          confidence: 0.96,
          box: { x: 0.1, y: 0.1, width: 0.3, height: 0.1 },
        },
        {
          text: 'Selectable English',
          confidence: 0.94,
          box: { x: 0.1, y: 0.3, width: 0.5, height: 0.1 },
        },
      ],
    })
    render(<ImagePreview url="blob:image" name="scan.png" variant="viewer" />)
    fireEvent.load(loadedImage())

    expect(await screen.findByText('2 selectable text lines ready')).toBeInTheDocument()
    expect(screen.getByText('中文识别')).toHaveClass('selectable-text-line')
    expect(screen.getByText('Selectable English')).toHaveClass('selectable-text-line')
    expect(screen.getByLabelText('scan.png recognized selectable text')).toBeInTheDocument()
    expect(recognizeImage).toHaveBeenCalledTimes(1)
  })

  it('cancels local recognition when the preview unmounts', async () => {
    let recognitionSignal: AbortSignal | undefined
    const pending = new Promise<{ lines: [] }>(() => undefined)
    vi.mocked(recognizeImage).mockImplementation((_image, options) => {
      recognitionSignal = options?.signal
      return pending
    })
    const rendered = render(<ImagePreview url="blob:image" name="scan.png" variant="viewer" />)
    fireEvent.load(loadedImage())
    await waitFor(() => expect(recognizeImage).toHaveBeenCalledTimes(1))

    rendered.unmount()

    expect(recognitionSignal?.aborted).toBe(true)
  })
})
