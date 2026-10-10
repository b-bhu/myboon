export interface ArticleContextAvailabilitySnapshot {
  available: boolean | null
  lastCheckedAt: string | null
  nextProbeAt: string | null
  consecutiveFailures: number
}

/** Checks storage before work is claimed; an outage never spends a work attempt. */
export class ArticleContextAvailabilityGate {
  private available: boolean | null = null
  private lastCheckedAt: number | null = null
  private nextProbeAt = 0
  private consecutiveFailures = 0
  private pending: Promise<boolean> | null = null
  private generation = 0

  constructor(
    private readonly probe: () => Promise<void>,
    private readonly now: () => number = Date.now,
    private readonly healthyIntervalMs = 300_000,
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
      consecutiveFailures: this.consecutiveFailures,
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
    const wasAvailable = this.available === true
    this.generation += 1
    this.available = false
    // A newly observed failure must not inherit the longer healthy deadline.
    const retryAt = this.now() + 30_000
    this.nextProbeAt = wasAvailable ? retryAt : Math.max(this.nextProbeAt, retryAt)
  }

  private async runProbe(): Promise<boolean> {
    const generation = this.generation
    try {
      await this.probe()
      if (generation !== this.generation) return false
      this.available = true
      this.consecutiveFailures = 0
      this.lastCheckedAt = this.now()
      this.nextProbeAt = this.lastCheckedAt + this.healthyIntervalMs
      return true
    } catch {
      if (generation !== this.generation) return false
      this.available = false
      this.consecutiveFailures += 1
      this.lastCheckedAt = this.now()
      this.nextProbeAt = this.lastCheckedAt + Math.min(300_000, 30_000 * 2 ** Math.min(this.consecutiveFailures - 1, 4))
      return false
    }
  }
}
