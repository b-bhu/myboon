import assert from 'node:assert/strict'
import { mkdtemp, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { HermesConcurrencyLimiter } from './limiter'

test('cross-process limiter waits until a shared slot is released', async () => {
  const lockDir = await mkdtemp(join(tmpdir(), 'hermes-limiter-'))
  try {
    const firstLimiter = new HermesConcurrencyLimiter({ maxConcurrency: 1, lockDir, pollIntervalMs: 2 })
    const secondLimiter = new HermesConcurrencyLimiter({ maxConcurrency: 1, lockDir, pollIntervalMs: 2 })
    const first = await firstLimiter.acquire(100)
    let acquired = false
    const waiting = secondLimiter.acquire(200).then((lease) => {
      acquired = true
      return lease
    })

    await new Promise((resolve) => setTimeout(resolve, 15))
    assert.equal(acquired, false)
    first.release()

    const second = await waiting
    assert.equal(acquired, true)
    second.release()
  } finally {
    await rm(lockDir, { recursive: true, force: true })
  }
})

test('cross-process limiter reclaims a lock whose owner PID is gone', async () => {
  const lockDir = await mkdtemp(join(tmpdir(), 'hermes-limiter-stale-'))
  try {
    await writeFile(join(lockDir, 'slot-0.lock'), JSON.stringify({ pid: 2_000_000_000, token: 'stale' }))
    const limiter = new HermesConcurrencyLimiter({ maxConcurrency: 1, lockDir, pollIntervalMs: 2 })

    const lease = await limiter.acquire(100)
    lease.release()
  } finally {
    await rm(lockDir, { recursive: true, force: true })
  }
})

test('cross-process limiter times out instead of allowing unbounded concurrency', async () => {
  const lockDir = await mkdtemp(join(tmpdir(), 'hermes-limiter-timeout-'))
  try {
    const limiter = new HermesConcurrencyLimiter({ maxConcurrency: 1, lockDir, pollIntervalMs: 2 })
    const lease = await limiter.acquire(100)
    await assert.rejects(() => limiter.acquire(10), /Timed out waiting 10ms/)
    lease.release()
  } finally {
    await rm(lockDir, { recursive: true, force: true })
  }
})

test('cross-process limiter reclaims a malformed lock left by a partial write', async () => {
  const lockDir = await mkdtemp(join(tmpdir(), 'hermes-limiter-partial-'))
  try {
    const path = join(lockDir, 'slot-0.lock')
    await writeFile(path, '')
    const old = new Date(Date.now() - 10_000)
    await utimes(path, old, old)
    const limiter = new HermesConcurrencyLimiter({
      maxConcurrency: 1,
      lockDir,
      pollIntervalMs: 2,
      invalidLockGraceMs: 5,
    })

    const lease = await limiter.acquire(100)
    lease.release()
  } finally {
    await rm(lockDir, { recursive: true, force: true })
  }
})
