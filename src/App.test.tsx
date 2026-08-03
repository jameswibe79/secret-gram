import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import App from './App'
import {
  createRoom,
  createSocketTicket,
  getRoomInfo,
  getRoomMessages,
  postRoomMessage,
  recallRoomMessage,
} from './lib/api'
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
    postRoomMessage: vi.fn(),
    recallRoomMessage: vi.fn(),
  }
})

vi.mock('./lib/file-transfer', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./lib/file-transfer')>()
  return { ...actual, uploadEncryptedFile: vi.fn() }
})

beforeEach(() => {
  window.history.replaceState(null, '', '/')
  window.localStorage.clear()
  delete document.documentElement.dataset.theme
  vi.mocked(createRoom).mockReset().mockResolvedValue({ created: true, expiresAt: Date.now() + 60_000 })
  vi.mocked(getRoomInfo).mockReset().mockResolvedValue({
    createdAt: Date.now(),
    expiresAt: Date.now() + 60_000,
    onlineCount: 1,
  })
  vi.mocked(getRoomMessages).mockReset().mockResolvedValue([])
  vi.mocked(createSocketTicket).mockReset().mockRejectedValue(new Error('offline in test'))
  vi.mocked(postRoomMessage).mockReset().mockImplementation(
    async (_locator, _token, _deviceId, envelope) => ({
      duplicate: false,
      message: { ...envelope, sequence: 1, serverCreatedAt: Date.now() },
    }),
  )
  vi.mocked(recallRoomMessage).mockReset().mockImplementation(
    async (_locator, _token, deviceId, messageId) => ({
      duplicate: false,
      event: {
        type: 'recall',
        messageId,
        senderId: deviceId,
        sequence: 2,
        recalledAt: Date.now(),
      },
    }),
  )
  vi.mocked(uploadEncryptedFile).mockReset()
})

describe('SecretGram application', () => {
  it('switches themes and restores the saved preference', async () => {
    const user = userEvent.setup()
    window.localStorage.setItem('secretgram-theme', 'night')
    const rendered = render(<App />)

    expect(document.documentElement).toHaveAttribute('data-theme', 'night')
    await user.click(screen.getByRole('button', { name: 'Switch to day theme' }))
    expect(document.documentElement).toHaveAttribute('data-theme', 'day')
    expect(window.localStorage.getItem('secretgram-theme')).toBe('day')

    rendered.unmount()
    render(<App />)
    expect(document.documentElement).toHaveAttribute('data-theme', 'day')
    expect(screen.getByRole('button', { name: 'Switch to night theme' })).toBeInTheDocument()
  })

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

  it('supports keyboard room-mode switching with accurate lifetime copy', async () => {
    const user = userEvent.setup()
    render(<App />)

    screen.getByRole('tab', { name: 'Join room' }).focus()
    await user.keyboard('{ArrowRight}')
    await waitFor(() => expect(screen.getByRole('tab', { name: 'Create room' })).toHaveFocus())
    expect(screen.getByRole('heading', { name: 'Create an encrypted room' })).toBeInTheDocument()

    const lifetime = screen.getByLabelText('Room lifetime')
    await user.selectOptions(lifetime, String(24 * 60 * 60))
    expect(screen.getByText(/This room expires after 24 hours/)).toBeInTheDocument()
    await user.selectOptions(lifetime, String(30 * 24 * 60 * 60))
    expect(screen.getByText(/This room expires after 30 days/)).toBeInTheDocument()
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

  it('keeps invitation controls collapsed until the user opens them', async () => {
    const user = userEvent.setup()
    render(<App />)

    await user.click(screen.getByRole('tab', { name: 'Create room' }))
    await user.click(screen.getByRole('button', { name: 'Create secure room' }))

    expect(await screen.findByRole('heading', { name: 'Secure room' })).toBeInTheDocument()
    expect(screen.queryByText('••••-••••-••••-••••-••••-••••-••')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Copy room code' })).not.toBeInTheDocument()
    await waitFor(() => expect(screen.getByRole('textbox', { name: 'Message' })).toHaveFocus())

    await user.click(screen.getByRole('button', { name: 'Invite' }))
    expect(screen.getByText('••••-••••-••••-••••-••••-••••-••')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Copy room code' })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Show' }))
    expect(screen.getByRole('button', { name: 'Hide' })).toBeInTheDocument()
    expect(createRoom).toHaveBeenCalledTimes(1)
  })

  it('recalls a sent message through an in-app confirmation dialog', async () => {
    const user = userEvent.setup()
    render(<App />)
    await user.click(screen.getByRole('tab', { name: 'Create room' }))
    await user.click(screen.getByRole('button', { name: 'Create secure room' }))
    await screen.findByRole('heading', { name: 'Secure room' })

    await user.type(screen.getByRole('textbox', { name: 'Message' }), 'Please remove this')
    await user.click(screen.getByRole('button', { name: 'Send' }))
    expect(await screen.findByText('Please remove this')).toBeInTheDocument()
    await user.click(await screen.findByRole('button', { name: 'Recall' }))

    expect(screen.getByRole('dialog', { name: 'Recall message?' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Close' })).toHaveFocus()
    expect(recallRoomMessage).not.toHaveBeenCalled()
    await user.click(screen.getByRole('button', { name: 'Keep message' }))
    expect(screen.queryByRole('dialog', { name: 'Recall message?' })).not.toBeInTheDocument()
    expect(screen.getByText('Please remove this')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Recall' }))
    await user.click(screen.getByRole('button', { name: 'Recall for everyone' }))
    await waitFor(() => expect(recallRoomMessage).toHaveBeenCalledTimes(1))
    expect(await screen.findByText('Message recalled')).toBeInTheDocument()
    expect(screen.queryByText('Please remove this')).not.toBeInTheDocument()
    expect(screen.getByText('Recalled for everyone')).toBeInTheDocument()
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

  it('queues pasted files until the user sends them', async () => {
    const user = userEvent.setup()
    vi.mocked(uploadEncryptedFile).mockRejectedValue(new Error('Upload stopped for test'))
    render(<App />)
    await user.click(screen.getByRole('tab', { name: 'Create room' }))
    await user.click(screen.getByRole('button', { name: 'Create secure room' }))
    await screen.findByRole('heading', { name: 'Secure room' })

    const file = new File(['pasted'], 'pasted.txt', { type: 'text/plain' })
    fireEvent.paste(screen.getByRole('textbox', { name: 'Message' }), {
      clipboardData: {
        items: [{ kind: 'file', getAsFile: () => file }],
        files: [file],
      },
    })

    expect(await screen.findByText('Pending to send')).toBeInTheDocument()
    expect(screen.getByText('pasted.txt')).toBeInTheDocument()
    expect(uploadEncryptedFile).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'Send' })).toBeEnabled()

    await user.click(screen.getByRole('button', { name: 'Send' }))
    await waitFor(() => expect(uploadEncryptedFile).toHaveBeenCalledTimes(1))
    expect(await screen.findByText('Upload stopped for test')).toBeInTheDocument()
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
