import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type ClipboardEvent,
  type FormEvent,
  type KeyboardEvent,
} from 'react'

import { useRoomChannel } from '../hooks/useRoomChannel'
import { uploadEncryptedFile } from '../lib/file-transfer'
import type { ActiveRoomSession } from '../lib/session'
import { MAX_TEXT_CHARACTERS, type FileDescriptor, type PlainMessage } from '../shared/protocol'
import { Attachment } from './Attachment'
import { SecurityDialog } from './SecurityDialog'

interface RoomWorkspaceProps {
  session: ActiveRoomSession
  onLeave: () => void
  theme: 'day' | 'night'
  onToggleTheme: () => void
}

interface TransferItem {
  id: string
  name: string
  progress: number
  status: 'pending' | 'uploading' | 'failed'
  file?: File
  error?: string
}

function statusLabel(status: ReturnType<typeof useRoomChannel>['status']): string {
  if (status === 'connected') return 'Connected'
  if (status === 'reconnecting') return 'Reconnecting'
  if (status === 'offline') return 'Offline'
  return 'Connecting'
}

function formatTime(timestamp: number): string {
  try {
    return new Intl.DateTimeFormat('en-US', {
      hour: '2-digit',
      minute: '2-digit',
    }).format(timestamp)
  } catch {
    return 'Unknown time'
  }
}

function invitationLink(roomCode: string): string {
  const url = new URL(window.location.href)
  url.search = ''
  url.hash = new URLSearchParams({ room: roomCode }).toString()
  return url.toString()
}

async function copyText(value: string): Promise<void> {
  if (navigator.clipboard?.writeText !== undefined) {
    await navigator.clipboard.writeText(value)
    return
  }
  const input = document.createElement('textarea')
  input.value = value
  input.style.position = 'fixed'
  input.style.opacity = '0'
  document.body.append(input)
  input.select()
  document.execCommand('copy')
  input.remove()
}

