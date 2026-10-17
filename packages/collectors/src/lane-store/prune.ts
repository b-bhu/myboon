/**
 * Retention pruning for the two lane stores (issue #346 PR 6).
 *
 * Deletes only OLD TERMINAL rows from the news-lane and polymarket-lane
 * SQLite files. Every store path resolves through
 * `resolveLaneSqlitePathFromEnv` in paths.ts, one lane per entry in
 * LANE_SQLITE_FILENAMES - there is no news-specific code path.
 *
 * Retention (decided for #346; news observations excluded by the #382 review):
 * - 14 days: terminal rows of news_source_runs, news_research_results,
 *   pipeline_runs, pipeline_candidates, pipeline_research.
 * - 7 days: delivered rows of news_source_delivery_outbox and
 *   pipeline_source_delivery_outbox.
 *
 * Never deleted (see the eligibility fragments below):
 * - news_candidate_observations: this table IS the news dedupe memory.
 *   fetchPriorObservations (news/sqlite-store.ts) selects from it with no
 *   time window, and ingestDiscoveredNewsCandidates applies no age cutoff, so
 *   deleting a settled observation would make classifyNewsCandidate return
 *   new_candidate again for any article a feed still lists: the article is
 *   researched and placed a second time. Old terminal observations therefore
 *   age out of retention entirely; only their research-result children and
 *   the run/outbox logs keep the usual cutoffs.
 * - pipeline_watchlist (has no entry in LANE_PRUNE_TABLE_SPECS).
 * - Outbox rows that are not yet delivered (state = 'pending').
 * - Non-terminal rows: queued / running / pending_* / retry states, plus
 *   failed or dead-letter-marked rows, which stay visible as evidence.
 * - pipeline_editor_drafts and pipeline_editor_decisions: the publisher's
 *   consumption is not safely determinable from the schema alone (drafts are
 *   marked published from the Supabase side, decisions via loose research_ids
 *   JSON), so these tables are not pruned at all.
 *
 * Cascade safety: pipeline_research cascades from candidates
 * (pipeline-store/sqlite-store.ts). A parent row is eligible only when every
 * child research row has reached a terminal state, so deleting a parent can
 * never cascade unfinished work away. News observations are never deleted, so
 * their ON DELETE CASCADE to news_research_results never fires during a
 * prune; news_research_results rows are deleted directly by their own
 * eligibility rule instead, and deleting that child never affects dedupe
 * (fetchPriorObservations reads only the observations table). The command
 * opens the SQLite files itself and sets PRAGMA foreign_keys = ON so those
 * cascades behave like the stores' own connections.
 *
 * Age column per table is `updated_at` (NOT NULL, maintained on every status
 * transition), except the delivery outboxes, which age on `delivered_at`
 * (always set together with state = 'delivered'). Timestamps are stored in
 * two shapes (SQLite CURRENT_TIMESTAMP and app-side toISOString), so ages
 * are compared through julianday(); rows with unparseable timestamps are
 * never eligible.
 *
 * Batching: deletes run in small transactions (default 1000 rows), the
 * command is idempotent, and it never runs VACUUM.
 */
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import type { SqliteLane } from './paths'
import { LANE_SQLITE_FILENAMES } from './paths'

const nodeRequire = createRequire(__filename)
const { DatabaseSync } = nodeRequire('node:sqlite') as {
  DatabaseSync: new (
    path: string,
    options?: { readOnly?: boolean },
  ) => SqliteStatementHost
}

interface SqliteStatement {
  all(...params: unknown[]): unknown[]
  get(...params: unknown[]): unknown
  run(...params: unknown[]): unknown
}

interface SqliteStatementHost {
  close(): void
  exec(sql: string): void
  prepare(sql: string): SqliteStatement
}

/**
 * Ages are compared in julian-day space so both stored timestamp shapes
 * (SQLite CURRENT_TIMESTAMP and app-side toISOString) compare correctly. The
 * cutoff is a numbered parameter (`?1`) because the same value is bound once
 * and used both by the table's own age check and by the child-row age checks
 * inside the parent-eligibility subqueries.
 */
const AGE_SQL = (column: string) => `julianday(${column}) < julianday(?1)`

