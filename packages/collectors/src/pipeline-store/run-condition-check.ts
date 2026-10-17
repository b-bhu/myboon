/**
 * Cron entrypoint for the log-only condition checks (Ref #346 PR 5).
 *
 * Runs every few minutes (see infra/vps/crontab.example), gathers real
 * inputs - `pm2 jlist` (read-only, 10s timeout), the freshest
 * published_at from Supabase, the freshest editor-draft created_at from
 * the local pipeline.sqlite (one read-only max(created_at) query on
 * pipeline_editor_drafts; Supabase editor_drafts is no longer written),
 * the shared Supabase health probe, and fs.statfs('/') - feeds them
 * through the pure checks in condition-checks.ts, and records
 * breaches/skips/recoveries in the shared JSONL error log. No push
 * alerts: the operator reads the log.
 *
 * Failure posture: every gatherer failure is caught and turned into a skip
 * (never a breach), the run itself never throws and always exits 0, and
 * the durable state file (last breach state, last-logged times, restart
 * samples, consecutive probe failures) is written atomically; a missing or
 * corrupt file yields a fresh state. Because PM2 apps are often
 * intentionally stopped, staleness queries are gated on the related app
 * being `online`, exactly as decided in Ref #346 Q2. For draft_stale the
 * same skip rule covers a missing, unreadable or empty local
 * pipeline.sqlite - a broken draft store never becomes a breach. The
 * disk check always runs; the Supabase health probe runs whenever the
 * Supabase env is present - a missing env is a configuration error,
 * recorded as a condition_skipped line that never counts toward the
 * consecutive probe-failure counter.
 */
import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { statfs as fsStatfs } from 'node:fs/promises'
import { homedir } from 'node:os'
import { createRequire } from 'node:module'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { promisify } from 'node:util'

import { createSupabaseClient, createSupabaseHealthProbe, requireSupabaseEnv } from '@myboon/shared/supabase-client'

import { loadDotenvChain } from './cli-env'
import {
  CHECKER_APP,
  DRAFT_APP,
  PUBLISHER_APP,
  checkDisk,
  checkPublishStale,
  checkDraftStale,
  checkRestartBurst,
  checkSupabaseFails,
  planLogEntries,
  stalenessGateReason,
  statfsUsedPercent,
  updateRestartSamples,
  type ConditionResult,
  type ConditionState,
  type Pm2AppSnapshot,
  type RestartSample,
} from './condition-checks'
import type { ErrorLogEntry } from './error-log'
import { appendErrorLog } from './error-log'
import { DEFAULT_PIPELINE_SQLITE_PATH } from './failure-recovery'

const execFileP = promisify(execFile)

/**
 * Failure-recovery's default plus the PIPELINE_SQLITE_PATH override, with
 * the same resolution the other SQLite-backed runners use: an absolute
 * path wins, a relative one is anchored at the collectors package dir.
 */
export function resolvePipelineSqlitePath(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.PIPELINE_SQLITE_PATH?.trim()
  if (!configured) return DEFAULT_PIPELINE_SQLITE_PATH
  return isAbsolute(configured) ? configured : resolve(__dirname, '..', '..', configured)
}

interface DraftSqliteStatement {
  get(...params: unknown[]): unknown
}

interface DraftSqliteDatabase {
  close(): void
  exec(sql: string): void
  prepare(sql: string): DraftSqliteStatement
}

const nodeRequire = createRequire(__filename)
const { DatabaseSync } = nodeRequire('node:sqlite') as {
  DatabaseSync: new (path: string, options?: { readOnly?: boolean; open?: boolean }) => DraftSqliteDatabase
}

/** SQLite CURRENT_TIMESTAMP ('YYYY-MM-DD HH:MM:SS', UTC) as written to created_at. */
const SQLITE_CURRENT_TIMESTAMP = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})$/

/**
 * Date.parse reads the space-separated SQLite timestamp as LOCAL time, but
 * CURRENT_TIMESTAMP is stored in UTC - rewriting it to ISO 'T...Z' form
 * keeps the age correct on non-UTC hosts. Other shapes pass through.
 */
