import { fileDescriptorSchema, type FileDescriptor } from '../shared/protocol'
import {
  beginEncryptedUpload,
  completeEncryptedUpload,
  getEncryptedChunk,
  putEncryptedChunk,
} from './api'
import {
  createFileEncryptionPlan,
  decryptFileChunk,
  encryptFileChunk,
  fileDescriptorFromPlan,
} from './file-crypto'

export interface FileTransferCredentials {
  locator: string
  token: string
  deviceId: string
}

export interface FileTransferProgress {
  phase: 'upload' | 'download'
  fileId: string
  fileName: string
  completedBytes: number
  totalBytes: number
  completedChunks: number
  totalChunks: number
}

export interface UploadFileOptions {
  chunkSize?: number
  signal?: AbortSignal
  retryAttempts?: number
  retryDelayMs?: number
  onProgress?: (progress: FileTransferProgress) => void
}

export interface DownloadFileOptions {
  signal?: AbortSignal
  retryAttempts?: number
  retryDelayMs?: number
  onProgress?: (progress: FileTransferProgress) => void
}

function ensureNotAborted(signal?: AbortSignal): void {
  if (signal?.aborted !== true) return
  if (signal.reason !== undefined) throw signal.reason
  throw new DOMException('Operation canceled', 'AbortError')
}

function isTransientFailure(error: unknown): boolean {
  if (typeof error !== 'object' || error === null || !('status' in error)) return true
  const status = Number(error.status)
  return status === 408 || status === 425 || status === 429 || status >= 500
}

async function retryDelay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  ensureNotAborted(signal)
  if (milliseconds <= 0) return
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', abort)
      resolve()
    }, milliseconds)
    function abort() {
      clearTimeout(timer)
      reject(signal?.reason ?? new DOMException('Operation canceled', 'AbortError'))
    }
    signal?.addEventListener('abort', abort, { once: true })
  })
}

async function retryTransfer<T>(
  operation: () => Promise<T>,
  options: Pick<UploadFileOptions, 'retryAttempts' | 'retryDelayMs' | 'signal'>,
): Promise<T> {
  const attempts = options.retryAttempts ?? 3
  const baseDelay = options.retryDelayMs ?? 300
  if (!Number.isInteger(attempts) || attempts < 1 || attempts > 5) {
    throw new Error('Retry attempts must be an integer between 1 and 5')
  }
  if (!Number.isFinite(baseDelay) || baseDelay < 0 || baseDelay > 5_000) {
    throw new Error('Retry delay must be between 0 and 5000 milliseconds')
  }

  for (let attempt = 1; ; attempt += 1) {
    ensureNotAborted(options.signal)
    try {
      return await operation()
    } catch (error) {
      ensureNotAborted(options.signal)
      if (attempt >= attempts || !isTransientFailure(error)) throw error
      await retryDelay(baseDelay * 2 ** (attempt - 1), options.signal)
    }
  }
}

export async function uploadEncryptedFile(
  file: File,
  credentials: FileTransferCredentials,
  options: UploadFileOptions = {},
): Promise<FileDescriptor> {
  ensureNotAborted(options.signal)
  const plan = await createFileEncryptionPlan(file.size, options.chunkSize)
  const descriptor = fileDescriptorSchema.parse(
    fileDescriptorFromPlan(plan, file.name, file.type || 'application/octet-stream'),
  )
  await retryTransfer(
    () => beginEncryptedUpload(
      credentials.locator,
      credentials.token,
      {
        deviceId: credentials.deviceId,
        fileId: descriptor.fileId,
        chunkCount: descriptor.chunkCount,
        encryptedSize: descriptor.size + descriptor.chunkCount * 16,
      },
      options.signal,
    ),
    options,
  )

  for (let index = 0; index < descriptor.chunkCount; index += 1) {
    ensureNotAborted(options.signal)
    const start = index * descriptor.chunkSize
    const end = Math.min(start + descriptor.chunkSize, descriptor.size)
    const plaintext = new Uint8Array(await file.slice(start, end).arrayBuffer())
    const ciphertext = await encryptFileChunk(plan, credentials.locator, index, plaintext)
    await retryTransfer(
      () => putEncryptedChunk(
        credentials.locator,
        credentials.token,
        credentials.deviceId,
        descriptor.fileId,
        index,
        ciphertext,
        options.signal,
      ),
      options,
    )
    options.onProgress?.({
      phase: 'upload',
      fileId: descriptor.fileId,
      fileName: descriptor.name,
      completedBytes: end,
      totalBytes: descriptor.size,
      completedChunks: index + 1,
      totalChunks: descriptor.chunkCount,
    })
  }

  await retryTransfer(
    () => completeEncryptedUpload(
      credentials.locator,
      credentials.token,
      credentials.deviceId,
      descriptor.fileId,
      options.signal,
    ),
    options,
  )
  return descriptor
}

export async function downloadDecryptedFile(
  unsafeDescriptor: FileDescriptor,
  credentials: FileTransferCredentials,
  options: DownloadFileOptions = {},
): Promise<Blob> {
  const descriptor = fileDescriptorSchema.parse(unsafeDescriptor)
  const parts: ArrayBuffer[] = []

  for (let index = 0; index < descriptor.chunkCount; index += 1) {
    ensureNotAborted(options.signal)
    const ciphertext = await retryTransfer(
      () => getEncryptedChunk(
        credentials.locator,
        credentials.token,
        descriptor.fileId,
        index,
        options.signal,
      ),
      options,
    )
    const plaintext = await decryptFileChunk(descriptor, credentials.locator, index, ciphertext)
    parts.push(plaintext.buffer.slice(plaintext.byteOffset, plaintext.byteOffset + plaintext.byteLength))
    const completedBytes = Math.min((index + 1) * descriptor.chunkSize, descriptor.size)
    options.onProgress?.({
      phase: 'download',
      fileId: descriptor.fileId,
      fileName: descriptor.name,
      completedBytes,
      totalBytes: descriptor.size,
      completedChunks: index + 1,
      totalChunks: descriptor.chunkCount,
    })
  }

  return new Blob(parts, { type: descriptor.mimeType })
}
