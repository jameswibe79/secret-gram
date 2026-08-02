import { useCallback, useEffect, useRef, useState } from 'react'

import {
  ApiError,
  createSocketTicket,
  getRoomMessages,
  postRoomMessage,
  roomWebSocketUrl,
} from '../lib/api'
import { decryptMessage, encryptMessage } from '../lib/message-crypto'
import type { ActiveRoomSession } from '../lib/session'
import {
  webSocketServerFrameSchema,
  type ClientMessageEnvelope,
  type PlainMessage,
  type StoredMessageEnvelope,
} from '../shared/protocol'

export type ConnectionStatus = 'connecting' | 'connected' | 'reconnecting' | 'offline'
export type DeliveryStatus = 'sending' | 'stored' | 'failed'

export interface TimelineMessage {
  id: string
  envelope: ClientMessageEnvelope
  sequence: number | null
  serverCreatedAt: number | null
  content: PlainMessage | null
  delivery: DeliveryStatus
  error?: string
}

interface PendingMessage {
  envelope: ClientMessageEnvelope
  content: PlainMessage
}

function sortTimeline(messages: TimelineMessage[]): TimelineMessage[] {
  return [...messages].sort((left, right) => {
    if (left.sequence !== null && right.sequence !== null) return left.sequence - right.sequence
    if (left.sequence !== null) return -1
    if (right.sequence !== null) return 1
    const leftTime = left.content?.clientCreatedAt ?? 0
    const rightTime = right.content?.clientCreatedAt ?? 0
    return leftTime - rightTime
  })
}

export function mergeTimeline(
  current: TimelineMessage[],
  incoming: TimelineMessage,
): TimelineMessage[] {
  const index = current.findIndex((message) => message.id === incoming.id)
  if (index === -1) return sortTimeline([...current, incoming])
  const next = [...current]
  next[index] = {
    ...next[index],
    ...incoming,
  }
  return sortTimeline(next)
}

export async function drainRoomHistory(
  afterSequence: number,
  pageSize: number,
  fetchPage: (after: number, limit: number) => Promise<StoredMessageEnvelope[]>,
  applyMessage: (message: StoredMessageEnvelope) => Promise<void>,
  shouldStop: () => boolean = () => false,
): Promise<number> {
  let cursor = afterSequence
  for (;;) {
    const page = await fetchPage(cursor, pageSize)
    if (shouldStop()) return cursor

    let nextCursor = cursor
    for (const message of page) {
      if (shouldStop()) return nextCursor
      if (message.sequence <= cursor) continue
      await applyMessage(message)
      nextCursor = Math.max(nextCursor, message.sequence)
    }

    if (page.length < pageSize) return nextCursor
    if (nextCursor <= cursor) throw new Error('History cursor did not advance')
    cursor = nextCursor
  }
}

