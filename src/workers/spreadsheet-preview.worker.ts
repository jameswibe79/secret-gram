import { parseSpreadsheet } from '../lib/spreadsheet-preview-parser'
import type {
  SpreadsheetPreviewWorkerRequest,
  SpreadsheetPreviewWorkerResponse,
} from '../lib/spreadsheet-preview'

const workerScope = self as unknown as {
  onmessage: ((event: MessageEvent<SpreadsheetPreviewWorkerRequest>) => void) | null
  postMessage(message: SpreadsheetPreviewWorkerResponse): void
}

workerScope.onmessage = (event) => {
  void parseSpreadsheet(event.data.arrayBuffer)
    .then((workbook) => workerScope.postMessage({ type: 'ready', workbook }))
    .catch(() => workerScope.postMessage({ type: 'error' }))
}
