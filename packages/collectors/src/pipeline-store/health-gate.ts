/**
 * Supabase health gate for pipeline workers (Ref #346).
 *
 * A Supabase outage used to burn every tick: each run spent its full timeout
 * (or worse, a batch of them) against a dead API, and kept logging per-tick
 * failures. A gate flips the shape: before each tick one small bounded probe
 * decides whether the tick may touch Supabase at all. While the gate is
 * closed, ticks return immediately (they are skipped, not failed), probes
 * retry on an exponential backoff capped at 15 minutes, and the JSONL error
 * log records ONE down / recovered transition plus a still_down heartbeat
 * every 10 skipped ticks - no per-tick spam.
 *
 * The probe itself (`createSupabaseHealthProbe` from @myboon/shared/
 * supabase-client) is a 5s-timeout single read from pipeline_runs, so a hung
 * Supabase is detected in seconds instead of stalling a worker forever.
 */

import { appendErrorLog, type ErrorLogEntry, type ErrorLogHealthState } from './error-log'

export const HEALTH_BACKOFF_BASE_MS = 30_000
export const HEALTH_BACKOFF_MAX_MS = 900_000
/** Floor keeping a (jittered) delay from collapsing to zero. */
const HEALTH_BACKOFF_MIN_MS = 1_000

/**
 * Exponential outage backoff between 30 s and 15 minutes (0.8x-1.2x jitter).
 * failure n>=1 waits BASE * 2^(n-1) capped at MAX; n<1 is treated as 1. The
 * exponent is clamped so 2**() can never produce Infinity even for absurd
 * counters, and the jittered delay is then clamped into [1s, MAX].
 */
export function healthBackoffMs(consecutiveFailures: number, random: () => number = Math.random): number {
  const failures = Math.max(1, Math.floor(consecutiveFailures))
  const exponent = Math.min(failures - 1, 10)
  const raw = Math.min(HEALTH_BACKOFF_MAX_MS, HEALTH_BACKOFF_BASE_MS * 2 ** exponent)
  const jittered = Math.round(raw * (0.8 + 0.4 * random()))
  return Math.min(HEALTH_BACKOFF_MAX_MS, Math.max(HEALTH_BACKOFF_MIN_MS, jittered))
}

export interface SupabaseHealthGateOptions {
  /** Error-log app label, the same one the worker already uses elsewhere. */
  app: string
  /** The bounded probe (createSupabaseHealthProbe); rejects when Supabase is unhealthy. */
  probe: () => Promise<void>
  /** Injectable clock. Defaults to Date.now. */
  now?: () => number
  /** Injectable jitter source. Defaults to Math.random. */
  random?: () => number
  /** Injectable error-log sink. Defaults to appendErrorLog. */
  log?: (entry: ErrorLogEntry) => void
}

export interface SupabaseHealthGateSnapshot {
  available: boolean | null
  consecutiveFailures: number
  skippedTicks: number
  nextProbeAt: string | null
}

/**
 * Gates ticks on Supabase health: check() returns false to skip a tick and
 * true to run it. Concurrent callers share one in-flight probe. Backoff
 * windows mean a closed gate may skip ticks WITHOUT probing (that is the
 * point: an outage must not keep hammering Supabase every tick).
 */
export class SupabaseHealthGate {
  private readonly app: string
  private readonly probe: () => Promise<void>
  private readonly now: () => number
  private readonly random: () => number
  private readonly log: (entry: ErrorLogEntry) => void

  private available: boolean | null = null
  private consecutiveFailures = 0
  private skippedTicks = 0
  private nextProbeAt = 0
  private firstDownAt: number | null = null
  private lastError: unknown
  private pending: Promise<boolean> | null = null

  constructor(options: SupabaseHealthGateOptions) {
    this.app = options.app
    this.probe = options.probe
    this.now = options.now ?? Date.now
    this.random = options.random ?? Math.random
    this.log = options.log ?? appendErrorLog
  }

  snapshot(): SupabaseHealthGateSnapshot {
    return {
      available: this.available,
      consecutiveFailures: this.consecutiveFailures,
      skippedTicks: this.skippedTicks,
      nextProbeAt: this.nextProbeAt === 0 ? null : new Date(this.nextProbeAt).toISOString(),
    }
  }

  /**
   * true = run the tick, false = skip it. Never rejects: a probe failure or a
   * throwing/injectable log sink is folded into state and logged instead.
   */
  check(): Promise<boolean> {
    if (this.pending) {
      // Concurrent ticks share the in-flight probe; a caller that shares a
      // failed probe is itself a skipped tick.
      return this.pending.then((allowed) => {
        if (!allowed) this.recordSkippedTick()
        return allowed
      })
    }
    const now = this.now()
    if (now < this.nextProbeAt) {
      this.recordSkippedTick()
      return Promise.resolve(false)
    }
    this.pending = this.runProbe().finally(() => { this.pending = null })
    return this.pending
  }

