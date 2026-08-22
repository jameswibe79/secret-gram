import * as ort from 'onnxruntime-web/wasm'

import { selectableOcrBox } from '../lib/ocr-selection'
import type {
  OcrImagePayload,
  OcrLine,
  OcrProgress,
  OcrWorkerRequest,
  OcrWorkerResponse,
} from '../lib/ocr-types'

const DETECTION_MODEL_URL = '/ocr/ppocrv5-mobile-det.onnx'
const RECOGNITION_MODEL_URL = '/ocr/ppocrv5-mobile-rec.onnx'
const DICTIONARY_URL = '/ocr/ppocrv5-mobile-dict.txt'
const DETECTION_LONG_SIDE = 960
const DETECTION_THRESHOLD = 0.3
const DETECTION_BOX_THRESHOLD = 0.6
const RECOGNITION_HEIGHT = 48
const RECOGNITION_MIN_WIDTH = 160
const MAX_INPUT_PIXELS = 4_000_000
const MAX_DETECTED_LINES = 200
const RECOGNITION_MAX_WIDTH = 960

interface RawImage {
  data: Uint8ClampedArray
  width: number
  height: number
}

interface PixelBox {
  left: number
  top: number
  right: number
  bottom: number
  textLeft: number
  textTop: number
  textRight: number
  textBottom: number
  score: number
}

interface OcrModels {
  detection: ort.InferenceSession
  recognition: ort.InferenceSession
  characters: string[]
}

const workerScope = self as unknown as {
  onmessage: ((event: MessageEvent<OcrWorkerRequest>) => void) | null
  postMessage(message: OcrWorkerResponse): void
}
const canceledRequests = new Set<number>()
let modelsPromise: Promise<OcrModels> | null = null
let workQueue = Promise.resolve()

ort.env.wasm.numThreads = 1
ort.env.wasm.proxy = false

function post(message: OcrWorkerResponse) {
  workerScope.postMessage(message)
}

function progress(id: number, value: OcrProgress) {
  post({ type: 'progress', id, progress: value })
}

function assertActive(id: number) {
  if (canceledRequests.has(id)) throw new DOMException('OCR canceled', 'AbortError')
}

async function loadModels(id: number): Promise<OcrModels> {
  progress(id, { stage: 'loading-models', completed: 0, total: 1 })
  modelsPromise ??= Promise.all([
    ort.InferenceSession.create(DETECTION_MODEL_URL, {
      executionProviders: ['wasm'],
      graphOptimizationLevel: 'all',
    }),
    ort.InferenceSession.create(RECOGNITION_MODEL_URL, {
      executionProviders: ['wasm'],
      graphOptimizationLevel: 'all',
    }),
    fetch(DICTIONARY_URL).then(async (response) => {
      if (!response.ok) throw new Error('OCR dictionary could not be loaded')
      const lines = (await response.text()).split('\n')
      if (lines.at(-1) === '') lines.pop()
      return [...lines.map((line) => line.replace(/\r$/, '')), ' ']
    }),
  ]).then(([detection, recognition, characters]) => ({
    detection,
    recognition,
    characters,
  }))
  try {
    const models = await modelsPromise
    progress(id, { stage: 'loading-models', completed: 1, total: 1 })
    return models
  } catch (error) {
    modelsPromise = null
    throw error
  }
}

function alignedDetectionSize(width: number, height: number) {
  const scale = Math.min(1, DETECTION_LONG_SIDE / Math.max(width, height))
  return {
    width: Math.max(32, Math.round((width * scale) / 32) * 32),
    height: Math.max(32, Math.round((height * scale) / 32) * 32),
  }
}

function resizeRgba(source: RawImage, targetWidth: number, targetHeight: number): RawImage {
  if (source.width === targetWidth && source.height === targetHeight) return source
  const output = new Uint8ClampedArray(targetWidth * targetHeight * 4)
  const xScale = source.width / targetWidth
  const yScale = source.height / targetHeight

  for (let y = 0; y < targetHeight; y += 1) {
    const sourceY = Math.min(source.height - 1, (y + 0.5) * yScale - 0.5)
    const y0 = Math.max(0, Math.floor(sourceY))
    const y1 = Math.min(source.height - 1, y0 + 1)
    const yWeight = sourceY - y0
    for (let x = 0; x < targetWidth; x += 1) {
      const sourceX = Math.min(source.width - 1, (x + 0.5) * xScale - 0.5)
      const x0 = Math.max(0, Math.floor(sourceX))
      const x1 = Math.min(source.width - 1, x0 + 1)
      const xWeight = sourceX - x0
      const targetIndex = (y * targetWidth + x) * 4
      for (let channel = 0; channel < 4; channel += 1) {
        const topLeft = source.data[(y0 * source.width + x0) * 4 + channel]
        const topRight = source.data[(y0 * source.width + x1) * 4 + channel]
        const bottomLeft = source.data[(y1 * source.width + x0) * 4 + channel]
        const bottomRight = source.data[(y1 * source.width + x1) * 4 + channel]
        const top = topLeft + (topRight - topLeft) * xWeight
        const bottom = bottomLeft + (bottomRight - bottomLeft) * xWeight
        output[targetIndex + channel] = top + (bottom - top) * yWeight
      }
    }
  }
  return { data: output, width: targetWidth, height: targetHeight }
}

