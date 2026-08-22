import { useEffect, useLayoutEffect, useRef, useState } from 'react'

import type { OcrLine } from '../lib/ocr-types'

interface SelectableTextLayerProps {
  lines: OcrLine[]
  label: string
}

export function SelectableTextLayer({ lines, label }: SelectableTextLayerProps) {
  const layerRef = useRef<HTMLDivElement>(null)
  const lineRefs = useRef<Array<HTMLSpanElement | null>>([])
  const [size, setSize] = useState({ width: 0, height: 0 })
  const [horizontalScales, setHorizontalScales] = useState<number[]>([])

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

  useLayoutEffect(() => {
    if (size.width === 0 || size.height === 0) return
    const nextScales = lines.map((line, index) => {
      const naturalWidth = lineRefs.current[index]?.scrollWidth ?? 0
      if (naturalWidth === 0) return 1
      const targetWidth = line.box.width * size.width
      return Math.max(0.2, Math.min(5, targetWidth / naturalWidth))
    })
    setHorizontalScales((current) => (
      current.length === nextScales.length && current.every((value, index) => (
        Math.abs(value - nextScales[index]) < 0.001
      ))
        ? current
        : nextScales
    ))
  }, [lines, size])

  return (
    <div ref={layerRef} className="selectable-text-layer" aria-label={label}>
      {lines.map((line, index) => {
        const fontSize = Math.max(4, line.box.height * size.height)
        return (
          <div
            key={`${index}-${line.text}`}
            className="selectable-text-line-box"
            style={{
              left: `${line.box.x * 100}%`,
              top: `${line.box.y * 100}%`,
              width: `${line.box.width * 100}%`,
              height: `${line.box.height * 100}%`,
            }}
          >
            <span
              ref={(element) => {
                lineRefs.current[index] = element
              }}
              className="selectable-text-line"
              data-confidence={line.confidence.toFixed(2)}
              style={{
                fontSize: `${fontSize}px`,
                transform: `scaleX(${horizontalScales[index] ?? 1})`,
              }}
            >
              {line.text}
            </span>
          </div>
        )
      })}
    </div>
  )
}