export function RoomWorkspace({ session, onLeave, theme, onToggleTheme }: RoomWorkspaceProps) {
  const {
    messages,
    status,
    onlineCount,
    connectionError,
    sendPlainMessage,
    retryMessage,
    recallMessage,
  } = useRoomChannel(session)
  const [draft, setDraft] = useState('')
  const [senderName, setSenderName] = useState(`Guest ${session.deviceId.slice(0, 4).toUpperCase()}`)
  const [composerError, setComposerError] = useState('')
  const [showInvite, setShowInvite] = useState(false)
  const [showCode, setShowCode] = useState(false)
  const [showSecurity, setShowSecurity] = useState(false)
  const [recallCandidateId, setRecallCandidateId] = useState<string | null>(null)
  const [copied, setCopied] = useState('')
  const [transfers, setTransfers] = useState<TransferItem[]>([])
  const controllersRef = useRef(new Map<string, AbortController>())
  const activeRef = useRef(true)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const timelineEndRef = useRef<HTMLDivElement>(null)
  const composerTextareaRef = useRef<HTMLTextAreaElement>(null)

  const credentials = useMemo(
    () => ({
      locator: session.locator,
      token: session.authToken,
      deviceId: session.deviceId,
    }),
    [session.authToken, session.deviceId, session.locator],
  )

  useEffect(() => {
    timelineEndRef.current?.scrollIntoView?.({ block: 'end' })
  }, [messages.length, transfers.length])

  useEffect(() => {
    activeRef.current = true
    const controllers = controllersRef.current
    return () => {
      activeRef.current = false
      for (const controller of controllers.values()) controller.abort()
    }
  }, [])

  useEffect(() => {
    composerTextareaRef.current?.focus()
  }, [])

  useEffect(() => {
    const textarea = composerTextareaRef.current
    if (textarea === null) return
    textarea.style.height = 'auto'
    textarea.style.height = `${Math.min(textarea.scrollHeight, 150)}px`
  }, [draft])

  async function copy(value: string, label: string) {
    try {
      await copyText(value)
      setCopied(label)
      window.setTimeout(() => setCopied(''), 2_000)
    } catch {
      setCopied('Copy failed')
    }
  }

  async function submitText(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const text = draft.trim()
    const pending = transfers.filter(
      (transfer): transfer is TransferItem & { file: File } =>
        transfer.status === 'pending' && transfer.file !== undefined,
    )
    if (!text && pending.length === 0) return
    setComposerError('')

    if (text) {
      setDraft('')
      const message: PlainMessage = {
        version: 1,
        id: crypto.randomUUID(),
        senderId: session.deviceId,
        senderName: senderName.trim() || 'Anonymous guest',
        clientCreatedAt: Date.now(),
        kind: 'text',
        text,
      }
      try {
        await sendPlainMessage(message)
      } catch {
        setDraft(text)
        setComposerError('The message could not be encrypted or sent. Try again.')
      }
    }

    if (pending.length > 0) {
      await uploadFiles(
        pending.map(({ id, file }) => ({
          file,
          transferId: id,
          controller: new AbortController(),
        })),
        false,
      )
    }
  }

  function handleComposerKey(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault()
      event.currentTarget.form?.requestSubmit()
    }
  }

  async function sendFileMessage(descriptor: FileDescriptor) {
    const message: PlainMessage = {
      version: 1,
      id: crypto.randomUUID(),
      senderId: session.deviceId,
      senderName: senderName.trim() || 'Anonymous guest',
      clientCreatedAt: Date.now(),
      kind: 'file',
      file: descriptor,
    }
    await sendPlainMessage(message)
  }

  async function uploadFiles(
    batch: Array<{ file: File; transferId: string; controller: AbortController }>,
    addTransfers: boolean,
  ) {
    for (const transfer of batch) {
      controllersRef.current.set(transfer.transferId, transfer.controller)
    }
    setTransfers((current) => {
      if (addTransfers) {
        return [
          ...current,
          ...batch.map(({ file, transferId }) => ({
            id: transferId,
            name: file.name || 'Pasted file',
            progress: 0,
            status: 'uploading' as const,
          })),
        ]
      }
      const ids = new Set(batch.map(({ transferId }) => transferId))
      return current.map((item) => ids.has(item.id)
        ? { ...item, progress: 0, status: 'uploading' as const, file: undefined }
        : item)
    })

    for (const { file, transferId, controller } of batch) {
      if (controller.signal.aborted || !activeRef.current) {
        controllersRef.current.delete(transferId)
        continue
      }
      try {
        const descriptor = await uploadEncryptedFile(file, credentials, {
          signal: controller.signal,
          onProgress: ({ completedBytes, totalBytes, completedChunks, totalChunks }) => {
            const progress = totalBytes === 0
              ? completedChunks / totalChunks
              : completedBytes / totalBytes
            setTransfers((current) =>
              current.map((item) => item.id === transferId ? { ...item, progress } : item),
            )
          },
        })
        if (controller.signal.aborted || !activeRef.current) continue
        await sendFileMessage(descriptor)
        if (activeRef.current) {
          setTransfers((current) => current.filter((item) => item.id !== transferId))
        }
      } catch (error) {
        const aborted = controller.signal.aborted
        if (activeRef.current) {
          setTransfers((current) =>
            current.map((item) => item.id === transferId
              ? {
                  ...item,
                  status: 'failed',
                  error: aborted ? 'Upload canceled' : error instanceof Error ? error.message : 'Upload failed',
                }
              : item),
          )
        }
      } finally {
        controllersRef.current.delete(transferId)
      }
    }
  }

  async function uploadSelectedFiles(event: ChangeEvent<HTMLInputElement>) {
    const files = [...(event.target.files ?? [])]
    event.target.value = ''
    await uploadFiles(
      files.map((file) => ({
        file,
        transferId: crypto.randomUUID(),
        controller: new AbortController(),
      })),
      true,
    )
  }

  function queuePastedFiles(event: ClipboardEvent<HTMLTextAreaElement>) {
    const itemFiles = [...event.clipboardData.items]
      .filter((item) => item.kind === 'file')
      .map((item) => item.getAsFile())
      .filter((file): file is File => file !== null)
    const files = itemFiles.length > 0 ? itemFiles : [...event.clipboardData.files]
    if (files.length === 0) return
    event.preventDefault()
    setTransfers((current) => [
      ...current,
      ...files.map((file) => ({
        id: crypto.randomUUID(),
        name: file.name || 'Pasted file',
        progress: 0,
        status: 'pending' as const,
        file,
      })),
    ])
  }

  function cancelTransfer(id: string) {
    controllersRef.current.get(id)?.abort()
  }

  function leaveRoom() {
    if (
      transfers.some((transfer) => transfer.status === 'pending' || transfer.status === 'uploading') &&
      !window.confirm('Attachments are pending or uploading. Leaving the room will discard them. Continue?')
    ) {
      return
    }
    for (const controller of controllersRef.current.values()) controller.abort()
    onLeave()
  }

  const hasPendingFiles = transfers.some((transfer) => transfer.status === 'pending')

  return (
    <main className="room-shell">
      <header className="room-bar">
        <div className="room-identity">
          <div className="brand-mark compact" aria-hidden="true">SG</div>
          <div>
            <h1>Secure room</h1>
            <div className="room-status" aria-live="polite">
              <span className={`status-dot ${status}`} aria-hidden="true" />
              <span>{statusLabel(status)}</span>
              {status === 'connected' && (
                <span>· {onlineCount} online session{onlineCount === 1 ? '' : 's'}</span>
              )}
            </div>
          </div>
        </div>
        <div className="room-actions">
          <button className="small-button" type="button" onClick={() => setShowInvite((value) => !value)}>
            Invite
          </button>
          <button
            className="small-button"
            type="button"
            aria-label={`Switch to ${theme === 'night' ? 'day' : 'night'} theme`}
            onClick={onToggleTheme}
          >
            {theme === 'night' ? 'Day' : 'Night'}
          </button>
          <button className="small-button" type="button" onClick={() => setShowSecurity(true)}>
            Security
          </button>
          <button
            className="small-button danger"
            type="button"
            aria-label="Leave room"
            onClick={leaveRoom}
          >
            Leave
          </button>
        </div>
      </header>

      {showInvite && (
        <section className="invite-banner" aria-labelledby="invite-title">
          <div className="invite-copy">
            <div>
              <p className="eyebrow" id="invite-title">Invitation credential</p>
              <code className={showCode ? 'room-code' : 'room-code masked'}>
                {showCode ? session.roomCode : '••••-••••-••••-••••-••••-••••-••'}
              </code>
            </div>
            <p>Anyone with this credential can join and decrypt. Share it through a trusted channel.</p>
          </div>
          <div className="invite-actions">
            <button className="small-button" type="button" onClick={() => setShowCode((value) => !value)}>
              {showCode ? 'Hide' : 'Show'}
            </button>
            <button
              className="small-button"
              type="button"
              aria-label="Copy room code"
              onClick={() => copy(session.roomCode, 'Room code copied')}
            >
              Copy room code
            </button>
            <button
              className="small-button"
              type="button"
              onClick={() => copy(invitationLink(session.roomCode), 'Invitation link copied')}
            >
              Copy invitation link
            </button>
            {copied && <span className="copy-status" role="status">{copied}</span>}
            <button
              className="close-button"
              type="button"
              aria-label="Close invitation banner"
              onClick={() => setShowInvite(false)}
            >
              ×
            </button>
          </div>
        </section>
      )}
      {connectionError && (
        <div className="connection-notice" role="status">
          <span>{connectionError}</span>
          {(connectionError.includes('Leave the room') || connectionError.includes('leave the room')) && (
            <button className="inline-button" type="button" onClick={leaveRoom}>
              Back to access
            </button>
          )}
        </div>
      )}

      <section className="workspace">
        <div className="timeline" aria-label="Encrypted messages">
          {messages.length === 0 && transfers.length === 0 && (
            <div className="empty-state">
              <span className="empty-mark" aria-hidden="true">E2EE</span>
              <h2>Your room is ready</h2>
              <p>Share the invitation link, then send the first encrypted message or attachment.</p>
              {!showInvite && (
                <button className="inline-button empty-action" type="button" onClick={() => setShowInvite(true)}>
                  Show invitation
                </button>
              )}
            </div>
          )}

          {messages.map((message) => {
            const own = message.senderId === session.deviceId
            const content = message.content
            const recalled = message.recalledAt !== undefined
            const displayTimestamp =
              message.recalledAt ?? content?.clientCreatedAt ?? message.serverCreatedAt ?? Date.now()
            return (
              <article className={own ? 'message own' : 'message'} key={message.id}>
                <div className="message-meta">
                  <strong>
                    {content?.senderName ?? (recalled ? own ? 'You' : 'A participant' : 'Unverified sender')}
                  </strong>
                  {own && <span className="own-label">This device</span>}
                  <time dateTime={new Date(displayTimestamp).toISOString()}>
                    {formatTime(displayTimestamp)}
                  </time>
                </div>
                <div className={recalled ? 'message-body recalled' : 'message-body'}>
                  {recalled && <p className="recalled-message">Message recalled</p>}
                  {!recalled && content?.kind === 'text' && <p>{content.text}</p>}
                  {!recalled && content?.kind === 'file' && (
                    <>
                      {content.caption && <p>{content.caption}</p>}
                      <Attachment descriptor={content.file} credentials={credentials} />
                    </>
                  )}
                  {!recalled && content === null && <p className="integrity-error">{message.error}</p>}
                </div>
                <div className={`delivery ${message.delivery}`}>
                  {recalled && (own ? 'Recalled for everyone' : 'Recalled by sender')}
                  {!recalled && message.delivery === 'sending' && 'Sending'}
                  {!recalled && message.delivery === 'stored' && (
                    <>
                      <span>Ciphertext stored by server</span>
                      {own && message.recallToken !== undefined && (
                        <button
                          type="button"
                          className="inline-button recall-button"
                          disabled={message.recalling}
                          onClick={() => setRecallCandidateId(message.id)}
                        >
                          {message.recalling ? 'Recalling…' : 'Recall'}
                        </button>
                      )}
                      {own && content !== null && message.error && (
                        <span className="recall-error">{message.error}</span>
                      )}
                    </>
                  )}
                  {!recalled && message.delivery === 'failed' && (
                    <>
                      <span>{message.error ?? 'Send failed'}</span>
                      <button type="button" className="inline-button" onClick={() => retryMessage(message.id)}>
                        Retry
                      </button>
                    </>
                  )}
                </div>
              </article>
            )
          })}

          {transfers.map((transfer) => (
            <article className={`transfer-card ${transfer.status}`} key={transfer.id}>
              <div>
                <strong>{transfer.name}</strong>
                <span>
                  {transfer.status === 'pending'
                    ? 'Pending to send'
                    : transfer.status === 'uploading' ? 'Encrypting locally and uploading' : transfer.error}
                </span>
              </div>
              {transfer.status === 'uploading' ? (
                <>
                  <progress max={1} value={transfer.progress} aria-label={`${transfer.name} upload progress`} />
                  <button className="inline-button" type="button" onClick={() => cancelTransfer(transfer.id)}>Cancel</button>
                </>
              ) : (
                <button
                  className="inline-button"
                  type="button"
                  onClick={() => setTransfers((current) => current.filter((item) => item.id !== transfer.id))}
                >
                  Remove
                </button>
              )}
            </article>
          ))}
          <div ref={timelineEndRef} />
        </div>

        <form className="composer" onSubmit={submitText}>
          <div className="composer-context">
            <label htmlFor="sender-name">Room display name</label>
            <input
              id="sender-name"
              value={senderName}
              maxLength={40}
              onChange={(event) => setSenderName(event.target.value)}
            />
            <span>Sent only inside encrypted messages; this is not a verified identity</span>
          </div>
          <div className="composer-row">
            <input
              ref={fileInputRef}
              className="visually-hidden"
              type="file"
              multiple
              aria-label="Choose attachments"
              onChange={uploadSelectedFiles}
            />
            <button
              className="attachment-button"
              type="button"
              aria-label="Add attachment"
              onClick={() => fileInputRef.current?.click()}
            >
              +
            </button>
            <textarea
              ref={composerTextareaRef}
              value={draft}
              maxLength={MAX_TEXT_CHARACTERS}
              rows={1}
              placeholder="Type an encrypted message…"
              aria-label="Message"
              aria-describedby="composer-help composer-count"
              onChange={(event) => setDraft(event.target.value)}
              onPaste={queuePastedFiles}
              onKeyDown={handleComposerKey}
            />
            <button className="send-button" type="submit" disabled={!draft.trim() && !hasPendingFiles}>
              Send
            </button>
          </div>
          <div className="composer-footer" id="composer-help">
            <span>Enter to send · Shift+Enter for a new line · Paste files to queue</span>
            <span id="composer-count">{draft.length}/{MAX_TEXT_CHARACTERS}</span>
          </div>
          {composerError && <p className="inline-error" role="alert">{composerError}</p>}
        </form>
      </section>

      {recallCandidateId !== null && (
        <SecurityDialog
          title="Recall message?"
          className="recall-dialog"
          onClose={() => setRecallCandidateId(null)}
        >
          <p>
            This removes the encrypted message from the room and replaces it with a recall notice
            for everyone. This cannot be undone.
          </p>
          <div className="recall-dialog-actions">
            <button
              type="button"
              className="small-button"
              onClick={() => setRecallCandidateId(null)}
            >
              Keep message
            </button>
            <button
              type="button"
              className="small-button danger"
              onClick={() => {
                const messageId = recallCandidateId
                setRecallCandidateId(null)
                void recallMessage(messageId)
              }}
            >
              Recall for everyone
            </button>
          </div>
        </SecurityDialog>
      )}

      {showSecurity && (
        <SecurityDialog title="Security and retention" onClose={() => setShowSecurity(false)}>
          <dl className="security-facts">
            <div><dt>Message encryption</dt><dd>AES-256-GCM with a separate key and monotonic nonce for every sending session</dd></div>
            <div><dt>Attachment encryption</dt><dd>Chunked AES-256-GCM; previews are generated only after local decryption</dd></div>
            <div><dt>Message retention</dt><dd>Encrypted messages are retained for up to seven days, or until the room expires if sooner</dd></div>
            <div><dt>Room expires</dt><dd>{new Date(session.expiresAt).toLocaleString('en-US')}</dd></div>
            <div><dt>Identity model</dt><dd>Shared room code, no accounts; display names and device labels are not authenticated identities</dd></div>
            <div><dt>Visible metadata</dt><dd>The server can observe IP addresses, connection times, traffic sizes, and online session counts</dd></div>
          </dl>
          <p className="security-warning">This version does not provide forward secrecy, individual member revocation, or enterprise SSO.</p>
        </SecurityDialog>
      )}
    </main>
  )
}