  private async runProbe(): Promise<boolean> {
    let failed = false
    let thrown: unknown
    try {
      await this.probe()
    } catch (error) {
      failed = true
      thrown = error
    }
    if (!failed) return this.recordSuccess()
    return this.recordFailure(thrown)
  }

  private recordSuccess(): boolean {
    const wasDown = this.available === false
    if (wasDown) {
      const downtimeMs = Math.max(0, this.now() - (this.firstDownAt ?? this.now()))
      this.logHealthGate({ state: 'recovered', error: this.lastError, downtimeMs, count: this.skippedTicks })
    }
    this.available = true
    this.consecutiveFailures = 0
    this.skippedTicks = 0
    this.firstDownAt = null
    this.lastError = undefined
    // The gate stays open between ticks: every interval tick probes again.
    this.nextProbeAt = 0
    return true
  }

  private recordFailure(thrown: unknown): boolean {
    this.lastError = thrown
    this.consecutiveFailures += 1
    this.nextProbeAt = this.now() + healthBackoffMs(this.consecutiveFailures, this.random)
    const wasDown = this.available === false
    this.available = false
    if (this.firstDownAt === null) this.firstDownAt = this.now()
    if (!wasDown) this.logHealthGate({ state: 'down', error: thrown })
    // A tick whose probe failed is also a skipped tick.
    this.recordSkippedTick()
    return false
  }

  private recordSkippedTick(): void {
    this.skippedTicks += 1
    // Heartbeat on every 10th skipped tick (10, 20, 30, ...) so a long outage
    // leaves a bounded trail instead of one line per tick.
    if (this.skippedTicks % 10 === 0) {
      this.logHealthGate({ state: 'still_down', error: this.lastError, count: this.skippedTicks })
    }
  }

  private logHealthGate(input: {
    state: ErrorLogHealthState
    error: unknown
    downtimeMs?: number
    count?: number
  }): void {
    const entry: ErrorLogEntry = {
      app: this.app,
      kind: 'supabase_unavailable',
      error: input.error,
      count: input.count,
      state: input.state,
      ...(input.downtimeMs !== undefined ? { downtimeMs: input.downtimeMs } : {}),
    }
    // Logging must never be able to kill (or crash-loop) a gated worker.
    try {
      this.log(entry)
    } catch {
      // Swallow: a broken log sink must not turn a skip into a tick failure.
    }
  }
}

export interface WaitForSupabaseRunOnceOptions {
  /** Error-log app label, the same one the worker already uses elsewhere. */
  app: string
  /** The bounded probe (createSupabaseHealthProbe); rejects when Supabase is unhealthy. */
  probe: () => Promise<void>
  /** Probe attempts before giving up. Defaults to 3. */
  attempts?: number
  /** Sleep between attempts. Defaults to 10_000 (about 30 s total with probe timeouts). */
  delayMs?: number
  /** Injectable sleep. Defaults to a real setTimeout. */
  sleep?: (ms: number) => Promise<void>
  /** Injectable error-log sink. Defaults to appendErrorLog. */
  log?: (entry: ErrorLogEntry) => void
}

/**
 * RUN_ONCE gate: give the worker a bounded startup window (about 30 s across
 * 3 attempts with the 5 s probe timeout) instead of failing after the first
 * hiccup. The first success returns. After the last failure logs one down
 * entry and throws so the existing fatal path exits non-zero.
 */
export async function waitForSupabaseRunOnce(options: WaitForSupabaseRunOnceOptions): Promise<void> {
  const attempts = options.attempts ?? 3
  const delayMs = options.delayMs ?? 10_000
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms) }))
  const log = options.log ?? appendErrorLog
  let lastError: unknown
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await options.probe()
      return
    } catch (error) {
      lastError = error
      if (attempt < attempts) await sleep(delayMs)
    }
  }
  // Logging must never throw - same contract as the gate.
  try {
    log({ app: options.app, kind: 'supabase_unavailable', error: lastError, count: attempts, state: 'down' })
  } catch {
    // Swallow: the fatal error below must still reach the caller.
  }
  throw new Error(`Supabase unavailable after ${attempts} health probe attempts`, { cause: lastError })
}

/**
 * Runs a gate check for a worker tick: true (or no gate) allows the tick, any
 * rejection counts as a closed gate. Never rejects, so a broken gate cannot
 * escape into a worker's error path as a run failure.
 */
export async function healthGateAllows(gate: { check(): Promise<boolean> } | undefined): Promise<boolean> {
  if (gate === undefined) return true
  try {
    return await gate.check()
  } catch {
    return false
  }
}