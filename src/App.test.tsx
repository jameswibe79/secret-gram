import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import App from './App'
import { createRoom, createSocketTicket, getRoomInfo, getRoomMessages } from './lib/api'
import { uploadEncryptedFile } from './lib/file-transfer'
import { generateRoomCode } from './lib/room-crypto'

vi.mock('./lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./lib/api')>()
  return {
    ...actual,
    createRoom: vi.fn(),
    createSocketTicket: vi.fn(),
    getRoomInfo: vi.fn(),
    getRoomMessages: vi.fn(),
  }
})

vi.mock('./lib/file-transfer', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./lib/file-transfer')>()
  return { ...actual, uploadEncryptedFile: vi.fn() }
})

beforeEach(() => {
  window.history.replaceState(null, '', '/')
  vi.mocked(createRoom).mockReset().mockResolvedValue({ created: true, expiresAt: Date.now() + 60_000 })
  vi.mocked(getRoomInfo).mockReset().mockResolvedValue({
    createdAt: Date.now(),
    expiresAt: Date.now() + 60_000,
    onlineCount: 1,
  })
  vi.mocked(getRoomMessages).mockReset().mockResolvedValue([])
  vi.mocked(createSocketTicket).mockReset().mockRejectedValue(new Error('offline in test'))
  vi.mocked(uploadEncryptedFile).mockReset()
})

describe('SecretGram application', () => {
  it('removes an invitation fragment immediately while keeping its code in memory', () => {
    window.history.replaceState(null, '', '/#room=TEST-ROOM-CODE')

    render(<App />)

    expect(window.location.hash).toBe('')
    expect(screen.getByLabelText('Room code or invitation link')).toHaveValue('TEST-ROOM-CODE')
  })

  it('opens on the focused join workflow with an honest encryption notice', () => {
    render(<App />)

    expect(screen.getByRole('heading', { name: 'Join an encrypted room' })).toBeInTheDocument()
    expect(screen.getByLabelText('Room code or invitation link')).toBeInTheDocument()
    expect(screen.getByText(/Content encrypted on this device/)).toBeInTheDocument()
  })

  it('rejects an invalid room code before contacting the API', async () => {
    const user = userEvent.setup()
    render(<App />)

    await user.type(screen.getByLabelText('Room code or invitation link'), '1234')
    await user.click(screen.getByRole('button', { name: 'Join room' }))

    expect(screen.getByRole('alert')).toHaveTextContent('Invalid room code')
    expect(getRoomInfo).not.toHaveBeenCalled()
  })

  it('provides keyboard dismissal and focus restoration for security details', async () => {
    const user = userEvent.setup()
    render(<App />)
    const trigger = screen.getByRole('button', { name: 'Security details' })

    await user.click(trigger)
    expect(screen.getByRole('dialog', { name: 'Security boundaries' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Close' })).toHaveFocus()

    await user.keyboard('{Escape}')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(trigger).toHaveFocus()
  })

  it('creates a room and reveals a copyable invite inside the workspace', async () => {
    const user = userEvent.setup()
    render(<App />)

    await user.click(screen.getByRole('tab', { name: 'Create room' }))
    await user.click(screen.getByRole('button', { name: 'Create secure room' }))

    expect(await screen.findByRole('heading', { name: 'Secure room' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Copy room code' })).toBeInTheDocument()
    expect(createRoom).toHaveBeenCalledTimes(1)
  })

  it('clears an invitation secret from the URL and join form after leaving', async () => {
    const user = userEvent.setup()
    const roomCode = await generateRoomCode()
    window.location.hash = `room=${encodeURIComponent(roomCode)}`
    render(<App />)

    expect(screen.getByLabelText('Room code or invitation link')).toHaveValue(roomCode)
    await user.click(screen.getByRole('button', { name: 'Join room' }))
    expect(await screen.findByRole('heading', { name: 'Secure room' })).toBeInTheDocument()
    expect(window.location.hash).toBe('')

    await user.click(screen.getByRole('button', { name: 'Leave room' }))
    expect(screen.getByLabelText('Room code or invitation link')).toHaveValue('')
  })

  it('does not start later queued uploads after leaving the room', async () => {
    const user = userEvent.setup()
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    vi.mocked(uploadEncryptedFile).mockImplementation((_file, _credentials, options) =>
      new Promise((_resolve, reject) => {
        options?.signal?.addEventListener(
          'abort',
          () => reject(new DOMException('Operation canceled', 'AbortError')),
          { once: true },
        )
      }),
    )
    render(<App />)
    await user.click(screen.getByRole('tab', { name: 'Create room' }))
    await user.click(screen.getByRole('button', { name: 'Create secure room' }))
    await screen.findByRole('heading', { name: 'Secure room' })

    await user.upload(screen.getByLabelText('Choose attachments'), [
      new File(['one'], 'one.txt', { type: 'text/plain' }),
      new File(['two'], 'two.txt', { type: 'text/plain' }),
    ])
    await waitFor(() => expect(uploadEncryptedFile).toHaveBeenCalledTimes(1))
    await user.click(screen.getByRole('button', { name: 'Leave room' }))
    await Promise.resolve()
    await Promise.resolve()

    expect(uploadEncryptedFile).toHaveBeenCalledTimes(1)
  })
})
