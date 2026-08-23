import { beforeEach, describe, expect, it, vi } from 'vitest'

import { handoffPdfToHeron } from './pdf-handoff'

function pdfBlob() {
  const data = new Blob(['pdf'], { type: 'application/pdf' })
  Object.defineProperty(data, 'arrayBuffer', {
    value: vi.fn().mockResolvedValue(new Uint8Array([1, 2, 3]).buffer),
  })
  return data
}

describe('handoffPdfToHeron', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('opens the fixed editor and transfers bytes only after an exact ready handshake', async () => {
    const postMessage = vi.fn()
    const editor = { closed: false, postMessage } as unknown as Window
    const open = vi.spyOn(window, 'open').mockReturnValue(editor)
    const operation = handoffPdfToHeron({ data: pdfBlob(), name: 'scan.pdf' })

    const destination = new URL(String(open.mock.calls[0][0]))
    const token = new URLSearchParams(destination.hash.slice(1)).get('token')
    expect(destination.origin).toBe('https://heron.tools')
    expect(destination.pathname).toBe('/tools/pdf-rotate-pages/')
    expect(destination.searchParams.get('handoff')).toBe('pdf')
    expect(token).toMatch(/^[0-9a-f-]{36}$/)
    expect(open).toHaveBeenCalledWith(destination.toString(), '_blank')

    window.dispatchEvent(new MessageEvent('message', {
      source: editor,
      origin: 'https://example.com',
      data: { type: 'heron.tools:pdf-handoff:ready', version: 1, token },
    }))
    expect(postMessage).not.toHaveBeenCalled()

    window.dispatchEvent(new MessageEvent('message', {
      source: editor,
      origin: 'https://heron.tools',
      data: { type: 'heron.tools:pdf-handoff:ready', version: 1, token },
    }))
    await operation

    expect(postMessage).toHaveBeenCalledTimes(1)
    const [message, targetOrigin, transfer] = postMessage.mock.calls[0]
    expect(message).toMatchObject({
      type: 'heron.tools:pdf-handoff:file',
      version: 1,
      token,
      name: 'scan.pdf',
    })
    expect(message.bytes).toBeInstanceOf(ArrayBuffer)
    expect(targetOrigin).toBe('https://heron.tools')
    expect(transfer).toEqual([message.bytes])
  })

  it('fails clearly when the browser blocks the editor window', async () => {
    vi.spyOn(window, 'open').mockReturnValue(null)

    await expect(handoffPdfToHeron({ data: pdfBlob(), name: 'scan.pdf' })).rejects.toThrow(
      'The browser blocked the Heron Tools window.',
    )
  })

  it('cancels the temporary message listener when the preview closes', async () => {
    const editor = { closed: false, postMessage: vi.fn() } as unknown as Window
    vi.spyOn(window, 'open').mockReturnValue(editor)
    const controller = new AbortController()
    const operation = handoffPdfToHeron({
      data: pdfBlob(),
      name: 'scan.pdf',
      signal: controller.signal,
    })

    controller.abort()

    await expect(operation).rejects.toMatchObject({ name: 'AbortError' })
  })
})