function detectionTensor(image: RawImage): ort.Tensor {
  const planeSize = image.width * image.height
  const input = new Float32Array(planeSize * 3)
  const means = [0.485, 0.456, 0.406]
  const deviations = [0.229, 0.224, 0.225]
  for (let pixel = 0; pixel < planeSize; pixel += 1) {
    const source = pixel * 4
    const red = image.data[source] / 255
    const green = image.data[source + 1] / 255
    const blue = image.data[source + 2] / 255
    input[pixel] = (blue - means[0]) / deviations[0]
    input[planeSize + pixel] = (green - means[1]) / deviations[1]
    input[planeSize * 2 + pixel] = (red - means[2]) / deviations[2]
  }
  return new ort.Tensor('float32', input, [1, 3, image.height, image.width])
}

function detectComponents(probabilities: Float32Array, width: number, height: number): PixelBox[] {
  const mask = new Uint8Array(width * height)
  for (let index = 0; index < probabilities.length; index += 1) {
    if (probabilities[index] <= DETECTION_THRESHOLD) continue
    const x = index % width
    const y = Math.floor(index / width)
    for (let offsetY = -1; offsetY <= 1; offsetY += 1) {
      const nextY = y + offsetY
      if (nextY < 0 || nextY >= height) continue
      for (let offsetX = -1; offsetX <= 1; offsetX += 1) {
        const nextX = x + offsetX
        if (nextX >= 0 && nextX < width) mask[nextY * width + nextX] = 1
      }
    }
  }

  const queue = new Int32Array(width * height)
  const boxes: PixelBox[] = []
  const minimumPixels = Math.max(12, Math.floor(width * height * 0.000015))
  for (let start = 0; start < mask.length; start += 1) {
    if (mask[start] === 0) continue
    mask[start] = 0
    let head = 0
    let tail = 1
    queue[0] = start
    let left = start % width
    let right = left
    let top = Math.floor(start / width)
    let bottom = top
    let strongPixels = 0
    let scoreTotal = 0

    while (head < tail) {
      const index = queue[head]
      head += 1
      const x = index % width
      const y = Math.floor(index / width)
      left = Math.min(left, x)
      right = Math.max(right, x)
      top = Math.min(top, y)
      bottom = Math.max(bottom, y)
      if (probabilities[index] > DETECTION_THRESHOLD) {
        strongPixels += 1
        scoreTotal += probabilities[index]
      }
      for (let offsetY = -1; offsetY <= 1; offsetY += 1) {
        const nextY = y + offsetY
        if (nextY < 0 || nextY >= height) continue
        for (let offsetX = -1; offsetX <= 1; offsetX += 1) {
          const nextX = x + offsetX
          if (nextX < 0 || nextX >= width) continue
          const next = nextY * width + nextX
          if (mask[next] === 0) continue
          mask[next] = 0
          queue[tail] = next
          tail += 1
        }
      }
    }

    const score = strongPixels === 0 ? 0 : scoreTotal / strongPixels
    if (strongPixels < minimumPixels || score < DETECTION_BOX_THRESHOLD) continue
    const boxWidth = right - left + 1
    const boxHeight = bottom - top + 1
    if (boxWidth < 4 || boxHeight < 4) continue
    const expandX = Math.max(2, Math.round(boxWidth * 0.08))
    const expandY = Math.max(2, Math.round(boxHeight * 0.14))
    boxes.push({
      left: Math.max(0, left - expandX),
      top: Math.max(0, top - expandY),
      right: Math.min(width - 1, right + expandX),
      bottom: Math.min(height - 1, bottom + expandY),
      textLeft: left,
      textTop: top,
      textRight: right,
      textBottom: bottom,
      score,
    })
  }
  return mergeLineBoxes(boxes).slice(0, MAX_DETECTED_LINES)
}

