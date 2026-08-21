import { Clock3, FileKey2, LockKeyhole, MessageSquareText, Moon, ShieldCheck, Sun } from 'lucide-react'
import { useState, type FormEvent } from 'react'

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
import { SecurityDialog } from './SecurityDialog'
import { Badge } from './ui/badge'
import { Button } from './ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from './ui/card'
import { Input } from './ui/input'
import { NativeSelect } from './ui/native-select'
import { Tabs, TabsContent, TabsList, TabsTrigger } from './ui/tabs'

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
          <span className="brand-mark" aria-hidden="true"><LockKeyhole /></span>
          <span>
            <span className="brand-name">SecretGram</span>
            <span className="brand-tagline">Private rooms. Zero accounts.</span>
          </span>
        </div>
        <div className="product-actions">
          <Button
            variant="ghost"
            size="sm"
            type="button"
            aria-label={`Switch to ${theme === 'night' ? 'day' : 'night'} theme`}
            onClick={onToggleTheme}
          >
            {theme === 'night' ? <Sun /> : <Moon />}
            <span className="desktop-action-label">{theme === 'night' ? 'Light' : 'Dark'}</span>
          </Button>
          <Button
            variant="ghost"
            size="sm"
            type="button"
            aria-label="Security details"
            onClick={() => setShowSecurity(true)}
          >
            <ShieldCheck />
            <span className="desktop-action-label">Security</span>
          </Button>
        </div>
      </header>

      <section className="access-panel" aria-labelledby="access-title">
        <div className="access-intro">
          <Badge variant="outline" className="eyebrow">
            <ShieldCheck />
            End-to-end encrypted
          </Badge>
          <h1 id="access-title">
            Share what matters.
            <span>Keep it between you.</span>
          </h1>
          <p>
            Temporary rooms for private messages and files. Encryption happens in your browser,
            before anything reaches the server.
          </p>
          <div className="intro-trust" aria-label="Room privacy highlights">
            <span><MessageSquareText /> Encrypted messages</span>
            <span><FileKey2 /> Private attachments</span>
            <span><Clock3 /> Automatic expiry</span>
          </div>
          <div className="security-visual" aria-hidden="true">
            <div className="security-visual-glow" />
            <div className="security-visual-card">
              <span className="security-visual-icon"><LockKeyhole /></span>
              <strong>Content encrypted on this device</strong>
              <span>Only room participants hold the key</span>
              <div className="cipher-lines"><i /><i /><i /></div>
            </div>
          </div>
        </div>

        <Card className="access-controls">
          <CardHeader>
            <CardTitle>{mode === 'join' ? 'Join an encrypted room' : 'Create an encrypted room'}</CardTitle>
            <CardDescription>
              {mode === 'join'
                ? 'Use a secure invitation link, or enter a room ID and password.'
                : 'Choose how long the room stays available.'}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Tabs
              value={mode}
              onValueChange={(value) => {
                if (value === 'join' || value === 'create') selectMode(value)
              }}
            >
              <TabsList className="tabs" aria-label="Room actions">
                <TabsTrigger id="join-room-tab" value="join">Join room</TabsTrigger>
                <TabsTrigger id="create-room-tab" value="create">Create room</TabsTrigger>
              </TabsList>

              <TabsContent value="join">
                {mode === 'join' && (
                  <form
                    id="join-room-panel"
                    className="access-form"
                    onSubmit={joinRoom}
                    noValidate
                    aria-busy={busy}
                  >
                    <div className="field-group">
                      <label htmlFor="room-id">Room ID or invitation link</label>
                      <Input
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
                        placeholder="Paste a link or enter /r/AB12CD"
                        aria-describedby={roomIdDescription}
                        aria-invalid={error ? true : undefined}
                        autoFocus
                      />
                      <p className="field-help" id="room-id-help">
                        {invitationKey === undefined
                          ? 'Without a secure link, enter the room password below.'
                          : 'Secure invitation key loaded. No password is needed.'}
                      </p>
                    </div>
                    <div className="field-group">
                      <label htmlFor="join-room-password">Room password</label>
                      <Input
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
                    </div>
                    <Button className="primary-button" size="lg" type="submit" disabled={busy || roomId.trim() === ''}>
                      <LockKeyhole />
                      {busy ? 'Establishing encrypted session…' : 'Join room'}
                    </Button>
                  </form>
                )}
              </TabsContent>

              <TabsContent value="create">
                {mode === 'create' && (
                  <form
                    id="create-room-panel"
                    className="access-form"
                    onSubmit={(event) => {
                      event.preventDefault()
                      void createSecureRoom()
                    }}
                    aria-busy={busy}
                  >
                    <div className="field-group">
                      <label htmlFor="room-retention">Room lifetime</label>
                      <NativeSelect
                        id="room-retention"
                        value={ttlSeconds}
                        disabled={busy}
                        onChange={(event) => setTtlSeconds(Number(event.target.value))}
                      >
                        <option value={24 * 60 * 60}>24 hours</option>
                        <option value={7 * 24 * 60 * 60}>7 days</option>
                        <option value={30 * 24 * 60 * 60}>30 days</option>
                      </NativeSelect>
                      <p className="field-help">
                        This room expires after {roomLifetime}. Messages are retained for up to seven
                        days, or until the room expires if sooner.
                      </p>
                    </div>
                    <aside className="join-method-callout" role="note" aria-label="How participants join">
                      <ShieldCheck aria-hidden="true" />
                      <div>
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
                      </div>
                    </aside>
                    <div className="field-group">
                      <label htmlFor="create-room-password">Optional room password</label>
                      <Input
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
                    </div>
                    <div className="field-group">
                      <label htmlFor="confirm-room-password">Confirm password</label>
                      <Input
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
                    </div>
                    <Button className="primary-button" size="lg" type="submit" disabled={busy}>
                      <LockKeyhole />
                      {busy ? 'Creating…' : 'Create secure room'}
                    </Button>
                  </form>
                )}
              </TabsContent>
            </Tabs>

            {error && <p className="form-error" id="access-error" role="alert">{error}</p>}

            <div className="trust-strip">
              <span className="status-dot secure" aria-hidden="true" />
              <span>Browser-encrypted</span>
              <span aria-hidden="true">·</span>
              <span>Server sees ciphertext only</span>
            </div>
          </CardContent>
        </Card>
      </section>

      <footer className="access-footer">
        <span>No analytics or external fonts</span>
        <span>Protocol 3</span>
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
