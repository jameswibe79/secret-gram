import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import App from './App'
import {
  createRoom,
  createSocketTicket,
  getRoomInfo,
  getRoomMessages,
  getRoomPin,
  postRoomMessage,
  recallRoomMessage,
  setRoomPin,
} from './lib/api'
import { uploadEncryptedFile } from './lib/file-transfer'
import { generateRoomKey } from './lib/room-crypto'

vi.mock('./lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./lib/api')>()
  return {
    ...actual,
    createRoom: vi.fn(),
    createSocketTicket: vi.fn(),
    getRoomInfo: vi.fn(),
    getRoomMessages: vi.fn(),
    getRoomPin: vi.fn(),
    postRoomMessage: vi.fn(),
    recallRoomMessage: vi.fn(),
    setRoomPin: vi.fn(),
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
  vi.mocked(getRoomPin).mockReset().mockResolvedValue({
    messageId: null,
    version: 0,
    updatedAt: null,
  })
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
  let pinVersion = 0
  vi.mocked(setRoomPin).mockReset().mockImplementation(
    async (_locator, _token, messageId, pinned) => ({
      duplicate: false,
      pin: {
        messageId: pinned ? messageId : null,
        version: ++pinVersion,
        updatedAt: Date.now(),
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

  it('removes a secure invitation key from the URL while keeping it in memory', () => {
    const roomKey = generateRoomKey()
    window.history.replaceState(null, '', `/r/ABC123#${new URLSearchParams({ key: roomKey })}`)

    render(<App />)

    expect(window.location.pathname).toBe('/r/ABC123')
    expect(window.location.hash).toBe('')
    expect(screen.getByLabelText('Room ID or invitation link')).toHaveValue('ABC123')
    expect(screen.getByLabelText('Room password')).toBeDisabled()
  })

  it('opens on the focused join workflow with an honest encryption notice', () => {
    render(<App />)

    expect(screen.getByRole('heading', { name: 'Join an encrypted room' })).toBeInTheDocument()
    expect(screen.getByLabelText('Room ID or invitation link')).toBeInTheDocument()
    expect(screen.getByText(/Content encrypted on this device/)).toBeInTheDocument()
  })

  it('supports keyboard room-mode switching with accurate lifetime copy', async () => {
    const user = userEvent.setup()
    render(<App />)

    screen.getByRole('tab', { name: 'Join room' }).focus()
    await user.keyboard('{ArrowRight}')
    await waitFor(() => expect(screen.getByRole('tab', { name: 'Create room' })).toHaveFocus())
    expect(screen.getByRole('heading', { name: 'Create an encrypted room' })).toBeInTheDocument()
    const joinMethod = screen.getByRole('note', { name: 'How participants join' })
    expect(joinMethod).toBeInTheDocument()
    expect(screen.getByText('No password')).toBeInTheDocument()
    expect(screen.getByText(
      'Share the full invitation link. The six-character Room ID alone will not work.',
    )).toBeInTheDocument()
    expect(screen.getByText('With a password')).toBeInTheDocument()
    expect(screen.getByText('Share the Room ID and password separately.')).toBeInTheDocument()

    const lifetime = screen.getByLabelText('Room lifetime')
    await user.selectOptions(lifetime, String(24 * 60 * 60))
    expect(screen.getByText(/This room expires after 24 hours/)).toBeInTheDocument()
    await user.selectOptions(lifetime, String(30 * 24 * 60 * 60))
    expect(screen.getByText(/This room expires after 30 days/)).toBeInTheDocument()
  })

  it('rejects an invalid room ID before contacting the API', async () => {
    const user = userEvent.setup()
    render(<App />)

    await user.type(screen.getByLabelText('Room ID or invitation link'), '1234')
    await user.click(screen.getByRole('button', { name: 'Join room' }))

    expect(screen.getByRole('alert')).toHaveTextContent('Invalid room ID')
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

  it('creates a short room URL and keeps invitation controls collapsed', async () => {
    const user = userEvent.setup()
    render(<App />)

    await user.click(screen.getByRole('tab', { name: 'Create room' }))
    await user.click(screen.getByRole('button', { name: 'Create secure room' }))

    expect(await screen.findByRole('heading', { name: 'Secure room' })).toBeInTheDocument()
    expect(window.location.pathname).toMatch(/^\/r\/[0-9A-HJKMNP-TV-Z]{6}$/)
    expect(window.location.hash).toBe('')
    expect(screen.queryByRole('button', { name: 'Copy room ID' })).not.toBeInTheDocument()
    await waitFor(() => expect(screen.getByRole('textbox', { name: 'Message' })).toHaveFocus())

    await user.click(screen.getByRole('button', { name: 'Invite' }))
    expect(screen.getByText(window.location.pathname)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Copy room ID' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Copy invitation link' })).toBeInTheDocument()
    expect(createRoom).toHaveBeenCalledTimes(1)
  })

  it('creates and rejoins a password-protected short room', async () => {
    const user = userEvent.setup()
    render(<App />)

    await user.click(screen.getByRole('tab', { name: 'Create room' }))
    await user.type(screen.getByLabelText('Optional room password'), 'correct horse')
    await user.type(screen.getByLabelText('Confirm password'), 'correct horse')
    await user.click(screen.getByRole('button', { name: 'Create secure room' }))
    await screen.findByRole('heading', { name: 'Secure room' })
    const roomId = window.location.pathname.slice('/r/'.length)
    const createdLocator = vi.mocked(createRoom).mock.calls[0]?.[0]

    await user.click(screen.getByRole('button', { name: 'Invite' }))
    expect(screen.getByText('Share this room ID and send the password separately.')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Leave room' }))

    await user.type(screen.getByLabelText('Room ID or invitation link'), roomId)
    await user.type(screen.getByLabelText('Room password'), 'correct horse')
    await user.click(screen.getByRole('button', { name: 'Join room' }))
    expect(await screen.findByRole('heading', { name: 'Secure room' })).toBeInTheDocument()
    expect(getRoomInfo).toHaveBeenCalledWith(
      createdLocator,
      expect.stringMatching(/^[A-Za-z0-9_-]{43}$/u),
    )
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

  it('pins, unpins, and clears a recalled room message', async () => {
    const user = userEvent.setup()
    render(<App />)
    await user.click(screen.getByRole('tab', { name: 'Create room' }))
    await user.click(screen.getByRole('button', { name: 'Create secure room' }))
    await screen.findByRole('heading', { name: 'Secure room' })

    await user.type(screen.getByRole('textbox', { name: 'Message' }), 'Keep this in view')
    await user.click(screen.getByRole('button', { name: 'Send' }))
    await user.click(await screen.findByRole('button', { name: 'Pin' }))

    await waitFor(() => expect(setRoomPin).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      expect.any(String),
      true,
    ))
    const banner = await screen.findByLabelText('Pinned message')
    expect(banner).toHaveTextContent('Keep this in view')

    await user.click(within(banner).getByRole('button', { name: 'Unpin' }))
    await waitFor(() => expect(setRoomPin).toHaveBeenLastCalledWith(
      expect.any(String),
      expect.any(String),
      expect.any(String),
      false,
    ))
    await waitFor(() => {
      expect(screen.queryByLabelText('Pinned message')).not.toBeInTheDocument()
    })

    await user.click(screen.getByRole('button', { name: 'Pin' }))
    await screen.findByLabelText('Pinned message')
    await user.click(screen.getByRole('button', { name: 'Recall' }))
    await user.click(screen.getByRole('button', { name: 'Recall for everyone' }))
    await waitFor(() => {
      expect(screen.queryByLabelText('Pinned message')).not.toBeInTheDocument()
    })
  })

  it('joins from a secure short link and clears the path after leaving', async () => {
    const user = userEvent.setup()
    const roomKey = generateRoomKey()
    window.history.replaceState(null, '', `/r/ABC123#${new URLSearchParams({ key: roomKey })}`)
    render(<App />)

    expect(screen.getByLabelText('Room ID or invitation link')).toHaveValue('ABC123')
    await user.click(screen.getByRole('button', { name: 'Join room' }))
    expect(await screen.findByRole('heading', { name: 'Secure room' })).toBeInTheDocument()
    expect(window.location.pathname).toBe('/r/ABC123')
    expect(window.location.hash).toBe('')

    await user.click(screen.getByRole('button', { name: 'Leave room' }))
    expect(window.location.pathname).toBe('/')
    expect(screen.getByLabelText('Room ID or invitation link')).toHaveValue('')
  })

  it('encrypts and sends pasted files immediately', async () => {
    vi.mocked(uploadEncryptedFile).mockRejectedValue(new Error('Upload stopped for test'))
    render(<App />)
    const user = userEvent.setup()
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

    await waitFor(() => expect(uploadEncryptedFile).toHaveBeenCalledTimes(1))
    expect(screen.getByText('pasted.txt')).toBeInTheDocument()
    expect(await screen.findByText(/Upload stopped for test/u)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Retry pasted.txt upload' })).toBeEnabled()
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled()
  })

  it('does not start later queued uploads after leaving the room', async () => {
    const user = userEvent.setup()
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    vi.mocked(uploadEncryptedFile).mockImplementation((_file, _credentials, options) => {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          options?.signal?.addEventListener(
            'abort',
            () => controller.error(new DOMException('Operation canceled', 'AbortError')),
            { once: true },
          )
        },
      })
      return new Response(stream).blob().then(() => {
        throw new Error('Unexpected upload stream completion')
      })
    })
    render(<App />)
    await user.click(screen.getByRole('tab', { name: 'Create room' }))
    await user.click(screen.getByRole('button', { name: 'Create secure room' }))
    await screen.findByRole('heading', { name: 'Secure room' })

    await user.upload(screen.getByLabelText('Choose attachments'), [
      new File(['one'], 'one.txt', { type: 'text/plain' }),
      new File(['two'], 'two.txt', { type: 'text/plain' }),
    ])
    expect(uploadEncryptedFile).not.toHaveBeenCalled()
    await user.click(screen.getByRole('button', { name: 'Send files' }))
    await waitFor(() => expect(uploadEncryptedFile).toHaveBeenCalledTimes(1))
    await user.click(screen.getByRole('button', { name: 'Leave room' }))
    await Promise.resolve()
    await Promise.resolve()

    expect(uploadEncryptedFile).toHaveBeenCalledTimes(1)
  })
})