function verticalOverlap(first: PixelBox, second: PixelBox): number {
  const overlap = Math.max(0, Math.min(first.bottom, second.bottom) - Math.max(first.top, second.top))
  const height = Math.min(first.bottom - first.top, second.bottom - second.top)
  return height <= 0 ? 0 : overlap / height
}

function mergeLineBoxes(boxes: PixelBox[]): PixelBox[] {
  const sorted = [...boxes].sort((first, second) => first.top - second.top || first.left - second.left)
  const merged: PixelBox[] = []
  for (const box of sorted) {
    const candidate = merged.findLast((line) => {
      const lineHeight = line.bottom - line.top + 1
      const boxHeight = box.bottom - box.top + 1
      const gap = box.left > line.right ? box.left - line.right : line.left - box.right
      return verticalOverlap(line, box) >= 0.55 && gap <= Math.max(20, lineHeight, boxHeight)
    })
    if (candidate === undefined) {
      merged.push({ ...box })
      continue
    }
    const firstArea = (candidate.right - candidate.left + 1) * (candidate.bottom - candidate.top + 1)
    const secondArea = (box.right - box.left + 1) * (box.bottom - box.top + 1)
    candidate.left = Math.min(candidate.left, box.left)
    candidate.top = Math.min(candidate.top, box.top)
    candidate.right = Math.max(candidate.right, box.right)
    candidate.bottom = Math.max(candidate.bottom, box.bottom)
    candidate.textLeft = Math.min(candidate.textLeft, box.textLeft)
    candidate.textTop = Math.min(candidate.textTop, box.textTop)
    candidate.textRight = Math.max(candidate.textRight, box.textRight)
    candidate.textBottom = Math.max(candidate.textBottom, box.textBottom)
    candidate.score = (candidate.score * firstArea + box.score * secondArea) / (firstArea + secondArea)
  }
  return merged.sort((first, second) => {
    const firstHeight = first.bottom - first.top + 1
    const secondHeight = second.bottom - second.top + 1
    const sameLine = Math.abs(first.top - second.top) <= Math.max(firstHeight, secondHeight) * 0.45
    return sameLine ? first.left - second.left : first.top - second.top
  })
}

function recognitionTensor(image: RawImage, box: PixelBox) {
  const sourceWidth = box.right - box.left + 1
  const sourceHeight = box.bottom - box.top + 1
  const requestedWidth = Math.ceil((sourceWidth / sourceHeight) * RECOGNITION_HEIGHT)
  const contentWidth = Math.max(8, Math.min(RECOGNITION_MAX_WIDTH, requestedWidth))
  const tensorWidth = Math.max(
    RECOGNITION_MIN_WIDTH,
    Math.min(RECOGNITION_MAX_WIDTH, Math.ceil(contentWidth / 8) * 8),
  )
  const planeSize = tensorWidth * RECOGNITION_HEIGHT
  const input = new Float32Array(planeSize * 3)

  for (let y = 0; y < RECOGNITION_HEIGHT; y += 1) {
    const sourceY = box.top + Math.min(sourceHeight - 1, Math.floor((y + 0.5) * sourceHeight / RECOGNITION_HEIGHT))
    for (let x = 0; x < contentWidth; x += 1) {
      const sourceX = box.left + Math.min(sourceWidth - 1, Math.floor((x + 0.5) * sourceWidth / contentWidth))
      const source = (sourceY * image.width + sourceX) * 4
      const target = y * tensorWidth + x
      input[target] = image.data[source + 2] / 127.5 - 1
      input[planeSize + target] = image.data[source + 1] / 127.5 - 1
      input[planeSize * 2 + target] = image.data[source] / 127.5 - 1
    }
  }
  return new ort.Tensor('float32', input, [1, 3, RECOGNITION_HEIGHT, tensorWidth])
}

function decodeRecognition(output: ort.Tensor, characters: string[]) {
  if (!(output.data instanceof Float32Array) || output.dims.length !== 3) {
    throw new Error('Unexpected OCR recognition output')
  }
  const steps = Number(output.dims[1])
  const classes = Number(output.dims[2])
  const text: string[] = []
  let previous = -1
  let confidenceTotal = 0
  let confidenceCount = 0

  for (let step = 0; step < steps; step += 1) {
    const offset = step * classes
    let bestIndex = 0
    let bestValue = Number.NEGATIVE_INFINITY
    for (let index = 0; index < classes; index += 1) {
      const value = output.data[offset + index]
      if (value > bestValue) {
        bestValue = value
        bestIndex = index
      }
    }
    if (bestIndex !== 0 && bestIndex !== previous) {
      const character = characters[bestIndex - 1]
      if (character !== undefined) text.push(character)
      confidenceTotal += Math.max(0, Math.min(1, bestValue))
      confidenceCount += 1
    }
    previous = bestIndex
  }
  return {
    text: text.join('').trim(),
    confidence: confidenceCount === 0 ? 0 : confidenceTotal / confidenceCount,
  }
}


