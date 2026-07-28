import { randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import type {
  PipelineBacklogDepth,
  PipelineBacklogDepthInput,
  PipelineCandidateInsertInput,
  PipelineCandidateRow,
  PipelineCandidateThreadUpdate,
  PipelineClaimRetryableWithLeaseInput,
  PipelineClaimWithLeaseInput,
  PipelineDraftAction,
  PipelineDraftRow,
  PipelineDraftStatus,
  PipelineDraftUpsertInput,
  PipelineEditorDecision,
  PipelineEditorDecisionInsertInput,
  PipelineEditorDecisionInsertResult,
  PipelineEditorDecisionRow,
  PipelineEditorDecisionStatus,
  PipelineEvidenceQuality,
  PipelineExpireAgedWorkInput,
  PipelineExpireAgedWorkResult,
  PipelineFetchEligibleDraftsInput,
  PipelineFetchPendingCandidatesInput,
  PipelineFetchResearchByStatusInput,
  PipelineFetchRetryableCandidatesInput,
  PipelineFindCandidatesForBacklogInput,
  PipelineFindEditorDecisionsInput,
  PipelineFindPriorResearchInput,
  PipelineFindResearchForBacklogInput,
  PipelineRecommendedEditorAction,
  PipelineRecoverExpiredLeasesInput,
  PipelineRecoverExpiredLeasesResult,
  PipelineResearchDepth,
  PipelineResearchRow,
  PipelineResearchStatus,
  PipelineResearchUpsertInput,
  PipelineRunFinishInput,
  PipelineRunStartInput,
  PipelineRunStartResult,
  PipelineSetCandidateStatusInput,
  PipelineStore,
  PipelineStoreCandidateStatus,
  PipelineTopicConfidence,
  PipelineWatchlistSnapshotRow,
  PipelineWatchlistUpsertInput,
} from './store'

const nodeRequire = createRequire(__filename)
const { DatabaseSync } = nodeRequire('node:sqlite') as {
  DatabaseSync: new (path: string) => SqliteDatabase
}

const COLLECTORS_PACKAGE_DIR = resolve(__dirname, '..', '..')
const DEFAULT_SQLITE_PATH = resolve(COLLECTORS_PACKAGE_DIR, '.data', 'pipeline.sqlite')

// SQLite has a default bound-parameter limit of ~999; chunk large IN-clause
// batches so callers of this store never have to think about it.
const CHUNK_SIZE = 50

interface SqliteStatement {
  all(...params: unknown[]): unknown[]
  get(...params: unknown[]): unknown
  run(...params: unknown[]): unknown
}

interface SqliteDatabase {
  close(): void
  exec(sql: string): void
  prepare(sql: string): SqliteStatement
}

function json(value: unknown): string {
  return JSON.stringify(value ?? null)
}

function parseJson(value: unknown): unknown {
  if (typeof value !== 'string') return null
  try {
    return JSON.parse(value)
  } catch {
    return null
  }
}

function parseJsonArray(value: unknown): unknown[] {
  const parsed = parseJson(value)
  return Array.isArray(parsed) ? parsed : []
}

function parseStringArray(value: unknown): string[] {
  return parseJsonArray(value).map((entry) => String(entry))
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

function numberValue(value: unknown): number {
  const parsed = typeof value === 'number'
    ? value
    : typeof value === 'bigint'
      ? Number(value)
      : typeof value === 'string'
        ? Number(value)
        : NaN
  return Number.isFinite(parsed) ? parsed : 0
}

function numberOrNull(value: unknown): number | null {
  if (value === null || value === undefined) return null
  const parsed = numberValue(value)
  return Number.isFinite(parsed) ? parsed : null
}

function boolValue(value: unknown): boolean {
  return numberValue(value) !== 0
}

function toIntFlag(value: boolean): number {
  return value ? 1 : 0
}

function chunk<T>(items: T[], size = CHUNK_SIZE): T[][] {
  if (items.length === 0) return []
  const chunks: T[][] = []
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size))
  }
  return chunks
}

function placeholders(count: number): string {
  return Array.from({ length: count }, () => '?').join(', ')
}

function sqlitePath(path = DEFAULT_SQLITE_PATH): string {
  if (path === ':memory:') return path
  return resolve(process.cwd(), path)
}

function openPipelineSqlite(path?: string): SqliteDatabase {
  const dbPath = sqlitePath(path)
  if (dbPath !== ':memory:') mkdirSync(dirname(dbPath), { recursive: true })
  const db = new DatabaseSync(dbPath)
  db.exec('PRAGMA journal_mode = WAL;')
  db.exec('PRAGMA busy_timeout = 5000;')
  db.exec('PRAGMA foreign_keys = ON;')
  return db
}

