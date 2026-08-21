import {
  ArrowDown,
  CheckCheck,
  ChevronDown,
  CircleAlert,
  Copy,
  DoorOpen,
  Ellipsis,
  LoaderCircle,
  LockKeyhole,
  Moon,
  Paperclip,
  Pin,
  RefreshCw,
  Send,
  ShieldCheck,
  Sun,
  UserRoundPlus,
  X,
} from 'lucide-react'
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type ClipboardEvent,
  type DragEvent,
  type FormEvent,
  type KeyboardEvent,
  type UIEvent,
} from 'react'
import { toast } from 'sonner'

import { useRoomChannel } from '../hooks/useRoomChannel'
import { uploadEncryptedFile } from '../lib/file-transfer'
import { roomPath } from '../lib/room-crypto'
import type { ActiveRoomSession } from '../lib/session'
import { MAX_TEXT_CHARACTERS, type FileDescriptor, type PlainMessage } from '../shared/protocol'
import { Attachment } from './Attachment'
import { SecurityDialog } from './SecurityDialog'
import { Button } from './ui/button'
import { Input } from './ui/input'
import { Textarea } from './ui/textarea'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from './ui/dropdown-menu'
import { Toaster } from './ui/sonner'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from './ui/tooltip'

interface RoomWorkspaceProps {
  session: ActiveRoomSession
  onLeave: () => void
  theme: 'day' | 'night'
  onToggleTheme: () => void
}

interface TransferItem {
  id: string
  name: string
  size: number
  progress: number
  status: 'pending' | 'uploading' | 'failed'
  file?: File
  previewUrl?: string
  error?: string
}

