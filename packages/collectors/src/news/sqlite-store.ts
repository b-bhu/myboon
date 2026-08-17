import { randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import type { PriorNewsObservation } from './types'
import {
  initialNewsResearchResultStatus,
  type NewsCandidateObservationInput,
  type NewsCandidateObservationRow,
  type NewsCandidateObservationStatus,
  type NewsResearchBacklog,
  type RecordNewsResearchFailureInput,
  type RecoverStaleNewsWorkInput,
  type RecoverStaleNewsWorkResult,
  type NewsResearchResultInput,
  type NewsResearchResultRow,
  type NewsResearchResultStatus,
  type NewsStore,
  type PendingNewsResearchResult,
  type PersistedNewsDedupeOutcome,
} from './store'

const nodeRequire = createRequire(__filename)
const { DatabaseSync } = nodeRequire('node:sqlite') as {
  DatabaseSync: new (path: string) => SqliteDatabase
}

const COLLECTORS_PACKAGE_DIR = resolve(__dirname, '..', '..')
const DEFAULT_SQLITE_PATH = resolve(COLLECTORS_PACKAGE_DIR, '.data', 'news.sqlite')

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

function sqlitePath(path = DEFAULT_SQLITE_PATH): string {
  if (path === ':memory:') return path
  return resolve(process.cwd(), path)
}

function openNewsSqlite(path?: string): SqliteDatabase {
  const dbPath = sqlitePath(path)
  if (dbPath !== ':memory:') mkdirSync(dirname(dbPath), { recursive: true })
  const db = new DatabaseSync(dbPath)
  db.exec('PRAGMA journal_mode = WAL;')
  db.exec('PRAGMA busy_timeout = 5000;')
  db.exec('PRAGMA foreign_keys = ON;')
  return db
}

function ensureNewsSqliteSchema(db: SqliteDatabase): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS news_source_runs (
      id TEXT PRIMARY KEY,
      job_id TEXT NOT NULL UNIQUE,
      source_id TEXT NOT NULL,
      source_name TEXT NOT NULL,
      source_type TEXT NOT NULL DEFAULT 'curated_news' CHECK (source_type IN ('curated_news')),
      url_id TEXT NOT NULL,
      url_label TEXT NOT NULL,
      source_url TEXT NOT NULL,
      task_type TEXT NOT NULL DEFAULT 'source_scout' CHECK (task_type IN ('source_scout')),
      status TEXT NOT NULL DEFAULT 'queued' CHECK (
        status IN (
          'queued',
          'running',
          'succeeded',
          'result_validated',
          'candidates_classified',
          'candidates_ingested',
          'failed_transient',
          'retry_scheduled',
          'failed_permanent'
        )
      ),
      observed_at TEXT,
      started_at TEXT,
      finished_at TEXT,
      candidates_found INTEGER NOT NULL DEFAULT 0,
      candidates_new INTEGER NOT NULL DEFAULT 0,
      candidates_unchanged INTEGER NOT NULL DEFAULT 0,
      candidates_materially_changed INTEGER NOT NULL DEFAULT 0,
      candidates_invalid INTEGER NOT NULL DEFAULT 0,
      raw_response TEXT,
      validated_payload TEXT,
      error TEXT,
      attempt_count INTEGER NOT NULL DEFAULT 0,
      next_retry_at TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS news_source_runs_source_url_time_idx
      ON news_source_runs (source_id, url_id, created_at DESC);

    CREATE INDEX IF NOT EXISTS news_source_runs_status_idx
      ON news_source_runs (status, next_retry_at, created_at DESC);

    CREATE TABLE IF NOT EXISTS news_candidate_observations (
      id TEXT PRIMARY KEY,
      source_run_id TEXT REFERENCES news_source_runs(id) ON DELETE SET NULL,
      source_id TEXT NOT NULL,
      source_name TEXT NOT NULL,
      url_id TEXT NOT NULL,
      url_label TEXT NOT NULL,
      source_url TEXT NOT NULL,
      canonical_article_url TEXT NOT NULL,
      headline TEXT NOT NULL,
      visible_summary TEXT,
      published_at TEXT,
      observed_at TEXT NOT NULL,
      headline_hash TEXT NOT NULL,
      summary_hash TEXT,
      content_hash TEXT NOT NULL,
      article_identity_key TEXT NOT NULL,
      observation_dedupe_key TEXT NOT NULL UNIQUE,
      dedupe_outcome TEXT NOT NULL CHECK (
        dedupe_outcome IN ('new_candidate', 'known_materially_changed')
      ),
      status TEXT NOT NULL DEFAULT 'pending_research' CHECK (
        status IN (
          'pending_research',
          'research_queued',
          'researching',
          'researched',
          'handed_to_entity_memory',
          'rejected',
          'failed_research'
        )
      ),
      last_research_job_id TEXT,
      research_worker_status TEXT,
      research_error TEXT,
      research_raw_response TEXT,
      research_stderr TEXT,
      raw_candidate TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS news_candidate_observations_source_url_time_idx
      ON news_candidate_observations (source_id, url_id, observed_at DESC);

    CREATE INDEX IF NOT EXISTS news_candidate_observations_article_identity_idx
      ON news_candidate_observations (article_identity_key, observed_at DESC);

    CREATE INDEX IF NOT EXISTS news_candidate_observations_status_idx
      ON news_candidate_observations (status, observed_at DESC);

    CREATE TABLE IF NOT EXISTS news_research_results (
      id TEXT PRIMARY KEY,
      candidate_observation_id TEXT NOT NULL REFERENCES news_candidate_observations(id) ON DELETE CASCADE,
      source_id TEXT NOT NULL,
      source_name TEXT NOT NULL,
      url_id TEXT NOT NULL,
      url_label TEXT NOT NULL,
      source_url TEXT NOT NULL,
      canonical_article_url TEXT NOT NULL,
      article_identity_key TEXT NOT NULL,
      observation_dedupe_key TEXT NOT NULL,
      research_job_id TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL CHECK (
        status IN (
          'pending_entity_memory',
          'not_ready_for_entity_memory',
          'handed_to_entity_memory',
          'failed_entity_memory'
        )
      ),
      response_status TEXT NOT NULL CHECK (
        response_status IN ('ready_for_entity_memory', 'needs_followup', 'failed')
      ),
      source_signal TEXT NOT NULL,
      research_summary TEXT NOT NULL,
      article_claims TEXT NOT NULL,
      verified_facts TEXT NOT NULL,
      unresolved_claims TEXT NOT NULL,
      entity_hints TEXT NOT NULL,
      evidence TEXT NOT NULL,
      open_questions TEXT NOT NULL,
      limitations TEXT NOT NULL,
      errors TEXT NOT NULL,
      raw_response TEXT NOT NULL,
      researched_at TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE (candidate_observation_id)
    );

    CREATE INDEX IF NOT EXISTS news_research_results_status_time_idx
      ON news_research_results (status, researched_at DESC);

    CREATE INDEX IF NOT EXISTS news_research_results_source_time_idx
      ON news_research_results (source_id, url_id, researched_at DESC);

    CREATE INDEX IF NOT EXISTS news_research_results_candidate_idx
      ON news_research_results (candidate_observation_id);
  `)
  ensureNewsSqliteMigrations(db)
}

function ensureNewsSqliteMigrations(db: SqliteDatabase): void {
  const columns = new Set((db.prepare('PRAGMA table_info(news_candidate_observations)').all() as Array<Record<string, unknown>>)
    .map((row) => String(row.name)))
  const additions: Array<[string, string]> = [
    ['last_research_job_id', 'TEXT'],
    ['research_worker_status', 'TEXT'],
    ['research_error', 'TEXT'],
    ['research_raw_response', 'TEXT'],
    ['research_stderr', 'TEXT'],
  ]
  for (const [name, definition] of additions) {
    if (!columns.has(name)) {
      db.exec(`ALTER TABLE news_candidate_observations ADD COLUMN ${name} ${definition};`)
    }
  }
}

export class SqliteNewsStore implements NewsStore {
  private readonly db: SqliteDatabase

  constructor(path?: string) {
    this.db = openNewsSqlite(path)
    ensureNewsSqliteSchema(this.db)
  }

  close(): void {
    this.db.close()
  }

  async fetchPriorObservations(
    sourceId: string,
    canonicalArticleUrls: string[]
  ): Promise<PriorNewsObservation[]> {
    const urls = [...new Set(canonicalArticleUrls.filter(Boolean))]
    if (urls.length === 0) return []

    try {
      const placeholders = urls.map(() => '?').join(', ')
      const rows = this.db.prepare(`
        SELECT
          source_id,
          url_id,
          canonical_article_url,
          headline_hash,
          summary_hash,
          article_identity_key,
          observation_dedupe_key,
          observed_at
        FROM news_candidate_observations
        WHERE source_id = ?
          AND canonical_article_url IN (${placeholders})
        ORDER BY observed_at DESC, created_at DESC
      `).all(sourceId, ...urls) as Array<Record<string, unknown>>

      return rows.map((row) => ({
        sourceId: String(row.source_id),
        urlId: String(row.url_id),
        canonicalArticleUrl: String(row.canonical_article_url),
        headlineHash: String(row.headline_hash),
        summaryHash: stringOrNull(row.summary_hash),
        articleIdentityKey: String(row.article_identity_key),
        observationDedupeKey: String(row.observation_dedupe_key),
        observedAt: String(row.observed_at),
      }))
    } catch (error) {
      throw new Error(`news_candidate_observations prior lookup failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  async insertCandidateObservations(
    inputs: NewsCandidateObservationInput[]
  ): Promise<NewsCandidateObservationRow[]> {
    const persistedInputs = inputs.filter((input) => isPersistedOutcome(input.dedupeOutcome))
    if (persistedInputs.length === 0) return []

    try {
      this.db.exec('BEGIN')
      try {
        for (const input of persistedInputs) {
          this.db.prepare(`
            INSERT OR IGNORE INTO news_candidate_observations (
              id,
              source_run_id,
              source_id,
              source_name,
              url_id,
              url_label,
              source_url,
              canonical_article_url,
              headline,
              visible_summary,
              published_at,
              observed_at,
              headline_hash,
              summary_hash,
              content_hash,
              article_identity_key,
              observation_dedupe_key,
              dedupe_outcome,
              status,
              raw_candidate
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).run(
            randomUUID(),
            null,
            input.source.sourceId,
            input.source.sourceName,
            input.sourceUrl.urlId,
            input.sourceUrl.label,
            input.sourceUrl.url,
            input.fingerprint.canonicalArticleUrl,
            input.candidate.headline,
            input.candidate.summary ?? null,
            input.candidate.published_at ?? null,
            input.observedAt,
            input.fingerprint.headlineHash,
            input.fingerprint.summaryHash,
            input.fingerprint.contentHash,
            input.fingerprint.articleIdentityKey,
            input.fingerprint.observationDedupeKey,
            input.dedupeOutcome,
            input.status ?? 'pending_research',
            json(input.candidate)
          )
        }
        this.db.exec('COMMIT')
      } catch (error) {
        this.db.exec('ROLLBACK')
        throw error
      }

      return this.candidateRowsByDedupeKeys(persistedInputs.map((input) => input.fingerprint.observationDedupeKey))
    } catch (error) {
      throw new Error(`news_candidate_observations insert failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  async fetchCandidateObservation(id: string): Promise<NewsCandidateObservationRow | null> {
    try {
      return this.candidateRowById(id)
    } catch (error) {
      throw new Error(`news_candidate_observations fetch failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  async fetchPendingCandidateObservations(limit: number): Promise<NewsCandidateObservationRow[]> {
    try {
      const rows = this.db.prepare(`
        SELECT *
        FROM news_candidate_observations
        WHERE status = 'pending_research'
        ORDER BY observed_at ASC, created_at ASC
        LIMIT ?
      `).all(Math.max(0, limit)) as Array<Record<string, unknown>>
      return rows.map(mapCandidateObservationRow)
    } catch (error) {
      throw new Error(`news_candidate_observations pending fetch failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  async claimPendingCandidateObservations(limit: number): Promise<NewsCandidateObservationRow[]> {
    const boundedLimit = Math.max(0, limit)
    if (boundedLimit === 0) return []

    try {
      this.db.exec('BEGIN IMMEDIATE')
      try {
        const selected = this.db.prepare(`
          SELECT id
          FROM news_candidate_observations
          WHERE status = 'pending_research'
          ORDER BY observed_at ASC, created_at ASC
          LIMIT ?
        `).all(boundedLimit) as Array<Record<string, unknown>>
        const ids = selected.map((row) => String(row.id))
        if (ids.length === 0) {
          this.db.exec('COMMIT')
          return []
        }

        const placeholders = ids.map(() => '?').join(', ')
        this.db.prepare(`
          UPDATE news_candidate_observations
          SET status = 'research_queued',
              updated_at = CURRENT_TIMESTAMP
          WHERE status = 'pending_research'
            AND id IN (${placeholders})
        `).run(...ids)
        const claimed = this.db.prepare(`
          SELECT *
          FROM news_candidate_observations
          WHERE id IN (${placeholders})
          ORDER BY observed_at ASC, created_at ASC
        `).all(...ids) as Array<Record<string, unknown>>
        this.db.exec('COMMIT')
        return claimed.map(mapCandidateObservationRow)
      } catch (error) {
        this.db.exec('ROLLBACK')
        throw error
      }
    } catch (error) {
      throw new Error(`news_candidate_observations claim failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  async readResearchBacklog(): Promise<NewsResearchBacklog> {
    try {
      const row = this.db.prepare(`
        SELECT
          COUNT(*) AS pending_count,
          MIN(observed_at) AS oldest_pending_observed_at
        FROM news_candidate_observations
        WHERE status = 'pending_research'
      `).get() as Record<string, unknown>
      return {
        pendingCandidates: numberValue(row.pending_count),
        oldestPendingObservedAt: stringOrNull(row.oldest_pending_observed_at),
      }
    } catch (error) {
      throw new Error(`news research backlog read failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  async markCandidateObservationStatus(id: string, status: NewsCandidateObservationStatus): Promise<void> {
    try {
      this.db.prepare(`
        UPDATE news_candidate_observations
        SET status = ?,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(status, id)
    } catch (error) {
      throw new Error(`news_candidate_observations status update failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  async markCandidateResearchStarted(id: string, jobId: string): Promise<void> {
    try {
      this.db.prepare(`
        UPDATE news_candidate_observations
        SET status = 'researching',
            last_research_job_id = ?,
            research_worker_status = NULL,
            research_error = NULL,
            research_raw_response = NULL,
            research_stderr = NULL,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(jobId, id)
    } catch (error) {
      throw new Error(`news_candidate_observations research start failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  async recordCandidateResearchFailure(input: RecordNewsResearchFailureInput): Promise<void> {
    try {
      this.db.prepare(`
        UPDATE news_candidate_observations
        SET status = 'failed_research',
            last_research_job_id = ?,
            research_worker_status = ?,
            research_error = ?,
            research_raw_response = ?,
            research_stderr = ?,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(
        input.jobId,
        input.workerStatus ?? null,
        input.error,
        input.rawResponse ?? null,
        input.stderr ?? null,
        input.id
      )
    } catch (error) {
      throw new Error(`news_candidate_observations research failure record failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  async recoverStaleWork(input: RecoverStaleNewsWorkInput): Promise<RecoverStaleNewsWorkResult> {
    try {
      const candidateResult = this.db.prepare(`
        UPDATE news_candidate_observations
        SET status = 'pending_research',
            research_error = COALESCE(research_error, 'Recovered stale queued/researching candidate after worker restart.'),
            updated_at = CURRENT_TIMESTAMP
        WHERE status IN ('research_queued', 'researching')
          AND updated_at < ?
      `).run(input.candidateCutoffIso) as { changes?: number }

      return {
        candidatesRecovered: numberValue(candidateResult.changes),
      }
    } catch (error) {
      throw new Error(`news stale work recovery failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  async insertResearchResult(input: NewsResearchResultInput): Promise<NewsResearchResultRow> {
    try {
      this.db.exec('BEGIN')
      try {
        this.db.prepare(`
          INSERT OR IGNORE INTO news_research_results (
            id,
            candidate_observation_id,
            source_id,
            source_name,
            url_id,
            url_label,
            source_url,
            canonical_article_url,
            article_identity_key,
            observation_dedupe_key,
            research_job_id,
            status,
            response_status,
            source_signal,
            research_summary,
            article_claims,
            verified_facts,
            unresolved_claims,
            entity_hints,
            evidence,
            open_questions,
            limitations,
            errors,
            raw_response,
            researched_at
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          randomUUID(),
          input.candidate.id,
          input.candidate.sourceId,
          input.candidate.sourceName,
          input.candidate.urlId,
          input.candidate.urlLabel,
          input.candidate.sourceUrl,
          input.candidate.canonicalArticleUrl,
          input.candidate.articleIdentityKey,
          input.candidate.observationDedupeKey,
          input.response.job_id,
          input.status ?? initialNewsResearchResultStatus(input.response.status),
          input.response.status,
          json(input.response.source_signal),
          json(input.response.research_summary),
          json(input.response.article_claims),
          json(input.response.verified_facts),
          json(input.response.unresolved_claims),
          json(input.response.entity_hints),
          json(input.response.evidence),
          json(input.response.open_questions),
          json(input.response.limitations),
          json(input.response.errors),
          json(input.response),
          input.researchedAt
        )

        this.db.prepare(`
          UPDATE news_candidate_observations
          SET status = 'researched',
              updated_at = CURRENT_TIMESTAMP
          WHERE id = ?
        `).run(input.candidate.id)
        this.db.exec('COMMIT')
      } catch (error) {
        this.db.exec('ROLLBACK')
        throw error
      }

      const row = this.db.prepare(`
        SELECT *
        FROM news_research_results
        WHERE candidate_observation_id = ?
           OR research_job_id = ?
        ORDER BY created_at ASC
        LIMIT 1
      `).get(input.candidate.id, input.response.job_id) as Record<string, unknown> | undefined
      if (!row) throw new Error('research result lookup failed after insert')
      return mapResearchResultRow(row)
    } catch (error) {
      throw new Error(`news_research_results insert failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  async fetchResearchResult(id: string): Promise<NewsResearchResultRow | null> {
    try {
      const row = this.db.prepare('SELECT * FROM news_research_results WHERE id = ?')
        .get(id) as Record<string, unknown> | undefined
      return row ? mapResearchResultRow(row) : null
    } catch (error) {
      throw new Error(`news_research_results fetch failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  async fetchPendingResearchResults(limit: number): Promise<PendingNewsResearchResult[]> {
    try {
      this.db.prepare(`
        UPDATE news_research_results
        SET status = 'not_ready_for_entity_memory',
            updated_at = CURRENT_TIMESTAMP
        WHERE status = 'pending_entity_memory'
          AND response_status != 'ready_for_entity_memory'
      `).run()

      const rows = this.db.prepare(`
        SELECT id, candidate_observation_id
        FROM news_research_results
        WHERE status = 'pending_entity_memory'
          AND response_status = 'ready_for_entity_memory'
        ORDER BY researched_at ASC, created_at ASC
        LIMIT ?
      `).all(Math.max(0, limit)) as Array<Record<string, unknown>>

      return rows.flatMap((row) => {
        const result = this.researchResultById(String(row.id))
        const candidate = this.candidateRowById(String(row.candidate_observation_id))
        return result && candidate ? [{ result, candidate }] : []
      })
    } catch (error) {
      throw new Error(`news_research_results pending fetch failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  async markResearchResultStatus(id: string, status: NewsResearchResultStatus): Promise<void> {
    try {
      this.db.exec('BEGIN')
      this.db.prepare(`
        UPDATE news_research_results
        SET status = ?,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(status, id)
      if (status === 'handed_to_entity_memory') {
        this.db.prepare(`
          UPDATE news_candidate_observations
          SET status = 'handed_to_entity_memory',
              updated_at = CURRENT_TIMESTAMP
          WHERE id = (
            SELECT candidate_observation_id
            FROM news_research_results
            WHERE id = ?
          )
        `).run(id)
      }
      this.db.exec('COMMIT')
    } catch (error) {
      try {
        this.db.exec('ROLLBACK')
      } catch {
        // Ignore rollback errors so the original failure is preserved.
      }
      throw new Error(`news_research_results status update failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  private candidateRowsByDedupeKeys(keys: string[]): NewsCandidateObservationRow[] {
    const uniqueKeys = [...new Set(keys)]
    if (uniqueKeys.length === 0) return []
    const placeholders = uniqueKeys.map(() => '?').join(', ')
    const rows = this.db.prepare(`
      SELECT *
      FROM news_candidate_observations
      WHERE observation_dedupe_key IN (${placeholders})
      ORDER BY observed_at DESC, created_at DESC
    `).all(...uniqueKeys) as Array<Record<string, unknown>>
    return rows.map(mapCandidateObservationRow)
  }

  private candidateRowById(id: string): NewsCandidateObservationRow | null {
    const row = this.db.prepare('SELECT * FROM news_candidate_observations WHERE id = ?')
      .get(id) as Record<string, unknown> | undefined
    return row ? mapCandidateObservationRow(row) : null
  }

  private researchResultById(id: string): NewsResearchResultRow | null {
    const row = this.db.prepare('SELECT * FROM news_research_results WHERE id = ?')
      .get(id) as Record<string, unknown> | undefined
    return row ? mapResearchResultRow(row) : null
  }
}

function isPersistedOutcome(value: string): value is PersistedNewsDedupeOutcome {
  return value === 'new_candidate' || value === 'known_materially_changed'
}

function mapCandidateObservationRow(row: Record<string, unknown>): NewsCandidateObservationRow {
  return {
    id: String(row.id),
    sourceRunId: stringOrNull(row.source_run_id),
    sourceId: String(row.source_id),
    sourceName: String(row.source_name),
    urlId: String(row.url_id),
    urlLabel: String(row.url_label),
    sourceUrl: String(row.source_url),
    canonicalArticleUrl: String(row.canonical_article_url),
    headline: String(row.headline),
    visibleSummary: stringOrNull(row.visible_summary),
    publishedAt: stringOrNull(row.published_at),
    observedAt: String(row.observed_at),
    headlineHash: String(row.headline_hash),
    summaryHash: stringOrNull(row.summary_hash),
    contentHash: String(row.content_hash),
    articleIdentityKey: String(row.article_identity_key),
    observationDedupeKey: String(row.observation_dedupe_key),
    dedupeOutcome: String(row.dedupe_outcome) as PersistedNewsDedupeOutcome,
    status: String(row.status) as NewsCandidateObservationRow['status'],
    lastResearchJobId: stringOrNull(row.last_research_job_id),
    researchWorkerStatus: stringOrNull(row.research_worker_status),
    researchError: stringOrNull(row.research_error),
    researchRawResponse: stringOrNull(row.research_raw_response),
    researchStderr: stringOrNull(row.research_stderr),
    rawCandidate: parseJson(row.raw_candidate) as NewsCandidateObservationRow['rawCandidate'],
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  }
}

function mapResearchResultRow(row: Record<string, unknown>): NewsResearchResultRow {
  return {
    id: String(row.id),
    candidateObservationId: String(row.candidate_observation_id),
    sourceId: String(row.source_id),
    sourceName: String(row.source_name),
    urlId: String(row.url_id),
    urlLabel: String(row.url_label),
    sourceUrl: String(row.source_url),
    canonicalArticleUrl: String(row.canonical_article_url),
    articleIdentityKey: String(row.article_identity_key),
    observationDedupeKey: String(row.observation_dedupe_key),
    researchJobId: String(row.research_job_id),
    status: String(row.status) as NewsResearchResultRow['status'],
    responseStatus: String(row.response_status) as NewsResearchResultRow['responseStatus'],
    sourceSignal: parseJson(row.source_signal) as NewsResearchResultRow['sourceSignal'],
    researchSummary: parseJson(row.research_summary) as NewsResearchResultRow['researchSummary'],
    articleClaims: parseJson(row.article_claims) as NewsResearchResultRow['articleClaims'],
    verifiedFacts: parseJson(row.verified_facts) as NewsResearchResultRow['verifiedFacts'],
    unresolvedClaims: parseJson(row.unresolved_claims) as NewsResearchResultRow['unresolvedClaims'],
    entityHints: parseJson(row.entity_hints) as NewsResearchResultRow['entityHints'],
    evidence: parseJson(row.evidence) as NewsResearchResultRow['evidence'],
    openQuestions: parseJson(row.open_questions) as NewsResearchResultRow['openQuestions'],
    limitations: parseJson(row.limitations) as NewsResearchResultRow['limitations'],
    errors: parseJson(row.errors) as NewsResearchResultRow['errors'],
    rawResponse: parseJson(row.raw_response) as NewsResearchResultRow['rawResponse'],
    researchedAt: String(row.researched_at),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  }
}

export const __newsSqliteTesting = {
  ensureNewsSqliteSchema,
  openNewsSqlite,
  sqlitePath,
}
