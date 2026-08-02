import { DurableObject } from 'cloudflare:workers'

const SCOPE_PATTERN = /^[a-z][a-z0-9-]{0,63}$/u

interface CounterRow extends Record<string, SqlStorageValue> {
  window_start: number
  request_count: number
}

export interface RateLimitResult {
  allowed: boolean
  remaining: number
  retryAfterSeconds: number
  resetAt: number
  reason?: 'invalid'
}

export class RateLimiterDurableObject extends DurableObject<Env> {
  private schemaReady = false

  private ensureSchema(): void {
    if (this.schemaReady) return
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS counters (
        scope TEXT PRIMARY KEY,
        window_start INTEGER NOT NULL,
        request_count INTEGER NOT NULL
      );
    `)
    this.schemaReady = true
  }

  async consume(scope: string, limit: number, windowSeconds: number): Promise<RateLimitResult> {
    if (
      !SCOPE_PATTERN.test(scope) ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 10_000 ||
      !Number.isSafeInteger(windowSeconds) ||
      windowSeconds < 1 ||
      windowSeconds > 86_400
    ) {
      return {
        allowed: false,
        remaining: 0,
        retryAfterSeconds: 1,
        resetAt: Date.now() + 1_000,
        reason: 'invalid',
      }
    }

    this.ensureSchema()
    const now = Date.now()
    const windowMilliseconds = windowSeconds * 1_000
    const windowStart = Math.floor(now / windowMilliseconds) * windowMilliseconds
    const resetAt = windowStart + windowMilliseconds
    const row = this.ctx.storage.sql
      .exec<CounterRow>(
        'SELECT window_start, request_count FROM counters WHERE scope = ?',
        scope,
      )
      .toArray()[0]
    const currentCount = row?.window_start === windowStart ? row.request_count : 0
    const allowed = currentCount < limit
    const nextCount = allowed ? currentCount + 1 : currentCount

    this.ctx.storage.sql.exec(
      `INSERT INTO counters (scope, window_start, request_count)
       VALUES (?, ?, ?)
       ON CONFLICT(scope) DO UPDATE SET
         window_start = excluded.window_start,
         request_count = excluded.request_count`,
      scope,
      windowStart,
      nextCount,
    )
    await this.ctx.storage.setAlarm(resetAt + 86_400_000)

    return {
      allowed,
      remaining: Math.max(0, limit - nextCount),
      retryAfterSeconds: allowed ? 0 : Math.max(1, Math.ceil((resetAt - now) / 1_000)),
      resetAt,
    }
  }

  async alarm(): Promise<void> {
    await this.ctx.storage.deleteAll()
    this.schemaReady = false
  }
}
