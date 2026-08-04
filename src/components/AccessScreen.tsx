import { useState, type FormEvent, type KeyboardEvent } from 'react'

import { ApiError, createRoom, getRoomInfo } from '../lib/api'
import { createMessageSender } from '../lib/message-crypto'
import {
  ROOM_PASSWORD_MIN_LENGTH,
  deriveRoomKeyFromPassword,
  deriveRoomSecrets,
  generateRoomId,
  generateRoomKey,
  parseRoomInvitation,
  type RoomInvitation,
} from '../lib/room-crypto'
import type { ActiveRoomSession } from '../lib/session'
import { SecurityDialog, SecurityIcon } from './SecurityDialog'

interface AccessScreenProps {
  initialInvitation?: RoomInvitation | null
  onSession: (session: ActiveRoomSession) => void
  theme: 'day' | 'night'
  onToggleTheme: () => void
}

type AccessMode = 'join' | 'create'


function roomLifetimeLabel(ttlSeconds: number): string {
  if (ttlSeconds === 24 * 60 * 60) return '24 hours'
  if (ttlSeconds === 7 * 24 * 60 * 60) return '7 days'
  return '30 days'
}

export function AccessScreen({
  initialInvitation = null,
  onSession,
  theme,
  onToggleTheme,
}: AccessScreenProps) {
  const [mode, setMode] = useState<AccessMode>('join')
  const [roomId, setRoomId] = useState(initialInvitation?.roomId ?? '')
  const [invitationKey, setInvitationKey] = useState(initialInvitation?.roomKey)
  const [joinPassword, setJoinPassword] = useState('')
  const [createPassword, setCreatePassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [ttlSeconds, setTtlSeconds] = useState(7 * 24 * 60 * 60)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [showSecurity, setShowSecurity] = useState(false)
  const roomIdDescription = error && mode === 'join' ? 'room-id-help access-error' : 'room-id-help'
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
    let invitation: RoomInvitation
    try {
      invitation = parseRoomInvitation(roomId)
    } catch {
      setError('Invalid room ID. Use six letters or numbers, such as /r/AB12CD.')
      return
    }

    setBusy(true)
    try {
      const loadedKey = invitation.roomKey ?? invitationKey
      if (loadedKey === undefined && joinPassword === '') {
        setError('Enter the room password or use the full invitation link.')
        return
      }
      const roomKey = loadedKey ??
        await deriveRoomKeyFromPassword(invitation.roomId, joinPassword)
      const secrets = await deriveRoomSecrets(invitation.roomId, roomKey)
      const info = await getRoomInfo(secrets.locator, secrets.authToken)
      const deviceId = crypto.randomUUID()
      onSession({
        roomId: invitation.roomId,
        ...(loadedKey === undefined ? {} : { invitationKey: roomKey }),
        locator: secrets.locator,
        authToken: secrets.authToken,
        messageRoot: secrets.messageRoot,
        deviceId,
        sender: await createMessageSender(secrets.messageRoot, secrets.locator),
        expiresAt: info.expiresAt,
      })
    } catch {
      setError('Unable to join. Check the room ID and password, or confirm that the room is still active.')
    } finally {
      setBusy(false)
    }
  }

  async function createSecureRoom() {
    setError('')
    if (createPassword !== '' && createPassword.length < ROOM_PASSWORD_MIN_LENGTH) {
      setError(`Room password must contain at least ${ROOM_PASSWORD_MIN_LENGTH} characters.`)
      return
    }
    if (createPassword !== confirmPassword) {
      setError('The room passwords do not match.')
      return
    }
    setBusy(true)
    try {
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const generatedRoomId = generateRoomId()
        const generatedRoomKey = createPassword === ''
          ? generateRoomKey()
          : await deriveRoomKeyFromPassword(generatedRoomId, createPassword)
        const secrets = await deriveRoomSecrets(generatedRoomId, generatedRoomKey)
        try {
          const result = await createRoom(secrets.locator, secrets.authVerifier, ttlSeconds)
          const deviceId = crypto.randomUUID()
          onSession({
            roomId: generatedRoomId,
            ...(createPassword === '' ? { invitationKey: generatedRoomKey } : {}),
            locator: secrets.locator,
            authToken: secrets.authToken,
            messageRoot: secrets.messageRoot,
            deviceId,
            sender: await createMessageSender(secrets.messageRoot, secrets.locator),
            expiresAt: result.expiresAt,
          })
          return
        } catch (reason) {
          if (!(reason instanceof ApiError) || reason.code !== 'conflict') throw reason
        }
      }
      throw new Error('Unable to allocate a room ID')
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
          <span className="brand-mark" aria-hidden="true"><span>S</span></span>
          <span className="brand-name">SecretGram</span>
          <span className="brand-tagline">a quiet place to share</span>
        </div>
        <div className="product-actions">
          <button
            className="text-button"
            type="button"
            aria-label={`Switch to ${theme === 'night' ? 'day' : 'night'} theme`}
            onClick={onToggleTheme}
          >
            <span aria-hidden="true">{theme === 'night' ? '☀' : '☾'}</span>
            {theme === 'night' ? 'Day' : 'Night'}
          </button>
          <button
            className="text-button"
            type="button"
            aria-label="Security details"
            onClick={() => setShowSecurity(true)}
          >
            <SecurityIcon />
            Security
          </button>
        </div>
      </header>

      <section className="access-panel" aria-labelledby="access-title">
        <div className="access-intro">
          <div className="access-intro-copy">
            <p className="eyebrow">Private by design · peaceful by nature</p>
            <h1 id="access-title">{mode === 'join' ? 'Join an encrypted room' : 'Create an encrypted room'}</h1>
            <p>No account, no noise. Open a temporary room for messages and files that only participants can read.</p>
            <div className="intro-trust" aria-label="Room privacy highlights">
              <span>Encrypted here</span>
              <span>Temporary rooms</span>
              <span>No tracking</span>
            </div>
          </div>
          <div className="storybook-scene" aria-hidden="true">
            <span className="scene-sun" />
            <span className="scene-cloud cloud-one" />
            <span className="scene-cloud cloud-two" />
            <span className="scene-hill hill-back" />
            <span className="scene-hill hill-front" />
            <span className="scene-house"><i /></span>
            <span className="scene-path" />
            <span className="scene-leaf leaf-one" />
            <span className="scene-leaf leaf-two" />
          </div>
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
            <label htmlFor="room-id">Room ID or invitation link</label>
            <input
              id="room-id"
              value={roomId}
              onChange={(event) => {
                setRoomId(event.target.value)
                setInvitationKey(undefined)
                setError('')
              }}
              autoComplete="off"
              autoCapitalize="characters"
              inputMode="text"
              spellCheck={false}
              placeholder="e.g. /r/AB12CD"
              aria-describedby={roomIdDescription}
              aria-invalid={error ? true : undefined}
              autoFocus
            />
            <p className="field-help" id="room-id-help">
              {invitationKey === undefined
                ? 'Enter the optional room password, or paste the full secure invitation link.'
                : 'Secure invitation key loaded from the link; no password is needed.'}
            </p>
            <label htmlFor="join-room-password">Room password</label>
            <input
              id="join-room-password"
              type="password"
              value={joinPassword}
              disabled={invitationKey !== undefined || busy}
              onChange={(event) => {
                setJoinPassword(event.target.value)
                setError('')
              }}
              autoComplete="current-password"
              placeholder={invitationKey === undefined ? 'Required without a secure link' : 'Not needed'}
            />
            <button className="primary-button" type="submit" disabled={busy || roomId.trim() === ''}>
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
            <aside
              className="join-method-callout"
              role="note"
              aria-label="How participants join"
            >
              <strong>How participants join</strong>
              <dl>
                <div>
                  <dt>No password</dt>
                  <dd>Share the full invitation link. The six-character Room ID alone will not work.</dd>
                </div>
                <div>
                  <dt>With a password</dt>
                  <dd>Share the Room ID and password separately.</dd>
                </div>
              </dl>
            </aside>
            <label htmlFor="create-room-password">Optional room password</label>
            <input
              id="create-room-password"
              type="password"
              value={createPassword}
              disabled={busy}
              minLength={ROOM_PASSWORD_MIN_LENGTH}
              onChange={(event) => {
                setCreatePassword(event.target.value)
                setError('')
              }}
              autoComplete="new-password"
              placeholder={`At least ${ROOM_PASSWORD_MIN_LENGTH} characters`}
            />
            <label htmlFor="confirm-room-password">Confirm password</label>
            <input
              id="confirm-room-password"
              type="password"
              value={confirmPassword}
              disabled={busy || createPassword === ''}
              onChange={(event) => {
                setConfirmPassword(event.target.value)
                setError('')
              }}
              autoComplete="new-password"
              placeholder={createPassword === '' ? 'Not needed without a password' : 'Re-enter room password'}
            />
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
        <span>Room protocol 3</span>
      </footer>

      {showSecurity && (
        <SecurityDialog title="Security boundaries" onClose={() => setShowSecurity(false)}>
          <ul className="security-list">
            <li>Messages, filenames, and attachments are encrypted in the browser before upload.</li>
            <li>The server can still observe necessary metadata such as connection times, IP addresses, and traffic sizes.</li>
            <li>A six-character room ID is public and is not an encryption key.</li>
            <li>Join with the full secure link, or protect the room with a password shared separately.</li>
            <li>This version does not provide member revocation or forward secrecy.</li>
          </ul>
        </SecurityDialog>
      )}
    </main>
  )
}
