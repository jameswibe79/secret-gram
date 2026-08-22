import { useEffect, useRef, useState } from 'react'

import type { OcrLine } from '../lib/ocr-types'

interface SelectableTextLayerProps {
  lines: OcrLine[]
  label: string
}

function estimatedTextUnits(text: string): number {
  let units = 0
  for (const character of text) {
    if (/\s/u.test(character)) units += 0.35
    else if (/\p{Script=Han}|\p{Script=Hiragana}|\p{Script=Katakana}/u.test(character)) units += 1
    else units += 0.58
  }
  return Math.max(1, units)
}

export function SelectableTextLayer({ lines, label }: SelectableTextLayerProps) {
  const layerRef = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState({ width: 0, height: 0 })

  useEffect(() => {
    const layer = layerRef.current
    if (layer === null) return
    const updateSize = () => {
      const next = { width: layer.clientWidth, height: layer.clientHeight }
      setSize((current) => current.width === next.width && current.height === next.height
        ? current
        : next)
    }
    updateSize()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(updateSize)
    observer.observe(layer)
    return () => observer.disconnect()
  }, [])

  return (
    <div ref={layerRef} className="selectable-text-layer" aria-label={label}>
      {lines.map((line, index) => {
        const fontSize = Math.max(4, line.box.height * size.height * 0.9)
        const targetWidth = line.box.width * size.width
        const naturalWidth = estimatedTextUnits(line.text) * fontSize
        const scaleX = naturalWidth === 0 ? 1 : Math.max(0.2, Math.min(5, targetWidth / naturalWidth))
        return (
          <span
            key={`${index}-${line.text}`}
            className="selectable-text-line"
            data-confidence={line.confidence.toFixed(2)}
            style={{
              left: `${line.box.x * 100}%`,
              top: `${line.box.y * 100}%`,
              width: `${line.box.width * 100}%`,
              height: `${line.box.height * 100}%`,
              fontSize: `${fontSize}px`,
              transform: `scaleX(${scaleX})`,
            }}
          >
            {line.text}
          </span>
        )
      })}
    </div>
  )
}