export function useRoomChannel(session: ActiveRoomSession) {
  const [messages, setMessages] = useState<TimelineMessage[]>([])
  const [status, setStatus] = useState<ConnectionStatus>('connecting')
  const [onlineCount, setOnlineCount] = useState(0)
  const [connectionError, setConnectionError] = useState('')
  const socketRef = useRef<WebSocket | null>(null)
  const pendingRef = useRef(new Map<string, PendingMessage>())
  const ackTimersRef = useRef(new Map<string, ReturnType<typeof setTimeout>>())
  const maxSequenceRef = useRef(0)

  const settlePending = useCallback((id: string) => {
    pendingRef.current.delete(id)
    const timer = ackTimersRef.current.get(id)
    if (timer !== undefined) clearTimeout(timer)
    ackTimersRef.current.delete(id)
  }, [])

  const applyStored = useCallback(
    async (stored: StoredMessageEnvelope) => {
      maxSequenceRef.current = Math.max(maxSequenceRef.current, stored.sequence)
      let content: PlainMessage | null = null
      let error: string | undefined
      try {
        content = await decryptMessage(session.messageRoot, session.locator, stored)
      } catch {
        error = 'The message could not be verified and may be damaged or tampered with.'
      }
      settlePending(stored.id)
      setMessages((current) =>
        mergeTimeline(current, {
          id: stored.id,
          envelope: stored,
          sequence: stored.sequence,
          serverCreatedAt: stored.serverCreatedAt,
          content,
          delivery: 'stored',
          error,
        }),
      )
    },
    [session.locator, session.messageRoot, settlePending],
  )

  const postPending = useCallback(
    async (pending: PendingMessage) => {
      try {
        const result = await postRoomMessage(
          session.locator,
          session.authToken,
          session.deviceId,
          pending.envelope,
        )
        await applyStored(result.message)
      } catch (error) {
        settlePending(pending.envelope.id)
        setMessages((current) => {
          const existing = current.find((message) => message.id === pending.envelope.id)
          if (existing === undefined) return current
          return mergeTimeline(current, {
            ...existing,
            delivery: 'failed',
            error: error instanceof Error ? error.message : 'Message delivery failed.',
          })
        })
      }
    },
    [applyStored, session.authToken, session.deviceId, session.locator, settlePending],
  )

  useEffect(() => {
    const ackTimers = ackTimersRef.current
    let stopped = false
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined
    let connectPromise: Promise<void> | null = null
    let connectionGeneration = 0
    let reconnectAttempt = 0
    let terminal = false
    const lifecycle = new AbortController()

    const syncHistory = () => drainRoomHistory(
      maxSequenceRef.current,
      100,
      (after, limit) => getRoomMessages(
        session.locator,
        session.authToken,
        after,
        limit,
        lifecycle.signal,
      ),
      applyStored,
      () => stopped,
    )

    const flushPending = async () => {
      for (const pending of [...pendingRef.current.values()]) {
        if (stopped) return
        await postPending(pending)
      }
    }

    const scheduleReconnect = () => {
      if (stopped || terminal || reconnectTimer !== undefined) return
      const currentSocket = socketRef.current
      if (currentSocket !== null && currentSocket.readyState < WebSocket.CLOSING) return
      setStatus(navigator.onLine === false ? 'offline' : 'reconnecting')
      const baseDelay = Math.min(30_000, 1_000 * 2 ** Math.min(reconnectAttempt, 5))
      reconnectAttempt += 1
      const delay = Math.round(baseDelay * (0.8 + Math.random() * 0.4))
      reconnectTimer = setTimeout(() => {
        reconnectTimer = undefined
        void startConnect()
      }, delay)
    }

    const connect = async (generation: number) => {
      if (stopped || generation !== connectionGeneration) return
      if (navigator.onLine === false) {
        setStatus('offline')
        return
      }
      setStatus(reconnectAttempt === 0 ? 'connecting' : 'reconnecting')
      setConnectionError('')
      try {
        await syncHistory()
        const ticket = await createSocketTicket(
          session.locator,
          session.authToken,
          session.deviceId,
          lifecycle.signal,
        )
        if (stopped || generation !== connectionGeneration) return
        const socket = new WebSocket(roomWebSocketUrl(session.locator, ticket.ticket))
        socketRef.current = socket
        let lastPongAt = Date.now()
        let heartbeatTimer: ReturnType<typeof setInterval> | undefined

        socket.addEventListener('open', () => {
          if (stopped || socketRef.current !== socket || generation !== connectionGeneration) {
            socket.close(1000, 'Superseded connection')
            return
          }
          reconnectAttempt = 0
          lastPongAt = Date.now()
          setStatus('connected')
          void (async () => {
            try {
              await syncHistory()
              if (!stopped && socket.readyState === WebSocket.OPEN) await flushPending()
            } catch {
              setConnectionError('History synchronization failed. Reconnecting…')
              socket.close(1012, 'History synchronization failed')
            }
          })()
          heartbeatTimer = setInterval(() => {
            if (Date.now() - lastPongAt > 65_000) {
              socket.close(4000, 'Heartbeat timeout')
              return
            }
            if (socket.readyState === WebSocket.OPEN) {
              socket.send(JSON.stringify({ type: 'ping' }))
            }
          }, 25_000)
        })

        socket.addEventListener('message', (event) => {
          if (stopped || socketRef.current !== socket || generation !== connectionGeneration) return
          if (typeof event.data !== 'string') return
          let candidate: unknown
          try {
            candidate = JSON.parse(event.data)
          } catch {
            socket.close(1002, 'Invalid server frame')
            return
          }
          const parsed = webSocketServerFrameSchema.safeParse(candidate)
          if (!parsed.success) {
            socket.close(1002, 'Invalid server frame')
            return
          }
          const frame = parsed.data
          if (frame.type === 'ready' || frame.type === 'presence') {
            setOnlineCount(frame.onlineCount)
          } else if (frame.type === 'pong') {
            lastPongAt = Date.now()
          } else if (frame.type === 'message') {
            void applyStored(frame.message)
          } else if (frame.type === 'ack') {
            settlePending(frame.id)
            setMessages((current) => {
              const existing = current.find((message) => message.id === frame.id)
              if (existing === undefined) return current
              return mergeTimeline(current, {
                ...existing,
                sequence: frame.sequence,
                serverCreatedAt: existing.serverCreatedAt ?? Date.now(),
                delivery: 'stored',
                error: undefined,
              })
            })
          } else if (frame.type === 'error' && frame.messageId !== undefined) {
            settlePending(frame.messageId)
            setMessages((current) => {
              const existing = current.find((message) => message.id === frame.messageId)
              if (existing === undefined) return current
              return mergeTimeline(current, {
                ...existing,
                delivery: 'failed',
                error: `Send failed: ${frame.code}`,
              })
            })
          }
        })

        socket.addEventListener('close', (event) => {
          if (heartbeatTimer !== undefined) clearInterval(heartbeatTimer)
          if (socketRef.current === socket) {
            socketRef.current = null
            if (event.code === 4001) {
              terminal = true
              setStatus('offline')
              setConnectionError('This room has expired. Leave the room to return to access.')
              return
            }
            scheduleReconnect()
          }
        })
        socket.addEventListener('error', () => {
          setConnectionError('The real-time connection is temporarily unavailable. Retrying…')
        })
      } catch (error) {
        if (stopped || generation !== connectionGeneration) return
        if (
          error instanceof ApiError &&
          (error.status === 401 || error.status === 403 || error.status === 404 || error.status === 410)
        ) {
          terminal = true
          setStatus('offline')
          setConnectionError(
            error.status === 410 || error.code === 'expired'
              ? 'This room has expired. Leave the room to return to access.'
              : 'Room access is no longer valid. Check the invitation or leave the room.',
          )
          return
        }
        setConnectionError('Unable to connect to the room. Retrying…')
        scheduleReconnect()
      }
    }

    const startConnect = (): Promise<void> => {
      if (stopped || terminal) return Promise.resolve()
      if (connectPromise !== null) return connectPromise
      const currentSocket = socketRef.current
      if (currentSocket !== null && currentSocket.readyState < WebSocket.CLOSING) {
        return Promise.resolve()
      }
      const generation = ++connectionGeneration
      const operation = connect(generation).finally(() => {
        if (connectPromise === operation) connectPromise = null
      })
      connectPromise = operation
      return operation
    }

    const handleOnline = () => {
      if (reconnectTimer !== undefined) clearTimeout(reconnectTimer)
      reconnectTimer = undefined
      void startConnect()
    }
    const handleOffline = () => setStatus('offline')
    window.addEventListener('online', handleOnline)
    window.addEventListener('offline', handleOffline)
    void startConnect()

    return () => {
      stopped = true
      connectionGeneration += 1
      lifecycle.abort()
      if (reconnectTimer !== undefined) clearTimeout(reconnectTimer)
      window.removeEventListener('online', handleOnline)
      window.removeEventListener('offline', handleOffline)
      const socket = socketRef.current
      socketRef.current = null
      if (socket !== null && socket.readyState < WebSocket.CLOSING) {
        socket.close(1000, 'Room left')
      }
      for (const timer of ackTimers.values()) clearTimeout(timer)
      ackTimers.clear()
    }
  }, [applyStored, postPending, session.authToken, session.deviceId, session.locator, settlePending])

  const sendPlainMessage = useCallback(
    async (content: PlainMessage) => {
      const envelope = await encryptMessage(session.sender, session.locator, content)
      const pending = { envelope, content }
      pendingRef.current.set(envelope.id, pending)
      setMessages((current) =>
        mergeTimeline(current, {
          id: envelope.id,
          envelope,
          sequence: null,
          serverCreatedAt: null,
          content,
          delivery: 'sending',
        }),
      )

      const socket = socketRef.current
      if (socket?.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: 'message', envelope }))
        const timer = setTimeout(() => {
          if (pendingRef.current.has(envelope.id)) void postPending(pending)
        }, 8_000)
        ackTimersRef.current.set(envelope.id, timer)
      } else {
        await postPending(pending)
      }
    },
    [postPending, session.locator, session.sender],
  )

  const retryMessage = useCallback(
    async (id: string) => {
      const message = messages.find((candidate) => candidate.id === id)
      if (message?.content === null || message === undefined) return
      const pending = { envelope: message.envelope, content: message.content }
      pendingRef.current.set(id, pending)
      setMessages((current) =>
        current.map((candidate) =>
          candidate.id === id ? { ...candidate, delivery: 'sending', error: undefined } : candidate,
        ),
      )
      await postPending(pending)
    },
    [messages, postPending],
  )

  return {
    messages,
    status,
    onlineCount,
    connectionError,
    sendPlainMessage,
    retryMessage,
  }
}
