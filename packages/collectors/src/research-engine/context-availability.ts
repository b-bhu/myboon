import { healthBackoffMs } from '../pipeline-store/health-gate'

export type ArticleContextReader = 'managed' | 'legacy'

export interface ArticleContextFailure {
  readonly reader: ArticleContextReader | 'probe'
  readonly errorClass: string
}

export class ArticleContextProbeError extends Error {
  constructor(readonly failures: readonly ArticleContextFailure[]) {
    super(`Article context storage is unavailable (${failures.map(f => `${f.reader}: ${f.errorClass}`).join(', ')})`)
    this.name = 'ArticleContextProbeError'
  }
}

/** Classifies an error by code or name only; never exposes message text. */
export function errorClassOf(error: unknown): string {
  if (typeof error === 'object' && error !== null) {
    const code = (error as { code?: unknown }).code
    if (typeof code === 'string' && /^[A-Z0-9][A-Z0-9_]{1,63}$/.test(code)) return code
  }
  if (error instanceof Error && /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(error.name)) return error.name
  return 'unknown'
}

export interface ArticleContextAvailabilitySnapshot {
  available: boolean | null
  lastCheckedAt: string | null
  nextProbeAt: string | null
  consecutiveFailures: number
  lastFailure: readonly ArticleContextFailure[] | null
}

/** Checks storage before work is claimed; an outage never spends a work attempt. */
export class ArticleContextAvailabilityGate {
  private available: boolean | null = null
  private lastCheckedAt: number | null = null
  private nextProbeAt = 0
  private consecutiveFailures = 0
  private lastFailure: readonly ArticleContextFailure[] | null = null
  private pending: Promise<boolean> | null = null
  private generation = 0

  constructor(
    private readonly probe: () => Promise<void>,
    private readonly now: () => number = Date.now,
    private readonly healthyIntervalMs = 300_000,
    private readonly random: () => number = Math.random,
  ) {
    if (!Number.isSafeInteger(healthyIntervalMs) || healthyIntervalMs < 30_000 || healthyIntervalMs > 300_000) {
      throw new RangeError('Healthy storage probe interval must be between 30000 and 300000 milliseconds')
    }
  }

  get claimsAllowed(): boolean { return this.available === true }

  snapshot(): ArticleContextAvailabilitySnapshot {
    return {
      available: this.available,
      lastCheckedAt: this.lastCheckedAt === null ? null : new Date(this.lastCheckedAt).toISOString(),
      nextProbeAt: this.nextProbeAt === 0 ? null : new Date(this.nextProbeAt).toISOString(),
      // Status consumers read consecutiveFailures > 0 as degraded (Ref #336):
      // while the gate is healthy the snapshot reports 0 even before real work
      // resets the counter. The internal back-off count is unchanged and keeps
      // its own step until recordHealthy() clears it or a failure advances it.
      consecutiveFailures: this.available === true ? 0 : this.consecutiveFailures,
      lastFailure: this.lastFailure === null ? null : Object.freeze([...this.lastFailure]),
    }
  }

  check(): Promise<boolean> {
    if (this.pending) return this.pending
    if (this.now() < this.nextProbeAt) return Promise.resolve(this.claimsAllowed)
    this.pending = this.runProbe().finally(() => { this.pending = null })
    return this.pending
  }

  /** A dependency can fail after a successful probe; stop the rest of the batch. */
  invalidate(): void {
    // Identity bump first: workers holding the old cycle must not record health.
    this.generation += 1
    // An invalidation while already down observes the same failure again: it
    // must not advance the back-off curve nor push the retry deadline further
    // (Ref #336). Only the transition out of available counts one step; two
    // sibling invalidations in one cycle therefore count once. A gate that has
    // never probed still counts: its in-flight probe result is stale and the
    // new failure must open the retry deadline.
    if (this.available === false) return
    this.available = false
    // The cheap probe passing does not prove the database answers (Ref #336):
    // a real call failing while available is another failure on the same
    // curve, otherwise a too-slow database retries every 30 s forever.
    this.consecutiveFailures += 1
    // A newly observed failure must not inherit the longer healthy deadline.
    this.nextProbeAt = this.now() + healthBackoffMs(this.consecutiveFailures, this.random)
  }

  /** Identity of the invalidation curve; captured once per cycle before its workers race. */
  get currentGeneration(): number { return this.generation }

  /**
   * Only real successful work proves the database healthy; a probe cannot.
   * Ignored unless the gate is still available and the generation captured at
   * cycle start is current: a batch landing after a sibling's invalidate()
   * must not erase the back-off step that failure just advanced (Ref #407).
   */
  recordHealthy(generation: number): void {
    if (this.available !== true || generation !== this.generation) return
    this.consecutiveFailures = 0
  }

  private async runProbe(): Promise<boolean> {
    const generation = this.generation
    try {
      await this.probe()
      if (generation !== this.generation) return false
      this.available = true
      // A passing probe no longer resets consecutiveFailures; only real work
      // via recordHealthy does, or a slow database would never back off.
      this.lastFailure = null
      this.lastCheckedAt = this.now()
      this.nextProbeAt = this.lastCheckedAt + this.healthyIntervalMs
      return true
    } catch (error) {
      if (generation !== this.generation) return false
      this.lastFailure = error instanceof ArticleContextProbeError
        ? error.failures
        : [{ reader: 'probe', errorClass: errorClassOf(error) }]
      this.available = false
      this.consecutiveFailures += 1
      this.lastCheckedAt = this.now()
      // Backoff moved to the shared 15-min ceiling jittered health backoff (Ref #346).
      this.nextProbeAt = this.lastCheckedAt + healthBackoffMs(this.consecutiveFailures, this.random)
      return false
    }
  }
}
