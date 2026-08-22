export interface OcrBox {
  x: number
  y: number
  width: number
  height: number
}

export interface OcrLine {
  text: string
  confidence: number
  box: OcrBox
}

export interface OcrResult {
  lines: OcrLine[]
}

export type OcrProgressStage = 'loading-models' | 'detecting' | 'recognizing'

export interface OcrProgress {
  stage: OcrProgressStage
  completed: number
  total: number
}

export interface OcrImagePayload {
  width: number
  height: number
  data: ArrayBuffer
}

export type OcrWorkerRequest =
  | { type: 'recognize'; id: number; image: OcrImagePayload }
  | { type: 'cancel'; id: number }

export type OcrWorkerResponse =
  | { type: 'progress'; id: number; progress: OcrProgress }
  | { type: 'result'; id: number; result: OcrResult }
  | { type: 'error'; id: number; message: string }
