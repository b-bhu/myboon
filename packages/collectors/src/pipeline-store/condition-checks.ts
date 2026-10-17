/**
 * Log-only condition checks for the Myboon VPS (Ref #346 PR 5).
 *
 * A cron checker watches six conditions - no published narrative for > 2h,
 * no editor draft for > 3h, an app restarting more than 5 times in 15
 * minutes, 3+ consecutive failed Supabase health probes, a missing Supabase
 * env (config_missing), and disk used > 80% - and records breaches through
 * the shared JSONL error log
 * (appendErrorLog). No push alerts: the decision is that human operators
 * read the VPS logs periodically, so the checks must be silent when
 * everything is sane and unmistakable when they are not.
 *
 * Two shapes of silence matter (decision Q2): all seven PM2 apps are
 * intentionally stopped right now, so a staleness check whose app is not
 * `online` in `pm2 jlist` must stay silent - a condition_skipped line
 * records the skipped check, but only when the set of skip reasons changes
 * (first sighting or transition): repeated stopped runs log nothing, and a
 * skip that resolves (the app is online again) closes with one
 * condition_cleared carrying condition "<check>_skipped". Supabase and
 * disk are never gated that way. The other is cadence (decision Q5): a
 * breach logs once, repeats at most every 30 minutes while it persists,
 * and closes with a single condition_cleared when it recovers.
 *
 * Everything computable lives in pure functions here with injected inputs,
 * so the tests drive ages, clocks and pm2 snapshots by hand; the cron
 * entrypoint (run-condition-check.ts) only gathers real inputs.
 */
import type { ErrorLogEntry } from './error-log'

export const PUBLISH_STALE_MAX_AGE_MS = 2 * 60 * 60 * 1000
export const DRAFT_STALE_MAX_AGE_MS = 3 * 60 * 60 * 1000
export const RESTART_BURST_WINDOW_MS = 15 * 60 * 1000
/** A burst is a restart_time increase STRICTLY greater than this in-window value. */
export const RESTART_BURST_THRESHOLD = 5
export const DISK_USED_PERCENT_THRESHOLD = 80
/** Breach once this many CONSECUTIVE checker probes have failed. */
export const SUPABASE_FAIL_THRESHOLD = 3
/** Repeat cadence while a breach persists (decision Q5): at most every 30 min. */
export const CONDITION_REPEAT_MS = 30 * 60 * 1000
/** Restart samples older than ~20 min are dropped from the state file. */
export const SAMPLE_TTL_MS = 20 * 60 * 1000

/** PM2 apps the staleness checks are gated on (ecosystem.config.cjs names). */
export const PUBLISHER_APP = 'myboon-publisher'
export const DRAFT_APP = 'myboon-editor-draft'
/** Label for checker-owned checks and bookkeeping lines. */
export const CHECKER_APP = 'condition-check'

export type ConditionKind =
  | 'publish_stale'
  | 'draft_stale'
  | 'restart_burst'
  | 'supabase_health_failed'
  | 'config_missing'
  | 'disk_high'

/** One pm2 jlist restart sample, keyed by app so the file stays small. */
export interface RestartSample {
  app: string
  pm_id: number
  restart_time: number
  /** Epoch ms the sample was taken. */
  at: number
}

/** What the checker needs from pm2 for one app. */
export interface Pm2AppSample {
  name: string
  pmId: number
  restartTime: number
}

export interface Pm2AppSnapshot extends Pm2AppSample {
  /** pm2 status string; only 'online' lets staleness checks query. */
  status: string
}

/**
 * Durable checker state, written between runs. `breached` and `lastLoggedAt`
 * are keyed by "<condition>:<app>" because restart_burst can breach on
 * several apps with independent cadence; every other condition has exactly
 * one app, so the suffix is uniform across keys. A check that is skipped
 * (its app offline, or pm2 unreadable) never appears as a result, which
 * deliberately leaves its breach state frozen until the check runs again.
 */
