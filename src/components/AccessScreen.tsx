import { useState, type FormEvent, type KeyboardEvent } from 'react'

import { createRoom, getRoomInfo } from '../lib/api'
import { createMessageSender } from '../lib/message-crypto'
import {
  deriveRoomSecrets,
  formatRoomCodeFromSecret,
  generateRoomCode,
  parseRoomCode,
} from '../lib/room-crypto'
import type { ActiveRoomSession } from '../lib/session'
import { SecurityDialog } from './SecurityDialog'

interface AccessScreenProps {
  initialRoomCode?: string
  onSession: (session: ActiveRoomSession) => void
  theme: 'day' | 'night'
  onToggleTheme: () => void
}

type AccessMode = 'join' | 'create'

function codeFromInput(input: string): string {
  const trimmed = input.trim()
  if (!trimmed.includes('://')) return trimmed.replace(/^#(?:room=)?/u, '')
  const invitation = new URL(trimmed)
  const fragment = invitation.hash.slice(1)
  if (fragment.length === 0) throw new Error('missing fragment')
  const params = new URLSearchParams(fragment)
  return decodeURIComponent(params.get('room') ?? fragment)
}

function roomLifetimeLabel(ttlSeconds: number): string {
  if (ttlSeconds === 24 * 60 * 60) return '24 hours'
  if (ttlSeconds === 7 * 24 * 60 * 60) return '7 days'
  return '30 days'
}

export function AccessScreen({
  initialRoomCode = '',
  onSession,
  theme,
  onToggleTheme,
}: AccessScreenProps) {
  const [mode, setMode] = useState<AccessMode>('join')
  const [roomCode, setRoomCode] = useState(initialRoomCode)
  const [ttlSeconds, setTtlSeconds] = useState(7 * 24 * 60 * 60)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [showSecurity, setShowSecurity] = useState(false)
  const roomCodeDescription = error && mode === 'join' ? 'room-code-help access-error' : 'room-code-help'
  const roomLifetime = roomLifetimeLabel(ttlSeconds)

  function selectMode(nextMode: AccessMode) {
    setMode(nextMode)
    setError('')
  }

  function handleTabKey(event: KeyboardEvent<HTMLButtonElement>) {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
    event.preventDefault()
    const nextMode = mode === 'join' ? 'create' : 'join'
    selectMode(nextMode)
    window.requestAnimationFrame(() => {
      document.getElementById(`${nextMode}-room-tab`)?.focus()
    })
  }

  async function joinRoom(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setError('')
    let secret: Uint8Array
    let canonicalCode: string
    try {
      secret = parseRoomCode(codeFromInput(roomCode))
      canonicalCode = await formatRoomCodeFromSecret(secret)
    } catch {
      setError('Invalid room code. Check the characters and checksum.')
      return
    }

    setBusy(true)
    try {
      const secrets = await deriveRoomSecrets(secret)
      const info = await getRoomInfo(secrets.locator, secrets.authToken)
      const deviceId = crypto.randomUUID()
      onSession({
        roomCode: canonicalCode,
        locator: secrets.locator,
        authToken: secrets.authToken,
        messageRoot: secrets.messageRoot,
        deviceId,
        sender: await createMessageSender(secrets.messageRoot, secrets.locator),
        expiresAt: info.expiresAt,
      })
    } catch {
      setError('Unable to join. Check the room code or confirm that the room is still active.')
    } finally {
      setBusy(false)
    }
  }

  async function createSecureRoom() {
    setBusy(true)
    setError('')
    try {
      const generatedCode = await generateRoomCode()
      const secret = parseRoomCode(generatedCode)
      const secrets = await deriveRoomSecrets(secret)
      const result = await createRoom(secrets.locator, secrets.authVerifier, ttlSeconds)
      const deviceId = crypto.randomUUID()
      onSession({
        roomCode: generatedCode,
        locator: secrets.locator,
        authToken: secrets.authToken,
        messageRoot: secrets.messageRoot,
        deviceId,
        sender: await createMessageSender(secrets.messageRoot, secrets.locator),
        expiresAt: result.expiresAt,
      })
    } catch {
      setError('Unable to create the room. Check your connection and try again.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <main className="access-shell">
      <header className="product-bar">
        <div className="brand-lockup" aria-label="SecretGram">
          <span className="brand-mark" aria-hidden="true">SG</span>
          <span>SecretGram</span>
        </div>
        <div className="product-actions">
          <button
            className="text-button"
            type="button"
            aria-label={`Switch to ${theme === 'night' ? 'day' : 'night'} theme`}
            onClick={onToggleTheme}
          >
            {theme === 'night' ? 'Day theme' : 'Night theme'}
          </button>
          <button className="text-button" type="button" onClick={() => setShowSecurity(true)}>
            Security details
          </button>
        </div>
      </header>

      <section className="access-panel" aria-labelledby="access-title">
        <div className="access-intro">
          <p className="eyebrow">End-to-end encrypted session</p>
          <h1 id="access-title">{mode === 'join' ? 'Join an encrypted room' : 'Create an encrypted room'}</h1>
          <p>No account required. The room code grants access and decryption; share it only through a trusted channel.</p>
        </div>

        <div className="access-controls">
        <div className="tabs" role="tablist" aria-label="Room actions">
          <button
            id="join-room-tab"
            type="button"
            role="tab"
            aria-selected={mode === 'join'}
            aria-controls="join-room-panel"
            className={mode === 'join' ? 'tab active' : 'tab'}
            onClick={() => selectMode('join')}
            onKeyDown={handleTabKey}
          >
            Join room
          </button>
          <button
            id="create-room-tab"
            type="button"
            role="tab"
            aria-selected={mode === 'create'}
            aria-controls="create-room-panel"
            className={mode === 'create' ? 'tab active' : 'tab'}
            onClick={() => selectMode('create')}
            onKeyDown={handleTabKey}
          >
            Create room
          </button>
        </div>

        {mode === 'join' ? (
          <form
            id="join-room-panel"
            className="access-form"
            role="tabpanel"
            aria-labelledby="join-room-tab"
            onSubmit={joinRoom}
            noValidate
            aria-busy={busy}
          >
            <label htmlFor="room-code">Room code or invitation link</label>
            <input
              id="room-code"
              value={roomCode}
              onChange={(event) => {
                setRoomCode(event.target.value)
                setError('')
              }}
              autoComplete="off"
              autoCapitalize="characters"
              inputMode="text"
              spellCheck={false}
              placeholder="e.g. ABCD-EFGH-JK…"
              aria-describedby={roomCodeDescription}
              aria-invalid={error ? true : undefined}
              autoFocus
            />
            <p className="field-help" id="room-code-help">
              You can paste a full invitation link. The key stays in the URL fragment and is not sent to the server.
            </p>
            <button className="primary-button" type="submit" disabled={busy || roomCode.trim() === ''}>
              {busy ? 'Establishing encrypted session…' : 'Join room'}
            </button>
          </form>
        ) : (
          <form
            id="create-room-panel"
            className="access-form"
            role="tabpanel"
            aria-labelledby="create-room-tab"
            onSubmit={(event) => {
              event.preventDefault()
              void createSecureRoom()
            }}
            aria-busy={busy}
          >
            <label htmlFor="room-retention">Room lifetime</label>
            <select
              id="room-retention"
              value={ttlSeconds}
              disabled={busy}
              onChange={(event) => setTtlSeconds(Number(event.target.value))}
            >
              <option value={24 * 60 * 60}>24 hours</option>
              <option value={7 * 24 * 60 * 60}>7 days</option>
              <option value={30 * 24 * 60 * 60}>30 days</option>
            </select>
            <p className="field-help">
              This room expires after {roomLifetime}. Messages are retained for up to seven days, or until the room
              expires if sooner.
            </p>
            <button className="primary-button" type="submit" disabled={busy}>
              {busy ? 'Creating…' : 'Create secure room'}
            </button>
          </form>
        )}

        {error && <p className="form-error" id="access-error" role="alert">{error}</p>}

        <div className="trust-strip">
          <span className="status-dot secure" aria-hidden="true" />
          <span>Content encrypted on this device</span>
          <span aria-hidden="true">·</span>
          <span>Server handles ciphertext only</span>
        </div>
        </div>
      </section>

      <footer className="access-footer">
        <span>No analytics scripts or external fonts</span>
        <span>Protocol version 2</span>
      </footer>

      {showSecurity && (
        <SecurityDialog title="Security boundaries" onClose={() => setShowSecurity(false)}>
          <ul className="security-list">
            <li>Messages, filenames, and attachments are encrypted in the browser before upload.</li>
            <li>The server can still observe necessary metadata such as connection times, IP addresses, and traffic sizes.</li>
            <li>Anyone with the room code can join and decrypt. This version does not provide member revocation or forward secrecy.</li>
            <li>Use a trusted device and verify the room code through an independent trusted channel.</li>
          </ul>
        </SecurityDialog>
      )}
    </main>
  )
}
