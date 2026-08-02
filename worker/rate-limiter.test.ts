import { env } from 'cloudflare:workers'
import { runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'

describe('RateLimiterDurableObject', () => {
  it('enforces fixed-window limits per scope', async () => {
    const limiter = env.RATE_LIMITERS.getByName(crypto.randomUUID())

    expect(await limiter.consume('room-create', 2, 60)).toMatchObject({
      allowed: true,
      remaining: 1,
    })
    expect(await limiter.consume('room-create', 2, 60)).toMatchObject({
      allowed: true,
      remaining: 0,
    })
    expect(await limiter.consume('room-create', 2, 60)).toMatchObject({
      allowed: false,
      remaining: 0,
    })
    expect((await limiter.consume('room-join', 1, 60)).allowed).toBe(true)
  })

  it('schedules its temporary storage for deletion', async () => {
    const limiter = env.RATE_LIMITERS.getByName(crypto.randomUUID())

    await limiter.consume('room-create', 1, 60)
    const alarm = await runInDurableObject(
      limiter,
      (_instance, state) => state.storage.getAlarm(),
    )

    expect(alarm).not.toBeNull()
    expect(alarm).toBeGreaterThan(Date.now())
  })

  it('recreates its temporary schema after the cleanup alarm', async () => {
    const limiter = env.RATE_LIMITERS.getByName(crypto.randomUUID())
    expect((await limiter.consume('room-create', 2, 60)).allowed).toBe(true)

    expect(await runDurableObjectAlarm(limiter)).toBe(true)

    await expect(limiter.consume('room-create', 2, 60)).resolves.toMatchObject({
      allowed: true,
      remaining: 1,
    })
  })
})