export interface ConditionState {
  version: 1
  samples: RestartSample[]
  supabaseConsecutiveFailures: number
  breached: Record<string, boolean>
  lastLoggedAt: Record<string, number>
  /**
   * Last-known pm2 status per gated staleness app (myboon-publisher,
   * myboon-editor-draft), e.g. "stopped". Absent on state files written
   * before this field existed; left untouched whenever pm2 is unreadable so
   * a transient daemon outage cannot fake a status transition.
   */
  appStatus?: Record<string, string>
  /**
   * Skip notes ("<check>: <reason>") that were active as of the last run,
   * keyed by the note itself and valued with the epoch ms the note was
   * first seen in the current stretch of runs. condition_skipped logs only
   * when a run's notes differ from these, so repeated stopped runs and
   * other persisting skips stay silent.
   */
  activeSkips?: Record<string, number>
}

export function emptyConditionState(): ConditionState {
  return { version: 1, samples: [], supabaseConsecutiveFailures: 0, breached: {}, lastLoggedAt: {} }
}

export interface ConditionResult {
  condition: ConditionKind
  /** PM2 app the condition concerns; the checker itself for disk/supabase. */
  app: string
  breached: boolean
  /** Measured value: age ms, restart delta, used percent or consecutive count. */
  observed?: number
  threshold?: number
  /** Dependency failure carried into the log line for the operator. */
  error?: unknown
}

/**
 * Skip reason for a staleness check, or null when it may run. Decision Q2:
 * an app that is missing or not `online` in `pm2 jlist` keeps its
 * staleness check silent (skip, never breach); an unreadable pm2 skips
 * every staleness check. Statuses compare case-insensitively because pm2
 * versions differ on casing in jlist output.
 */
export function stalenessGateReason(apps: readonly Pm2AppSnapshot[] | null, appName: string): string | null {
  if (apps === null) return 'pm2 jlist unavailable'
  const app = apps.find((candidate) => candidate.name === appName)
  if (app === undefined) return 'app missing from pm2 jlist'
  if (app.status.toLowerCase() !== 'online') return `app status ${app.status}`
  return null
}

/**
 * Last-known pm2 status for the gated staleness apps, persisted between
 * runs (Ref #346): the operator can see what the checker last observed.
 * A readable pm2 jlist updates each gated app whose snapshot is present;
 * an unreadable pm2 keeps every previous value - no data is not a status.
 */
export function updateAppStatuses(
  prev: Record<string, string> | undefined,
  current: readonly Pm2AppSnapshot[] | null,
): Record<string, string> {
  const next: Record<string, string> = { ...(prev ?? {}) }
  if (current === null) return next
  for (const appName of [PUBLISHER_APP, DRAFT_APP] as const) {
    const app = current.find((candidate) => candidate.name === appName)
    if (app !== undefined) next[appName] = app.status
  }
  return next
}

/** The check a skip note belongs to: 'publish_stale: app status stopped' -> 'publish_stale'. */
export function skipNoteCheck(note: string): string {
  const colon = note.indexOf(':')
  return colon === -1 ? note : note.slice(0, colon)
}

/** App named on a skip's condition_cleared line: the gating app for staleness checks, the checker itself otherwise. */
export function skipCheckApp(check: string): string {
  if (check === 'publish_stale') return PUBLISHER_APP
  if (check === 'draft_stale') return DRAFT_APP
  return CHECKER_APP
}

export interface SkipPlan {
  entries: ErrorLogEntry[]
  /** Notes that stopped being active this run ("<check>: <reason>"). */
  clearedNotes: string[]
  /** Notes active after this run, keyed by note, valued with the first-seen epoch ms. */
  activeSkips: Record<string, number>
}

/**
 * Skip lines are part of the log's signal, so they follow a transition
 * cadence like the breach lines do (Ref #346): a run logs condition_skipped
 * exactly once per change - the notes first seen this run, which covers an
 * app first seen not online, an online -> not-online transition, pm2 going
 * unreadable, or a store/statfs failure - and stays silent while the same
 * notes persist (repeated stopped runs log nothing). A note that stops
 * being active (its app came back online, pm2 recovered, the store is
 * readable again) closes with one condition_cleared per note, carrying
 * condition "<check>_skipped". Keys are the full note strings ("keyed by
 * reason"), so a changed reason is a new sighting and a resolved reason
 * clears its own key independently.
 */