const CHILD_AGE_SAFE_SQL = `julianday(r.updated_at) <= julianday(?1)`

/**
 * A pipeline research child is safe to cascade-delete (its candidate may go
 * away) only when no consumer can still need it, and only when the child
 * itself is older than the cutoff (a recently-consumed child survives the
 * aged parent):
 * editor-terminal statuses are edited / rejected / published
 * (pending_editor and editing are the editor queue and its lease;
 * needs_more_research is re-researchable). The entity-manager lifecycle
 * runs independently (claimResearchForEntityManager claims rows whose
 * editor status is edited or published), so edited/published rows also
 * need entity_manager_status processed/skipped. Rejected rows are never
 * claimed by the entity manager. entity_manager_failure_status rows
 * (failed / dead_letter) stay as evidence.
 *
 * news_research_results needs no such child-safety fragment: observations
 * are never pruned, so a result is deleted directly by its own eligibility
 * rule (see the news spec below) and never via a cascade.
 */
const PIPELINE_RESEARCH_TERMINAL = `
  (
    (r.status = 'rejected' AND r.entity_manager_failure_status IS NULL)
    OR (
      r.status IN ('edited', 'published')
      AND r.entity_manager_status IN ('processed', 'skipped')
      AND r.entity_manager_failure_status IS NULL
    )
  )`

const PIPELINE_RESEARCH_SAFE = `
  (${PIPELINE_RESEARCH_TERMINAL} AND ${CHILD_AGE_SAFE_SQL})`

export interface LanePruneTableSpec {
  table: string
  /** Column the batched DELETE keys on; outboxes key on signal_id. */
  keyColumn: 'id' | 'signal_id'
  retentionDays: number
  /** WHERE fragment with the cutoff ISO string bound as the only parameter. */
  eligibleWhere: string
}

/**
 * One entry per prunable table. Statuses and references follow the CREATE
 * TABLE definitions in src/news/sqlite-store.ts and
 * src/pipeline-store/sqlite-store.ts. pipeline_research comes before its
 * cascade parent pipeline_candidates so apply-time per-table counts line up
 * with the dry run; the parent-side NOT EXISTS child check remains the real
 * safety net. news_candidate_observations has no entry here (never pruned).
 */
export const LANE_PRUNE_TABLE_SPECS: Readonly<Record<SqliteLane, readonly LanePruneTableSpec[]>> = {
  news: [
    {
      // Old terminal results are pruned directly here; their observation
      // parents are NEVER pruned (dedupe memory - see the header), so this
      // delete is standalone and no news cascade is involved.
      // Only handed_to_entity_memory rows are terminal; failures keep their
      // entity_manager_failure_status evidence.
      table: 'news_research_results',
      keyColumn: 'id',
      retentionDays: 14,
      eligibleWhere: `
        status = 'handed_to_entity_memory'
        AND entity_manager_failure_status IS NULL
        AND ${AGE_SQL('updated_at')}`,
    },
    {
      // Terminal run statuses: succeeded, result_validated,
      // candidates_classified, candidates_ingested, failed_permanent.
      // queued / running / failed_transient / retry_scheduled are non-terminal
      // and stay.
      table: 'news_source_runs',
      keyColumn: 'id',
      retentionDays: 14,
      eligibleWhere: `
        status IN (
          'succeeded', 'result_validated', 'candidates_classified',
          'candidates_ingested', 'failed_permanent'
        )
        AND ${AGE_SQL('updated_at')}`,
    },
    {
      // Delivered obligations only; state = 'pending' rows are undelivered
      // work and never pruned. Ages on delivered_at.
      table: 'news_source_delivery_outbox',
      keyColumn: 'signal_id',
      retentionDays: 7,
      eligibleWhere: `
        state = 'delivered'
        AND delivered_at IS NOT NULL
        AND ${AGE_SQL('delivered_at')}`,
    },
  ],
  polymarket: [
    {
      // Editor-terminal row (edited / published / rejected) whose
      // entity-manager lifecycle has settled, per PIPELINE_RESEARCH_TERMINAL.
      // pending_editor / editing / needs_more_research and unresolved
      // entity-manager work stay.
      table: 'pipeline_research',
      keyColumn: 'id',
      retentionDays: 14,
      eligibleWhere: `
        status IN ('edited', 'published', 'rejected')
        AND entity_manager_failure_status IS NULL
        AND (status = 'rejected' OR entity_manager_status IN ('processed', 'skipped'))
        AND ${AGE_SQL('updated_at')}`,
    },
    {
      // Terminal candidate statuses: rejected, published, stale_expired and
      // skipped_recently_researched (documented in researcher.ts as the
      // store's terminal skip status). pending_research / researching /
      // research_failed (incl. dead letters) stay. A candidate whose
      // pipeline_research child is not terminal-safe-and-old stays so the
      // cascade can never delete unfinished or recently-consumed research.
      table: 'pipeline_candidates',
      keyColumn: 'id',
      retentionDays: 14,
      eligibleWhere: `
        status IN ('skipped_recently_researched', 'rejected', 'published', 'stale_expired')
        AND ${AGE_SQL('updated_at')}
        AND NOT EXISTS (
          SELECT 1
          FROM pipeline_research r
          WHERE r.candidate_id = pipeline_candidates.id
            AND NOT ${PIPELINE_RESEARCH_SAFE}
        )`,
    },
    {
      // Terminal run statuses: succeeded, failed, skipped, partial
      // (running is the only non-terminal one).
      table: 'pipeline_runs',
      keyColumn: 'id',
      retentionDays: 14,
      eligibleWhere: `
        status IN ('succeeded', 'failed', 'skipped', 'partial')
        AND ${AGE_SQL('updated_at')}`,
    },
    {
      // Delivered obligations only; ages on delivered_at.
      table: 'pipeline_source_delivery_outbox',
      keyColumn: 'signal_id',
      retentionDays: 7,
      eligibleWhere: `
        state = 'delivered'
        AND delivered_at IS NOT NULL
        AND ${AGE_SQL('delivered_at')}`,
    },
  ],
}