async function recognize(id: number, payload: OcrImagePayload) {
  assertActive(id)
  if (
    !Number.isInteger(payload.width) ||
    !Number.isInteger(payload.height) ||
    payload.width <= 0 ||
    payload.height <= 0 ||
    payload.width * payload.height > MAX_INPUT_PIXELS ||
    payload.data.byteLength !== payload.width * payload.height * 4
  ) {
    throw new Error('OCR image dimensions are invalid')
  }
  const models = await loadModels(id)
  assertActive(id)
  const original: RawImage = {
    data: new Uint8ClampedArray(payload.data),
    width: payload.width,
    height: payload.height,
  }
  const detectionSize = alignedDetectionSize(original.width, original.height)
  const image = resizeRgba(original, detectionSize.width, detectionSize.height)
  progress(id, { stage: 'detecting', completed: 0, total: 1 })
  const detectionFeeds = { [models.detection.inputNames[0]]: detectionTensor(image) }
  const detectionOutputs = await models.detection.run(detectionFeeds)
  assertActive(id)
  const detectionOutput = detectionOutputs[models.detection.outputNames[0]]
  if (!(detectionOutput?.data instanceof Float32Array) || detectionOutput.dims.length !== 4) {
    throw new Error('Unexpected OCR detection output')
  }
  const outputHeight = Number(detectionOutput.dims[2])
  const outputWidth = Number(detectionOutput.dims[3])
  if (
    !Number.isInteger(outputWidth) ||
    !Number.isInteger(outputHeight) ||
    detectionOutput.data.length !== outputWidth * outputHeight
  ) {
    throw new Error('OCR detection dimensions are invalid')
  }
  const scaleX = image.width / outputWidth
  const scaleY = image.height / outputHeight
  const boxes = detectComponents(detectionOutput.data, outputWidth, outputHeight).map((box) => ({
    left: Math.max(0, Math.round(box.left * scaleX)),
    top: Math.max(0, Math.round(box.top * scaleY)),
    right: Math.min(image.width - 1, Math.round(box.right * scaleX)),
    bottom: Math.min(image.height - 1, Math.round(box.bottom * scaleY)),
    textLeft: Math.max(0, Math.round(box.textLeft * scaleX)),
    textTop: Math.max(0, Math.round(box.textTop * scaleY)),
    textRight: Math.min(image.width - 1, Math.round(box.textRight * scaleX)),
    textBottom: Math.min(image.height - 1, Math.round(box.textBottom * scaleY)),
    score: box.score,
  }))
  progress(id, { stage: 'detecting', completed: 1, total: 1 })

  const lines: OcrLine[] = []
  for (let index = 0; index < boxes.length; index += 1) {
    assertActive(id)
    const box = boxes[index]
    const recognitionFeeds = { [models.recognition.inputNames[0]]: recognitionTensor(image, box) }
    const recognitionOutputs = await models.recognition.run(recognitionFeeds)
    const recognitionOutput = recognitionOutputs[models.recognition.outputNames[0]]
    if (recognitionOutput === undefined) throw new Error('OCR recognition returned no output')
    const decoded = decodeRecognition(recognitionOutput, models.characters)
    if (decoded.text !== '') {
      lines.push({
        text: decoded.text,
        confidence: Math.min(box.score, decoded.confidence || box.score),
        box: selectableOcrBox(box, image.width, image.height, decoded.text),
      })
    }
    progress(id, { stage: 'recognizing', completed: index + 1, total: boxes.length })
  }
  assertActive(id)
  post({ type: 'result', id, result: { lines } })
}

workerScope.onmessage = (event) => {
  const request = event.data
  if (request.type === 'cancel') {
    canceledRequests.add(request.id)
    return
  }
  canceledRequests.delete(request.id)
  workQueue = workQueue.then(async () => {
    try {
      await recognize(request.id, request.image)
    } catch (error) {
      if (canceledRequests.has(request.id)) return
      post({
        type: 'error',
        id: request.id,
        message: error instanceof Error ? error.message : 'Text recognition failed',
      })
    } finally {
      canceledRequests.delete(request.id)
    }
  })
}