function normaliseSqliteTimestamp(value: string): string {
  const match = SQLITE_CURRENT_TIMESTAMP.exec(value)
  return match === null ? value : `${match[1]}T${match[2]}Z`
}

/**
 * Draft staleness reads the local PipelineStore, not Supabase: the
 * editor_drafts data moved off Supabase into the pipeline_editor_drafts
 * table (see editor-draft/supabase-store.ts and sqlite-store.ts). The
 * gatherer opens pipeline.sqlite strictly READ-ONLY - it can never create
 * the file - for a single max(created_at) query, and closes the connection
 * even on failure. There is nothing to measure (missing file, empty table,
 * any read error) rejects: the run records a condition_skipped line rather
 * than breaching on a store it could not read.
 */
export function createDraftCreatedAtGatherer(env: NodeJS.ProcessEnv = process.env): () => Promise<string> {
  return async () => {
    const dbPath = resolvePipelineSqlitePath(env)
    // Read-only opens do not create files, but checking first keeps a
    // missing store a plain, readable skip instead of a node:sqlite error.
    if (!existsSync(dbPath)) throw new Error(`pipeline sqlite not found at ${dbPath}`)
    const db = new DatabaseSync(dbPath, { readOnly: true, open: true })
    try {
      db.exec('PRAGMA busy_timeout = 5000;')
      const row = db
        .prepare('SELECT max(created_at) AS last_created_at FROM pipeline_editor_drafts')
        .get() as { last_created_at?: unknown } | undefined
      if (typeof row?.last_created_at !== 'string') {
        throw new Error('pipeline_editor_drafts is empty (no drafts to measure)')
      }
      return normaliseSqliteTimestamp(row.last_created_at)
    } finally {
      db.close()
    }
  }
}

/** Timeout for the read-only `pm2 jlist` call. */
export const PM2_JLIST_TIMEOUT_MS = 10_000

export interface ConditionCheckDeps {
  /** Injectable clock. Defaults to Date.now. */
  now?: () => number
  /** Absolute path of the JSON state file. Defaults to MYBOON_CONDITION_STATE or ~/myboon-logs/condition-state.json. */
  statePath?: string
  /** Env for the error-log path, the pipeline.sqlite path (PIPELINE_SQLITE_PATH) and Supabase credentials. Defaults to process.env. */
  env?: NodeJS.ProcessEnv
  /** Read-only pm2 jlist; null (or a throw) means pm2 was unreadable. */
  listPm2Apps?: () => Promise<Pm2AppSnapshot[] | null>
  /** max(published_at) of Supabase published_narratives, or null when the table is empty. */
  fetchLastPublishedAt?: () => Promise<string | null>
  /** max(created_at) of the local pipeline_editor_drafts table (pipeline.sqlite, opened read-only), normalised to ISO UTC. Rejects when there is nothing to measure (missing file, empty table, read error), which logs a condition_skipped line instead of a draft_stale breach. */
  fetchLastDraftCreatedAt?: () => Promise<string>
  /** The bounded health probe (createSupabaseHealthProbe); rejects when Supabase is unhealthy. */
  probe?: () => Promise<void>
  /** Injected for tests. Defaults to fs.statfs. */
  statfs?: (path: string) => Promise<{ blocks: number; bfree: number; bavail: number }>
  /** Injectable error-log sink. Defaults to appendErrorLog on the resolved log path. */
  log?: (entry: ErrorLogEntry) => void
}

export interface ConditionCheckSummary {
  now: number
  /** Results of the checks that actually ran (skipped checks are absent). */
  results: ConditionResult[]
  /** Human-readable skip notes, e.g. "publish_stale: app status stopped". */
  skipped: string[]
  entriesLogged: number
  stateWritten: boolean
}