export function planSkipEntries(
  prevActiveSkips: Record<string, number> | undefined,
  skippedNotes: readonly string[],
  now: number,
): SkipPlan {
  const activeSkips: Record<string, number> = { ...(prevActiveSkips ?? {}) }
  const persisted = new Set(Object.keys(activeSkips))
  const currentNotes = new Set(skippedNotes)
  const newNotes: string[] = []
  for (const note of skippedNotes) {
    if (!persisted.has(note) && newNotes.indexOf(note) === -1) newNotes.push(note)
  }
  const clearedNotes = [...persisted].filter((note) => !currentNotes.has(note))

  const entries: ErrorLogEntry[] = []
  if (newNotes.length > 0) {
    entries.push({
      app: CHECKER_APP,
      kind: 'condition_skipped',
      error: new Error(`checks skipped: ${newNotes.join('; ')}`),
    })
  }
  for (const note of clearedNotes) {
    const check = skipNoteCheck(note)
    entries.push({
      app: skipCheckApp(check),
      kind: 'condition_cleared',
      condition: `${check}_skipped`,
      error: new Error(`no longer skipped: ${note}`),
    })
  }
  for (const note of newNotes) activeSkips[note] = now
  for (const note of clearedNotes) delete activeSkips[note]
  return { entries, clearedNotes, activeSkips }
}

/**
 * Age of a timestamp in ms, or null when there is nothing to measure (no
 * row, or an unparseable value). Null is reported as a breach without an
 * observed value: "no published narrative" is exactly what a missing or
 * unreadable timestamp means.
 */
function timestampAgeMs(timestamp: string | null | undefined, now: number): number | null {
  if (timestamp === null || timestamp === undefined) return null
  const parsed = Date.parse(timestamp)
  return Number.isFinite(parsed) ? now - parsed : null
}

function stalenessResult(
  condition: ConditionKind,
  app: string,
  maxAgeMs: number,
  observedAgeMs: number | null,
): ConditionResult {
  return {
    condition,
    app,
    breached: observedAgeMs === null || observedAgeMs > maxAgeMs,
    ...(observedAgeMs !== null ? { observed: observedAgeMs } : {}),
    threshold: maxAgeMs,
  }
}

/** max(published_at) older than 2h breaches; a missing row breaches unmeasured. */
export function checkPublishStale(
  input: { lastPublishedAt: string | null | undefined },
  now: number,
): ConditionResult {
  return stalenessResult('publish_stale', PUBLISHER_APP, PUBLISH_STALE_MAX_AGE_MS, timestampAgeMs(input.lastPublishedAt, now))
}

/**
 * max(created_at) older than 3h breaches; a missing row breaches
 * unmeasured. (The cron's real draft gatherer reads the local
 * pipeline.sqlite and skips instead when the store is missing, unreadable
 * or empty - a missing row only reaches this function through injected
 * inputs.)
 */
export function checkDraftStale(
  input: { lastDraftCreatedAt: string | null | undefined },
  now: number,
): ConditionResult {
  return stalenessResult('draft_stale', DRAFT_APP, DRAFT_STALE_MAX_AGE_MS, timestampAgeMs(input.lastDraftCreatedAt, now))
}

/**
 * Compares each app's current restart_time against the oldest same-pm_id
 * sample inside the 15-minute window - the widest honest window the samples
 * allow, so a burst spanning several 5-minute cron runs is caught once with
 * its full delta. No in-window baseline (new app), a changed pm_id, or a
 * restart_time decrease means pm2 was restarted or re-saved: that is a
 * reset, never a breach, and the current run re-establishes the baseline.
 */
