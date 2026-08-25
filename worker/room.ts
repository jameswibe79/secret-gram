import { DurableObject } from 'cloudflare:workers'

import {
  MAX_RETAINED_ROOM_EVENTS,
  clientMessageEnvelopeSchema,
  webSocketClientFrameSchema,
  type ClientMessageEnvelope,
  type RoomPinState,
  type StoredMessageEnvelope,
  type StoredRecallEvent,
  type StoredRoomEvent,
} from '../src/shared/protocol'

const BASE64URL_256_PATTERN = /^[A-Za-z0-9_-]{43}$/u
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu
const MAINTENANCE_INTERVAL_MS = 3_600_000
const MAX_RETAINED_MESSAGE_CHARACTERS = 256 * 1024 * 1024
const MAX_ROOM_UPLOADS = 128
const MAX_PENDING_UPLOADS = 32
const MAX_ROOM_FILE_CHUNKS = 4_096
const MESSAGE_COLUMNS =
  'sequence, id, sender_id, sender_epoch_id, message_counter, server_created_at, ciphertext, event_type, recall_verifier, recalled_message_id, recalled_at'

function errorType(error: unknown): string {
  return error instanceof Error ? error.name : 'UnknownError'
}

interface InitializeRoomInput {
  locator: string
  authVerifier: string
  ttlSeconds: number
}

export type InitializeRoomResult =
  | { ok: true; created: boolean; expiresAt: number }
  | { ok: false; created: false; expiresAt: 0; reason: 'invalid' | 'conflict' }

export type RoomInfoResult =
  | {
      ok: true
      createdAt: number
      expiresAt: number
      onlineCount: number
      remainingEvents: number
    }
  | { ok: false; reason: 'not_found' | 'unauthorized' | 'expired' }

interface RoomRow extends Record<string, SqlStorageValue> {
  locator: string
  auth_verifier: string
  created_at: number
  expires_at: number
}

interface MessageRow extends Record<string, SqlStorageValue> {
  sequence: number
  id: string
  sender_id: string
  sender_epoch_id: string
  message_counter: number
  server_created_at: number
  ciphertext: string
  event_type: 'message' | 'recall'
  recall_verifier: string | null
  recalled_message_id: string | null
  recalled_at: number | null
}

interface RoomUsageRow extends Record<string, SqlStorageValue> {
  message_count: number
  message_characters: number
}

interface PinRow extends Record<string, SqlStorageValue> {
  message_id: string | null
  version: number
  updated_at: number | null
}

interface TableInfoRow extends Record<string, SqlStorageValue> {
  name: string
}

type RoomFailureReason = 'not_found' | 'unauthorized' | 'expired'

export type AppendMessageResult =
  | {
      ok: true
      duplicate: boolean
      message: StoredMessageEnvelope
      remainingEvents: number
    }
  | {
      ok: false
      duplicate: false
      message: null
      reason:
        | RoomFailureReason
        | 'invalid'
        | 'sender_mismatch'
        | 'message_id_conflict'
        | 'sender_counter_conflict'
        | 'rate_limited'
        | 'capacity'
    }

export type RecallMessageResult =
  | { ok: true; duplicate: boolean; event: StoredRecallEvent }
  | {
      ok: false
      duplicate: false
      event: null
      reason: RoomFailureReason | 'invalid' | 'forbidden' | 'not_recallable'
    }

export type GetRoomPinResult =
  | { ok: true; pin: RoomPinState }
  | { ok: false; pin: null; reason: RoomFailureReason }

export type SetRoomPinResult =
  | { ok: true; duplicate: boolean; pin: RoomPinState }
  | {
      ok: false
      duplicate: false
      pin: null
      reason: RoomFailureReason | 'invalid' | 'not_found'
    }

export type MessageHistoryResult =
  | { ok: true; messages: StoredRoomEvent[] }
  | { ok: false; messages: []; reason: RoomFailureReason | 'invalid' }

interface BeginUploadInput {
  fileId: string
  chunkCount: number
  encryptedSize: number
}

interface UploadRow extends Record<string, SqlStorageValue> {
  file_id: string
  uploader_id: string
  chunk_count: number
  encrypted_size: number
  status: string
}

interface UploadChunkRow extends Record<string, SqlStorageValue> {
  encrypted_size: number
  etag: string
  ciphertext_sha256: string
}

type UploadFailureReason =
  | RoomFailureReason
  | 'capacity'
  | 'invalid'
  | 'not_found'
  | 'forbidden'
  | 'upload_conflict'
  | 'chunk_conflict'
  | 'incomplete'
  | 'not_ready'

export type BeginUploadResult =
  | { ok: true; created: boolean }
  | { ok: false; created: false; reason: UploadFailureReason }

export type UploadActionResult = { ok: true } | { ok: false; reason: UploadFailureReason }

export type UploadChunkAuthorizationResult =
  | { ok: true; recorded: false }
  | { ok: true; recorded: true; etag: string }
  | { ok: false; reason: UploadFailureReason }

export type DownloadAuthorizationResult =
  | { ok: true; chunkCount: number }
  | { ok: false; reason: UploadFailureReason }

export type DownloadChunkAuthorizationResult =
  | { ok: true; encryptedSize: number; ciphertextSha256: string }
  | { ok: false; reason: UploadFailureReason }

export type SocketTicketResult =
  | { ok: true; ticket: string; expiresAt: number }
  | { ok: false; reason: RoomFailureReason | 'invalid' | 'capacity' }

interface TicketRow extends Record<string, SqlStorageValue> {
  device_id: string
  expires_at: number
}

interface SocketAttachment {
  deviceId: string
  connectedAt: number
}

function decodeBase64Url(value: string): Uint8Array<ArrayBuffer> | null {
  if (!BASE64URL_256_PATTERN.test(value)) return null
  const padded = value.replaceAll('-', '+').replaceAll('_', '/') + '='
  try {
    const binary = atob(padded)
    const bytes = new Uint8Array(binary.length)
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index)
    }
    return bytes.byteLength === 32 ? bytes : null
  } catch {
    return null
  }
}

function encodeBase64Url(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '')
}

export class RoomDurableObject extends DurableObject<Env> {
  private schemaReady = false