export function resolveConditionStatePath(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.MYBOON_CONDITION_STATE?.trim()
  if (configured) return configured
  return join(homedir(), 'myboon-logs', 'condition-state.json')
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function parsePm2App(raw: unknown): Pm2AppSnapshot | null {
  if (raw === null || typeof raw !== 'object') return null
  const record = raw as Record<string, unknown>
  const env = record.pm2_env
  if (
    typeof record.name !== 'string'
    || typeof record.pm_id !== 'number'
    || env === null || typeof env !== 'object'
  ) return null
  const pm2Env = env as Record<string, unknown>
  if (typeof pm2Env.status !== 'string' || typeof pm2Env.restart_time !== 'number') return null
  return { name: record.name, pmId: record.pm_id, status: pm2Env.status, restartTime: pm2Env.restart_time }
}

async function listPm2Apps(): Promise<Pm2AppSnapshot[] | null> {
  try {
    const { stdout } = await execFileP('pm2', ['jlist'], { timeout: PM2_JLIST_TIMEOUT_MS, encoding: 'utf8' })
    const parsed: unknown = JSON.parse(stdout)
    if (!Array.isArray(parsed)) return null
    const apps = parsed
      .map(parsePm2App)
      .filter((app): app is Pm2AppSnapshot => app !== null)
    return apps
  } catch {
    // pm2 missing, daemon down, non-JSON output, timeout: unreadable, and a
    // skip - not a breach - is the correct silence for staleness checks.
    return null
  }
}

function createSupabaseGatherers(env: NodeJS.ProcessEnv): {
  /** True when SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are absent from `env`. */
  envMissing: boolean
  fetchLastPublishedAt: () => Promise<string | null>
  probe: () => Promise<void>
} {
  let resolved: { supabaseUrl: string; supabaseKey: string } | null
  let envError: unknown
  try {
    resolved = requireSupabaseEnv(env)
  } catch (error) {
    resolved = null
    envError = error
  }
  // A missing env is a configuration error, not a Supabase failure: it skips
  // the staleness gatherer and the probe without counting toward the
  // consecutive-failure counter. Editor drafts are local, so draft_stale does
  // not depend on this factory at all.
  if (resolved === null) {
    const envUnavailable = (): never => {
      throw envError instanceof Error ? envError : new Error('Supabase env unavailable')
    }
    return {
      envMissing: true,
      fetchLastPublishedAt: envUnavailable,
      probe: envUnavailable,
    }
  }
  const client = createSupabaseClient(resolved.supabaseUrl, resolved.supabaseKey)
  const fetchLastPublishedAt = async (): Promise<string | null> => {
    const { data, error } = await client
      .from('published_narratives')
      .select('published_at')
      .order('published_at', { ascending: false })
      .limit(1)
    if (error) throw new Error(`published_narratives read failed: ${error.message}`)
    const row = (data as Array<Record<string, unknown>> | null)?.[0]
    const value = row?.published_at
    return typeof value === 'string' ? value : null
  }
  return {
    envMissing: false,
    fetchLastPublishedAt,
    probe: createSupabaseHealthProbe(resolved.supabaseUrl, resolved.supabaseKey),
  }
}

function isNumberRecord(value: unknown): value is Record<string, number> {
  if (value === null || typeof value !== 'object') return false
  return Object.values(value).every((entry) => typeof entry === 'number')
}

function parseState(parsed: unknown): ConditionState {
  const fresh = () => ({ version: 1 as const, samples: [], supabaseConsecutiveFailures: 0, breached: {}, lastLoggedAt: {} })
  if (parsed === null || typeof parsed !== 'object') return fresh()
  const record = parsed as Record<string, unknown>
  // Unknown version: the file was written by another codebase version - do
  // not guess, start fresh (any breach re-logs on the next run at worst).
  if (record.version !== 1) return fresh()
  const state: ConditionState = fresh()
  if (Array.isArray(record.samples)) {
    state.samples = record.samples.filter((row): row is RestartSample =>
      row !== null && typeof row === 'object'
      && typeof (row as Record<string, unknown>).app === 'string'
      && typeof (row as Record<string, unknown>).pm_id === 'number'
      && typeof (row as Record<string, unknown>).restart_time === 'number'
      && typeof (row as Record<string, unknown>).at === 'number')
  }
  if (typeof record.supabaseConsecutiveFailures === 'number') {
    state.supabaseConsecutiveFailures = record.supabaseConsecutiveFailures
  }
  if (record.breached === null || typeof record.breached !== 'object') return state
  const breached = record.breached as Record<string, unknown>
  for (const [key, value] of Object.entries(breached)) {
    if (value === true) state.breached[key] = true
  }
  if (isNumberRecord(record.lastLoggedAt)) state.lastLoggedAt = { ...record.lastLoggedAt }
  return state
}

function readState(statePath: string): ConditionState {
  try {
    return parseState(JSON.parse(readFileSync(statePath, 'utf8')))
  } catch {
    // Missing or corrupt state file: the checker starts fresh rather than
    // failing; state is rewritten at the end of the run.
    return { version: 1, samples: [], supabaseConsecutiveFailures: 0, breached: {}, lastLoggedAt: {} }
  }
}

/** Atomic-ish write: same-dir tmp then rename, so readers never see a torn file. */
function writeState(statePath: string, state: ConditionState): boolean {
  try {
    mkdirSync(dirname(statePath), { recursive: true })
    const tmpPath = `${statePath}.tmp`
    writeFileSync(tmpPath, JSON.stringify(state))
    renameSync(tmpPath, statePath)
    return true
  } catch (error) {
    console.error('[condition-check] state write failed:', errorText(error))
    return false
  }
}

export async function runConditionCheck(deps: ConditionCheckDeps = {}): Promise<ConditionCheckSummary> {
  const env = deps.env ?? process.env
  const now = (deps.now ?? Date.now)()
  const statePath = deps.statePath ?? resolveConditionStatePath(env)
  const log = deps.log ?? ((entry: ErrorLogEntry) => appendErrorLog(entry, { env }))
  const gather = createSupabaseGatherers(env)
  // Draft staleness is local: resolved lazily from env inside the
  // gatherer; only invoked while myboon-editor-draft is online.
  const fetchLastDraftCreatedAt = createDraftCreatedAtGatherer(env)
  const prevState = readState(statePath)

  const skipped: string[] = []
  const results: ConditionResult[] = []

  // pm2 jlist gates every staleness check (Q2) and feeds restart tracking.
  let pm2Apps: Pm2AppSnapshot[] | null = null
  try {
    pm2Apps = await (deps.listPm2Apps ?? listPm2Apps)()
  } catch {
    pm2Apps = null
  }

  // Staleness checks run only when their app is online (Q2); a stopped,
  // missing app or unreadable pm2 stays silent except for the skip line.
  const publisherGate = stalenessGateReason(pm2Apps, PUBLISHER_APP)
  if (publisherGate !== null) {
    skipped.push(`publish_stale: ${publisherGate}`)
  } else {
    try {
      const lastPublishedAt = await (deps.fetchLastPublishedAt ?? gather.fetchLastPublishedAt)()
      results.push(checkPublishStale({ lastPublishedAt }, now))
    } catch (error) {
      skipped.push(`publish_stale: ${errorText(error)}`)
    }
  }
  const draftGate = stalenessGateReason(pm2Apps, DRAFT_APP)
  if (draftGate !== null) {
    skipped.push(`draft_stale: ${draftGate}`)
  } else {
    try {
      const lastDraftCreatedAt = await (deps.fetchLastDraftCreatedAt ?? fetchLastDraftCreatedAt)()
      results.push(checkDraftStale({ lastDraftCreatedAt }, now))
    } catch (error) {
      skipped.push(`draft_stale: ${errorText(error)}`)
    }
  }

  if (pm2Apps === null) {
    skipped.push('restart_burst: pm2 jlist unavailable')
  } else {
    results.push(...checkRestartBurst({ prev: prevState.samples ?? [], current: pm2Apps }, now))
  }

  // The checker's own Supabase liveness: runs even when all apps are stopped.
  // A missing Supabase env is a configuration error, not a probe failure: it
  // is recorded as a skip and leaves the consecutive counter unchanged. (An
  // injected probe - tests - overrides the env gate.)
  if (gather.envMissing && deps.probe === undefined) {
    skipped.push('supabase_health_failed: supabase env missing')
  } else {
    let probeFailed = false
    let probeError: unknown
    try {
      await (deps.probe ?? gather.probe)()
    } catch (error) {
      probeFailed = true
      probeError = error
    }
    results.push(checkSupabaseFails({
      prevConsecutive: prevState.supabaseConsecutiveFailures ?? 0,
      failed: probeFailed,
      error: probeError,
    }))
  }

  // Disk: never gated on app state.
  const diskPath = env.MYBOON_CONDITION_DISK_PATH?.trim() || '/'
  try {
    const stat = await (deps.statfs ?? fsStatfs)(diskPath)
    const usedPercent = statfsUsedPercent(stat)
    if (usedPercent === null) {
      skipped.push('disk_high: cannot compute used percent from statfs result')
    } else {
      results.push(checkDisk({ usedPercent }))
    }
  } catch (error) {
    skipped.push(`disk_high: ${errorText(error)}`)
  }

  // One condition_skipped line per run naming every skipped check and why.
  if (skipped.length > 0) {
    log({
      app: CHECKER_APP,
      kind: 'condition_skipped',
      error: new Error(`checks skipped: ${skipped.join('; ')}`),
    })
  }

  const plan = planLogEntries(prevState, results, now)
  for (const entry of plan.entries) {
    try {
      log(entry)
    } catch {
      // A broken log sink must not take the checker down (same contract as
      // appendErrorLog itself).
    }
  }

  // A failed pm2 jlist must not wipe restart samples: keep the previous
  // baselines so a transient pm2 outage does not reset burst tracking.
  const samples = pm2Apps === null
    ? prevState.samples
    : updateRestartSamples(prevState.samples ?? [], pm2Apps, now)
  const nextState: ConditionState = {
    version: 1,
    samples,
    supabaseConsecutiveFailures: plan.supabaseConsecutiveFailures ?? prevState.supabaseConsecutiveFailures ?? 0,
    breached: plan.breached,
    lastLoggedAt: plan.lastLoggedAt,
  }
  const stateWritten = writeState(statePath, nextState)

  return {
    now,
    results,
    skipped,
    entriesLogged: plan.entries.length + (skipped.length > 0 ? 1 : 0),
    stateWritten,
  }
}

async function main(): Promise<void> {
  // CLI main path only: the cron needs the .env chain so SUPABASE_URL /
  // SUPABASE_SERVICE_ROLE_KEY reach process.env, like every other run-*.ts
  // entrypoint. Importing this module (tests) must stay hermetic - the load
  // never happens inside runConditionCheck.
  loadDotenvChain()
  const summary = await runConditionCheck()
  // Short stdout trail for the cron log file; the JSONL error log carries
  // the actual condition entries.
  console.log(JSON.stringify({
    ts: new Date().toISOString(),
    breached: summary.results.filter((result) => result.breached).map((result) => `${result.condition}(${result.app})`),
    skipped: summary.skipped,
    entries: summary.entriesLogged,
  }))
  // Explicit exit so keep-alive sockets from Supabase cannot hang the cron
  // run; appendErrorLog writes are synchronous, so logging is durable.
  process.exit(0)
}

// Never throws, always exits 0: a broken cron run must not page anyone more
// than the JSONL log already does. Guarded so importing the module (tests)
// does not fire the check.
if (require.main === module) {
  main().catch((error) => {
    console.error('[condition-check] unexpected failure:', errorText(error))
    appendErrorLog({ app: CHECKER_APP, kind: 'run_failed', error })
    process.exit(0)
  })
}