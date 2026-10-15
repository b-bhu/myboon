import assert from 'node:assert/strict'
import test from 'node:test'
import { LimitedError, UpstreamLimiter, UpstreamStatusError } from './limiter.js'

test('limiter caps concurrent work at two', async () => {
  const limiter = new UpstreamLimiter()
  let active = 0; let maximum = 0
  await Promise.all(Array.from({ length: 6 }, () => limiter.schedule(async () => {
    active++; maximum = Math.max(maximum, active)
    await new Promise((resolve) => setTimeout(resolve, 5)); active--
  })))
  assert.equal(maximum, 2)
})

test('token bucket enforces RPM using an injected clock', async () => {
  let now = 0
  const limiter = new UpstreamLimiter({ requestsPerMinute: 1, now: () => now, sleep: async (ms) => { now += ms } })
  await limiter.schedule(async () => 1)
  await limiter.schedule(async () => 2, 120_000)
  assert.ok(now >= 60_000)
})

test('429/5xx backoff honors Retry-After and circuit opens after three failures', async () => {
  let now = 0
  const sleeps: number[] = []
  const limiter = new UpstreamLimiter({ requestsPerMinute: 100, cooldownMs: 10_000, now: () => now, random: () => 0.5, sleep: async (ms) => { sleeps.push(ms); now += ms } })
  for (const status of [429, 503, 500]) {
    await assert.rejects(limiter.schedule(async () => { throw new UpstreamStatusError(status, status === 429 ? 4_000 : undefined) }, 10_000))
  }
  assert.equal(limiter.isOpen, true)
  await assert.rejects(limiter.schedule(async () => undefined), LimitedError)
  now += 10_000
  await limiter.schedule(async () => undefined, 10_000)
  assert.ok(sleeps.includes(4_000))
})

test('timeouts and 404s do not open the circuit; three consecutive 503s do', async () => {
  let now = 0
  const limiter = new UpstreamLimiter({
    requestsPerMinute: 100, cooldownMs: 10_000, now: () => now, random: () => 0,
    sleep: async (ms) => { now += ms },
  })

  for (let i = 0; i < 3; i++) {
    await assert.rejects(
      limiter.schedule(() => new Promise((resolve) => setTimeout(resolve, 5)), 1),
      (error: unknown) => error instanceof LimitedError && error.reason === 'budget-exceeded',
    )
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  for (let i = 0; i < 3; i++) {
    await assert.rejects(limiter.schedule(async () => { throw new UpstreamStatusError(404) }))
  }
  assert.equal(limiter.isOpen, false)

  for (let i = 0; i < 3; i++) {
    await assert.rejects(limiter.schedule(async () => { throw new UpstreamStatusError(503) }))
  }
  assert.equal(limiter.isOpen, true)
})