export const DEFAULT_LANE_PRUNE_BATCH_SIZE = 1000

export type LaneStorePruneMode = 'dry_run' | 'apply'

export interface LaneStorePruneTableResult {
  table: string
  retentionDays: number
  /** Rows younger than this cutoff are kept; cutoff = now - retentionDays. */
  cutoffIso: string
  /** Dry run: rows that would be deleted. */
  eligibleRows?: number
  /** Apply: rows actually deleted in this run. */
  deletedRows?: number
}

export interface LaneStorePruneLaneResult {
  lane: SqliteLane
  path: string
  status: 'pruned' | 'missing'
  tables: LaneStorePruneTableResult[]
}

export interface LaneStorePruneAudit {
  mode: LaneStorePruneMode
  nowIso: string
  batchSize: number
  lanes: LaneStorePruneLaneResult[]
  totals: {
    eligibleRows?: number
    deletedRows?: number
  }
}

export interface LaneStorePruneInput {
  /** Resolved store path per lane, from resolveLaneSqlitePathFromEnv. */
  paths: Readonly<Record<SqliteLane, string>>
  /** Lanes to prune; defaults to every lane in LANE_SQLITE_FILENAMES. */
  lanes?: readonly SqliteLane[]
  /** Reference time for retention cutoffs; defaults to now (tests override). */
  now?: Date
  /** Default false: dry run only counts, never deletes. */
  apply?: boolean
  /** Rows per DELETE transaction; default 1000. */
  batchSize?: number
}

function cutoffIso(now: Date, retentionDays: number): string {
  return new Date(now.getTime() - retentionDays * 24 * 60 * 60 * 1000).toISOString()
}

/** SELECT COUNT(*) per table for a dry run; never writes. */
function countEligibleRows(db: SqliteStatementHost, spec: LanePruneTableSpec, cutoff: string): number {
  const row = db.prepare(`SELECT COUNT(*) AS count FROM ${spec.table} WHERE ${spec.eligibleWhere}`)
    .get(cutoff) as { count?: unknown }
  return Number(row?.count ?? 0)
}