export function checkRestartBurst(
  input: { prev: readonly RestartSample[]; current: readonly Pm2AppSample[] },
  now: number,
): ConditionResult[] {
  const windowStart = now - RESTART_BURST_WINDOW_MS
  return input.current.map((app) => {
    const baseline = input.prev
      .filter((sample) =>
        sample.app === app.name
        && sample.pm_id === app.pmId
        // A decreased restart_time is a reset for this measurement, not a
        // baseline to diff from.
        && sample.restart_time <= app.restartTime
        // Anything older than the window start is outside the breach window.
        && sample.at >= windowStart
        && sample.at <= now)
      .sort((a, b) => a.at - b.at)[0]
    if (baseline === undefined) {
      return { condition: 'restart_burst' as const, app: app.name, breached: false, observed: 0, threshold: RESTART_BURST_THRESHOLD }
    }
    const delta = app.restartTime - baseline.restart_time
    return {
      condition: 'restart_burst' as const,
      app: app.name,
      breached: delta > RESTART_BURST_THRESHOLD,
      observed: delta,
      threshold: RESTART_BURST_THRESHOLD,
    }
  })
}

/** Appends one sample per app for this run and prunes everything past the ~20 min TTL. */
export function updateRestartSamples(
  prev: readonly RestartSample[],
  current: readonly Pm2AppSample[],
  now: number,
): RestartSample[] {
  const fresh = prev.filter((sample) => sample.at > now - SAMPLE_TTL_MS)
  return [
    ...fresh,
    ...current.map((app) => ({ app: app.name, pm_id: app.pmId, restart_time: app.restartTime, at: now })),
  ]
}

/**
 * The checker's own Supabase liveness (createSupabaseHealthProbe): a failed
 * run increments the consecutive counter, a successful one resets it to
 * zero. Breach once the counter reaches 3; it runs even when all apps are
 * stopped, because a stopped fleet still needs a working database to start.
 */
export function checkSupabaseFails(
  input: { prevConsecutive: number; failed: boolean; error?: unknown },
): ConditionResult {
  const failures = input.failed ? Math.max(0, Math.floor(input.prevConsecutive)) + 1 : 0
  return {
    condition: 'supabase_health_failed',
    app: CHECKER_APP,
    breached: failures >= SUPABASE_FAIL_THRESHOLD,
    observed: failures,
    threshold: SUPABASE_FAIL_THRESHOLD,
    ...(input.failed && input.error !== undefined ? { error: input.error } : {}),
  }
}

/**
 * Supabase env precondition for the checker's own probe and the
 * published-narratives gatherer: a missing SUPABASE_URL /
 * SUPABASE_SERVICE_ROLE_KEY is a configuration error, not a Supabase outage
 * (Ref #346 PR 5). It breaches config_missing and supersedes the old
 * env-missing skip, while the health probe never runs and the consecutive
 * probe-failure counter stays exactly as the previous run left it. A
 * present env reports healthy so a recovered configuration closes with one
 * condition_cleared.
 */
export function checkConfigMissing(
  input: { envMissing: boolean; error?: unknown },
): ConditionResult {
  return {
    condition: 'config_missing',
    app: CHECKER_APP,
    breached: input.envMissing,
    ...(input.envMissing && input.error !== undefined ? { error: input.error } : {}),
  }
}

/**
 * Disk used percent STRICTLY greater than 80 breaches (exactly 80% is fine).
 * Expects a df-style read of a statfs result.
 */
export function checkDisk(input: { usedPercent: number }): ConditionResult {
  return {
    condition: 'disk_high',
    app: CHECKER_APP,
    breached: input.usedPercent > DISK_USED_PERCENT_THRESHOLD,
    observed: input.usedPercent,
    threshold: DISK_USED_PERCENT_THRESHOLD,
  }
}

/**
 * df-style used percent: (blocks - free) / (blocks - free + available).
 * Mirrors what operators see in `df`, where the denominator includes the
 * root-reserved blocks; division guard returns null when the result cannot
 * be computed from degenerate values.
 */
export function statfsUsedPercent(stat: { blocks: number; bfree: number; bavail: number }): number | null {
  const used = stat.blocks - stat.bfree
  const denominator = used + stat.bavail
  if (stat.blocks <= 0 || denominator <= 0) return null
  return (used / denominator) * 100
}

