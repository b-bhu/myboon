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
