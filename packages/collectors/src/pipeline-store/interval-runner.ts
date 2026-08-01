/**
 * Overlap-guarded interval runner.
 *
 * Every `run-*.ts` CLI entrypoint in this package (polymarket/, entity-manager/)
 * ticks its stage on a bare `setInterval`, with no in-flight mutex: if a run
 * takes longer than the tick interval, `setInterval` fires again anyway and
 * starts a SECOND overlapping run of the same stage against the same store.
 *
 * This is not theoretical for this pipeline. The Polymarket researcher ticks
 * every 5 minutes (RESEARCHER_INTERVAL_MS), but a single deep_web candidate
 * can take ~11 minutes, and a batch can contain several. A tick that starts
 * while the previous tick is still researching would claim a second,
 * disjoint batch (claimWithLease is safe against double-claiming the SAME
 * row), but the two runs would still compete for the same hermes/last30days
 * subprocess capacity, double the outbound request volume, and make
 * "one run in flight" assumptions elsewhere (e.g. reasoning about lease
 * ownership per process) considerably harder to reason about. The fix here
 * is a simple mutex: skip a tick outright (and log it) if the previous tick
 * from this same runner has not finished yet.
 *
 * This does not replace the lease-based crash recovery in pipeline-store -
 * it addresses a different failure mode. Leases handle a run that died
 * mid-flight (the process is gone); this handles a run that is merely SLOW
 * (the process is still alive and working) so two of them never race.
 */

export interface IntervalRunnerOptions {
  /** Human-readable name used in the skip/overlap log line. */
  label: string
  /** Tick interval in milliseconds. */
  intervalMs: number
  /** The work to run on each tick. */
  run: () => Promise<void>
  /** Called when a tick is skipped because the previous tick is still running. */
  onOverlap?: (info: { label: string; runningForMs: number }) => void
  /** Called when `run()` rejects. Defaults to a console.error line. */
  onError?: (error: unknown, info: { label: string }) => void
}

export interface IntervalRunnerHandle {
  /** Stops scheduling further ticks. Does not cancel a tick already in flight. */
  stop: () => void
  /** True while a tick is currently executing. */
  isRunning: () => boolean
}

function defaultOnOverlap(info: { label: string; runningForMs: number }): void {
  console.warn(
    `[${info.label}] skipped tick: previous run still in flight after ${Math.round(info.runningForMs)}ms`
  )
}

function defaultOnError(error: unknown, info: { label: string }): void {
  console.error(`[${info.label}] run failed:`, error)
}

/**
 * Starts a `run` callback on a fixed interval, skipping (and logging) any
 * tick that would overlap a still-in-flight previous run.
 *
 * Does NOT invoke `run` immediately - callers that want an initial run
 * before the interval starts should await it themselves first (matching the
 * existing `await runOnce()` before `setInterval(...)` pattern in every
 * `run-*.ts` entrypoint), then call `startIntervalRunner` for the recurring
 * schedule.
 */
export function startIntervalRunner(options: IntervalRunnerOptions): IntervalRunnerHandle {
  const { label, intervalMs, run } = options
  const onOverlap = options.onOverlap ?? defaultOnOverlap
  const onError = options.onError ?? defaultOnError

  let running = false
  let startedAt = 0

  const timer = setInterval(() => {
    if (running) {
      onOverlap({ label, runningForMs: Date.now() - startedAt })
      return
    }

    running = true
    startedAt = Date.now()
    run()
      .catch((error) => onError(error, { label }))
      .finally(() => {
        running = false
      })
  }, intervalMs)

  // This timer MUST hold a ref. In every run-*.ts daemon entrypoint it is
  // the ONLY thing keeping the event loop alive between ticks - an earlier
  // unref() here let each process exit cleanly after its first cycle, which
  // under PM2 became an infinite restart loop (a new pid every ~7 seconds,
  // observed live on 2026-07-30). Daemons exit on signals or fatal errors,
  // not by the scheduler letting go. See the liveness regression test in
  // polymarket/interval-runner.test.ts.

  return {
    stop: () => clearInterval(timer),
    isRunning: () => running,
  }
}