function conditionKey(result: ConditionResult): string {
  return `${result.condition}:${result.app}`
}

function observedFields(result: ConditionResult): Partial<Pick<ErrorLogEntry, 'observed' | 'threshold'>> {
  return {
    ...(result.observed !== undefined ? { observed: result.observed } : {}),
    ...(result.threshold !== undefined ? { threshold: result.threshold } : {}),
  }
}

function breachMessage(result: ConditionResult): string {
  const measured = result.observed === undefined
    ? 'not measurable (no data)'
    : `${result.observed}`
  switch (result.condition) {
    case 'publish_stale':
      return `no published narrative for ${measured}ms (threshold ${PUBLISH_STALE_MAX_AGE_MS}ms)`
    case 'draft_stale':
      return `no editor draft for ${measured}ms (threshold ${DRAFT_STALE_MAX_AGE_MS}ms)`
    case 'restart_burst':
      return `pm2 restart_time rose by ${measured} within the last ${RESTART_BURST_WINDOW_MS}ms (threshold: more than ${RESTART_BURST_THRESHOLD})`
    case 'supabase_health_failed':
      return `supabase health probe failed on ${measured} consecutive checker runs (threshold ${SUPABASE_FAIL_THRESHOLD})`
    case 'config_missing':
      return 'missing required Supabase env (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY)'
    case 'disk_high':
      return `disk used ${measured}% (threshold: more than ${DISK_USED_PERCENT_THRESHOLD}%)`
  }
}

function breachEntry(result: ConditionResult): ErrorLogEntry {
  return {
    // A check whose gatherer failed may carry its original error; a pure
    // breach carries a descriptive Error so the line has a readable message.
    error: result.error ?? new Error(breachMessage(result)),
    app: result.app,
    kind: result.condition,
    condition: result.condition,
    ...observedFields(result),
  }
}

export interface ConditionPlan {
  entries: ErrorLogEntry[]
  breached: Record<string, boolean>
  lastLoggedAt: Record<string, number>
  /** New consecutive-failure counter, set only when this run ran the supabase check. */
  supabaseConsecutiveFailures?: number
}

/**
 * Applies the cadence rules (decision Q5) to one run's results:
 * breached-once, repeat at most every CONDITION_REPEAT_MS while it
 * persists, one condition_cleared on recovery. Results for conditions not
 * currently breached and not newly breaching produce nothing. Skipped
 * checks never reach this function, so their state is left untouched.
 */
export function planLogEntries(
  prevState: ConditionState,
  results: readonly ConditionResult[],
  now: number,
): ConditionPlan {
  const breached: Record<string, boolean> = { ...(prevState.breached ?? {}) }
  const lastLoggedAt: Record<string, number> = { ...(prevState.lastLoggedAt ?? {}) }
  const entries: ErrorLogEntry[] = []
  let supabaseConsecutiveFailures: number | undefined

  for (const result of results) {
    if (result.condition === 'supabase_health_failed') {
      supabaseConsecutiveFailures = result.observed ?? 0
    }
    const key = conditionKey(result)
    const wasBreached = breached[key] === true
    if (result.breached && !wasBreached) {
      entries.push(breachEntry(result))
      breached[key] = true
      lastLoggedAt[key] = now
      continue
    }
    if (result.breached && wasBreached) {
      const last = lastLoggedAt[key]
      if (last === undefined || now - last >= CONDITION_REPEAT_MS) {
        entries.push(breachEntry(result))
        lastLoggedAt[key] = now
      }
      continue
    }
    if (!result.breached && wasBreached) {
      entries.push({
        error: new Error(`condition recovered: ${result.condition}`),
        app: result.app,
        kind: 'condition_cleared',
        condition: result.condition,
        ...observedFields(result),
      })
      delete breached[key]
      delete lastLoggedAt[key]
    }
    // Not breached and never breached: nothing to log.
  }

  return { entries, breached, lastLoggedAt, supabaseConsecutiveFailures }
}