const LOCAL_PREVIEW_LIMIT_BYTES = 16 * 1024 * 1024
const DROPDOWN_DIALOG_FOCUS_DELAY_MS = 25
const LOCAL_IMAGE_PREVIEW_TYPES: Record<string, true> = {
  'image/avif': true,
  'image/gif': true,
  'image/jpeg': true,
  'image/png': true,
  'image/webp': true,
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

function formatFileSize(bytes: number): string {
  if (bytes < 1_024) return `${bytes} B`
  if (bytes < 1_024 ** 2) return `${(bytes / 1_024).toFixed(1)} KB`
  return `${(bytes / 1_024 ** 2).toFixed(1)} MB`
}

function invitationLink(session: ActiveRoomSession): string {
  const url = new URL(window.location.href)
  url.pathname = roomPath(session.roomId)
  url.search = ''
  url.hash = session.invitationKey === undefined
    ? ''
    : new URLSearchParams({ key: session.invitationKey }).toString()
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
    pinnedMessageId,
    pinningMessageId,
    pinError,
    connectionError,
    sendPlainMessage,
    retryMessage,
    recallMessage,
    updatePin,
  } = useRoomChannel(session)
  const [draft, setDraft] = useState('')
  const [senderName, setSenderName] = useState(`Guest ${session.deviceId.slice(0, 4).toUpperCase()}`)
  const [composerError, setComposerError] = useState('')
  const [showInvite, setShowInvite] = useState(false)
  const [showSecurity, setShowSecurity] = useState(false)
  const [recallCandidateId, setRecallCandidateId] = useState<string | null>(null)
  const [editingName, setEditingName] = useState(false)
  const [showJumpToLatest, setShowJumpToLatest] = useState(false)
  const [transfers, setTransfers] = useState<TransferItem[]>([])
  const [isDraggingFiles, setIsDraggingFiles] = useState(false)
  const controllersRef = useRef(new Map<string, AbortController>())
  const transfersRef = useRef<TransferItem[]>([])
  const activeRef = useRef(true)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const timelineRef = useRef<HTMLDivElement>(null)
  const timelineAtBottomRef = useRef(true)
  const previousMessageCountRef = useRef(0)
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

  const pinnedMessage = useMemo(
    () => messages.find((message) =>
      message.id === pinnedMessageId &&
      message.recalledAt === undefined) ?? null,
    [messages, pinnedMessageId],
  )

  useEffect(() => {
    const hasNewMessage = messages.length > previousMessageCountRef.current
    previousMessageCountRef.current = messages.length
    if (!hasNewMessage) return
    if (timelineAtBottomRef.current) {
      window.requestAnimationFrame(() => {
        timelineEndRef.current?.scrollIntoView?.({ block: 'end' })
      })
      return
    }
    setShowJumpToLatest(true)
  }, [messages.length])

  useEffect(() => {
    transfersRef.current = transfers
  }, [transfers])

  useEffect(() => {
    activeRef.current = true
    const controllers = controllersRef.current
    return () => {
      activeRef.current = false
      for (const controller of controllers.values()) controller.abort()
      for (const transfer of transfersRef.current) {
        if (transfer.previewUrl) URL.revokeObjectURL(transfer.previewUrl)
      }
      transfersRef.current = []
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

  function scrollToLatest(behavior: ScrollBehavior = 'smooth') {
    timelineAtBottomRef.current = true
    setShowJumpToLatest(false)
    timelineEndRef.current?.scrollIntoView?.({ block: 'end', behavior })
  }

  function handleTimelineScroll(event: UIEvent<HTMLDivElement>) {
    const timeline = event.currentTarget
    const atBottom = timeline.scrollHeight - timeline.scrollTop - timeline.clientHeight < 80
    timelineAtBottomRef.current = atBottom
    if (atBottom) setShowJumpToLatest(false)
  }

  async function copy(value: string, label: string) {
    try {
      await copyText(value)
      toast.success(label)
    } catch {
      toast.error('Copy failed')
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
    timelineAtBottomRef.current = true
    setShowJumpToLatest(false)

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
  ) {
    for (const transfer of batch) {
      controllersRef.current.set(transfer.transferId, transfer.controller)
    }
    const ids = new Set(batch.map(({ transferId }) => transferId))
    setTransfers((current) => current.map((item) => ids.has(item.id)
      ? { ...item, progress: 0, status: 'uploading' as const, error: undefined }
      : item))

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
          setTransfers((current) => {
            const completed = current.find((item) => item.id === transferId)
            if (completed?.previewUrl) URL.revokeObjectURL(completed.previewUrl)
            return current.filter((item) => item.id !== transferId)
          })
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

  function queueFiles(files: File[]): Array<TransferItem & { file: File }> {
    const nextTransfers = files.map((file) => ({
      id: crypto.randomUUID(),
      name: file.name || 'Pasted file',
      size: file.size,
      progress: 0,
      status: 'pending' as const,
      file,
      ...(LOCAL_IMAGE_PREVIEW_TYPES[file.type] === true && file.size <= LOCAL_PREVIEW_LIMIT_BYTES
        ? { previewUrl: URL.createObjectURL(file) }
        : {}),
    }))
    if (nextTransfers.length > 0) {
      setTransfers((current) => [...current, ...nextTransfers])
    }
    return nextTransfers
  }

  function uploadSelectedFiles(event: ChangeEvent<HTMLInputElement>) {
    queueFiles([...(event.target.files ?? [])])
    event.target.value = ''
  }

  function sendPastedFiles(event: ClipboardEvent<HTMLTextAreaElement>) {
    const itemFiles = [...event.clipboardData.items]
      .filter((item) => item.kind === 'file')
      .map((item) => item.getAsFile())
      .filter((file): file is File => file !== null)
    const files = itemFiles.length > 0 ? itemFiles : [...event.clipboardData.files]
    if (files.length === 0) return
    event.preventDefault()
    const pastedTransfers = queueFiles(files)
    void uploadFiles(pastedTransfers.map((transfer) => ({
      file: transfer.file,
      transferId: transfer.id,
      controller: new AbortController(),
    })))
  }

  function queueDroppedFiles(event: DragEvent<HTMLFormElement>) {
    event.preventDefault()
    setIsDraggingFiles(false)
    queueFiles([...event.dataTransfer.files])
  }

  function cancelTransfer(id: string) {
    controllersRef.current.get(id)?.abort()
  }

  function removeTransfer(id: string) {
    setTransfers((current) => {
      const removed = current.find((item) => item.id === id)
      if (removed?.previewUrl) URL.revokeObjectURL(removed.previewUrl)
      return current.filter((item) => item.id !== id)
    })
  }

  function retryTransfer(id: string) {
    const transfer = transfers.find((item) => item.id === id)
    if (transfer?.file === undefined) return
    void uploadFiles([{
      file: transfer.file,
      transferId: transfer.id,
      controller: new AbortController(),
    }])
  }

  function leaveRoom() {
    if (
      transfers.some((transfer) => transfer.status === 'pending' || transfer.status === 'uploading') &&
      !window.confirm('Attachments are pending or uploading. Leaving the room will discard them. Continue?')
    ) {
      return
    }
    for (const controller of controllersRef.current.values()) controller.abort()
    for (const transfer of transfersRef.current) {
      if (transfer.previewUrl) URL.revokeObjectURL(transfer.previewUrl)
    }
    transfersRef.current = []
    onLeave()
  }

  const activeUploadCount = transfers.filter((transfer) => transfer.status === 'uploading').length
  const hasActiveUploads = activeUploadCount > 0

  const hasPendingFiles = transfers.some((transfer) => transfer.status === 'pending')

  return (
    <TooltipProvider>
      <main className="room-shell">
        <header className="room-bar">
          <div className="room-identity">
            <div className="brand-mark compact" aria-hidden="true"><LockKeyhole /></div>
            <div className="room-heading">
              <div className="room-title-line">
                <h1>Secure room</h1>
                <span className="room-privacy-label"><ShieldCheck /> End-to-end encrypted</span>
              </div>
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
            <Button variant="default" size="sm" type="button" onClick={() => setShowInvite(true)}>
              <UserRoundPlus />
              <span>Invite</span>
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon-sm" type="button" aria-label="Room menu">
                  <Ellipsis />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuLabel>Room settings</DropdownMenuLabel>
                <DropdownMenuItem
                  onSelect={() => {
                    window.setTimeout(() => setShowSecurity(true), DROPDOWN_DIALOG_FOCUS_DELAY_MS)
                  }}
                >
                  <ShieldCheck />
                  Security and retention
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={onToggleTheme}>
                  {theme === 'night' ? <Sun /> : <Moon />}
                  Switch to {theme === 'night' ? 'light' : 'dark'} theme
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem destructive onSelect={leaveRoom}>
                  <DoorOpen />
                  Leave room
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </header>

        {connectionError && (
          <div className="connection-notice" role="status">
            <CircleAlert aria-hidden="true" />
            <span>{connectionError}</span>
            {(connectionError.includes('Leave the room') || connectionError.includes('leave the room')) && (
              <Button variant="outline" size="sm" type="button" onClick={leaveRoom}>
                Back to access
              </Button>
            )}
          </div>
        )}

        <section className={isDraggingFiles ? 'workspace is-dragging' : 'workspace'}>
          <div
            ref={timelineRef}
            className="timeline"
            aria-label="Encrypted messages"
            onScroll={handleTimelineScroll}
          >
            <div className="timeline-content">
              {pinnedMessage !== null && (
                <aside className="pinned-message" aria-label="Pinned message">
                  <span className="pinned-icon" aria-hidden="true"><Pin /></span>
                  <button
                    type="button"
                    className="pinned-summary"
                    aria-label="Jump to pinned message"
                    onClick={() => {
                      document.getElementById(`message-${pinnedMessage.id}`)?.scrollIntoView({
                        block: 'center',
                        behavior: 'smooth',
                      })
                    }}
                  >
                    <span className="pinned-context">
                      <span className="pinned-eyebrow">Pinned</span>
                      <span aria-hidden="true">·</span>
                      <strong>{pinnedMessage.content?.senderName ?? 'Unverified sender'}</strong>
                    </span>
                    <span className="pinned-preview">
                      {pinnedMessage.content?.kind === 'text'
                        ? pinnedMessage.content.text
                        : pinnedMessage.content?.kind === 'file'
                          ? `Attachment: ${pinnedMessage.content.file.name}`
                          : 'Message could not be verified'}
                    </span>
                  </button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="pinned-remove"
                    aria-label="Unpin message"
                    disabled={pinningMessageId !== null}
                    onClick={() => void updatePin(pinnedMessage.id, false)}
                  >
                    {pinningMessageId === pinnedMessage.id ? 'Working…' : 'Unpin'}
                  </Button>
                </aside>
              )}
              {pinError && <p className="pin-error" role="alert">{pinError}</p>}
              {messages.length === 0 && (
                <div className="empty-state">
                  <span className="empty-illustration" aria-hidden="true"><i /></span>
                  <span className="empty-mark">End-to-end encrypted</span>
                  <h2>Your room is ready</h2>
                  <p>Invite someone you trust, then send the first encrypted message or attachment.</p>
                  <Button className="empty-action" size="sm" type="button" onClick={() => setShowInvite(true)}>
                    <UserRoundPlus />
                    Invite people
                  </Button>
                </div>
              )}

              {messages.map((message, index) => {
                const own = message.senderId === session.deviceId
                const content = message.content
                const recalled = message.recalledAt !== undefined
                const pinned = pinnedMessageId === message.id
                const displayTimestamp =
                  message.recalledAt ?? content?.clientCreatedAt ?? message.serverCreatedAt ?? Date.now()
                const previous = messages[index - 1]
                const previousTimestamp = previous === undefined
                  ? 0
                  : previous.recalledAt ??
                    previous.content?.clientCreatedAt ??
                    previous.serverCreatedAt ??
                    0
                const grouped = previous !== undefined &&
                  previous.senderId === message.senderId &&
                  previous.recalledAt === undefined &&
                  !recalled &&
                  displayTimestamp - previousTimestamp < 5 * 60 * 1_000
                const senderLabel =
                  content?.senderName ?? (recalled ? own ? 'You' : 'A participant' : 'Unverified sender')
                return (
                  <article
                    className={`${own ? 'message own' : 'message'}${pinned ? ' is-pinned' : ''}${grouped ? ' grouped' : ''}${content?.kind === 'file' ? ' has-attachment' : ''}`}
                    id={`message-${message.id}`}
                    key={message.id}
                  >
                    <div className="message-meta">
                      {grouped ? (
                        <span className="visually-hidden">{senderLabel}</span>
                      ) : (
                        <>
                          <strong>{senderLabel}</strong>
                          {own && <span className="own-label">This device</span>}
                        </>
                      )}
                      {pinned && (
                        <span className="message-pinned-label">
                          <Pin />
                          Pinned
                        </span>
                      )}
                      <time dateTime={new Date(displayTimestamp).toISOString()}>
                        {formatTime(displayTimestamp)}
                      </time>
                      {!recalled && message.delivery === 'stored' && content !== null && (
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button
                              className="message-actions-trigger"
                              variant="ghost"
                              size="icon-sm"
                              type="button"
                              aria-label={`Message actions for ${senderLabel}`}
                            >
                              <Ellipsis />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align={own ? 'end' : 'start'}>
                            <DropdownMenuItem
                              disabled={pinningMessageId !== null}
                              onSelect={() => void updatePin(message.id, !pinned)}
                            >
                              <Pin />
                              {pinningMessageId === message.id
                                ? pinned ? 'Unpinning…' : 'Pinning…'
                                : pinned ? 'Unpin' : 'Pin'}
                            </DropdownMenuItem>
                            {own && message.recallToken !== undefined && (
                              <DropdownMenuItem
                                destructive
                                disabled={message.recalling}
                                onSelect={() => {
                                  window.setTimeout(
                                    () => setRecallCandidateId(message.id),
                                    DROPDOWN_DIALOG_FOCUS_DELAY_MS,
                                  )
                                }}
                              >
                                <RefreshCw />
                                {message.recalling ? 'Recalling…' : 'Recall'}
                              </DropdownMenuItem>
                            )}
                          </DropdownMenuContent>
                        </DropdownMenu>
                      )}
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
                      {recalled && <span>{own ? 'Recalled for everyone' : 'Recalled by sender'}</span>}
                      {!recalled && message.delivery === 'sending' && (
                        <span className="message-delivery-status"><LoaderCircle className="spinning" /> Sending</span>
                      )}
                      {!recalled && message.delivery === 'stored' && (
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <span className="message-delivery-status">
                              <CheckCheck />
                              Stored
                              <span className="visually-hidden">Ciphertext stored by server</span>
                            </span>
                          </TooltipTrigger>
                          <TooltipContent>Ciphertext stored by the server</TooltipContent>
                        </Tooltip>
                      )}
                      {!recalled && message.delivery === 'failed' && (
                        <>
                          <span className="message-delivery-status"><CircleAlert /> {message.error ?? 'Send failed'}</span>
                          <Button variant="ghost" size="sm" type="button" onClick={() => retryMessage(message.id)}>
                            <RefreshCw />
                            Retry
                          </Button>
                        </>
                      )}
                      {own && content !== null && message.error && (
                        <span className="recall-error">{message.error}</span>
                      )}
                    </div>
                  </article>
                )
              })}

              <div ref={timelineEndRef} />
            </div>
            {showJumpToLatest && (
              <Button
                type="button"
                size="sm"
                className="jump-to-latest"
                onClick={() => scrollToLatest()}
              >
                <ArrowDown />
                Jump to latest
              </Button>
            )}
          </div>

          <form
            className="composer"
            onSubmit={submitText}
            onDragEnter={(event) => {
              if (event.dataTransfer.types.includes('Files')) setIsDraggingFiles(true)
            }}
            onDragOver={(event) => {
              if (!event.dataTransfer.types.includes('Files')) return
              event.preventDefault()
              event.dataTransfer.dropEffect = 'copy'
            }}
            onDragLeave={(event) => {
              if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setIsDraggingFiles(false)
            }}
            onDrop={queueDroppedFiles}
          >
            <div className="drop-hint" aria-hidden={!isDraggingFiles}>
              <Paperclip />
              <span>Drop files to attach them</span>
            </div>
            <div className="composer-inner">
              <div className="composer-identity">
                <Button
                  className="identity-chip"
                  variant="ghost"
                  size="sm"
                  type="button"
                  aria-label="Change display name"
                  aria-expanded={editingName}
                  onClick={() => setEditingName((value) => !value)}
                >
                  <span className="identity-avatar" aria-hidden="true">
                    {(senderName.trim()[0] ?? '?').toUpperCase()}
                  </span>
                  <span>Writing as <strong>{senderName.trim() || 'Anonymous guest'}</strong></span>
                  <ChevronDown />
                </Button>
                <span className="identity-note">Encrypted, not identity-verified</span>
              </div>
              {editingName && (
                <div className="identity-editor">
                  <label htmlFor="sender-name">Display name</label>
                  <Input
                    id="sender-name"
                    className="sender-input"
                    value={senderName}
                    maxLength={40}
                    autoFocus
                    onChange={(event) => setSenderName(event.target.value)}
                  />
                  <Button variant="secondary" size="sm" type="button" onClick={() => setEditingName(false)}>
                    Done
                  </Button>
                </div>
              )}
              {transfers.length > 0 && (
                <section className="attachment-tray" aria-label="Attachment activity" aria-live="polite">
                  <div className="attachment-tray-heading">
                    <strong>
                      {hasActiveUploads
                        ? `Sending ${activeUploadCount} attachment${activeUploadCount === 1 ? '' : 's'}`
                        : hasPendingFiles
                          ? `${transfers.length} attachment${transfers.length === 1 ? '' : 's'} ready`
                          : `${transfers.length} attachment${transfers.length === 1 ? '' : 's'} need attention`}
                    </strong>
                    <span>
                      {hasActiveUploads
                        ? 'Encrypting in this browser'
                        : hasPendingFiles
                          ? 'Ready to send'
                          : 'Retry or remove'}
                    </span>
                  </div>
                  <div className="attachment-tray-items">
                    {transfers.map((transfer) => (
                      <article className={`transfer-card ${transfer.status}`} key={transfer.id}>
                        {transfer.previewUrl ? (
                          <img className="transfer-thumbnail" src={transfer.previewUrl} alt="" />
                        ) : (
                          <span className="transfer-glyph" aria-hidden="true">FILE</span>
                        )}
                        <div className="transfer-copy">
                          <strong title={transfer.name}>{transfer.name}</strong>
                          <span>
                            {formatFileSize(transfer.size)} · {transfer.status === 'pending'
                              ? 'Ready'
                              : transfer.status === 'uploading'
                                ? `Encrypting and uploading · ${Math.round(transfer.progress * 100)}%`
                                : transfer.error}
                          </span>
                          {transfer.status === 'uploading' && (
                            <progress max={1} value={transfer.progress} aria-label={`${transfer.name} upload progress`} />
                          )}
                        </div>
                        <div className="transfer-actions">
                          {transfer.status === 'uploading' && (
                            <Button
                              variant="ghost"
                              size="sm"
                              type="button"
                              aria-label={`Cancel ${transfer.name} upload`}
                              onClick={() => cancelTransfer(transfer.id)}
                            >
                              Cancel
                            </Button>
                          )}
                          {transfer.status === 'failed' && transfer.file !== undefined && (
                            <Button
                              variant="ghost"
                              size="sm"
                              type="button"
                              aria-label={`Retry ${transfer.name} upload`}
                              onClick={() => retryTransfer(transfer.id)}
                            >
                              <RefreshCw />
                              Retry
                            </Button>
                          )}
                          {transfer.status !== 'uploading' && (
                            <Button
                              variant="ghost"
                              size="icon-sm"
                              type="button"
                              aria-label={`Remove ${transfer.name}`}
                              onClick={() => removeTransfer(transfer.id)}
                            >
                              <X />
                            </Button>
                          )}
                        </div>
                      </article>
                    ))}
                  </div>
                </section>
              )}
              <div className="composer-box">
                <input
                  ref={fileInputRef}
                  className="visually-hidden"
                  type="file"
                  multiple
                  aria-label="Choose attachments"
                  onChange={uploadSelectedFiles}
                />
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      className="attachment-button"
                      variant="ghost"
                      size="icon"
                      type="button"
                      aria-label="Add attachment"
                      onClick={() => fileInputRef.current?.click()}
                    >
                      <Paperclip />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>Add attachments</TooltipContent>
                </Tooltip>
                <Textarea
                  ref={composerTextareaRef}
                  className="composer-textarea"
                  value={draft}
                  maxLength={MAX_TEXT_CHARACTERS}
                  rows={1}
                  placeholder={hasPendingFiles ? 'Add a note, or send the files as they are…' : 'Write an encrypted message…'}
                  aria-label="Message"
                  aria-describedby="composer-help composer-count"
                  onChange={(event) => setDraft(event.target.value)}
                  onPaste={sendPastedFiles}
                  onKeyDown={handleComposerKey}
                />
                <Button className="send-button" type="submit" disabled={!draft.trim() && !hasPendingFiles}>
                  <span>{hasPendingFiles && !draft.trim() ? 'Send files' : 'Send'}</span>
                  <Send />
                </Button>
              </div>
              <div className="composer-footer" id="composer-help">
                <span>Enter to send · Shift+Enter for a new line · Paste files to send instantly</span>
                <span
                  className={draft.length > MAX_TEXT_CHARACTERS * 0.9 ? 'composer-count nearing-limit' : 'composer-count'}
                  id="composer-count"
                >
                  {draft.length}/{MAX_TEXT_CHARACTERS}
                </span>
              </div>
              {composerError && <p className="inline-error" role="alert">{composerError}</p>}
            </div>
          </form>
        </section>

        {showInvite && (
          <SecurityDialog
            title="Invite to this room"
            className="invite-dialog"
            onClose={() => setShowInvite(false)}
          >
            <p className="invite-dialog-intro">
              Share access only with people you trust. The server never receives the room secret.
            </p>
            <div className="invite-room-id">
              <div>
                <span>Room ID</span>
                <code className="room-id">{roomPath(session.roomId)}</code>
              </div>
              <Button
                variant="outline"
                size="icon"
                type="button"
                aria-label="Copy room ID"
                onClick={() => copy(roomPath(session.roomId), 'Room ID copied')}
              >
                <Copy />
              </Button>
            </div>
            <div className="invite-method">
              <ShieldCheck aria-hidden="true" />
              <p>
                {session.invitationKey === undefined
                  ? 'Share this room ID and send the password separately.'
                  : 'The invitation link carries the encryption key in its URL fragment. Send it through a trusted channel.'}
              </p>
            </div>
            <Button
              className="invite-primary-action"
              type="button"
              onClick={() => copy(invitationLink(session), 'Invitation link copied')}
            >
              <Copy />
              Copy invitation link
            </Button>
          </SecurityDialog>
        )}

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
            <Button
              type="button"
              variant="outline"
              onClick={() => setRecallCandidateId(null)}
            >
              Keep message
            </Button>
            <Button
              type="button"
              variant="destructive"
              onClick={() => {
                const messageId = recallCandidateId
                setRecallCandidateId(null)
                void recallMessage(messageId)
              }}
            >
              Recall for everyone
            </Button>
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
            <div><dt>Identity model</dt><dd>Public room ID plus a secure link or password; display names and device labels are not authenticated identities</dd></div>
            <div><dt>Visible metadata</dt><dd>The server can observe IP addresses, connection times, traffic sizes, and online session counts</dd></div>
          </dl>
          <p className="security-warning">This version does not provide forward secrecy, individual member revocation, or enterprise SSO.</p>
        </SecurityDialog>
      )}
        <Toaster theme={theme === 'night' ? 'dark' : 'light'} richColors />
      </main>
    </TooltipProvider>
  )
}