/** One batched DELETE per transaction, keyed on the table's primary key. */
function deleteEligibleRows(
  db: SqliteStatementHost,
  spec: LanePruneTableSpec,
  cutoff: string,
  batchSize: number,
): number {
  let deleted = 0
  // `?2` keeps the LIMIT parameter explicit: the cutoff (?1) appears twice in
  // some eligibility fragments (table age + child-age inside the NOT EXISTS
  // subqueries), so plain anonymous parameters would count as two binds.
  const selectBatch = db.prepare(`SELECT ${spec.keyColumn} AS key FROM ${spec.table} WHERE ${spec.eligibleWhere} LIMIT ?2`)
  while (true) {
    const keys = (selectBatch.all(cutoff, batchSize) as Array<Record<string, unknown>>)
      .map((row) => String(row.key ?? ''))
      .filter((key) => key !== '')
    if (keys.length === 0) return deleted
    const placeholders = keys.map(() => '?').join(', ')
    db.exec('BEGIN')
    try {
      db.prepare(`DELETE FROM ${spec.table} WHERE ${spec.keyColumn} IN (${placeholders})`).run(...keys)
      db.exec('COMMIT')
      deleted += keys.length
    } catch (error) {
      try { db.exec('ROLLBACK') } catch { /* preserve the original delete error */ }
      throw error
    }
    if (keys.length < batchSize) return deleted
  }
}

/**
 * Prune one lane's SQLite file. A file that does not exist is reported as
 * missing and is never created. Dry runs open the file read-only; only
 * --apply opens it read-write (and then enables foreign keys so the
 * candidate->research cascade behaves exactly like the stores' own
 * connections).
 */
function pruneLane(
  lane: SqliteLane,
  path: string,
  now: Date,
  apply: boolean,
  batchSize: number,
): LaneStorePruneLaneResult {
  const specs = LANE_PRUNE_TABLE_SPECS[lane]
  if (!existsSync(path)) {
    return { lane, path, status: 'missing', tables: [] }
  }
  if (!apply) {
    const db = new DatabaseSync(path, { readOnly: true })
    try {
      return {
        lane,
        path,
        status: 'pruned',
        tables: specs.map((spec) => ({
          table: spec.table,
          retentionDays: spec.retentionDays,
          cutoffIso: cutoffIso(now, spec.retentionDays),
          eligibleRows: countEligibleRows(db, spec, cutoffIso(now, spec.retentionDays)),
        })),
      }
    } finally {
      db.close()
    }
  }

  const db = new DatabaseSync(path)
  try {
    db.exec('PRAGMA busy_timeout = 5000;')
    db.exec('PRAGMA foreign_keys = ON;')
    return {
      lane,
      path,
      status: 'pruned',
      tables: specs.map((spec) => ({
        table: spec.table,
        retentionDays: spec.retentionDays,
        cutoffIso: cutoffIso(now, spec.retentionDays),
        deletedRows: deleteEligibleRows(db, spec, cutoffIso(now, spec.retentionDays), batchSize),
      })),
    }
  } finally {
    db.close()
  }
}

/**
 * Dry-run or prune every requested lane. Lanes default to all entries in
 * LANE_SQLITE_FILENAMES; each lane fails soft on a missing file and hard on a
 * broken one (a SQL error means an unexpected file and aborts the run).
 */
export function runLaneStorePrune(input: LaneStorePruneInput): LaneStorePruneAudit {
  const now = input.now ?? new Date()
  const apply = input.apply ?? false
  const batchSize = Math.max(1, Math.floor(input.batchSize ?? DEFAULT_LANE_PRUNE_BATCH_SIZE))
  const lanes = input.lanes ?? (Object.keys(LANE_SQLITE_FILENAMES) as SqliteLane[])
  const laneResults = lanes.map((lane) => pruneLane(lane, input.paths[lane], now, apply, batchSize))

  const totalField = apply ? 'deletedRows' : 'eligibleRows'
  const totals = laneResults.reduce<Record<string, number>>((acc, laneResult) => {
    for (const tableResult of laneResult.tables) {
      const value = apply ? tableResult.deletedRows : tableResult.eligibleRows
      acc[totalField] = (acc[totalField] ?? 0) + Number(value ?? 0)
    }
    return acc
  }, {})

  return {
    mode: apply ? 'apply' : 'dry_run',
    nowIso: now.toISOString(),
    batchSize,
    lanes: laneResults,
    totals,
  }
}