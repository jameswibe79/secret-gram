import type { OcrBox } from './ocr-types'

const CJK_HORIZONTAL_PADDING = 0.04
const LATIN_HORIZONTAL_PADDING = 0.015
const VERTICAL_PADDING = 0.3

export interface OcrTextPixelBounds {
  textLeft: number
  textTop: number
  textRight: number
  textBottom: number
}

export function selectableOcrBox(
  bounds: OcrTextPixelBounds,
  imageWidth: number,
  imageHeight: number,
  text: string,
): OcrBox {
  const textWidth = bounds.textRight - bounds.textLeft + 1
  const textHeight = bounds.textBottom - bounds.textTop + 1
  const horizontalPadding = /\p{Script=Han}|\p{Script=Hiragana}|\p{Script=Katakana}/u.test(text)
    ? CJK_HORIZONTAL_PADDING
    : LATIN_HORIZONTAL_PADDING
  const paddingX = Math.max(1, Math.round(textWidth * horizontalPadding))
  const paddingY = Math.max(1, Math.round(textHeight * VERTICAL_PADDING))
  const left = Math.max(0, bounds.textLeft - paddingX)
  const top = Math.max(0, bounds.textTop - paddingY)
  const right = Math.min(imageWidth - 1, bounds.textRight + paddingX)
  const bottom = Math.min(imageHeight - 1, bounds.textBottom + paddingY)
  return {
    x: left / imageWidth,
    y: top / imageHeight,
    width: (right - left + 1) / imageWidth,
    height: (bottom - top + 1) / imageHeight,
  }
}
