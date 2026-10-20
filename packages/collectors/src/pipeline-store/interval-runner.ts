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

import { appendErrorLog } from './error-log'

export interface IntervalRunnerOptions {
  /** Human-readable name used in the skip/overlap log line. */
  label: string
  /** Tick interval in milliseconds. */
  intervalMs: number
  /** The work to run on each tick. */
  run: () => Promise<void>
  /** Called when a tick is skipped because the previous tick is still running. */
  onOverlap?: (info: { label: string; runningForMs: number }) => void
  /** Called when `run()` rejects. Defaults to a console.error line plus a JSONL error-log entry. */
  onError?: (error: unknown, info: { label: string; consecutiveFailures?: number }) => void
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

function defaultOnError(error: unknown, info: { label: string; consecutiveFailures?: number }): void {
  console.error(`[${info.label}] run failed:`, error)
  appendErrorLog(
    info.consecutiveFailures === undefined
      ? { app: info.label, kind: 'run_failed', error }
      : { app: info.label, kind: 'run_failed', error, count: info.consecutiveFailures },
  )
}

/**
 * Starts a `run` callback on a fixed interval, skipping (and logging) any
 * tick that would overlap a still-in-flight previous run.
 *
 * Does NOT invoke `run` immediately. Callers that want an initial run before
 * the interval starts should use `runFirstThenInterval`, which awaits that
 * first run and then starts this recurring schedule - reporting a failing
 * first run through `onError` instead of letting it escape, so one bad
 * startup tick cannot exit the worker before the schedule is running.
 */
export function startIntervalRunner(options: IntervalRunnerOptions): IntervalRunnerHandle {
  const { label, intervalMs, run } = options
  const onError = options.onError ?? defaultOnError

  let running = false
  let startedAt = 0
  let lastOverlapWarningAt = 0
  let consecutiveFailures = 0
  const overlapWarningAfterMs = Math.max(5 * 60_000, intervalMs * 2)

  const timer = setInterval(() => {
    if (running) {
      const runningForMs = Date.now() - startedAt
      if (options.onOverlap) options.onOverlap({ label, runningForMs })
      else if (runningForMs >= overlapWarningAfterMs && runningForMs - lastOverlapWarningAt >= overlapWarningAfterMs) {
        defaultOnOverlap({ label, runningForMs })
        lastOverlapWarningAt = runningForMs
      }
      return
    }

    running = true
    startedAt = Date.now()
    lastOverlapWarningAt = 0
    run()
      .then(() => { consecutiveFailures = 0 }, (error) => {
        consecutiveFailures += 1
        onError(error, { label, consecutiveFailures })
      })
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

export interface RunFirstThenIntervalOptions extends IntervalRunnerOptions {
  /** When true, run exactly once and let a failure propagate (RUN_ONCE semantics). */
  runOnce: boolean
}

/**
 * Runs `run` once, then (unless runOnce) starts the overlap-guarded interval.
 * A failing first run is reported through onError and the schedule still starts,
 * so one bad tick cannot exit a PM2 daemon. Returns null in runOnce mode.
 */
export async function runFirstThenInterval(options: RunFirstThenIntervalOptions): Promise<IntervalRunnerHandle | null> {
  if (options.runOnce) {
    await options.run()
    return null
  }
  // In daemon mode the first run is just an early tick: a failure here used
  // to escape to the entrypoint catch and process.exit(1) before the
  // interval ever started, so PM2 kept restarting into the same failure.
  // Report it the same way an interval tick failure is reported and keep the
  // schedule running so a later tick can succeed.
  try {
    await options.run()
  } catch (error) {
    ;(options.onError ?? defaultOnError)(error, { label: options.label })
  }
  return startIntervalRunner(options)
}