function ensurePipelineSqliteSchema(db: SqliteDatabase): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS pipeline_watchlist (
      id TEXT PRIMARY KEY,
      source TEXT NOT NULL DEFAULT 'polymarket',
      area TEXT NOT NULL,
      tag_slug TEXT NOT NULL,
      tag_label TEXT,
      market_id TEXT NOT NULL,
      slug TEXT NOT NULL,
      title TEXT NOT NULL,
      event_slug TEXT,
      event_title TEXT,
      end_date TEXT,
      is_manual_pin INTEGER NOT NULL DEFAULT 0,
      rank_in_area INTEGER,
      watch_score REAL NOT NULL DEFAULT 0,
      score_breakdown TEXT NOT NULL DEFAULT '{}',
      selection_reason TEXT NOT NULL,
      latest_observed_at TEXT,
      latest_yes_price REAL,
      latest_volume REAL,
      latest_volume_24h REAL,
      latest_liquidity REAL,
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE (area, slug)
    );

    CREATE INDEX IF NOT EXISTS pipeline_watchlist_slug_idx
      ON pipeline_watchlist (slug);

    CREATE INDEX IF NOT EXISTS pipeline_watchlist_score_idx
      ON pipeline_watchlist (area, watch_score DESC);

    CREATE TABLE IF NOT EXISTS pipeline_candidates (
      id TEXT PRIMARY KEY,
      source TEXT NOT NULL DEFAULT 'polymarket',
      area TEXT NOT NULL,
      candidate_type TEXT NOT NULL,
      market_id TEXT NOT NULL,
      slug TEXT NOT NULL,
      title TEXT NOT NULL,
      tag_slug TEXT NOT NULL,
      tag_label TEXT,
      observed_at TEXT NOT NULL,
      what_changed TEXT NOT NULL,
      why_flagged TEXT NOT NULL,
      score REAL NOT NULL DEFAULT 0,
      score_breakdown TEXT NOT NULL DEFAULT '{}',
      metrics TEXT NOT NULL DEFAULT '{}',
      evidence_refs TEXT NOT NULL DEFAULT '[]',
      status TEXT NOT NULL DEFAULT 'pending_research' CHECK (
        status IN (
          'pending_research',
          'researching',
          'researched',
          'skipped_recently_researched',
          'research_failed',
          'rejected',
          'published',
          'stale_expired'
        )
      ),
      dedupe_key TEXT NOT NULL,
      research_error TEXT,
      research_attempted_at TEXT,
      research_retry_count INTEGER NOT NULL DEFAULT 0,
      research_next_retry_at TEXT,
      research_last_error_kind TEXT,
      research_family_key TEXT,
      research_cluster_key TEXT,
      research_depth TEXT CHECK (
        research_depth IS NULL OR research_depth IN ('market_structure_only', 'reuse_prior', 'deep_web')
      ),
      lease_owner TEXT,
      lease_expires_at TEXT,
      attempt_count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE (dedupe_key)
    );

    CREATE INDEX IF NOT EXISTS pipeline_candidates_status_idx
      ON pipeline_candidates (status, observed_at DESC);

    CREATE INDEX IF NOT EXISTS pipeline_candidates_slug_idx
      ON pipeline_candidates (slug, observed_at DESC);

    CREATE INDEX IF NOT EXISTS pipeline_candidates_research_family_idx
      ON pipeline_candidates (research_family_key, observed_at DESC);

    CREATE INDEX IF NOT EXISTS pipeline_candidates_retry_idx
      ON pipeline_candidates (status, research_next_retry_at, research_retry_count);

    CREATE INDEX IF NOT EXISTS pipeline_candidates_lease_idx
      ON pipeline_candidates (status, lease_expires_at);

    CREATE TABLE IF NOT EXISTS pipeline_research (
      id TEXT PRIMARY KEY,
      candidate_id TEXT NOT NULL REFERENCES pipeline_candidates(id) ON DELETE CASCADE,
      source TEXT NOT NULL DEFAULT 'polymarket',
      area TEXT NOT NULL DEFAULT 'markets',
      slug TEXT NOT NULL,
      title TEXT NOT NULL,
      candidate_type TEXT NOT NULL,
      research_mode TEXT NOT NULL,
      summary TEXT NOT NULL,
      notes TEXT NOT NULL,
      key_findings TEXT NOT NULL DEFAULT '[]',
      evidence_links TEXT NOT NULL DEFAULT '[]',
      related_context TEXT NOT NULL DEFAULT '[]',
      uncertainty TEXT NOT NULL,
      editor_notes TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending_editor' CHECK (
        status IN ('pending_editor', 'editing', 'edited', 'rejected', 'needs_more_research', 'published')
      ),
      researched_at TEXT NOT NULL,
      research_family_key TEXT NOT NULL,
      research_cluster_key TEXT NOT NULL,
      research_depth TEXT NOT NULL CHECK (
        research_depth IN ('market_structure_only', 'reuse_prior', 'deep_web')
      ),
      evidence_quality TEXT NOT NULL DEFAULT 'medium' CHECK (
        evidence_quality IN ('strong', 'medium', 'weak')
      ),
      catalyst_found INTEGER NOT NULL DEFAULT 0,
      recommended_editor_action TEXT NOT NULL DEFAULT 'needs_more_research' CHECK (
        recommended_editor_action IN ('publish_candidate', 'reject_thin', 'needs_more_research')
      ),
      duplicate_of_research_id TEXT REFERENCES pipeline_research(id) ON DELETE SET NULL,
      research_backend TEXT NOT NULL DEFAULT 'hermes_cli',
      research_model TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE (candidate_id)
    );

    CREATE INDEX IF NOT EXISTS pipeline_research_slug_time_idx
      ON pipeline_research (slug, researched_at DESC);

    CREATE INDEX IF NOT EXISTS pipeline_research_status_idx
      ON pipeline_research (status, researched_at DESC);

    CREATE INDEX IF NOT EXISTS pipeline_research_family_time_idx
      ON pipeline_research (research_family_key, researched_at DESC);

    CREATE TABLE IF NOT EXISTS pipeline_editor_decisions (
      id TEXT PRIMARY KEY,
      source TEXT NOT NULL DEFAULT 'polymarket',
      area TEXT NOT NULL DEFAULT 'markets',
      research_ids TEXT NOT NULL DEFAULT '[]',
      decision TEXT NOT NULL CHECK (decision IN ('publish', 'reject', 'needs_more_research')),
      status TEXT NOT NULL CHECK (
        status IN ('pending_publisher', 'rejected', 'needs_more_research', 'published')
      ),
      angle TEXT,
      why_this_matters TEXT,
      reasoning TEXT NOT NULL,
      reason_codes TEXT NOT NULL DEFAULT '[]',
      evidence_quality TEXT NOT NULL CHECK (evidence_quality IN ('strong', 'medium', 'weak')),
      primary_topic TEXT,
      related_topics TEXT NOT NULL DEFAULT '[]',
      topic_confidence TEXT CHECK (topic_confidence IS NULL OR topic_confidence IN ('high', 'medium', 'low')),
      publisher_notes TEXT,
      follow_up_questions TEXT NOT NULL DEFAULT '[]',
      research_instructions TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS pipeline_editor_decisions_status_idx
      ON pipeline_editor_decisions (status, created_at DESC);

    CREATE INDEX IF NOT EXISTS pipeline_editor_decisions_source_area_idx
      ON pipeline_editor_decisions (source, area, created_at DESC);

    CREATE TABLE IF NOT EXISTS pipeline_editor_drafts (
      id TEXT PRIMARY KEY,
      entity_id TEXT NOT NULL,
      entity_slug TEXT NOT NULL,
      entity_name TEXT NOT NULL,
      entity_type TEXT NOT NULL,
      bundle_key TEXT NOT NULL,
      source_memory_ids TEXT NOT NULL DEFAULT '[]',
      source_memory_hash TEXT NOT NULL,
      source TEXT,
      source_area TEXT,
      action TEXT NOT NULL CHECK (
        action IN ('draft_post', 'watch', 'skip_repetitive', 'needs_more_research', 'merge_with_existing_draft')
      ),
      status TEXT NOT NULL CHECK (
        status IN ('drafted', 'watching', 'skipped', 'needs_more_research', 'merged', 'published')
      ),
      title TEXT,
      angle TEXT,
      summary TEXT,
      body TEXT,
      reasoning TEXT NOT NULL,
      reason_codes TEXT NOT NULL DEFAULT '[]',
      evidence_quality TEXT CHECK (evidence_quality IS NULL OR evidence_quality IN ('strong', 'medium', 'weak')),
      priority REAL CHECK (priority IS NULL OR (priority >= 0 AND priority <= 100)),
      confidence REAL CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
      merge_target_draft_id TEXT REFERENCES pipeline_editor_drafts(id) ON DELETE SET NULL,
      related_draft_ids TEXT NOT NULL DEFAULT '[]',
      follow_up_questions TEXT NOT NULL DEFAULT '[]',
      research_instructions TEXT,
      backend TEXT NOT NULL DEFAULT 'hermes_cli',
      model TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE (bundle_key)
    );

    CREATE INDEX IF NOT EXISTS pipeline_editor_drafts_entity_created_idx
      ON pipeline_editor_drafts (entity_id, created_at DESC);

    CREATE INDEX IF NOT EXISTS pipeline_editor_drafts_action_status_idx
      ON pipeline_editor_drafts (action, status, created_at DESC);

    CREATE INDEX IF NOT EXISTS pipeline_editor_drafts_source_idx
      ON pipeline_editor_drafts (source, source_area, created_at DESC);

    CREATE TABLE IF NOT EXISTS pipeline_runs (
      id TEXT PRIMARY KEY,
      source TEXT NOT NULL,
      source_area TEXT,
      stage TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('running', 'succeeded', 'failed', 'skipped', 'partial')),
      input_ref TEXT,
      output_ref TEXT,
      started_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      finished_at TEXT,
      counts TEXT NOT NULL DEFAULT '{}',
      error TEXT,
      metadata TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS pipeline_runs_source_stage_started_idx
      ON pipeline_runs (source, source_area, stage, started_at DESC);

    CREATE INDEX IF NOT EXISTS pipeline_runs_status_started_idx
      ON pipeline_runs (status, started_at DESC);
  `)
}

export class SqlitePipelineStore implements PipelineStore {
  private readonly db: SqliteDatabase

  constructor(path?: string) {
    this.db = openPipelineSqlite(path)
    ensurePipelineSqliteSchema(this.db)
  }

  close(): void {
    this.db.close()
  }

  private tx<T>(fn: () => T): T {
    this.db.exec('BEGIN')
    try {
      const result = fn()
      this.db.exec('COMMIT')
      return result
    } catch (error) {
      try {
        this.db.exec('ROLLBACK')
      } catch {
        // Ignore rollback failure so the original error surfaces.
      }
      throw error
    }
  }

  // -------------------------------------------------------------------------
  // Watchlist
  // -------------------------------------------------------------------------

  async getWatchlistSnapshots(area: string, slugs: string[]): Promise<PipelineWatchlistSnapshotRow[]> {
    const uniqueSlugs = [...new Set(slugs.filter(Boolean))]
    if (uniqueSlugs.length === 0) return []

    const results: PipelineWatchlistSnapshotRow[] = []
    for (const batch of chunk(uniqueSlugs)) {
      const rows = this.db.prepare(`
        SELECT slug, latest_observed_at, latest_yes_price, latest_volume, latest_volume_24h
        FROM pipeline_watchlist
        WHERE area = ? AND slug IN (${placeholders(batch.length)})
      `).all(area, ...batch) as Array<Record<string, unknown>>
      results.push(...rows.map((row) => ({
        slug: String(row.slug),
        latestObservedAt: stringOrNull(row.latest_observed_at),
        latestYesPrice: numberOrNull(row.latest_yes_price),
        latestVolume: numberOrNull(row.latest_volume),
        latestVolume24h: numberOrNull(row.latest_volume_24h),
      })))
    }
    return results
  }

  async upsertWatchlist(rows: PipelineWatchlistUpsertInput[]): Promise<void> {
    if (rows.length === 0) return

    this.tx(() => {
      const stmt = this.db.prepare(`
        INSERT INTO pipeline_watchlist (
          id, source, area, tag_slug, tag_label, market_id, slug, title,
          event_slug, event_title, end_date, is_manual_pin, rank_in_area,
          watch_score, score_breakdown, selection_reason, latest_observed_at,
          latest_yes_price, latest_volume, latest_volume_24h, latest_liquidity,
          status
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (area, slug) DO UPDATE SET
          source = excluded.source,
          tag_slug = excluded.tag_slug,
          tag_label = excluded.tag_label,
          market_id = excluded.market_id,
          title = excluded.title,
          event_slug = excluded.event_slug,
          event_title = excluded.event_title,
          end_date = excluded.end_date,
          is_manual_pin = excluded.is_manual_pin,
          rank_in_area = excluded.rank_in_area,
          watch_score = excluded.watch_score,
          score_breakdown = excluded.score_breakdown,
          selection_reason = excluded.selection_reason,
          latest_observed_at = excluded.latest_observed_at,
          latest_yes_price = excluded.latest_yes_price,
          latest_volume = excluded.latest_volume,
          latest_volume_24h = excluded.latest_volume_24h,
          latest_liquidity = excluded.latest_liquidity,
          status = excluded.status,
          updated_at = CURRENT_TIMESTAMP
      `)
      for (const row of rows) {
        stmt.run(
          randomUUID(),
          row.source,
          row.area,
          row.tagSlug,
          row.tagLabel,
          row.marketId,
          row.slug,
          row.title,
          row.eventSlug,
          row.eventTitle,
          row.endDate,
          toIntFlag(row.isManualPin),
          row.rankInArea,
          row.watchScore,
          json(row.scoreBreakdown),
          row.selectionReason,
          row.latestObservedAt,
          row.latestYesPrice,
          row.latestVolume,
          row.latestVolume24h,
          row.latestLiquidity,
          row.status ?? 'active'
        )
      }
    })
  }

  async deactivateStaleWatchlist(area: string, observedAt: string): Promise<void> {
    this.db.prepare(`
      UPDATE pipeline_watchlist
      SET status = 'inactive',
          updated_at = CURRENT_TIMESTAMP
      WHERE area = ?
        AND status = 'active'
        AND (latest_observed_at IS NULL OR latest_observed_at < ?)
    `).run(area, observedAt)
  }

  // -------------------------------------------------------------------------
  // Candidates
  // -------------------------------------------------------------------------

  async findExistingDedupeKeys(dedupeKeys: string[]): Promise<Set<string>> {
    const uniqueKeys = [...new Set(dedupeKeys.filter(Boolean))]
    if (uniqueKeys.length === 0) return new Set()

    const found = new Set<string>()
    for (const batch of chunk(uniqueKeys)) {
      const rows = this.db.prepare(`
        SELECT dedupe_key FROM pipeline_candidates WHERE dedupe_key IN (${placeholders(batch.length)})
      `).all(...batch) as Array<Record<string, unknown>>
      for (const row of rows) found.add(String(row.dedupe_key))
    }
    return found
  }

  async findCandidateThreadsByFamilyKey(
    source: string,
    area: string,
    familyKeys: string[],
    fallbackScanLimit = 200
  ): Promise<PipelineCandidateRow[]> {
    const uniqueKeys = [...new Set(familyKeys.filter(Boolean))]
    if (uniqueKeys.length === 0) return []

    const results: PipelineCandidateRow[] = []
    for (const batch of chunk(uniqueKeys)) {
      const rows = this.db.prepare(`
        SELECT * FROM pipeline_candidates
        WHERE source = ? AND area = ? AND research_family_key IN (${placeholders(batch.length)})
        ORDER BY observed_at DESC
      `).all(source, area, ...batch) as Array<Record<string, unknown>>
      results.push(...rows.map(mapCandidateRow))
    }

    if (results.length === 0) {
      const fallbackRows = this.db.prepare(`
        SELECT * FROM pipeline_candidates
        WHERE source = ? AND area = ?
        ORDER BY observed_at DESC
        LIMIT ?
      `).all(source, area, Math.max(0, fallbackScanLimit)) as Array<Record<string, unknown>>
      return fallbackRows.map(mapCandidateRow)
    }

    return results
  }

  async findCandidatesForBacklog(input: PipelineFindCandidatesForBacklogInput): Promise<PipelineCandidateRow[]> {
    if (input.statuses.length === 0) return []
    if (input.slugs && input.slugs.length === 0) return []

    const statusPlaceholders = placeholders(input.statuses.length)
    const params: unknown[] = [input.source, input.area, ...input.statuses]
    let slugClause = ''
    if (input.slugs && input.slugs.length > 0) {
      slugClause = ` AND slug IN (${placeholders(input.slugs.length)})`
      params.push(...input.slugs)
    }
    params.push(Math.max(0, input.limit))

    const rows = this.db.prepare(`
      SELECT * FROM pipeline_candidates
      WHERE source = ? AND area = ? AND status IN (${statusPlaceholders})${slugClause}
      ORDER BY observed_at DESC
      LIMIT ?
    `).all(...params) as Array<Record<string, unknown>>
    return rows.map(mapCandidateRow)
  }

  async insertCandidates(rows: PipelineCandidateInsertInput[]): Promise<PipelineCandidateRow[]> {
    if (rows.length === 0) return []

    this.tx(() => {
      const stmt = this.db.prepare(`
        INSERT OR IGNORE INTO pipeline_candidates (
          id, source, area, candidate_type, market_id, slug, title, tag_slug,
          tag_label, observed_at, what_changed, why_flagged, score,
          score_breakdown, metrics, evidence_refs, status, dedupe_key
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      for (const row of rows) {
        stmt.run(
          randomUUID(),
          row.source,
          row.area,
          row.candidateType,
          row.marketId,
          row.slug,
          row.title,
          row.tagSlug,
          row.tagLabel,
          row.observedAt,
          row.whatChanged,
          row.whyFlagged,
          row.score,
          json(row.scoreBreakdown),
          json(row.metrics),
          json(row.evidenceRefs),
          row.status ?? 'pending_research',
          row.dedupeKey
        )
      }
    })

    // Read back by dedupe_key (authoritative identity for this insert),
    // since INSERT OR IGNORE may resolve some rows to pre-existing candidates
    // rather than the freshly generated id.
    return this.getCandidatesByDedupeKeys(rows.map((row) => row.dedupeKey))
  }

  private getCandidatesByDedupeKeys(dedupeKeys: string[]): PipelineCandidateRow[] {
    const uniqueKeys = [...new Set(dedupeKeys.filter(Boolean))]
    const results: PipelineCandidateRow[] = []
    for (const batch of chunk(uniqueKeys)) {
      const rows = this.db.prepare(`
        SELECT * FROM pipeline_candidates WHERE dedupe_key IN (${placeholders(batch.length)})
      `).all(...batch) as Array<Record<string, unknown>>
      results.push(...rows.map(mapCandidateRow))
    }
    return results
  }

  async updateCandidateThreads(updates: PipelineCandidateThreadUpdate[]): Promise<void> {
    if (updates.length === 0) return

    this.tx(() => {
      for (const update of updates) {
        const fields: string[] = []
        const params: unknown[] = []
        const payload = update.payload

        if (payload.status !== undefined) {
          fields.push('status = ?')
          params.push(payload.status)
        }
        if (payload.observedAt !== undefined) {
          fields.push('observed_at = ?')
          params.push(payload.observedAt)
        }
        if (payload.whatChanged !== undefined) {
          fields.push('what_changed = ?')
          params.push(payload.whatChanged)
        }
        if (payload.whyFlagged !== undefined) {
          fields.push('why_flagged = ?')
          params.push(payload.whyFlagged)
        }
        if (payload.score !== undefined) {
          fields.push('score = ?')
          params.push(payload.score)
        }
        if (payload.scoreBreakdown !== undefined) {
          fields.push('score_breakdown = ?')
          params.push(json(payload.scoreBreakdown))
        }
        if (payload.metrics !== undefined) {
          fields.push('metrics = ?')
          params.push(json(payload.metrics))
        }
        if (payload.evidenceRefs !== undefined) {
          fields.push('evidence_refs = ?')
          params.push(json(payload.evidenceRefs))
        }
        if (payload.researchFamilyKey !== undefined) {
          fields.push('research_family_key = ?')
          params.push(payload.researchFamilyKey)
        }
        if (payload.researchClusterKey !== undefined) {
          fields.push('research_cluster_key = ?')
          params.push(payload.researchClusterKey)
        }
        if (payload.researchDepth !== undefined) {
          fields.push('research_depth = ?')
          params.push(payload.researchDepth)
        }

        if (fields.length === 0) continue

        fields.push('updated_at = CURRENT_TIMESTAMP')
        params.push(update.id)

        this.db.prepare(`
          UPDATE pipeline_candidates SET ${fields.join(', ')} WHERE id = ?
        `).run(...params)
      }
    })
  }

  async fetchPendingCandidates(input: PipelineFetchPendingCandidatesInput): Promise<PipelineCandidateRow[]> {
    const params: unknown[] = [input.source, input.area]
    let observedClause = ''
    if (input.observedAfter) {
      observedClause = ' AND observed_at > ?'
      params.push(input.observedAfter)
    }
    params.push(Math.max(0, input.limit))

    const rows = this.db.prepare(`
      SELECT * FROM pipeline_candidates
      WHERE source = ? AND area = ? AND status = 'pending_research'${observedClause}
      ORDER BY observed_at ASC
      LIMIT ?
    `).all(...params) as Array<Record<string, unknown>>
    return rows.map(mapCandidateRow)
  }

  async fetchRetryableCandidates(input: PipelineFetchRetryableCandidatesInput): Promise<PipelineCandidateRow[]> {
    const params: unknown[] = [input.source, input.area, input.maxRetryCount, input.now, input.now]
    let observedClause = ''
    if (input.observedAfter) {
      observedClause = ' AND observed_at > ?'
      params.push(input.observedAfter)
    }
    params.push(Math.max(0, input.limit))

    const rows = this.db.prepare(`
      SELECT * FROM pipeline_candidates
      WHERE source = ? AND area = ?
        AND status = 'research_failed'
        AND research_retry_count < ?
        AND (research_next_retry_at IS NULL OR research_next_retry_at <= ?)
        AND (lease_expires_at IS NULL OR lease_expires_at <= ?)${observedClause}
      ORDER BY observed_at ASC
      LIMIT ?
    `).all(...params) as Array<Record<string, unknown>>
    return rows.map(mapCandidateRow)
  }

  async setCandidateStatus(input: PipelineSetCandidateStatusInput): Promise<void> {
    if (input.ids.length === 0) return

    this.tx(() => {
      for (const batch of chunk(input.ids)) {
        const fields = [
          'status = ?',
          'observed_at = ?',
          'research_error = ?',
          'updated_at = CURRENT_TIMESTAMP',
        ]
        const params: unknown[] = [input.status, input.observedAt, input.researchError ?? null]

        if (input.extra?.researchRetryCount !== undefined) {
          fields.push('research_retry_count = ?')
          params.push(input.extra.researchRetryCount)
        }
        if (input.extra?.researchNextRetryAt !== undefined) {
          fields.push('research_next_retry_at = ?')
          params.push(input.extra.researchNextRetryAt)
        }
        if (input.extra?.researchLastErrorKind !== undefined) {
          fields.push('research_last_error_kind = ?')
          params.push(input.extra.researchLastErrorKind)
        }
        if (input.extra?.researchAttemptedAt !== undefined) {
          fields.push('research_attempted_at = ?')
          params.push(input.extra.researchAttemptedAt)
        }

        params.push(...batch)

        this.db.prepare(`
          UPDATE pipeline_candidates
          SET ${fields.join(', ')}
          WHERE id IN (${placeholders(batch.length)})
        `).run(...params)
      }
    })
  }

  async getCandidatesByIds(ids: string[]): Promise<PipelineCandidateRow[]> {
    const uniqueIds = [...new Set(ids.filter(Boolean))]
    if (uniqueIds.length === 0) return []

    // `WHERE id IN (...)` has no guaranteed row order, so results are returned
    // in the caller's requested id order. Callers routinely destructure the
    // result positionally against the ids they passed in.
    const byId = new Map<string, PipelineCandidateRow>()
    for (const batch of chunk(uniqueIds)) {
      const rows = this.db.prepare(`
        SELECT * FROM pipeline_candidates WHERE id IN (${placeholders(batch.length)})
      `).all(...batch) as Array<Record<string, unknown>>
      for (const row of rows) {
        const mapped = mapCandidateRow(row)
        byId.set(mapped.id, mapped)
      }
    }

    const results: PipelineCandidateRow[] = []
    for (const id of uniqueIds) {
      const row = byId.get(id)
      if (row !== undefined) results.push(row)
    }
    return results
  }

  // -------------------------------------------------------------------------
  // Research
  // -------------------------------------------------------------------------

  async getResearchByIds(ids: string[]): Promise<PipelineResearchRow[]> {
    const uniqueIds = [...new Set(ids.filter(Boolean))]
    if (uniqueIds.length === 0) return []

    // Returned in the caller's requested id order - see getCandidatesByIds.
    const byId = new Map<string, PipelineResearchRow>()
    for (const batch of chunk(uniqueIds)) {
      const rows = this.db.prepare(`
        SELECT r.*, c.source AS candidate_source, c.area AS candidate_area
        FROM pipeline_research r
        JOIN pipeline_candidates c ON c.id = r.candidate_id
        WHERE r.id IN (${placeholders(batch.length)})
      `).all(...batch) as Array<Record<string, unknown>>
      for (const row of rows) {
        const mapped = mapResearchRow(row)
        byId.set(mapped.id, mapped)
      }
    }

    const results: PipelineResearchRow[] = []
    for (const id of uniqueIds) {
      const row = byId.get(id)
      if (row !== undefined) results.push(row)
    }
    return results
  }

  async findResearchForBacklog(input: PipelineFindResearchForBacklogInput): Promise<PipelineResearchRow[]> {
    if (input.statuses.length === 0) return []
    if (input.slugs && input.slugs.length === 0) return []

    const statusPlaceholders = placeholders(input.statuses.length)
    const params: unknown[] = [input.source, input.area, ...input.statuses]
    let slugClause = ''
    if (input.slugs && input.slugs.length > 0) {
      slugClause = ` AND r.slug IN (${placeholders(input.slugs.length)})`
      params.push(...input.slugs)
    }
    params.push(Math.max(0, input.limit))

    const rows = this.db.prepare(`
      SELECT r.*, c.source AS candidate_source, c.area AS candidate_area
      FROM pipeline_research r
      JOIN pipeline_candidates c ON c.id = r.candidate_id
      WHERE r.source = ? AND r.area = ? AND r.status IN (${statusPlaceholders})${slugClause}
      ORDER BY r.researched_at DESC
      LIMIT ?
    `).all(...params) as Array<Record<string, unknown>>
    return rows.map(mapResearchRow)
  }

  async findPriorResearch(input: PipelineFindPriorResearchInput): Promise<PipelineResearchRow[]> {
    const uniqueKeys = [...new Set(input.keys.filter(Boolean))]
    if (uniqueKeys.length === 0) return []

    const column = input.keyType === 'slug' ? 'r.slug' : 'r.research_family_key'
    const results: PipelineResearchRow[] = []
    for (const batch of chunk(uniqueKeys)) {
      const rows = this.db.prepare(`
        SELECT r.*, c.source AS candidate_source, c.area AS candidate_area
        FROM pipeline_research r
        JOIN pipeline_candidates c ON c.id = r.candidate_id
        WHERE ${column} IN (${placeholders(batch.length)})
        ORDER BY r.researched_at DESC
        LIMIT ?
      `).all(...batch, Math.max(0, input.limit)) as Array<Record<string, unknown>>
      results.push(...rows.map(mapResearchRow))
    }
    return results.slice(0, input.limit)
  }

  async upsertResearchRows(rows: PipelineResearchUpsertInput[]): Promise<string[]> {
    if (rows.length === 0) return []

    this.tx(() => {
      const stmt = this.db.prepare(`
        INSERT INTO pipeline_research (
          id, candidate_id, source, area, slug, title, candidate_type,
          research_mode, summary, notes, key_findings, evidence_links,
          related_context, uncertainty, editor_notes, status, researched_at,
          research_family_key, research_cluster_key, research_depth,
          evidence_quality, catalyst_found, recommended_editor_action,
          duplicate_of_research_id, research_backend, research_model
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (candidate_id) DO UPDATE SET
          source = excluded.source,
          area = excluded.area,
          slug = excluded.slug,
          title = excluded.title,
          candidate_type = excluded.candidate_type,
          research_mode = excluded.research_mode,
          summary = excluded.summary,
          notes = excluded.notes,
          key_findings = excluded.key_findings,
          evidence_links = excluded.evidence_links,
          related_context = excluded.related_context,
          uncertainty = excluded.uncertainty,
          editor_notes = excluded.editor_notes,
          status = excluded.status,
          researched_at = excluded.researched_at,
          research_family_key = excluded.research_family_key,
          research_cluster_key = excluded.research_cluster_key,
          research_depth = excluded.research_depth,
          evidence_quality = excluded.evidence_quality,
          catalyst_found = excluded.catalyst_found,
          recommended_editor_action = excluded.recommended_editor_action,
          duplicate_of_research_id = excluded.duplicate_of_research_id,
          research_backend = excluded.research_backend,
          research_model = excluded.research_model,
          updated_at = CURRENT_TIMESTAMP
      `)
      for (const row of rows) {
        stmt.run(
          randomUUID(),
          row.candidateId,
          row.source,
          row.area,
          row.slug,
          row.title,
          row.candidateType,
          row.researchMode,
          row.summary,
          row.notes,
          json(row.keyFindings),
          json(row.evidenceLinks),
          json(row.relatedContext),
          row.uncertainty,
          row.editorNotes,
          row.status ?? 'pending_editor',
          row.researchedAt,
          row.researchFamilyKey,
          row.researchClusterKey,
          row.researchDepth,
          row.evidenceQuality,
          toIntFlag(row.catalystFound),
          row.recommendedEditorAction,
          row.duplicateOfResearchId ?? null,
          row.researchBackend,
          row.researchModel ?? null
        )
      }
    })

    // Read back the actual persisted research row ids rather than echoing the
    // generated uuids, since ON CONFLICT (candidate_id) may have resolved to a
    // pre-existing row and kept its original id. Callers use these ids with
    // getResearchByIds / setResearchStatus, so they must be pipeline_research
    // ids - not the candidate ids the caller already holds.
    //
    // Returned in the caller's input order so `ids[i]` corresponds to `rows[i]`.
    const idByCandidateId = new Map<string, string>()
    const candidateIds = [...new Set(rows.map((row) => row.candidateId))]
    for (const batch of chunk(candidateIds)) {
      const found = this.db.prepare(`
        SELECT id, candidate_id FROM pipeline_research WHERE candidate_id IN (${placeholders(batch.length)})
      `).all(...batch) as Array<Record<string, unknown>>
      for (const row of found) {
        idByCandidateId.set(String(row.candidate_id), String(row.id))
      }
    }

    const persisted: string[] = []
    for (const row of rows) {
      const id = idByCandidateId.get(row.candidateId)
      if (id !== undefined) persisted.push(id)
    }
    return persisted
  }

  async fetchResearchByStatus(input: PipelineFetchResearchByStatusInput): Promise<PipelineResearchRow[]> {
    const rows = this.db.prepare(`
      SELECT r.*, c.source AS candidate_source, c.area AS candidate_area
      FROM pipeline_research r
      JOIN pipeline_candidates c ON c.id = r.candidate_id
      WHERE r.source = ? AND r.area = ? AND r.status = ?
      ORDER BY r.researched_at ASC, r.id ASC
      LIMIT ? OFFSET ?
    `).all(input.source, input.area, input.status, Math.max(0, input.limit), Math.max(0, input.offset ?? 0)) as Array<Record<string, unknown>>
    return rows.map(mapResearchRow)
  }

  async setResearchStatus(ids: string[], status: PipelineResearchStatus, observedAt: string): Promise<void> {
    if (ids.length === 0) return

    this.tx(() => {
      for (const batch of chunk(ids)) {
        this.db.prepare(`
          UPDATE pipeline_research
          SET status = ?, researched_at = ?, updated_at = CURRENT_TIMESTAMP
          WHERE id IN (${placeholders(batch.length)})
        `).run(status, observedAt, ...batch)
      }
    })
  }

  // -------------------------------------------------------------------------
  // Editor decisions
  // -------------------------------------------------------------------------

  async findEditorDecisions(input: PipelineFindEditorDecisionsInput): Promise<PipelineEditorDecisionRow[]> {
    const params: unknown[] = [input.source, input.area]
    let clauses = ''
    if (input.status) {
      clauses += ' AND status = ?'
      params.push(input.status)
    }
    if (input.decision) {
      clauses += ' AND decision = ?'
      params.push(input.decision)
    }
    params.push(Math.max(0, input.limit))

    const order = input.orderBy === 'asc' ? 'ASC' : 'DESC'
    const rows = this.db.prepare(`
      SELECT * FROM pipeline_editor_decisions
      WHERE source = ? AND area = ?${clauses}
      ORDER BY created_at ${order}
      LIMIT ?
    `).all(...params) as Array<Record<string, unknown>>
    return rows.map(mapEditorDecisionRow)
  }

  async insertEditorDecisions(
    rows: PipelineEditorDecisionInsertInput[]
  ): Promise<PipelineEditorDecisionInsertResult[]> {
    if (rows.length === 0) return []

    const ids = this.tx(() => {
      const stmt = this.db.prepare(`
        INSERT INTO pipeline_editor_decisions (
          id, source, area, research_ids, decision, status, angle,
          why_this_matters, reasoning, reason_codes, evidence_quality,
          primary_topic, related_topics, topic_confidence, publisher_notes,
          follow_up_questions, research_instructions
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      const insertedIds: string[] = []
      for (const row of rows) {
        const id = randomUUID()
        stmt.run(
          id,
          row.source,
          row.area,
          json(row.researchIds),
          row.decision,
          row.status,
          row.angle ?? null,
          row.whyThisMatters ?? null,
          row.reasoning,
          json(row.reasonCodes ?? []),
          row.evidenceQuality,
          row.primaryTopic ?? null,
          json(row.relatedTopics ?? []),
          row.topicConfidence ?? null,
          row.publisherNotes ?? null,
          json(row.followUpQuestions ?? []),
          row.researchInstructions ?? null
        )
        insertedIds.push(id)
      }
      return insertedIds
    })

    const results: PipelineEditorDecisionInsertResult[] = []
    for (const batch of chunk(ids)) {
      const found = this.db.prepare(`
        SELECT id, research_ids, decision, status, angle
        FROM pipeline_editor_decisions
        WHERE id IN (${placeholders(batch.length)})
      `).all(...batch) as Array<Record<string, unknown>>
      results.push(...found.map((row) => ({
        id: String(row.id),
        researchIds: parseStringArray(row.research_ids),
        decision: String(row.decision) as PipelineEditorDecision,
        status: String(row.status) as PipelineEditorDecisionStatus,
        angle: stringOrNull(row.angle),
      })))
    }
    return results
  }

  async setEditorDecisionStatus(ids: string[], status: PipelineEditorDecisionStatus, observedAt: string): Promise<void> {
    if (ids.length === 0) return

    this.tx(() => {
      for (const batch of chunk(ids)) {
        this.db.prepare(`
          UPDATE pipeline_editor_decisions
          SET status = ?, updated_at = ?
          WHERE id IN (${placeholders(batch.length)})
        `).run(status, observedAt, ...batch)
      }
    })
  }

  // -------------------------------------------------------------------------
  // Editor drafts
  // -------------------------------------------------------------------------

  async fetchPriorDraftsByEntity(entityIds: string[], limitPerEntity: number): Promise<Map<string, PipelineDraftRow[]>> {
    const uniqueIds = [...new Set(entityIds.filter(Boolean))]
    const result = new Map<string, PipelineDraftRow[]>()
    if (uniqueIds.length === 0) return result

    for (const entityId of uniqueIds) {
      const rows = this.db.prepare(`
        SELECT * FROM pipeline_editor_drafts
        WHERE entity_id = ?
        ORDER BY created_at DESC
        LIMIT ?
      `).all(entityId, Math.max(0, limitPerEntity)) as Array<Record<string, unknown>>
      result.set(entityId, rows.map(mapDraftRow))
    }
    return result
  }

  async findReviewedMemoryIds(memoryIds: string[]): Promise<Set<string>> {
    const uniqueIds = [...new Set(memoryIds.filter(Boolean))]
    if (uniqueIds.length === 0) return new Set()

    const reviewed = new Set<string>()
    const stmt = this.db.prepare(`
      SELECT 1 FROM pipeline_editor_drafts
      WHERE EXISTS (SELECT 1 FROM json_each(source_memory_ids) WHERE value = ?)
      LIMIT 1
    `)
    for (const id of uniqueIds) {
      const row = stmt.get(id)
      if (row) reviewed.add(id)
    }
    return reviewed
  }

  async upsertDraftsByBundleKey(drafts: PipelineDraftUpsertInput[]): Promise<PipelineDraftRow[]> {
    if (drafts.length === 0) return []

    this.tx(() => {
      const stmt = this.db.prepare(`
        INSERT INTO pipeline_editor_drafts (
          id, entity_id, entity_slug, entity_name, entity_type, bundle_key,
          source_memory_ids, source_memory_hash, source, source_area, action,
          status, title, angle, summary, body, reasoning, reason_codes,
          evidence_quality, priority, confidence, merge_target_draft_id,
          related_draft_ids, follow_up_questions, research_instructions,
          backend, model
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (bundle_key) DO UPDATE SET
          entity_id = excluded.entity_id,
          entity_slug = excluded.entity_slug,
          entity_name = excluded.entity_name,
          entity_type = excluded.entity_type,
          source_memory_ids = excluded.source_memory_ids,
          source_memory_hash = excluded.source_memory_hash,
          source = excluded.source,
          source_area = excluded.source_area,
          action = excluded.action,
          status = excluded.status,
          title = excluded.title,
          angle = excluded.angle,
          summary = excluded.summary,
          body = excluded.body,
          reasoning = excluded.reasoning,
          reason_codes = excluded.reason_codes,
          evidence_quality = excluded.evidence_quality,
          priority = excluded.priority,
          confidence = excluded.confidence,
          merge_target_draft_id = excluded.merge_target_draft_id,
          related_draft_ids = excluded.related_draft_ids,
          follow_up_questions = excluded.follow_up_questions,
          research_instructions = excluded.research_instructions,
          backend = excluded.backend,
          model = excluded.model,
          updated_at = CURRENT_TIMESTAMP
      `)
      for (const draft of drafts) {
        stmt.run(
          randomUUID(),
          draft.entityId,
          draft.entitySlug,
          draft.entityName,
          draft.entityType,
          draft.bundleKey,
          json(draft.sourceMemoryIds),
          draft.sourceMemoryHash,
          draft.source ?? null,
          draft.sourceArea ?? null,
          draft.action,
          draft.status,
          draft.title ?? null,
          draft.angle ?? null,
          draft.summary ?? null,
          draft.body ?? null,
          draft.reasoning,
          json(draft.reasonCodes ?? []),
          draft.evidenceQuality ?? null,
          draft.priority ?? null,
          draft.confidence ?? null,
          draft.mergeTargetDraftId ?? null,
          json(draft.relatedDraftIds ?? []),
          json(draft.followUpQuestions ?? []),
          draft.researchInstructions ?? null,
          draft.backend,
          draft.model ?? null
        )
      }
    })

    const bundleKeys = [...new Set(drafts.map((draft) => draft.bundleKey))]
    const results: PipelineDraftRow[] = []
    for (const batch of chunk(bundleKeys)) {
      const rows = this.db.prepare(`
        SELECT * FROM pipeline_editor_drafts WHERE bundle_key IN (${placeholders(batch.length)})
      `).all(...batch) as Array<Record<string, unknown>>
      results.push(...rows.map(mapDraftRow))
    }
    return results
  }

  async fetchEligibleDrafts(input: PipelineFetchEligibleDraftsInput): Promise<PipelineDraftRow[]> {
    const rows = this.db.prepare(`
      SELECT * FROM pipeline_editor_drafts
      WHERE action = ? AND status = ?
      ORDER BY created_at ASC
      LIMIT ?
    `).all(input.action, input.status, Math.max(0, input.limit)) as Array<Record<string, unknown>>
    return rows.map(mapDraftRow)
  }

  async setDraftPublished(draftId: string, observedAt: string): Promise<void> {
    this.db.prepare(`
      UPDATE pipeline_editor_drafts
      SET status = 'published', updated_at = ?
      WHERE id = ?
    `).run(observedAt, draftId)
  }

  // -------------------------------------------------------------------------
  // Pipeline runs
  // -------------------------------------------------------------------------

  async startRun(input: PipelineRunStartInput): Promise<PipelineRunStartResult> {
    const id = randomUUID()
    this.db.prepare(`
      INSERT INTO pipeline_runs (
        id, source, source_area, stage, status, input_ref, started_at, metadata
      )
      VALUES (?, ?, ?, ?, 'running', ?, ?, ?)
    `).run(
      id,
      input.source,
      input.sourceArea ?? null,
      input.stage,
      input.inputRef ?? null,
      input.startedAt,
      json(input.metadata ?? {})
    )
    return { id }
  }

  async finishRun(id: string, input: PipelineRunFinishInput): Promise<void> {
    const fields = [
      'status = ?',
      'finished_at = ?',
      'updated_at = CURRENT_TIMESTAMP',
    ]
    const params: unknown[] = [input.status, input.finishedAt]

    if (input.outputRef !== undefined) {
      fields.push('output_ref = ?')
      params.push(input.outputRef)
    }
    if (input.counts !== undefined) {
      fields.push('counts = ?')
      params.push(json(input.counts))
    }
    if (input.error !== undefined) {
      fields.push('error = ?')
      params.push(input.error)
    }
    if (input.metadata !== undefined) {
      fields.push('metadata = ?')
      params.push(json(input.metadata))
    }

    params.push(id)

    this.db.prepare(`
      UPDATE pipeline_runs SET ${fields.join(', ')} WHERE id = ?
    `).run(...params)
  }

  // -------------------------------------------------------------------------
  // Lease / recovery
  // -------------------------------------------------------------------------

  async claimWithLease(input: PipelineClaimWithLeaseInput): Promise<PipelineCandidateRow[]> {
    return this.tx(() => {
      // Claimable work is either untouched pending work, or in-flight work
      // whose lease has expired (the previous owner died mid-flight). Selecting
      // only 'pending_research' would make an expired lease permanently
      // unreclaimable, since claiming flips the status to 'researching'.
      const claimable = this.db.prepare(`
        SELECT id FROM pipeline_candidates
        WHERE source = ? AND area = ?
          AND (
            (status = 'pending_research' AND (lease_expires_at IS NULL OR lease_expires_at <= ?))
            OR (status = 'researching' AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?)
          )
        ORDER BY observed_at ASC
        LIMIT ?
      `).all(input.source, input.area, input.now, input.now, Math.max(0, input.limit)) as Array<Record<string, unknown>>

      const ids = claimable.map((row) => String(row.id))
      if (ids.length === 0) return []

      const leaseExpiresAt = new Date(new Date(input.now).getTime() + input.leaseSeconds * 1000).toISOString()

      for (const batch of chunk(ids)) {
        this.db.prepare(`
          UPDATE pipeline_candidates
          SET status = 'researching',
              lease_owner = ?,
              lease_expires_at = ?,
              attempt_count = attempt_count + 1,
              updated_at = CURRENT_TIMESTAMP
          WHERE id IN (${placeholders(batch.length)})
        `).run(input.leaseOwner, leaseExpiresAt, ...batch)
      }

      const claimed: PipelineCandidateRow[] = []
      for (const batch of chunk(ids)) {
        const rows = this.db.prepare(`
          SELECT * FROM pipeline_candidates WHERE id IN (${placeholders(batch.length)})
        `).all(...batch) as Array<Record<string, unknown>>
        claimed.push(...rows.map(mapCandidateRow))
      }
      return claimed
    })
  }

  async claimRetryableWithLease(input: PipelineClaimRetryableWithLeaseInput): Promise<PipelineCandidateRow[]> {
    return this.tx(() => {
      // Claimable work here is the retry lane ONLY: 'research_failed' rows
      // that have not exhausted their retry budget and are past their
      // next-retry-at (or never had one set). This does not overlap
      // claimWithLease's claimable set (pending_research / expired-lease
      // researching), so the two claims can run back-to-back without either
      // one seeing a row the other already claimed.
      const claimable = this.db.prepare(`
        SELECT id FROM pipeline_candidates
        WHERE source = ? AND area = ?
          AND status = 'research_failed'
          AND attempt_count < ?
          AND (research_next_retry_at IS NULL OR research_next_retry_at <= ?)
        ORDER BY observed_at ASC
        LIMIT ?
      `).all(
        input.source,
        input.area,
        input.maxRetryCount,
        input.now,
        Math.max(0, input.limit)
      ) as Array<Record<string, unknown>>

      const ids = claimable.map((row) => String(row.id))
      if (ids.length === 0) return []

      const leaseExpiresAt = new Date(new Date(input.now).getTime() + input.leaseSeconds * 1000).toISOString()

      for (const batch of chunk(ids)) {
        this.db.prepare(`
          UPDATE pipeline_candidates
          SET status = 'researching',
              lease_owner = ?,
              lease_expires_at = ?,
              attempt_count = attempt_count + 1,
              updated_at = CURRENT_TIMESTAMP
          WHERE id IN (${placeholders(batch.length)})
        `).run(input.leaseOwner, leaseExpiresAt, ...batch)
      }

      const claimed: PipelineCandidateRow[] = []
      for (const batch of chunk(ids)) {
        const rows = this.db.prepare(`
          SELECT * FROM pipeline_candidates WHERE id IN (${placeholders(batch.length)})
        `).all(...batch) as Array<Record<string, unknown>>
        claimed.push(...rows.map(mapCandidateRow))
      }
      return claimed
    })
  }

  async renewLease(ids: string[], leaseOwner: string, leaseSeconds: number, now: string): Promise<void> {
    if (ids.length === 0) return

    const leaseExpiresAt = new Date(new Date(now).getTime() + leaseSeconds * 1000).toISOString()

    this.tx(() => {
      for (const batch of chunk(ids)) {
        this.db.prepare(`
          UPDATE pipeline_candidates
          SET lease_expires_at = ?,
              updated_at = CURRENT_TIMESTAMP
          WHERE lease_owner = ? AND id IN (${placeholders(batch.length)})
        `).run(leaseExpiresAt, leaseOwner, ...batch)
      }
    })
  }

  async releaseLease(ids: string[], leaseOwner: string): Promise<void> {
    if (ids.length === 0) return

    this.tx(() => {
      for (const batch of chunk(ids)) {
        // Releasing returns in-flight work to the claimable pool: clearing the
        // lease alone would leave the row stuck in 'researching' with no owner.
        // The `lease_owner = ?` predicate is what enforces ownership - a wrong
        // owner matches no rows and therefore releases nothing.
        this.db.prepare(`
          UPDATE pipeline_candidates
          SET lease_owner = NULL,
              lease_expires_at = NULL,
              status = CASE WHEN status = 'researching' THEN 'pending_research' ELSE status END,
              updated_at = CURRENT_TIMESTAMP
          WHERE lease_owner = ? AND id IN (${placeholders(batch.length)})
        `).run(leaseOwner, ...batch)
      }
    })
  }

  async recoverExpiredLeases(input: PipelineRecoverExpiredLeasesInput): Promise<PipelineRecoverExpiredLeasesResult> {
    return this.tx(() => {
      const expired = this.db.prepare(`
        SELECT id FROM pipeline_candidates
        WHERE status = 'researching' AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?
      `).all(input.now) as Array<Record<string, unknown>>

      const ids = expired.map((row) => String(row.id))
      if (ids.length === 0) return { recovered: 0, ids: [] }

      for (const batch of chunk(ids)) {
        this.db.prepare(`
          UPDATE pipeline_candidates
          SET status = 'pending_research',
              lease_owner = NULL,
              lease_expires_at = NULL,
              updated_at = CURRENT_TIMESTAMP
          WHERE id IN (${placeholders(batch.length)})
        `).run(...batch)
      }

      return { recovered: ids.length, ids }
    })
  }

  async expireAgedWork(input: PipelineExpireAgedWorkInput): Promise<PipelineExpireAgedWorkResult> {
    return this.tx(() => {
      const aged = this.db.prepare(`
        SELECT id FROM pipeline_candidates
        WHERE status = 'pending_research' AND observed_at < ?
      `).all(input.olderThan) as Array<Record<string, unknown>>

      const ids = aged.map((row) => String(row.id))
      if (ids.length === 0) return { expired: 0 }

      for (const batch of chunk(ids)) {
        this.db.prepare(`
          UPDATE pipeline_candidates
          SET status = 'stale_expired',
              updated_at = CURRENT_TIMESTAMP
          WHERE id IN (${placeholders(batch.length)})
        `).run(...batch)
      }

      return { expired: ids.length }
    })
  }

  // -------------------------------------------------------------------------
  // Backlog depth
  // -------------------------------------------------------------------------

  async getBacklogDepth(input: PipelineBacklogDepthInput): Promise<PipelineBacklogDepth> {
    const now = input.now ?? new Date().toISOString()

    const countCandidates = (whereSql: string, params: unknown[]): number => {
      const row = this.db.prepare(`
        SELECT COUNT(*) AS n FROM pipeline_candidates
        WHERE source = ? AND area = ? AND ${whereSql}
      `).get(input.source, input.area, ...params) as Record<string, unknown>
      return numberValue(row.n)
    }

    const candidatesPending = countCandidates(`status = 'pending_research'`, [])
    const candidatesFailed = countCandidates(`status = 'research_failed'`, [])
    const candidatesStaleExpired = countCandidates(`status = 'stale_expired'`, [])
    const candidatesInFlight = countCandidates(
      `status = 'researching' AND (lease_expires_at IS NULL OR lease_expires_at > ?)`,
      [now]
    )
    const candidatesLeaseExpired = countCandidates(
      `status = 'researching' AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?`,
      [now]
    )

    const researchRow = this.db.prepare(`
      SELECT COUNT(*) AS n
      FROM pipeline_research r
      JOIN pipeline_candidates c ON c.id = r.candidate_id
      WHERE c.source = ? AND c.area = ? AND r.status = 'pending_editor'
    `).get(input.source, input.area) as Record<string, unknown>
    const researchPendingEditor = numberValue(researchRow.n)

    const decisionsRow = this.db.prepare(`
      SELECT COUNT(*) AS n FROM pipeline_editor_decisions
      WHERE source = ? AND area = ? AND status = 'pending_publisher'
    `).get(input.source, input.area) as Record<string, unknown>
    const decisionsPendingPublisher = numberValue(decisionsRow.n)

    const draftsRow = this.db.prepare(`
      SELECT COUNT(*) AS n FROM pipeline_editor_drafts
      WHERE source = ? AND source_area = ? AND status = 'drafted'
    `).get(input.source, input.area) as Record<string, unknown>
    const draftsDrafted = numberValue(draftsRow.n)

    return {
      source: input.source,
      area: input.area,
      candidatesPending,
      candidatesInFlight,
      candidatesFailed,
      candidatesStaleExpired,
      candidatesLeaseExpired,
      researchPendingEditor,
      decisionsPendingPublisher,
      draftsDrafted,
    }
  }
}

// -----------------------------------------------------------------------------
// Row mappers
// -----------------------------------------------------------------------------

function mapCandidateRow(row: Record<string, unknown>): PipelineCandidateRow {
  return {
    id: String(row.id),
    source: String(row.source),
    area: String(row.area),
    candidateType: String(row.candidate_type),
    marketId: String(row.market_id),
    slug: String(row.slug),
    title: String(row.title),
    tagSlug: String(row.tag_slug),
    tagLabel: stringOrNull(row.tag_label),
    observedAt: String(row.observed_at),
    whatChanged: String(row.what_changed),
    whyFlagged: String(row.why_flagged),
    score: numberValue(row.score),
    scoreBreakdown: parseJson(row.score_breakdown),
    metrics: parseJson(row.metrics),
    evidenceRefs: parseJson(row.evidence_refs),
    status: String(row.status) as PipelineStoreCandidateStatus,
    dedupeKey: String(row.dedupe_key),
    researchError: stringOrNull(row.research_error),
    researchAttemptedAt: stringOrNull(row.research_attempted_at),
    researchRetryCount: numberValue(row.research_retry_count),
    researchNextRetryAt: stringOrNull(row.research_next_retry_at),
    researchLastErrorKind: stringOrNull(row.research_last_error_kind),
    researchFamilyKey: stringOrNull(row.research_family_key),
    researchClusterKey: stringOrNull(row.research_cluster_key),
    researchDepth: (stringOrNull(row.research_depth) as PipelineResearchDepth | null),
    leaseOwner: stringOrNull(row.lease_owner),
    leaseExpiresAt: stringOrNull(row.lease_expires_at),
    attemptCount: numberValue(row.attempt_count),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  }
}

function mapResearchRow(row: Record<string, unknown>): PipelineResearchRow {
  return {
    id: String(row.id),
    candidateId: String(row.candidate_id),
    source: String(row.candidate_source ?? row.source),
    area: String(row.candidate_area ?? row.area),
    slug: String(row.slug),
    title: String(row.title),
    candidateType: String(row.candidate_type),
    researchMode: String(row.research_mode),
    summary: String(row.summary),
    notes: String(row.notes),
    keyFindings: parseJson(row.key_findings),
    evidenceLinks: parseJson(row.evidence_links),
    relatedContext: parseJson(row.related_context),
    uncertainty: String(row.uncertainty),
    editorNotes: String(row.editor_notes),
    status: String(row.status) as PipelineResearchStatus,
    researchedAt: String(row.researched_at),
    researchFamilyKey: String(row.research_family_key),
    researchClusterKey: String(row.research_cluster_key),
    researchDepth: String(row.research_depth) as PipelineResearchDepth,
    evidenceQuality: String(row.evidence_quality) as PipelineEvidenceQuality,
    catalystFound: boolValue(row.catalyst_found),
    recommendedEditorAction: String(row.recommended_editor_action) as PipelineRecommendedEditorAction,
    duplicateOfResearchId: stringOrNull(row.duplicate_of_research_id),
    researchBackend: String(row.research_backend),
    researchModel: stringOrNull(row.research_model),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  }
}

function mapEditorDecisionRow(row: Record<string, unknown>): PipelineEditorDecisionRow {
  return {
    id: String(row.id),
    source: String(row.source),
    area: String(row.area),
    researchIds: parseStringArray(row.research_ids),
    decision: String(row.decision) as PipelineEditorDecision,
    status: String(row.status) as PipelineEditorDecisionStatus,
    angle: stringOrNull(row.angle),
    whyThisMatters: stringOrNull(row.why_this_matters),
    reasoning: String(row.reasoning),
    reasonCodes: parseJson(row.reason_codes),
    evidenceQuality: String(row.evidence_quality) as PipelineEvidenceQuality,
    primaryTopic: stringOrNull(row.primary_topic),
    relatedTopics: parseJson(row.related_topics),
    topicConfidence: (stringOrNull(row.topic_confidence) as PipelineTopicConfidence | null),
    publisherNotes: stringOrNull(row.publisher_notes),
    followUpQuestions: parseJson(row.follow_up_questions),
    researchInstructions: stringOrNull(row.research_instructions),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  }
}

function mapDraftRow(row: Record<string, unknown>): PipelineDraftRow {
  return {
    id: String(row.id),
    entityId: String(row.entity_id),
    entitySlug: String(row.entity_slug),
    entityName: String(row.entity_name),
    entityType: String(row.entity_type),
    bundleKey: String(row.bundle_key),
    sourceMemoryIds: parseStringArray(row.source_memory_ids),
    sourceMemoryHash: String(row.source_memory_hash),
    source: stringOrNull(row.source),
    sourceArea: stringOrNull(row.source_area),
    action: String(row.action) as PipelineDraftAction,
    status: String(row.status) as PipelineDraftStatus,
    title: stringOrNull(row.title),
    angle: stringOrNull(row.angle),
    summary: stringOrNull(row.summary),
    body: stringOrNull(row.body),
    reasoning: String(row.reasoning),
    reasonCodes: parseJson(row.reason_codes),
    evidenceQuality: (stringOrNull(row.evidence_quality) as PipelineEvidenceQuality | null),
    priority: numberOrNull(row.priority),
    confidence: numberOrNull(row.confidence),
    mergeTargetDraftId: stringOrNull(row.merge_target_draft_id),
    relatedDraftIds: parseJson(row.related_draft_ids),
    followUpQuestions: parseJson(row.follow_up_questions),
    researchInstructions: stringOrNull(row.research_instructions),
    backend: String(row.backend),
    model: stringOrNull(row.model),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  }
}

export const __testing = {
  ensurePipelineSqliteSchema,
  openPipelineSqlite,
  sqlitePath,
}
