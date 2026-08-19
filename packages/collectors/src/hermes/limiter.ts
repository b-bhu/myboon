import { randomUUID } from 'node:crypto'
import { closeSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const DEFAULT_MAX_CONCURRENCY = 2
const DEFAULT_POLL_INTERVAL_MS = 250
const DEFAULT_LOCK_DIR = '/tmp/myboon-hermes-slots'

export interface HermesConcurrencyLimiterOptions {
  maxConcurrency?: number
  lockDir?: string
  pollIntervalMs?: number
}

export interface HermesConcurrencyLease {
  release(): void
}

interface LockRecord {
  pid: number
  token: string
}

function positiveInteger(value: string | undefined, fallback: number): number {
  if (!value) return fallback
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback
}

function processIsAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

function readLock(path: string): LockRecord | null {
  try {
    const value = JSON.parse(readFileSync(path, 'utf8')) as Partial<LockRecord>
    return typeof value.pid === 'number' && typeof value.token === 'string'
      ? { pid: value.pid, token: value.token }
      : null
  } catch {
    return null
  }
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Small cross-process semaphore for Hermes CLI calls.
 *
 * PM2 runs each pipeline stage in a separate process, so an in-memory queue
 * in HermesService would still let every stage launch its own browser at the
 * same time. Atomic `wx` lock files provide one shared budget across all of
 * them. A lock whose owning PID no longer exists is reclaimed automatically,
 * which makes the limiter safe across worker crashes and PM2 restarts.
 */
export class HermesConcurrencyLimiter {
  private readonly maxConcurrency: number
  private readonly lockDir: string
  private readonly pollIntervalMs: number

  constructor(options: HermesConcurrencyLimiterOptions = {}) {
    this.maxConcurrency = options.maxConcurrency
      ?? positiveInteger(process.env.HERMES_MAX_CONCURRENCY, DEFAULT_MAX_CONCURRENCY)
    this.lockDir = options.lockDir ?? process.env.HERMES_CONCURRENCY_LOCK_DIR ?? DEFAULT_LOCK_DIR
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS
  }

  async acquire(waitTimeoutMs: number): Promise<HermesConcurrencyLease> {
    const deadline = Date.now() + waitTimeoutMs
    mkdirSync(this.lockDir, { recursive: true })

    while (Date.now() <= deadline) {
      for (let slot = 0; slot < this.maxConcurrency; slot += 1) {
        const path = join(this.lockDir, `slot-${slot}.lock`)
        const existing = readLock(path)
        if (existing && !processIsAlive(existing.pid)) {
          // Re-read before unlinking. Another waiter may have reclaimed the
          // path and written its own live lease since our first read.
          const current = readLock(path)
          try {
            if (current?.pid === existing.pid && current.token === existing.token) unlinkSync(path)
          } catch {
            // Another waiter may already have reclaimed it.
          }
        }

        const token = randomUUID()
        let fd: number | null = null
        try {
          fd = openSync(path, 'wx', 0o600)
          writeFileSync(fd, JSON.stringify({ pid: process.pid, token }))
          closeSync(fd)
          fd = null
          let released = false
          return {
            release: () => {
              if (released) return
              released = true
              const current = readLock(path)
              if (current?.pid !== process.pid || current.token !== token) return
              try {
                unlinkSync(path)
              } catch {
                // The lease is already gone; release remains idempotent.
              }
            },
          }
        } catch (error) {
          if (fd !== null) closeSync(fd)
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
        }
      }

      await wait(Math.min(this.pollIntervalMs, Math.max(1, deadline - Date.now())))
    }

    throw new Error(`Timed out waiting ${waitTimeoutMs}ms for a Hermes concurrency slot`)
  }
}
