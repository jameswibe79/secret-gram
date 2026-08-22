import { render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { SelectableTextLayer } from './SelectableTextLayer'

describe('SelectableTextLayer', () => {
  beforeEach(() => {
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(function (this: HTMLElement) {
      return this.classList.contains('selectable-text-layer') ? 1000 : 0
    })
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(function (this: HTMLElement) {
      return this.classList.contains('selectable-text-layer') ? 500 : 0
    })
    vi.spyOn(HTMLElement.prototype, 'scrollWidth', 'get').mockImplementation(function (this: HTMLElement) {
      return this.classList.contains('selectable-text-line') ? 200 : 0
    })
  })

  it('uses tight OCR bounds and measured font width for selection geometry', async () => {
    render(
      <SelectableTextLayer
        label="recognized text"
        lines={[{
          text: '室内装修工程',
          confidence: 0.96,
          box: { x: 0.1, y: 0.2, width: 0.4, height: 0.1 },
        }]}
      />,
    )

    const text = screen.getByText('室内装修工程')
    const box = text.closest('.selectable-text-line-box')
    expect(box).toHaveStyle({ left: '10%', top: '20%', width: '40%', height: '10%' })
    await waitFor(() => expect(text).toHaveStyle({ fontSize: '50px', transform: 'scaleX(2)' }))

    const range = document.createRange()
    range.selectNodeContents(text)
    const selection = window.getSelection()
    selection?.removeAllRanges()
    selection?.addRange(range)
    expect(selection?.toString()).toBe('室内装修工程')
  })
})
