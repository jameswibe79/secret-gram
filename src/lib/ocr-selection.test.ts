import { describe, expect, it } from 'vitest'

import { selectableOcrBox } from './ocr-selection'

const bounds = {
  textLeft: 100,
  textTop: 50,
  textRight: 299,
  textBottom: 99,
}

describe('selectableOcrBox', () => {
  it('pads CJK glyph bounds enough to keep the first character under the pointer', () => {
    expect(selectableOcrBox(bounds, 1000, 500, '室内装修工程')).toEqual({
      x: 0.092,
      y: 0.07,
      width: 0.216,
      height: 0.16,
    })
  })

  it('uses narrower Latin padding so a narrow first glyph is not shifted left', () => {
    expect(selectableOcrBox(bounds, 1000, 500, 'Interior Renovation Project')).toEqual({
      x: 0.097,
      y: 0.07,
      width: 0.206,
      height: 0.16,
    })
  })
})
