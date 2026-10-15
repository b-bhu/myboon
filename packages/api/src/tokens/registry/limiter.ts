export class LimitedError extends Error {
  constructor(message: string, readonly reason: 'circuit-open' | 'budget-exceeded' | 'rate-limited' = 'rate-limited') {
    super(message); this.name = 'LimitedError'
  }
}

export class UpstreamStatusError extends Error {
  constructor(readonly status: number, readonly retryAfterMs?: number) { super(`Upstream returned ${status}`) }
}

export interface LimiterOptions {
  maxConcurrency?: number
  requestsPerMinute?: number
  cooldownMs?: number
  now?: () => number
  random?: () => number
  sleep?: (ms: number) => Promise<void>
}

export class UpstreamLimiter {
  private active = 0
  private tokens: number
  private lastRefill: number
  private failures = 0
  private circuitUntil = 0
  private blockedUntil = 0
  private readonly now: () => number
  private readonly random: () => number
  private readonly sleep: (ms: number) => Promise<void>
  readonly maxConcurrency: number
  readonly requestsPerMinute: number
  readonly cooldownMs: number

  constructor(options: LimiterOptions = {}) {
    this.maxConcurrency = options.maxConcurrency ?? 2
    this.requestsPerMinute = options.requestsPerMinute ?? 30
    this.cooldownMs = options.cooldownMs ?? 300_000
    this.now = options.now ?? Date.now
    this.random = options.random ?? Math.random
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
    this.tokens = this.requestsPerMinute
    this.lastRefill = this.now()
  }

  async schedule<T>(fn: () => Promise<T>, budgetMs = 2_000): Promise<T> {
    const deadline = this.now() + budgetMs
    while (true) {
      this.refill()
      if (this.now() < this.circuitUntil) throw new LimitedError('Upstream circuit is open', 'circuit-open')
      const tokenWait = this.tokens >= 1 ? 0 : Math.ceil((1 - this.tokens) * 60_000 / this.requestsPerMinute)
      const waitFor = Math.max(this.blockedUntil - this.now(), this.active >= this.maxConcurrency ? 5 : 0, tokenWait)
      if (waitFor <= 0) break
      const remaining = deadline - this.now()
      if (remaining <= 0) throw new LimitedError('Upstream scheduling budget exceeded', 'budget-exceeded')
      await this.sleep(Math.min(waitFor, remaining))
    }
    this.tokens -= 1
    this.active += 1
    let released = false
    let timedOut = false
    const release = () => { if (!released) { released = true; this.active -= 1 } }
    const operation = Promise.resolve().then(fn)
    // Keep the concurrency slot until the underlying request really settles,
    // even when its caller has already hit the scheduling budget.
    void operation.then(release, release)
    let timeout: NodeJS.Timeout | undefined
    try {
      const value = await Promise.race([
        operation,
        new Promise<never>((_, reject) => {
          timeout = setTimeout(() => {
            timedOut = true
            reject(new LimitedError('Upstream request budget exceeded', 'budget-exceeded'))
          }, Math.max(0, deadline - this.now()))
        }),
      ])
      this.failures = 0
      this.blockedUntil = 0
      return value
    } catch (error) {
      this.failures += 1
      const isRetryable = error instanceof UpstreamStatusError && (error.status === 429 || error.status >= 500)
      if (isRetryable) {
        const base = Math.min(60_000, 1_000 * (2 ** (this.failures - 1)))
        const jitter = Math.floor(this.random() * base)
        this.blockedUntil = this.now() + Math.max(jitter, error.retryAfterMs ?? 0)
      }
      if (this.failures >= 3) this.circuitUntil = this.now() + this.cooldownMs
      throw error
    } finally {
      if (timeout) clearTimeout(timeout)
      if (!timedOut) release()
    }
  }

  get inFlight(): number { return this.active }
  get isOpen(): boolean { return this.now() < this.circuitUntil }

  private refill(): void {
    const now = this.now()
    const elapsed = Math.max(0, now - this.lastRefill)
    this.tokens = Math.min(this.requestsPerMinute, this.tokens + elapsed * this.requestsPerMinute / 60_000)
    this.lastRefill = now
    if (now >= this.circuitUntil) this.circuitUntil = 0
  }
}
