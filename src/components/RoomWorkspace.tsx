import {
  Check,
  CheckCheck,
  ChevronDown,
  CircleAlert,
  Clipboard,
  Copy,
  DoorOpen,
  Ellipsis,
  FileText,
  Files,
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
  type CSSProperties,
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

type ResourceFilter = 'all' | 'file' | 'text'

const LOCAL_PREVIEW_LIMIT_BYTES = 16 * 1024 * 1024
const DROPDOWN_DIALOG_FOCUS_DELAY_MS = 25
const TEXT_LIST_PREVIEW_CHARACTERS = 180
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
  if (bytes < 1_024 ** 3) return `${(bytes / 1_024 ** 2).toFixed(1)} MB`
  return `${(bytes / 1_024 ** 3).toFixed(1)} GB`
}

function senderHue(senderId: string): number {
  let hash = 0
  for (const character of senderId) hash = (hash * 31 + character.charCodeAt(0)) >>> 0
  return hash % 360
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
  const [transfers, setTransfers] = useState<TransferItem[]>([])
  const [isDraggingFiles, setIsDraggingFiles] = useState(false)
  const [resourceFilter, setResourceFilter] = useState<ResourceFilter>('all')
  const [selectedResourceId, setSelectedResourceId] = useState<string | null>(null)
  const [mobileDetailOpen, setMobileDetailOpen] = useState(false)
  const [newItemCount, setNewItemCount] = useState(0)
  const controllersRef = useRef(new Map<string, AbortController>())
  const transfersRef = useRef<TransferItem[]>([])
  const activeRef = useRef(true)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const resourceListRef = useRef<HTMLDivElement>(null)
  const resourceListAtTopRef = useRef(true)
  const previousMessageCountRef = useRef(0)
  const composerTextareaRef = useRef<HTMLTextAreaElement>(null)

  const credentials = useMemo(
    () => ({
      locator: session.locator,
      token: session.authToken,
      deviceId: session.deviceId,
    }),
    [session.authToken, session.deviceId, session.locator],
  )

  const orderedResources = useMemo(() => [...messages].sort((left, right) => {
    const leftPinned = left.id === pinnedMessageId
    const rightPinned = right.id === pinnedMessageId
    if (leftPinned !== rightPinned) return leftPinned ? -1 : 1
    const leftTime = left.recalledAt ?? left.content?.clientCreatedAt ?? left.serverCreatedAt ?? 0
    const rightTime = right.recalledAt ?? right.content?.clientCreatedAt ?? right.serverCreatedAt ?? 0
    return rightTime - leftTime
  }), [messages, pinnedMessageId])

  const visibleResources = useMemo(() => orderedResources.filter((message) => {
    if (resourceFilter === 'all') return true
    if (message.recalledAt !== undefined) return false
    return message.content?.kind === resourceFilter
  }), [orderedResources, resourceFilter])

  const selectedResource = useMemo(
    () => visibleResources.find((message) => message.id === selectedResourceId) ?? null,
    [selectedResourceId, visibleResources],
  )

  const resourceCounts = useMemo(() => ({
    all: orderedResources.length,
    file: orderedResources.filter((message) =>
      message.recalledAt === undefined && message.content?.kind === 'file').length,
    text: orderedResources.filter((message) =>
      message.recalledAt === undefined && message.content?.kind === 'text').length,
  }), [orderedResources])

  useEffect(() => {
    const addedCount = Math.max(0, messages.length - previousMessageCountRef.current)
    previousMessageCountRef.current = messages.length
    if (addedCount === 0) return
    if (resourceListAtTopRef.current) {
      window.requestAnimationFrame(() => resourceListRef.current?.scrollTo?.({ top: 0 }))
      return
    }
    setNewItemCount((current) => current + addedCount)
  }, [messages.length])

  useEffect(() => {
    if (visibleResources.length === 0) {
      setSelectedResourceId(null)
      setMobileDetailOpen(false)
      return
    }
    if (!visibleResources.some((message) => message.id === selectedResourceId)) {
      setSelectedResourceId(visibleResources[0].id)
    }
  }, [selectedResourceId, visibleResources])

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
    textarea.style.height = `${Math.min(textarea.scrollHeight, 132)}px`
  }, [draft])

  function selectResource(messageId: string) {
    setSelectedResourceId(messageId)
    setMobileDetailOpen(true)
  }

  function showNewestResources() {
    resourceListAtTopRef.current = true
    setNewItemCount(0)
    resourceListRef.current?.scrollTo?.({ top: 0, behavior: 'smooth' })
  }

  function handleResourceListScroll(event: UIEvent<HTMLDivElement>) {
    const atTop = event.currentTarget.scrollTop < 48
    resourceListAtTopRef.current = atTop
    if (atTop) setNewItemCount(0)
  }

  async function copy(value: string, label: string) {
    try {
      await copyText(value)
      toast.success(label, { icon: <Check aria-hidden="true" /> })
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
    resourceListAtTopRef.current = true
    setNewItemCount(0)

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
        setSelectedResourceId(message.id)
      } catch {
        setDraft(text)
        setComposerError('The text could not be encrypted or shared. Try again.')
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
    if (
      event.key === 'Enter' &&
      (event.metaKey || event.ctrlKey) &&
      !event.nativeEvent.isComposing
    ) {
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
    setSelectedResourceId(message.id)
  }

  async function uploadFiles(
    batch: Array<{ file: File; transferId: string; controller: AbortController }>,
  ) {
    for (const transfer of batch) controllersRef.current.set(transfer.transferId, transfer.controller)
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
          setTransfers((current) => current.map((item) => item.id === transferId
            ? {
                ...item,
                status: 'failed',
                error: aborted ? 'Upload canceled' : error instanceof Error ? error.message : 'Upload failed',
              }
            : item))
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
    if (nextTransfers.length > 0) setTransfers((current) => [...current, ...nextTransfers])
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
      !window.confirm('Files are pending or uploading. Leaving the room will discard them. Continue?')
    ) return
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
                <h1>Encrypted sharing room</h1>
                <span className="room-privacy-label"><ShieldCheck /> Browser encrypted</span>
              </div>
              <div className="room-status" aria-live="polite">
                <span className={`status-dot ${status}`} aria-hidden="true" />
                <span>{statusLabel(status)}</span>
                {status === 'connected' && (
                  <span>· {onlineCount} online device{onlineCount === 1 ? '' : 's'}</span>
                )}
              </div>
            </div>
          </div>
          <div className="room-actions">
            <Button variant="default" size="sm" type="button" aria-label="Invite" onClick={() => setShowInvite(true)}>
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
          <form
            className="share-panel"
            aria-label="Share files and text"
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
              <Files />
              <strong>Drop files to add them</strong>
              <span>They stay in this browser until you share them.</span>
            </div>
            <div className="share-panel-topline">
              <div>
                <h2>Share files or clipboard text</h2>
                <p>Encrypted here before anything leaves this device.</p>
              </div>
              <div className="share-identity">
                <Button
                  className="identity-chip"
                  variant="ghost"
                  size="sm"
                  type="button"
                  aria-label="Change display name"
                  aria-expanded={editingName}
                  onClick={() => setEditingName((value) => !value)}
                >
                  <span
                    className="identity-avatar"
                    style={{ '--sender-hue': senderHue(session.deviceId) } as CSSProperties}
                    aria-hidden="true"
                  >
                    {(senderName.trim()[0] ?? '?').toUpperCase()}
                  </span>
                  <span>Sharing as <strong>{senderName.trim() || 'Anonymous guest'}</strong></span>
                  <ChevronDown />
                </Button>
                <span className="identity-note">Name is not identity-verified</span>
              </div>
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
              <section className="attachment-tray" aria-label="File activity" aria-live="polite">
                <div className="attachment-tray-heading">
                  <strong>
                    {hasActiveUploads
                      ? `Sharing ${activeUploadCount} file${activeUploadCount === 1 ? '' : 's'}`
                      : hasPendingFiles
                        ? `${transfers.length} file${transfers.length === 1 ? '' : 's'} ready`
                        : `${transfers.length} file${transfers.length === 1 ? '' : 's'} need attention`}
                  </strong>
                  <span>
                    {hasActiveUploads
                      ? 'Encrypting in this browser'
                      : hasPendingFiles
                        ? 'Ready to share'
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

            <div className="share-input-row">
              <input
                ref={fileInputRef}
                className="visually-hidden"
                type="file"
                multiple
                aria-label="Choose files"
                onChange={uploadSelectedFiles}
              />
              <Button
                className="file-pick-button"
                variant="secondary"
                type="button"
                onClick={() => fileInputRef.current?.click()}
              >
                <Paperclip />
                Add files
              </Button>
              <div className="share-text-field">
                <Clipboard aria-hidden="true" />
                <Textarea
                  ref={composerTextareaRef}
                  className="share-textarea"
                  value={draft}
                  maxLength={MAX_TEXT_CHARACTERS}
                  rows={1}
                  placeholder={hasPendingFiles ? 'Add optional clipboard text…' : 'Paste text or write a short note…'}
                  aria-label="Shared text"
                  aria-describedby="share-help share-count"
                  onChange={(event) => setDraft(event.target.value)}
                  onPaste={sendPastedFiles}
                  onKeyDown={handleComposerKey}
                />
              </div>
              <Button
                className="share-button"
                type="submit"
                aria-label={hasPendingFiles && !draft.trim() ? 'Share files' : 'Share'}
                disabled={!draft.trim() && !hasPendingFiles}
              >
                <span>{hasPendingFiles && !draft.trim() ? 'Share files' : 'Share'}</span>
                <Send />
              </Button>
            </div>
            <div className="share-footer" id="share-help">
              <span>Drop or paste files anywhere here · Ctrl/⌘ + Enter to share text</span>
              <span
                className={draft.length > MAX_TEXT_CHARACTERS * 0.9 ? 'share-count nearing-limit' : 'share-count'}
                id="share-count"
              >
                {draft.length}/{MAX_TEXT_CHARACTERS}
              </span>
            </div>
            {composerError && <p className="inline-error" role="alert">{composerError}</p>}
          </form>

          <div className="resource-browser">
            <aside className="resource-rail" aria-label="Shared resources">
              <div className="resource-toolbar">
                <div>
                  <h2>Shared items</h2>
                  <span>{resourceCounts.all} total</span>
                </div>
                <div className="resource-filters" role="tablist" aria-label="Filter shared items">
                  {(['all', 'file', 'text'] as const).map((filter) => (
                    <button
                      type="button"
                      role="tab"
                      aria-selected={resourceFilter === filter}
                      className={resourceFilter === filter ? 'active' : ''}
                      key={filter}
                      onClick={() => setResourceFilter(filter)}
                    >
                      {filter === 'all' ? 'All' : filter === 'file' ? 'Files' : 'Text'}
                      <span>{resourceCounts[filter]}</span>
                    </button>
                  ))}
                </div>
              </div>

              <div
                ref={resourceListRef}
                className="resource-list"
                onScroll={handleResourceListScroll}
              >
                {newItemCount > 0 && (
                  <Button className="new-items-button" type="button" size="sm" onClick={showNewestResources}>
                    {newItemCount} new item{newItemCount === 1 ? '' : 's'}
                  </Button>
                )}
                {visibleResources.length === 0 && (
                  <div className="resource-empty-state">
                    <span aria-hidden="true">{resourceFilter === 'file' ? <Files /> : resourceFilter === 'text' ? <Clipboard /> : <LockKeyhole />}</span>
                    <h3>{resourceCounts.all === 0 ? 'Nothing shared yet' : `No ${resourceFilter} items`}</h3>
                    <p>
                      {resourceCounts.all === 0
                        ? 'Add files or paste text above. Every item is encrypted in this browser.'
                        : 'Choose another filter to see the rest of this room.'}
                    </p>
                  </div>
                )}

                {visibleResources.map((message) => {
                  const own = message.senderId === session.deviceId
                  const content = message.content
                  const recalled = message.recalledAt !== undefined
                  const pinned = pinnedMessageId === message.id
                  const selected = selectedResourceId === message.id
                  const timestamp = message.recalledAt ?? content?.clientCreatedAt ?? message.serverCreatedAt ?? Date.now()
                  const senderLabel = content?.senderName ?? (recalled ? own ? 'You' : 'A participant' : 'Unverified sender')
                  const senderStyle = { '--sender-hue': senderHue(message.senderId) } as CSSProperties
                  return (
                    <article
                      className={`resource-item${selected ? ' selected' : ''}${pinned ? ' pinned' : ''}${recalled ? ' recalled' : ''}`}
                      style={senderStyle}
                      key={message.id}
                    >
                      <button
                        className="resource-select"
                        type="button"
                        aria-current={selected ? 'true' : undefined}
                        onClick={() => selectResource(message.id)}
                      >
                        <span className="resource-avatar" aria-hidden="true">
                          {(senderLabel[0] ?? '?').toUpperCase()}
                        </span>
                        <span className="resource-item-main">
                          <span className="resource-meta">
                            <strong>{senderLabel}</strong>
                            {own && <span className="own-label">This device</span>}
                            <time dateTime={new Date(timestamp).toISOString()}>{formatTime(timestamp)}</time>
                          </span>
                          {recalled ? (
                            <span className="resource-summary removed-summary">
                              <RefreshCw />
                              <span><strong>Removed item</strong><small>Removed by sender</small></span>
                            </span>
                          ) : content?.kind === 'file' ? (
                            <span className="resource-summary">
                              <Attachment
                                descriptor={content.file}
                                credentials={credentials}
                                presentation="thumbnail"
                              />
                              <span>
                                <strong title={content.file.name}>{content.file.name}</strong>
                                <small>{formatFileSize(content.file.size)} · encrypted file</small>
                              </span>
                            </span>
                          ) : content?.kind === 'text' ? (
                            <span className="resource-text-summary">
                              “{content.text.slice(0, TEXT_LIST_PREVIEW_CHARACTERS)}{content.text.length > TEXT_LIST_PREVIEW_CHARACTERS ? '…' : ''}”
                            </span>
                          ) : (
                            <span className="resource-summary removed-summary">
                              <CircleAlert />
                              <span><strong>Could not verify item</strong><small>{message.error}</small></span>
                            </span>
                          )}
                          <span className={`resource-delivery ${message.delivery}`}>
                            {pinned && <span><Pin /> Pinned</span>}
                            {!recalled && message.delivery === 'sending' && <span><LoaderCircle className="spinning" /> Sharing</span>}
                            {!recalled && message.delivery === 'stored' && <span><CheckCheck /> Stored</span>}
                            {!recalled && message.delivery === 'failed' && <span><CircleAlert /> Share failed</span>}
                          </span>
                        </span>
                      </button>

                      {!recalled && content?.kind === 'text' && (
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <Button
                              className="resource-copy-button"
                              variant="ghost"
                              size="icon-sm"
                              type="button"
                              aria-label={`Copy text from ${senderLabel}`}
                              onClick={() => copy(content.text, 'Text copied')}
                            >
                              <Copy />
                            </Button>
                          </TooltipTrigger>
                          <TooltipContent>Copy text</TooltipContent>
                        </Tooltip>
                      )}

                      {!recalled && message.delivery === 'stored' && content !== null && (
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button
                              className="resource-actions-trigger"
                              variant="ghost"
                              size="icon-sm"
                              type="button"
                              aria-label={`Resource actions for ${senderLabel}`}
                            >
                              <Ellipsis />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end">
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
                                <X />
                                {message.recalling ? 'Removing…' : 'Remove from room'}
                              </DropdownMenuItem>
                            )}
                          </DropdownMenuContent>
                        </DropdownMenu>
                      )}
                    </article>
                  )
                })}
              </div>
            </aside>

            <section className={`resource-detail${mobileDetailOpen ? ' mobile-open' : ''}`} aria-label="Selected shared item">
              <Button
                className="mobile-detail-close"
                variant="ghost"
                size="icon"
                type="button"
                aria-label="Back to shared items"
                onClick={() => setMobileDetailOpen(false)}
              >
                <X />
              </Button>
              {selectedResource === null ? (
                <div className="detail-empty-state">
                  <span aria-hidden="true"><Files /></span>
                  <h2>Select an item to preview</h2>
                  <p>Files decrypt only in this browser. Text stays ready to copy.</p>
                </div>
              ) : (() => {
                const content = selectedResource.content
                const own = selectedResource.senderId === session.deviceId
                const recalled = selectedResource.recalledAt !== undefined
                const pinned = selectedResource.id === pinnedMessageId
                const timestamp = selectedResource.recalledAt ?? content?.clientCreatedAt ?? selectedResource.serverCreatedAt ?? Date.now()
                const senderLabel = content?.senderName ?? (recalled ? own ? 'You' : 'A participant' : 'Unverified sender')
                return (
                  <div className="resource-detail-inner" key={selectedResource.id}>
                    <header className="resource-detail-header">
                      <div className="detail-sender" style={{ '--sender-hue': senderHue(selectedResource.senderId) } as CSSProperties}>
                        <span className="resource-avatar" aria-hidden="true">{(senderLabel[0] ?? '?').toUpperCase()}</span>
                        <span>
                          <strong>{senderLabel}</strong>
                          <small>{own ? 'This device · identity not verified' : 'Identity not verified'}</small>
                        </span>
                      </div>
                      <div className="detail-meta">
                        {pinned && <span><Pin /> Pinned</span>}
                        <time dateTime={new Date(timestamp).toISOString()}>{formatTime(timestamp)}</time>
                      </div>
                    </header>

                    {pinError && <p className="pin-error" role="alert">{pinError}</p>}

                    {recalled ? (
                      <div className="detail-removed-state">
                        <RefreshCw aria-hidden="true" />
                        <h2>Item removed from this room</h2>
                        <p>The sender used their removal capability. The ordered notice remains visible to everyone.</p>
                      </div>
                    ) : content?.kind === 'text' ? (
                      <div className="shared-text-detail">
                        <div className="detail-content-heading">
                          <div>
                            <FileText aria-hidden="true" />
                            <span><strong>Clipboard text</strong><small>{content.text.length.toLocaleString()} characters</small></span>
                          </div>
                          <Button type="button" onClick={() => copy(content.text, 'Text copied')}>
                            <Copy />
                            Copy text
                          </Button>
                        </div>
                        <pre tabIndex={0} dir="auto">{content.text}</pre>
                      </div>
                    ) : content?.kind === 'file' ? (
                      <div className="shared-file-detail">
                        {content.caption && <p className="file-caption">{content.caption}</p>}
                        <Attachment
                          key={selectedResource.id}
                          descriptor={content.file}
                          credentials={credentials}
                          presentation="viewer"
                        />
                      </div>
                    ) : (
                      <div className="detail-removed-state error">
                        <CircleAlert aria-hidden="true" />
                        <h2>Could not verify this item</h2>
                        <p>{selectedResource.error}</p>
                      </div>
                    )}

                    {!recalled && (
                      <footer className="resource-detail-footer">
                        <div className={`resource-detail-status ${selectedResource.delivery}`}>
                          {selectedResource.delivery === 'sending' && <><LoaderCircle className="spinning" /> Sharing encrypted item…</>}
                          {selectedResource.delivery === 'stored' && <><CheckCheck /> Ciphertext stored by server</>}
                          {selectedResource.delivery === 'failed' && <><CircleAlert /> {selectedResource.error ?? 'Share failed'}</>}
                        </div>
                        <div className="resource-detail-actions">
                          {selectedResource.delivery === 'failed' && (
                            <Button variant="outline" size="sm" type="button" onClick={() => retryMessage(selectedResource.id)}>
                              <RefreshCw />
                              Retry
                            </Button>
                          )}
                          {selectedResource.delivery === 'stored' && content !== null && (
                            <Button
                              variant="outline"
                              size="sm"
                              type="button"
                              disabled={pinningMessageId !== null}
                              onClick={() => void updatePin(selectedResource.id, !pinned)}
                            >
                              <Pin />
                              {pinned ? 'Unpin selected item' : 'Pin selected item'}
                            </Button>
                          )}
                          {own && selectedResource.recallToken !== undefined && (
                            <Button
                              variant="ghost"
                              size="sm"
                              type="button"
                              className="danger"
                              disabled={selectedResource.recalling}
                              onClick={() => setRecallCandidateId(selectedResource.id)}
                            >
                              <X />
                              {selectedResource.recalling ? 'Removing…' : 'Remove selected item'}
                            </Button>
                          )}
                        </div>
                      </footer>
                    )}
                  </div>
                )
              })()}
            </section>
          </div>
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
            title="Remove item from room?"
            className="recall-dialog"
            onClose={() => setRecallCandidateId(null)}
          >
            <p>
              This removes the encrypted item from the room and leaves an ordered removal notice
              for everyone. This cannot be undone.
            </p>
            <div className="recall-dialog-actions">
              <Button type="button" variant="outline" onClick={() => setRecallCandidateId(null)}>
                Keep item
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
                Remove for everyone
              </Button>
            </div>
          </SecurityDialog>
        )}

        {showSecurity && (
          <SecurityDialog title="Security and retention" onClose={() => setShowSecurity(false)}>
            <dl className="security-facts">
              <div><dt>Text encryption</dt><dd>AES-256-GCM with a separate key and monotonic nonce for every sending session</dd></div>
              <div><dt>File encryption</dt><dd>Chunked AES-256-GCM; previews are generated only after local decryption</dd></div>
              <div><dt>Item retention</dt><dd>Encrypted items are retained for up to seven days, or until the room expires if sooner</dd></div>
              <div><dt>Room expires</dt><dd>{new Date(session.expiresAt).toLocaleString('en-US')}</dd></div>
              <div><dt>Identity model</dt><dd>Public room ID plus a secure link or password; display names and device colors are not authenticated identities</dd></div>
              <div><dt>Visible metadata</dt><dd>The server can observe IP addresses, connection times, traffic sizes, and online device counts</dd></div>
            </dl>
            <p className="security-warning">This version does not provide forward secrecy, individual member revocation, or enterprise SSO.</p>
          </SecurityDialog>
        )}
        <Toaster theme={theme === 'night' ? 'dark' : 'light'} richColors />
      </main>
    </TooltipProvider>
  )
}
