import {
  DEFAULT_FILE_CHUNK_SIZE,
  MAX_FILE_BYTES,
  MAX_FILE_CHUNKS,
  type FileDescriptor,
} from '../shared/protocol'
import { base64UrlToBytes, bytesToBase64Url } from './encoding'

const encoder = new TextEncoder()

interface EncryptedChunkInput {
  locator: string
  plaintextDigest: string
}

const encryptedChunkInputs = new WeakMap<
  FileEncryptionPlan,
  Map<number, EncryptedChunkInput>
>()

export interface FileEncryptionPlan {
  fileId: string
  size: number
  chunkSize: number
  chunkCount: number
  key: CryptoKey
  encodedKey: string
  noncePrefix: Uint8Array<ArrayBuffer>
  encodedNoncePrefix: string
}

function expectedChunkLength(
  size: number,
  chunkSize: number,
  chunkCount: number,
  index: number,
): number {
  if (!Number.isInteger(index) || index < 0 || index >= chunkCount) {
    throw new Error('Invalid file chunk index')
  }
  const start = index * chunkSize
  return Math.max(0, Math.min(chunkSize, size - start))
}

function chunkNonce(prefix: Uint8Array, index: number): Uint8Array<ArrayBuffer> {
  if (prefix.byteLength !== 8) throw new Error('Invalid file nonce prefix')
  const nonce = new Uint8Array(12)
  nonce.set(prefix, 0)
  new DataView(nonce.buffer).setUint32(8, index, false)
  return nonce
}

function chunkAuthenticatedData(
  locator: string,
  fileId: string,
  size: number,
  chunkSize: number,
  chunkCount: number,
  index: number,
  plainLength: number,
): Uint8Array<ArrayBuffer> {
  return encoder.encode(
    [
      'secretgram/file-chunk/v1',
      locator,
      fileId,
      String(size),
      String(chunkSize),
      String(chunkCount),
      String(index),
      String(plainLength),
    ].join('\n'),
  )
}

async function importFileKey(encodedKey: string): Promise<CryptoKey> {
  const rawKey = base64UrlToBytes(encodedKey)
  if (rawKey.byteLength !== 32) throw new Error('Invalid file key')
  return crypto.subtle.importKey(
    'raw',
    rawKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['decrypt'],
  )
}

export async function createFileEncryptionPlan(
  size: number,
  chunkSize = DEFAULT_FILE_CHUNK_SIZE,
): Promise<FileEncryptionPlan> {
  if (!Number.isSafeInteger(size) || size < 0 || size > MAX_FILE_BYTES) {
    throw new Error(`File size must be between 0 and ${MAX_FILE_BYTES} bytes`)
  }
  if (!Number.isSafeInteger(chunkSize) || chunkSize <= 0 || chunkSize > 8 * 1024 * 1024) {
    throw new Error('Invalid file chunk size')
  }

  const chunkCount = Math.max(1, Math.ceil(size / chunkSize))
  if (chunkCount > MAX_FILE_CHUNKS) throw new Error('File chunk count exceeds the limit')

  const rawKey = crypto.getRandomValues(new Uint8Array(32))
  const key = await crypto.subtle.importKey(
    'raw',
    rawKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt'],
  )
  const noncePrefix = crypto.getRandomValues(new Uint8Array(8))

  return {
    fileId: crypto.randomUUID(),
    size,
    chunkSize,
    chunkCount,
    key,
    encodedKey: bytesToBase64Url(rawKey),
    noncePrefix,
    encodedNoncePrefix: bytesToBase64Url(noncePrefix),
  }
}

export function fileDescriptorFromPlan(
  plan: FileEncryptionPlan,
  name: string,
  mimeType: string,
): FileDescriptor {
  return {
    fileId: plan.fileId,
    name,
    mimeType: mimeType || 'application/octet-stream',
    size: plan.size,
    chunkSize: plan.chunkSize,
    chunkCount: plan.chunkCount,
    key: plan.encodedKey,
    noncePrefix: plan.encodedNoncePrefix,
  }
}

export async function encryptFileChunk(
  plan: FileEncryptionPlan,
  locator: string,
  index: number,
  plaintext: Uint8Array,
): Promise<Uint8Array<ArrayBuffer>> {
  const expectedLength = expectedChunkLength(plan.size, plan.chunkSize, plan.chunkCount, index)
  if (plaintext.byteLength !== expectedLength) {
    throw new Error('File chunk size does not match the manifest')
  }

  const plaintextCopy = new Uint8Array(plaintext)
  const plaintextDigest = bytesToBase64Url(
    new Uint8Array(await crypto.subtle.digest('SHA-256', plaintextCopy)),
  )
  let inputs = encryptedChunkInputs.get(plan)
  if (inputs === undefined) {
    inputs = new Map()
    encryptedChunkInputs.set(plan, inputs)
  }
  const existing = inputs.get(index)
  if (existing !== undefined) {
    if (existing.locator !== locator || existing.plaintextDigest !== plaintextDigest) {
      throw new Error('An upload chunk cannot be re-encrypted with different content')
    }
  } else {
    inputs.set(index, { locator, plaintextDigest })
  }

  try {
    const ciphertext = await crypto.subtle.encrypt(
      {
        name: 'AES-GCM',
        iv: chunkNonce(plan.noncePrefix, index),
        additionalData: chunkAuthenticatedData(
          locator,
          plan.fileId,
          plan.size,
          plan.chunkSize,
          plan.chunkCount,
          index,
          expectedLength,
        ),
        tagLength: 128,
      },
      plan.key,
      plaintextCopy,
    )
    return new Uint8Array(ciphertext)
  } catch (error) {
    if (existing === undefined) inputs.delete(index)
    throw error
  }
}

export async function decryptFileChunk(
  descriptor: FileDescriptor,
  locator: string,
  index: number,
  ciphertext: Uint8Array,
): Promise<Uint8Array<ArrayBuffer>> {
  const expectedLength = expectedChunkLength(
    descriptor.size,
    descriptor.chunkSize,
    descriptor.chunkCount,
    index,
  )
  if (ciphertext.byteLength !== expectedLength + 16) {
    throw new Error('File chunk integrity check failed')
  }

  const key = await importFileKey(descriptor.key)
  const noncePrefix = base64UrlToBytes(descriptor.noncePrefix)

  try {
    const plaintext = await crypto.subtle.decrypt(
      {
        name: 'AES-GCM',
        iv: chunkNonce(noncePrefix, index),
        additionalData: chunkAuthenticatedData(
          locator,
          descriptor.fileId,
          descriptor.size,
          descriptor.chunkSize,
          descriptor.chunkCount,
          index,
          expectedLength,
        ),
        tagLength: 128,
      },
      key,
      new Uint8Array(ciphertext),
    )
    return new Uint8Array(plaintext)
  } catch {
    throw new Error('File chunk integrity check failed')
  }
}