  private migrate(): void {
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS _sql_schema_migrations (
        id INTEGER PRIMARY KEY,
        applied_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS room (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        locator TEXT NOT NULL,
        auth_verifier TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS messages (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        sender_id TEXT NOT NULL,
        sender_epoch_id TEXT NOT NULL,
        message_counter INTEGER NOT NULL,
        server_created_at INTEGER NOT NULL,
        ciphertext TEXT NOT NULL,
        event_type TEXT NOT NULL DEFAULT 'message' CHECK (event_type IN ('message', 'recall')),
        recall_verifier TEXT,
        recalled_message_id TEXT,
        recalled_at INTEGER,
        UNIQUE (sender_epoch_id, message_counter)
      );
      CREATE INDEX IF NOT EXISTS messages_server_created_at
      ON messages(server_created_at);
      CREATE TABLE IF NOT EXISTS uploads (
        file_id TEXT PRIMARY KEY,
        uploader_id TEXT NOT NULL,
        chunk_count INTEGER NOT NULL,
        encrypted_size INTEGER NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('pending', 'ready')),
        created_at INTEGER NOT NULL,
        completed_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS upload_chunks (
        file_id TEXT NOT NULL,
        chunk_index INTEGER NOT NULL,
        encrypted_size INTEGER NOT NULL,
        etag TEXT NOT NULL,
        ciphertext_sha256 TEXT NOT NULL,
        PRIMARY KEY (file_id, chunk_index)
      );
      CREATE INDEX IF NOT EXISTS uploads_created_at ON uploads(created_at);
      CREATE TABLE IF NOT EXISTS socket_tickets (
        ticket_hash TEXT PRIMARY KEY,
        device_id TEXT NOT NULL,
        expires_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS socket_tickets_expires_at ON socket_tickets(expires_at);
      CREATE TABLE IF NOT EXISTS room_pin_state (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        message_id TEXT,
        version INTEGER NOT NULL CHECK (version >= 0),
        updated_at INTEGER
      );
      INSERT OR IGNORE INTO room_pin_state (singleton, message_id, version, updated_at)
      VALUES (1, NULL, 0, NULL);
      CREATE TABLE IF NOT EXISTS message_rate_windows (
        device_id TEXT PRIMARY KEY,
        window_start INTEGER NOT NULL,
        message_count INTEGER NOT NULL
      );
      INSERT OR IGNORE INTO _sql_schema_migrations (id, applied_at)
      VALUES (1, unixepoch() * 1000);
    `)

    const messageColumns = this.ctx.storage.sql
      .exec<TableInfoRow>('PRAGMA table_info(messages)')
      .toArray()
      .map((column) => column.name)
    const uploadChunkColumns = this.ctx.storage.sql
      .exec<TableInfoRow>('PRAGMA table_info(upload_chunks)')
      .toArray()
      .map((column) => column.name)
    if (
      !messageColumns.includes('sender_epoch_id') ||
      !uploadChunkColumns.includes('ciphertext_sha256')
    ) {
      this.ctx.storage.transactionSync(() => {
        if (!messageColumns.includes('sender_epoch_id')) {
          this.ctx.storage.sql.exec(`
            ALTER TABLE messages RENAME TO messages_protocol_v1;
            DROP INDEX IF EXISTS messages_server_created_at;
            CREATE TABLE messages (
              sequence INTEGER PRIMARY KEY AUTOINCREMENT,
              id TEXT NOT NULL UNIQUE,
              sender_id TEXT NOT NULL,
              sender_epoch_id TEXT NOT NULL,
              message_counter INTEGER NOT NULL,
              server_created_at INTEGER NOT NULL,
              ciphertext TEXT NOT NULL,
              event_type TEXT NOT NULL DEFAULT 'message' CHECK (event_type IN ('message', 'recall')),
              recall_verifier TEXT,
              recalled_message_id TEXT,
              recalled_at INTEGER,
              UNIQUE (sender_epoch_id, message_counter)
            );
            CREATE INDEX messages_server_created_at ON messages(server_created_at);
            DROP TABLE messages_protocol_v1;
          `)
        }
        if (!uploadChunkColumns.includes('ciphertext_sha256')) {
          this.ctx.storage.sql.exec(
            "ALTER TABLE upload_chunks ADD COLUMN ciphertext_sha256 TEXT NOT NULL DEFAULT ''",
          )
        }
        this.ctx.storage.sql.exec(
          'INSERT OR IGNORE INTO _sql_schema_migrations (id, applied_at) VALUES (2, ?)',
          Date.now(),
        )
      })
    }

    const recallColumns = this.ctx.storage.sql
      .exec<TableInfoRow>('PRAGMA table_info(messages)')
      .toArray()
      .map((column) => column.name)
    if (!recallColumns.includes('event_type')) {
      this.ctx.storage.transactionSync(() => {
        this.ctx.storage.sql.exec(
          "ALTER TABLE messages ADD COLUMN event_type TEXT NOT NULL DEFAULT 'message'",
        )
        this.ctx.storage.sql.exec('ALTER TABLE messages ADD COLUMN recall_verifier TEXT')
        this.ctx.storage.sql.exec('ALTER TABLE messages ADD COLUMN recalled_message_id TEXT')
        this.ctx.storage.sql.exec('ALTER TABLE messages ADD COLUMN recalled_at INTEGER')
        this.ctx.storage.sql.exec(
          'INSERT OR IGNORE INTO _sql_schema_migrations (id, applied_at) VALUES (4, ?)',
          Date.now(),
        )
      })
    }

    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS room_usage (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        message_count INTEGER NOT NULL CHECK (message_count >= 0),
        message_characters INTEGER NOT NULL CHECK (message_characters >= 0)
      );
      INSERT OR IGNORE INTO room_usage (singleton, message_count, message_characters)
      SELECT 1, COUNT(*), COALESCE(SUM(LENGTH(ciphertext)), 0) FROM messages;
      INSERT OR IGNORE INTO _sql_schema_migrations (id, applied_at)
      VALUES (3, unixepoch() * 1000);
    `)
    this.ctx.storage.sql.exec(
      'INSERT OR IGNORE INTO _sql_schema_migrations (id, applied_at) VALUES (4, ?)',
      Date.now(),
    )
    this.ctx.storage.sql.exec(
      'INSERT OR IGNORE INTO _sql_schema_migrations (id, applied_at) VALUES (5, ?)',
      Date.now(),
    )
  }

  private room(): RoomRow | null {
    const table = this.ctx.storage.sql
      .exec<{ name: string } & Record<string, SqlStorageValue>>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'room'",
      )
      .toArray()[0]
    if (table === undefined) return null

    let row = this.ctx.storage.sql
      .exec<RoomRow>(
        'SELECT locator, auth_verifier, created_at, expires_at FROM room WHERE singleton = 1',
      )
      .toArray()[0]
    if (row !== undefined && !this.schemaReady) {
      this.migrate()
      this.schemaReady = true
      row = this.ctx.storage.sql
        .exec<RoomRow>(
          'SELECT locator, auth_verifier, created_at, expires_at FROM room WHERE singleton = 1',
        )
        .toArray()[0]
    }
    return row ?? null
  }

  private pinRow(): PinRow {
    return this.ctx.storage.sql
      .exec<PinRow>(
        'SELECT message_id, version, updated_at FROM room_pin_state WHERE singleton = 1',
      )
      .one()
  }

  private roomPin(row: PinRow = this.pinRow()): RoomPinState {
    return {
      messageId: row.message_id,
      version: row.version,
      updatedAt: row.updated_at,
    }
  }

  private remainingEvents(): number {
    const usage = this.ctx.storage.sql
      .exec<{ message_count: number } & Record<string, SqlStorageValue>>(
        'SELECT message_count FROM room_usage WHERE singleton = 1',
      )
      .one()
    return Math.max(0, MAX_RETAINED_ROOM_EVENTS - usage.message_count)
  }

  private writePin(messageId: string | null, updatedAt: number): RoomPinState {
    const row = this.ctx.storage.sql
      .exec<PinRow>(
        `UPDATE room_pin_state
         SET message_id = ?, version = version + 1, updated_at = ?
         WHERE singleton = 1
         RETURNING message_id, version, updated_at`,
        messageId,
        updatedAt,
      )
      .one()
    return this.roomPin(row)
  }

  private clearPinForMessage(messageId: string, updatedAt: number): RoomPinState | null {
    const row = this.ctx.storage.sql
      .exec<PinRow>(
        `UPDATE room_pin_state
         SET message_id = NULL, version = version + 1, updated_at = ?
         WHERE singleton = 1 AND message_id = ?
         RETURNING message_id, version, updated_at`,
        updatedAt,
        messageId,
      )
      .toArray()[0]
    return row === undefined ? null : this.roomPin(row)
  }

  private deleteMessagesBefore(cutoff: number): void {
    const expiredCount = this.ctx.storage.sql
      .exec<{ count: number } & Record<string, SqlStorageValue>>(
        'SELECT COUNT(*) AS count FROM messages WHERE server_created_at < ?',
        cutoff,
      )
      .one().count
    if (expiredCount === 0) return

    const currentPin = this.pinRow()
    const pinnedMessageExpires = currentPin.message_id !== null && this.ctx.storage.sql
      .exec<{ found: number } & Record<string, SqlStorageValue>>(
        'SELECT 1 AS found FROM messages WHERE id = ? AND server_created_at < ?',
        currentPin.message_id,
        cutoff,
      )
      .toArray()[0] !== undefined
    const clearedPin = this.ctx.storage.transactionSync(() => {
      const cleared = pinnedMessageExpires && currentPin.message_id !== null
        ? this.clearPinForMessage(currentPin.message_id, Date.now())
        : null
      this.ctx.storage.sql.exec('DELETE FROM messages WHERE server_created_at < ?', cutoff)
      this.ctx.storage.sql.exec(
        `UPDATE room_usage SET
           message_count = (SELECT COUNT(*) FROM messages),
           message_characters = (
             SELECT COALESCE(SUM(LENGTH(ciphertext)), 0) FROM messages
           )
         WHERE singleton = 1`,
      )
      return cleared
    })
    if (clearedPin !== null) this.broadcast({ type: 'pin', pin: clearedPin })
  }

  private async isAuthorized(token: string, row: RoomRow): Promise<boolean> {
    const tokenBytes = decodeBase64Url(token)
    const expected = decodeBase64Url(row.auth_verifier)
    if (tokenBytes === null || expected === null) return false

    const actual = new Uint8Array(await crypto.subtle.digest('SHA-256', tokenBytes))
    return crypto.subtle.timingSafeEqual(actual, expected)
  }

  private async recallTokenDigest(token: string): Promise<Uint8Array<ArrayBuffer> | null> {
    const tokenBytes = decodeBase64Url(token)
    if (tokenBytes === null || tokenBytes.byteLength !== 32) return null
    return new Uint8Array(await crypto.subtle.digest('SHA-256', tokenBytes))
  }

  private async authorizationFailure(token: string): Promise<RoomFailureReason | null> {
    const row = this.room()
    if (row === null) return 'not_found'
    if (row.expires_at <= Date.now()) return 'expired'
    return (await this.isAuthorized(token, row)) ? null : 'unauthorized'
  }

  private storedMessage(row: MessageRow): StoredMessageEnvelope {
    return {
      version: 2,
      id: row.id,
      senderId: row.sender_id,
      senderEpochId: row.sender_epoch_id,
      counter: row.message_counter,
      serverCreatedAt: row.server_created_at,
      sequence: row.sequence,
      ciphertext: row.ciphertext,
      ...(row.recall_verifier === null ? {} : { recallVerifier: row.recall_verifier }),
    }
  }

  private storedEvent(row: MessageRow): StoredRoomEvent {
    if (row.event_type === 'message') return this.storedMessage(row)
    if (row.recalled_message_id === null || row.recalled_at === null) {
      throw new Error('Stored recall event is incomplete')
    }
    return {
      type: 'recall',
      messageId: row.recalled_message_id,
      senderId: row.sender_id,
      sequence: row.sequence,
      recalledAt: row.recalled_at,
    }
  }

  private upload(fileId: string): UploadRow | null {
    return (
      this.ctx.storage.sql
        .exec<UploadRow>(
          `SELECT file_id, uploader_id, chunk_count, encrypted_size, status
           FROM uploads WHERE file_id = ?`,
          fileId,
        )
        .toArray()[0] ?? null
    )
  }

  private broadcast(payload: object): void {
    const encoded = JSON.stringify(payload)
    for (const socket of this.ctx.getWebSockets()) {
      if (socket.readyState !== WebSocket.OPEN) continue
      try {
        socket.send(encoded)
      } catch (error) {
        console.error(JSON.stringify({ event: 'websocket_send_failed', errorType: errorType(error) }))
        socket.close(1011, 'Delivery failed')
      }
    }
  }

  private broadcastPresence(): void {
    this.broadcast({ type: 'presence', onlineCount: this.ctx.getWebSockets().length })
  }

  private async ticketHash(ticketBytes: Uint8Array<ArrayBuffer>): Promise<string> {
    const digest = await crypto.subtle.digest('SHA-256', ticketBytes)
    return encodeBase64Url(new Uint8Array(digest))
  }

  private async consumeSocketTicket(ticket: string): Promise<TicketRow | null> {
    const ticketBytes = decodeBase64Url(ticket)
    if (ticketBytes === null) return null
    const ticketHash = await this.ticketHash(ticketBytes)
    const row = this.ctx.storage.sql
      .exec<TicketRow>(
        'SELECT device_id, expires_at FROM socket_tickets WHERE ticket_hash = ?',
        ticketHash,
      )
      .toArray()[0]
    this.ctx.storage.sql.exec('DELETE FROM socket_tickets WHERE ticket_hash = ?', ticketHash)
    return row !== undefined && row.expires_at > Date.now() ? row : null
  }

  private consumeMessageWindow(key: string, limit: number): boolean {
    const windowStart = Math.floor(Date.now() / 60_000) * 60_000
    const row = this.ctx.storage.sql
      .exec<
        { window_start: number; message_count: number } & Record<string, SqlStorageValue>
      >(
        `SELECT window_start, message_count FROM message_rate_windows WHERE device_id = ?`,
        key,
      )
      .toArray()[0]

    if (row === undefined || row.window_start !== windowStart) {
      if (key === '__room__') {
        this.ctx.storage.sql.exec(
          'DELETE FROM message_rate_windows WHERE window_start < ?',
          windowStart,
        )
      }
      this.ctx.storage.sql.exec(
        `INSERT INTO message_rate_windows (device_id, window_start, message_count)
         VALUES (?, ?, 1)
         ON CONFLICT(device_id) DO UPDATE SET
           window_start = excluded.window_start,
           message_count = 1`,
        key,
        windowStart,
      )
      return true
    }
    if (row.message_count >= limit) return false
    this.ctx.storage.sql.exec(
      'UPDATE message_rate_windows SET message_count = message_count + 1 WHERE device_id = ?',
      key,
    )
    return true
  }

  private async deleteEncryptedFiles(prefix: string): Promise<void> {
    let cursor: string | undefined
    do {
      const listed = await this.env.FILES.list({ prefix, cursor, limit: 1_000 })
      const keys = listed.objects.map((object) => object.key)
      if (keys.length > 0) await this.env.FILES.delete(keys)
      cursor = listed.truncated ? listed.cursor : undefined
    } while (cursor !== undefined)
  }

  async initialize(input: InitializeRoomInput): Promise<InitializeRoomResult> {
    const maxTtl = Number(this.env.ROOM_TTL_MAX_SECONDS)
    if (
      !BASE64URL_256_PATTERN.test(input.locator) ||
      !BASE64URL_256_PATTERN.test(input.authVerifier) ||
      !Number.isInteger(input.ttlSeconds) ||
      input.ttlSeconds < 300 ||
      input.ttlSeconds > maxTtl
    ) {
      return { ok: false, created: false, expiresAt: 0, reason: 'invalid' }
    }

    const existing = this.room()
    if (existing !== null) {
      const supplied = decodeBase64Url(input.authVerifier)
      const stored = decodeBase64Url(existing.auth_verifier)
      if (
        existing.locator !== input.locator ||
        supplied === null ||
        stored === null ||
        !crypto.subtle.timingSafeEqual(supplied, stored)
      ) {
        return { ok: false, created: false, expiresAt: 0, reason: 'conflict' }
      }
      const nextAlarm = Math.min(existing.expires_at, Date.now() + MAINTENANCE_INTERVAL_MS)
      const currentAlarm = await this.ctx.storage.getAlarm()
      if (currentAlarm === null || currentAlarm > nextAlarm) {
        await this.ctx.storage.setAlarm(nextAlarm)
      }
      return { ok: true, created: false, expiresAt: existing.expires_at }
    }

    this.migrate()
    this.schemaReady = true
    const createdAt = Date.now()
    const expiresAt = createdAt + input.ttlSeconds * 1_000
    this.ctx.storage.sql.exec(
      `INSERT INTO room (singleton, locator, auth_verifier, created_at, expires_at)
       VALUES (1, ?, ?, ?, ?)`,
      input.locator,
      input.authVerifier,
      createdAt,
      expiresAt,
    )
    await this.ctx.storage.setAlarm(Math.min(expiresAt, createdAt + MAINTENANCE_INTERVAL_MS))

    return { ok: true, created: true, expiresAt }
  }

  async getInfo(token: string): Promise<RoomInfoResult> {
    const row = this.room()
    if (row === null) return { ok: false, reason: 'not_found' }
    if (row.expires_at <= Date.now()) return { ok: false, reason: 'expired' }
    if (!(await this.isAuthorized(token, row))) {
      return { ok: false, reason: 'unauthorized' }
    }
    this.deleteMessagesBefore(
      Date.now() - Number(this.env.MESSAGE_RETENTION_SECONDS) * 1_000,
    )

    return {
      ok: true,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
      onlineCount: this.ctx.getWebSockets().length,
      remainingEvents: this.remainingEvents(),
    }
  }

  private storeMessage(
    deviceId: string,
    envelope: ClientMessageEnvelope,
  ): AppendMessageResult {
    const parsed = clientMessageEnvelopeSchema.safeParse(envelope)
    if (!UUID_PATTERN.test(deviceId) || !parsed.success) {
      return { ok: false, duplicate: false, message: null, reason: 'invalid' }
    }
    if (parsed.data.senderId !== deviceId) {
      return { ok: false, duplicate: false, message: null, reason: 'sender_mismatch' }
    }

    const existing = this.ctx.storage.sql
      .exec<MessageRow>(
        `SELECT ${MESSAGE_COLUMNS}
         FROM messages
         WHERE id = ? OR recalled_message_id = ?
         ORDER BY sequence DESC LIMIT 1`,
        parsed.data.id,
        parsed.data.id,
      )
      .toArray()[0]

    if (existing !== undefined) {
      if (
        existing.event_type !== 'message' ||
        existing.sender_id !== parsed.data.senderId ||
        existing.sender_epoch_id !== parsed.data.senderEpochId ||
        existing.message_counter !== parsed.data.counter ||
        existing.ciphertext !== parsed.data.ciphertext ||
        (existing.recall_verifier ?? undefined) !== parsed.data.recallVerifier
      ) {
        return {
          ok: false,
          duplicate: false,
          message: null,
          reason: 'message_id_conflict',
        }
      }
      return {
        ok: true,
        duplicate: true,
        message: this.storedMessage(existing),
        remainingEvents: this.remainingEvents(),
      }
    }

    const reusedCounter = this.ctx.storage.sql
      .exec<{ id: string } & Record<string, SqlStorageValue>>(
        `SELECT id FROM messages
         WHERE sender_epoch_id = ? AND message_counter = ?`,
        parsed.data.senderEpochId,
        parsed.data.counter,
      )
      .toArray()[0]
    if (reusedCounter !== undefined) {
      return {
        ok: false,
        duplicate: false,
        message: null,
        reason: 'sender_counter_conflict',
      }
    }

    const serverCreatedAt = Date.now()
    const retentionCutoff = serverCreatedAt - Number(this.env.MESSAGE_RETENTION_SECONDS) * 1_000
    this.deleteMessagesBefore(retentionCutoff)

    const usage = this.ctx.storage.sql
      .exec<RoomUsageRow>(
        'SELECT message_count, message_characters FROM room_usage WHERE singleton = 1',
      )
      .one()
    if (
      usage.message_count >= MAX_RETAINED_ROOM_EVENTS ||
      usage.message_characters + parsed.data.ciphertext.length > MAX_RETAINED_MESSAGE_CHARACTERS
    ) {
      return { ok: false, duplicate: false, message: null, reason: 'capacity' }
    }

    if (!this.consumeMessageWindow(deviceId, 60)) {
      return { ok: false, duplicate: false, message: null, reason: 'rate_limited' }
    }
    if (!this.consumeMessageWindow('__room__', 600)) {
      return { ok: false, duplicate: false, message: null, reason: 'rate_limited' }
    }

    const inserted = this.ctx.storage.transactionSync(() => {
      const row = this.ctx.storage.sql
        .exec<{ sequence: number } & Record<string, SqlStorageValue>>(
        `INSERT INTO messages
         (id, sender_id, sender_epoch_id, message_counter, server_created_at, ciphertext,
          recall_verifier)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         RETURNING sequence`,
        parsed.data.id,
        parsed.data.senderId,
        parsed.data.senderEpochId,
        parsed.data.counter,
        serverCreatedAt,
        parsed.data.ciphertext,
        parsed.data.recallVerifier ?? null,
        )
        .one()
      this.ctx.storage.sql.exec(
        `UPDATE room_usage SET
           message_count = message_count + 1,
           message_characters = message_characters + ?
         WHERE singleton = 1`,
        parsed.data.ciphertext.length,
      )
      return row
    })

    return {
      ok: true,
      duplicate: false,
      message: {
        ...parsed.data,
        sequence: inserted.sequence,
        serverCreatedAt,
      },
      remainingEvents: MAX_RETAINED_ROOM_EVENTS - usage.message_count - 1,
    }
  }

  async appendMessage(
    token: string,
    deviceId: string,
    envelope: ClientMessageEnvelope,
  ): Promise<AppendMessageResult> {
    const authFailure = await this.authorizationFailure(token)
    if (authFailure !== null) {
      return { ok: false, duplicate: false, message: null, reason: authFailure }
    }
    return this.storeMessage(deviceId, envelope)
  }

  async recallMessage(
    token: string,
    deviceId: string,
    messageId: string,
    recallToken: string,
  ): Promise<RecallMessageResult> {
    const authFailure = await this.authorizationFailure(token)
    if (authFailure !== null) {
      return { ok: false, duplicate: false, event: null, reason: authFailure }
    }
    if (
      !UUID_PATTERN.test(deviceId) ||
      !UUID_PATTERN.test(messageId) ||
      !BASE64URL_256_PATTERN.test(recallToken)
    ) {
      return { ok: false, duplicate: false, event: null, reason: 'invalid' }
    }

    const actualVerifier = await this.recallTokenDigest(recallToken)
    if (actualVerifier === null) {
      return { ok: false, duplicate: false, event: null, reason: 'invalid' }
    }
    const row = this.ctx.storage.sql
      .exec<MessageRow>(
        `SELECT ${MESSAGE_COLUMNS}
         FROM messages
         WHERE id = ? OR recalled_message_id = ?
         ORDER BY sequence DESC LIMIT 1`,
        messageId,
        messageId,
      )
      .toArray()[0]
    if (row === undefined) {
      return { ok: false, duplicate: false, event: null, reason: 'not_found' }
    }
    if (row.sender_id !== deviceId) {
      return { ok: false, duplicate: false, event: null, reason: 'forbidden' }
    }
    const expectedVerifier = row.recall_verifier === null
      ? null
      : decodeBase64Url(row.recall_verifier)
    if (expectedVerifier === null || expectedVerifier.byteLength !== 32) {
      return { ok: false, duplicate: false, event: null, reason: 'not_recallable' }
    }
    if (!crypto.subtle.timingSafeEqual(actualVerifier, expectedVerifier)) {
      return { ok: false, duplicate: false, event: null, reason: 'forbidden' }
    }
    if (row.event_type === 'recall') {
      return { ok: true, duplicate: true, event: this.storedEvent(row) as StoredRecallEvent }
    }

    const recalledAt = Date.now()
    const eventId = crypto.randomUUID()
    const eventEpochId = encodeBase64Url(crypto.getRandomValues(new Uint8Array(16)))
    const inserted = this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec('DELETE FROM messages WHERE id = ?', messageId)
      const eventRow = this.ctx.storage.sql
        .exec<{ sequence: number } & Record<string, SqlStorageValue>>(
          `INSERT INTO messages
           (id, sender_id, sender_epoch_id, message_counter, server_created_at, ciphertext,
            event_type, recall_verifier, recalled_message_id, recalled_at)
           VALUES (?, ?, ?, 0, ?, '', 'recall', ?, ?, ?)
           RETURNING sequence`,
          eventId,
          row.sender_id,
          eventEpochId,
          recalledAt,
          row.recall_verifier,
          messageId,
          recalledAt,
        )
        .one()
      this.ctx.storage.sql.exec(
        `UPDATE room_usage SET
           message_characters = MAX(0, message_characters - ?)
         WHERE singleton = 1`,
        row.ciphertext.length,
      )
      return {
        eventRow,
        clearedPin: this.clearPinForMessage(messageId, recalledAt),
      }
    })
    const event: StoredRecallEvent = {
      type: 'recall',
      messageId,
      senderId: row.sender_id,
      sequence: inserted.eventRow.sequence,
      recalledAt,
    }
    if (inserted.clearedPin !== null) {
      this.broadcast({ type: 'pin', pin: inserted.clearedPin })
    }
    this.broadcast(event)
    return { ok: true, duplicate: false, event }
  }

  async getPin(token: string): Promise<GetRoomPinResult> {
    const authFailure = await this.authorizationFailure(token)
    if (authFailure !== null) return { ok: false, pin: null, reason: authFailure }

    const pin = this.roomPin()
    if (pin.messageId === null) return { ok: true, pin }

    const retentionCutoff = Date.now() - Number(this.env.MESSAGE_RETENTION_SECONDS) * 1_000
    const pinnedMessage = this.ctx.storage.sql
      .exec<{ id: string } & Record<string, SqlStorageValue>>(
        `SELECT id FROM messages
         WHERE id = ? AND event_type = 'message' AND server_created_at >= ?`,
        pin.messageId,
        retentionCutoff,
      )
      .toArray()[0]
    if (pinnedMessage !== undefined) return { ok: true, pin }

    const clearedPin = this.writePin(null, Date.now())
    this.broadcast({ type: 'pin', pin: clearedPin })
    return { ok: true, pin: clearedPin }
  }

  async setPin(
    token: string,
    messageId: string,
    pinned: boolean,
  ): Promise<SetRoomPinResult> {
    const authFailure = await this.authorizationFailure(token)
    if (authFailure !== null) {
      return { ok: false, duplicate: false, pin: null, reason: authFailure }
    }
    if (!UUID_PATTERN.test(messageId) || typeof pinned !== 'boolean') {
      return { ok: false, duplicate: false, pin: null, reason: 'invalid' }
    }

    const current = this.roomPin()
    if (!pinned) {
      if (current.messageId !== messageId) {
        return { ok: true, duplicate: true, pin: current }
      }
      const pin = this.writePin(null, Date.now())
      this.broadcast({ type: 'pin', pin })
      return { ok: true, duplicate: false, pin }
    }

    const retentionCutoff = Date.now() - Number(this.env.MESSAGE_RETENTION_SECONDS) * 1_000
    const message = this.ctx.storage.sql
      .exec<{ id: string } & Record<string, SqlStorageValue>>(
        `SELECT id FROM messages
         WHERE id = ? AND event_type = 'message' AND server_created_at >= ?`,
        messageId,
        retentionCutoff,
      )
      .toArray()[0]
    if (message === undefined) {
      if (current.messageId === messageId) {
        const pin = this.writePin(null, Date.now())
        this.broadcast({ type: 'pin', pin })
      }
      return { ok: false, duplicate: false, pin: null, reason: 'not_found' }
    }
    if (current.messageId === messageId) {
      return { ok: true, duplicate: true, pin: current }
    }

    const pin = this.writePin(messageId, Date.now())
    this.broadcast({ type: 'pin', pin })
    return { ok: true, duplicate: false, pin }
  }

  async getMessages(
    token: string,
    afterSequence: number,
    limit: number,
  ): Promise<MessageHistoryResult> {
    if (
      !Number.isSafeInteger(afterSequence) ||
      afterSequence < 0 ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 100
    ) {
      return { ok: false, messages: [], reason: 'invalid' }
    }

    const authFailure = await this.authorizationFailure(token)
    if (authFailure !== null) return { ok: false, messages: [], reason: authFailure }

    const columns = MESSAGE_COLUMNS
    const retentionCutoff = Date.now() - Number(this.env.MESSAGE_RETENTION_SECONDS) * 1_000
    const rows = this.ctx.storage.sql
      .exec<MessageRow>(
        `SELECT ${columns} FROM messages
         WHERE sequence > ? AND server_created_at >= ? ORDER BY sequence ASC LIMIT ?`,
        afterSequence,
        retentionCutoff,
        limit,
      )
      .toArray()

    return { ok: true, messages: rows.map((row) => this.storedEvent(row)) }
  }

  async beginUpload(
    token: string,
    deviceId: string,
    input: BeginUploadInput,
  ): Promise<BeginUploadResult> {
    const authFailure = await this.authorizationFailure(token)
    if (authFailure !== null) return { ok: false, created: false, reason: authFailure }

    const maxEncryptedSize = Number(this.env.MAX_FILE_BYTES) + input.chunkCount * 16
    if (
      !UUID_PATTERN.test(deviceId) ||
      !UUID_PATTERN.test(input.fileId) ||
      !Number.isSafeInteger(input.chunkCount) ||
      input.chunkCount < 1 ||
      input.chunkCount > 4_096 ||
      !Number.isSafeInteger(input.encryptedSize) ||
      input.encryptedSize < input.chunkCount * 16 ||
      input.encryptedSize > maxEncryptedSize
    ) {
      return { ok: false, created: false, reason: 'invalid' }
    }

    const existing = this.upload(input.fileId)
    if (existing !== null) {
      if (
        existing.uploader_id !== deviceId ||
        existing.chunk_count !== input.chunkCount ||
        existing.encrypted_size !== input.encryptedSize
      ) {
        return { ok: false, created: false, reason: 'upload_conflict' }
      }
      return { ok: true, created: false }
    }

    const reservations = this.ctx.storage.sql
      .exec<{
        total_bytes: number
        total_uploads: number
        pending_uploads: number
        total_chunks: number
      } & Record<string, SqlStorageValue>>(
        `SELECT
           COALESCE(SUM(encrypted_size), 0) AS total_bytes,
           COUNT(*) AS total_uploads,
           COALESCE(SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END), 0) AS pending_uploads,
           COALESCE(SUM(chunk_count), 0) AS total_chunks
         FROM uploads`,
      )
      .one()
    if (
      reservations.total_bytes + input.encryptedSize > Number(this.env.MAX_ROOM_FILE_BYTES) ||
      reservations.total_uploads >= MAX_ROOM_UPLOADS ||
      reservations.pending_uploads >= MAX_PENDING_UPLOADS ||
      reservations.total_chunks + input.chunkCount > MAX_ROOM_FILE_CHUNKS
    ) {
      return { ok: false, created: false, reason: 'capacity' }
    }

    this.ctx.storage.sql.exec(
      `INSERT INTO uploads
       (file_id, uploader_id, chunk_count, encrypted_size, status, created_at)
       VALUES (?, ?, ?, ?, 'pending', ?)`,
      input.fileId,
      deviceId,
      input.chunkCount,
      input.encryptedSize,
      Date.now(),
    )
    return { ok: true, created: true }
  }

  async authorizeUploadChunk(
    token: string,
    deviceId: string,
    fileId: string,
    chunkIndex: number,
    encryptedSize: number,
    ciphertextSha256: string,
  ): Promise<UploadChunkAuthorizationResult> {
    const authFailure = await this.authorizationFailure(token)
    if (authFailure !== null) return { ok: false, reason: authFailure }
    if (
      !UUID_PATTERN.test(deviceId) ||
      !UUID_PATTERN.test(fileId) ||
      !Number.isSafeInteger(chunkIndex) ||
      !Number.isSafeInteger(encryptedSize) ||
      encryptedSize < 16 ||
      encryptedSize > 8 * 1024 * 1024 + 16 ||
      !BASE64URL_256_PATTERN.test(ciphertextSha256)
    ) {
      return { ok: false, reason: 'invalid' }
    }

    const upload = this.upload(fileId)
    if (upload === null) return { ok: false, reason: 'not_found' }
    if (upload.uploader_id !== deviceId) return { ok: false, reason: 'forbidden' }
    if (chunkIndex < 0 || chunkIndex >= upload.chunk_count) {
      return { ok: false, reason: 'invalid' }
    }

    const existing = this.ctx.storage.sql
      .exec<UploadChunkRow>(
        `SELECT encrypted_size, etag, ciphertext_sha256
         FROM upload_chunks WHERE file_id = ? AND chunk_index = ?`,
        fileId,
        chunkIndex,
      )
      .toArray()[0]
    if (existing !== undefined) {
      if (
        existing.encrypted_size !== encryptedSize ||
        existing.ciphertext_sha256 !== ciphertextSha256
      ) {
        return { ok: false, reason: 'chunk_conflict' }
      }
      return { ok: true, recorded: true, etag: existing.etag }
    }

    if (upload.status !== 'pending') return { ok: false, reason: 'forbidden' }

    const otherBytes = this.ctx.storage.sql
      .exec<{ total: number } & Record<string, SqlStorageValue>>(
        `SELECT COALESCE(SUM(encrypted_size), 0) AS total
         FROM upload_chunks WHERE file_id = ? AND chunk_index != ?`,
        fileId,
        chunkIndex,
      )
      .one().total
    if (otherBytes + encryptedSize > upload.encrypted_size) {
      return { ok: false, reason: 'invalid' }
    }
    return { ok: true, recorded: false }
  }

  async recordUploadChunk(
    token: string,
    deviceId: string,
    fileId: string,
    chunkIndex: number,
    encryptedSize: number,
    etag: string,
    ciphertextSha256: string,
  ): Promise<UploadActionResult> {
    const authorized = await this.authorizeUploadChunk(
      token,
      deviceId,
      fileId,
      chunkIndex,
      encryptedSize,
      ciphertextSha256,
    )
    if (!authorized.ok) return authorized
    if (authorized.recorded) return { ok: true }
    if (
      etag.length < 1 ||
      etag.length > 256 ||
      !BASE64URL_256_PATTERN.test(ciphertextSha256)
    ) {
      return { ok: false, reason: 'invalid' }
    }

    const existing = this.ctx.storage.sql
      .exec<UploadChunkRow>(
        `SELECT encrypted_size, etag, ciphertext_sha256
         FROM upload_chunks WHERE file_id = ? AND chunk_index = ?`,
        fileId,
        chunkIndex,
      )
      .toArray()[0]
    if (existing !== undefined) {
      if (
        existing.encrypted_size !== encryptedSize ||
        existing.ciphertext_sha256 !== ciphertextSha256
      ) {
        return { ok: false, reason: 'chunk_conflict' }
      }
      return { ok: true }
    }

    this.ctx.storage.sql.exec(
      `INSERT INTO upload_chunks
       (file_id, chunk_index, encrypted_size, etag, ciphertext_sha256)
       VALUES (?, ?, ?, ?, ?)`,
      fileId,
      chunkIndex,
      encryptedSize,
      etag,
      ciphertextSha256,
    )
    return { ok: true }
  }

  async completeUpload(
    token: string,
    deviceId: string,
    fileId: string,
  ): Promise<UploadActionResult> {
    const authFailure = await this.authorizationFailure(token)
    if (authFailure !== null) return { ok: false, reason: authFailure }
    const upload = this.upload(fileId)
    if (upload === null) return { ok: false, reason: 'not_found' }
    if (upload.uploader_id !== deviceId) return { ok: false, reason: 'forbidden' }
    if (upload.status === 'ready') return { ok: true }

    const chunks = this.ctx.storage.sql
      .exec<{ count: number; total: number } & Record<string, SqlStorageValue>>(
        `SELECT COUNT(*) AS count, COALESCE(SUM(encrypted_size), 0) AS total
         FROM upload_chunks WHERE file_id = ?`,
        fileId,
      )
      .one()
    if (chunks.count !== upload.chunk_count || chunks.total !== upload.encrypted_size) {
      return { ok: false, reason: 'incomplete' }
    }

    this.ctx.storage.sql.exec(
      `UPDATE uploads SET status = 'ready', completed_at = ? WHERE file_id = ?`,
      Date.now(),
      fileId,
    )
    return { ok: true }
  }

  async canDownload(token: string, fileId: string): Promise<DownloadAuthorizationResult> {
    const authFailure = await this.authorizationFailure(token)
    if (authFailure !== null) return { ok: false, reason: authFailure }
    if (!UUID_PATTERN.test(fileId)) return { ok: false, reason: 'invalid' }

    const upload = this.upload(fileId)
    if (upload === null) return { ok: false, reason: 'not_found' }
    if (upload.status !== 'ready') return { ok: false, reason: 'not_ready' }
    return { ok: true, chunkCount: upload.chunk_count }
  }

  async authorizeDownloadChunk(
    token: string,
    fileId: string,
    chunkIndex: number,
  ): Promise<DownloadChunkAuthorizationResult> {
    const authFailure = await this.authorizationFailure(token)
    if (authFailure !== null) return { ok: false, reason: authFailure }
    if (!UUID_PATTERN.test(fileId) || !Number.isSafeInteger(chunkIndex)) {
      return { ok: false, reason: 'invalid' }
    }

    const upload = this.upload(fileId)
    if (upload === null) return { ok: false, reason: 'not_found' }
    if (upload.status !== 'ready') return { ok: false, reason: 'not_ready' }
    if (chunkIndex < 0 || chunkIndex >= upload.chunk_count) {
      return { ok: false, reason: 'not_found' }
    }

    const chunk = this.ctx.storage.sql
      .exec<UploadChunkRow>(
        `SELECT encrypted_size, etag, ciphertext_sha256
         FROM upload_chunks WHERE file_id = ? AND chunk_index = ?`,
        fileId,
        chunkIndex,
      )
      .toArray()[0]
    if (chunk === undefined) return { ok: false, reason: 'not_ready' }
    return {
      ok: true,
      encryptedSize: chunk.encrypted_size,
      ciphertextSha256: chunk.ciphertext_sha256,
    }
  }

  async alarm(): Promise<void> {
    try {
      await this.performMaintenance()
    } catch (error) {
      console.error(JSON.stringify({ event: 'room_maintenance_failed', errorType: errorType(error) }))
      await this.ctx.storage.setAlarm(Date.now() + MAINTENANCE_INTERVAL_MS)
    }
  }

  private async performMaintenance(): Promise<void> {
    const row = this.room()
    if (row === null) return
    const now = Date.now()

    if (row.expires_at <= now) {
      for (const socket of this.ctx.getWebSockets()) {
        try {
          socket.close(4001, 'Room expired')
        } catch {
          // The socket may already be closing.
        }
      }
      try {
        await this.deleteEncryptedFiles(`rooms/${row.locator}/`)
      } catch (error) {
        console.error(JSON.stringify({ event: 'expired_room_cleanup_failed', errorType: errorType(error) }))
        await this.ctx.storage.setAlarm(now + MAINTENANCE_INTERVAL_MS)
        return
      }
      await this.ctx.storage.deleteAll()
      this.schemaReady = false
      return
    }

    this.ctx.storage.sql.exec('DELETE FROM socket_tickets WHERE expires_at <= ?', now)
    this.deleteMessagesBefore(now - Number(this.env.MESSAGE_RETENTION_SECONDS) * 1_000)
    this.ctx.storage.sql.exec(
      'DELETE FROM message_rate_windows WHERE window_start < ?',
      now - 120_000,
    )

    const abandoned = this.ctx.storage.sql
      .exec<{ file_id: string } & Record<string, SqlStorageValue>>(
        `SELECT file_id FROM uploads
         WHERE status = 'pending' AND created_at < ?`,
        now - 86_400_000,
      )
      .toArray()
    for (const upload of abandoned) {
      try {
        await this.deleteEncryptedFiles(`rooms/${row.locator}/${upload.file_id}/`)
      } catch (error) {
        console.error(JSON.stringify({ event: 'abandoned_upload_cleanup_failed', errorType: errorType(error) }))
        await this.ctx.storage.setAlarm(Math.min(row.expires_at, now + MAINTENANCE_INTERVAL_MS))
        return
      }
      this.ctx.storage.sql.exec('DELETE FROM upload_chunks WHERE file_id = ?', upload.file_id)
      this.ctx.storage.sql.exec('DELETE FROM uploads WHERE file_id = ?', upload.file_id)
    }

    await this.ctx.storage.setAlarm(Math.min(row.expires_at, now + MAINTENANCE_INTERVAL_MS))
  }

  async createSocketTicket(token: string, deviceId: string): Promise<SocketTicketResult> {
    const authFailure = await this.authorizationFailure(token)
    if (authFailure !== null) return { ok: false, reason: authFailure }
    if (!UUID_PATTERN.test(deviceId)) return { ok: false, reason: 'invalid' }
    if (this.ctx.getWebSockets().length >= Number(this.env.MAX_ROOM_CONNECTIONS)) {
      return { ok: false, reason: 'capacity' }
    }

    const ticketBytes = crypto.getRandomValues(new Uint8Array(32))
    const ticket = encodeBase64Url(ticketBytes)
    const ticketHash = await this.ticketHash(ticketBytes)
    const expiresAt = Date.now() + 30_000
    this.ctx.storage.sql.exec('DELETE FROM socket_tickets WHERE expires_at <= ?', Date.now())
    this.ctx.storage.sql.exec(
      'INSERT INTO socket_tickets (ticket_hash, device_id, expires_at) VALUES (?, ?, ?)',
      ticketHash,
      deviceId,
      expiresAt,
    )
    return { ok: true, ticket, expiresAt }
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)
    if (url.pathname !== '/websocket') return new Response('Not found', { status: 404 })
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
      return new Response('Expected WebSocket upgrade', { status: 426 })
    }

    const ticket = url.searchParams.get('ticket')
    const ticketRow = ticket === null ? null : await this.consumeSocketTicket(ticket)
    if (ticketRow === null) return new Response('Invalid or expired ticket', { status: 401 })

    const row = this.room()
    if (row === null || row.expires_at <= Date.now()) {
      return new Response('Room expired', { status: 410 })
    }
    if (this.ctx.getWebSockets().length >= Number(this.env.MAX_ROOM_CONNECTIONS)) {
      return new Response('Room is at capacity', { status: 429 })
    }

    const pair = new WebSocketPair()
    const client = pair[0]
    const server = pair[1]
    this.ctx.acceptWebSocket(server)
    server.serializeAttachment({
      deviceId: ticketRow.device_id,
      connectedAt: Date.now(),
    } satisfies SocketAttachment)
    server.send(
      JSON.stringify({
        type: 'ready',
        onlineCount: this.ctx.getWebSockets().length,
        expiresAt: row.expires_at,
        remainingEvents: this.remainingEvents(),
      }),
    )
    this.broadcastPresence()

    return new Response(null, { status: 101, webSocket: client })
  }

  async webSocketMessage(socket: WebSocket, frame: string | ArrayBuffer): Promise<void> {
    if (typeof frame !== 'string') {
      socket.close(1003, 'Text frames only')
      return
    }
    if (frame.length > 196_608) {
      socket.close(1009, 'Frame too large')
      return
    }

    let value: unknown
    try {
      value = JSON.parse(frame)
    } catch {
      socket.send(JSON.stringify({ type: 'error', code: 'invalid_frame' }))
      return
    }
    const parsed = webSocketClientFrameSchema.safeParse(value)
    if (!parsed.success) {
      socket.send(JSON.stringify({ type: 'error', code: 'invalid_frame' }))
      return
    }
    if (parsed.data.type === 'ping') {
      socket.send(JSON.stringify({ type: 'pong', at: Date.now() }))
      return
    }

    const attachment: unknown = socket.deserializeAttachment()
    if (
      typeof attachment !== 'object' ||
      attachment === null ||
      !('deviceId' in attachment) ||
      typeof attachment.deviceId !== 'string' ||
      !UUID_PATTERN.test(attachment.deviceId)
    ) {
      socket.close(1011, 'Session state unavailable')
      return
    }
    const row = this.room()
    if (row === null || row.expires_at <= Date.now()) {
      socket.close(4001, 'Room expired')
      return
    }

    const result = this.storeMessage(attachment.deviceId, parsed.data.envelope)
    if (!result.ok) {
      socket.send(
        JSON.stringify({
          type: 'error',
          code: result.reason,
          messageId: parsed.data.envelope.id,
        }),
      )
      return
    }
    if (!result.duplicate) {
      this.broadcast({
        type: 'message',
        message: result.message,
        remainingEvents: result.remainingEvents,
      })
    }
    socket.send(
      JSON.stringify({
        type: 'ack',
        id: result.message.id,
        sequence: result.message.sequence,
        duplicate: result.duplicate,
        remainingEvents: result.remainingEvents,
      }),
    )
  }

  webSocketClose(socket: WebSocket, code: number, reason: string): void {
    socket.close(code, reason)
    this.broadcastPresence()
  }

  webSocketError(socket: WebSocket, error: unknown): void {
    console.error(JSON.stringify({ event: 'websocket_error', errorType: errorType(error) }))
    socket.close(1011, 'WebSocket error')
  }
}
