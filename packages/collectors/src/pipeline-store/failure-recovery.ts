import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import {
  backupNewsStore,
  backupPipelineStore,
  verifyNewsBackup,
  verifyPipelineBackup,
  type PipelineBackupResult,
} from './backup'

const nodeRequire = createRequire(__filename)
const { DatabaseSync } = nodeRequire('node:sqlite') as {
  DatabaseSync: new (path: string, options?: { readOnly?: boolean; open?: boolean }) => SqliteDatabase
}

interface SqliteStatement {
  all(...params: unknown[]): unknown[]
  get(...params: unknown[]): unknown
  run(...params: unknown[]): { changes?: number | bigint }
}

interface SqliteDatabase {
  close(): void
  exec(sql: string): void
  prepare(sql: string): SqliteStatement
}

const COLLECTORS_PACKAGE_DIR = resolve(__dirname, '..', '..')
export const DEFAULT_PIPELINE_SQLITE_PATH = resolve(COLLECTORS_PACKAGE_DIR, '.data', 'pipeline.sqlite')
export const DEFAULT_NEWS_SQLITE_PATH = resolve(COLLECTORS_PACKAGE_DIR, '.data', 'news.sqlite')
export const DEFAULT_RECOVERY_LIMIT = 100
export const MAX_RECOVERY_LIMIT = 500

export type FailureRecoveryStage = 'research' | 'entity-manager'
export type FailureRecoverySource = 'news' | 'polymarket'
export type FailureRecoveryAction = 'requeue' | 'dead-letter'
export type FailureCategory =
  | 'authentication'
  | 'rate_limit'
  | 'timeout'
  | 'connection'
  | 'provider'
  | 'malformed_output'
  | 'source_data'
  | 'unknown'
  | 'other'
export type FailureCategoryFilter = FailureCategory | 'provider_outage'

export interface FailureRecoveryOptions {
  stage: FailureRecoveryStage
  source: FailureRecoverySource
  since?: string
  until?: string
  failureCategory?: FailureCategoryFilter
  candidateId?: string
  limit?: number
  apply?: boolean
  action?: FailureRecoveryAction
  pipelineSqlitePath?: string
  newsSqlitePath?: string
  backupDir?: string
  now?: string
  /** Test seam. Production callers must leave this unset. */
  backupBeforeWrite?: (input: RecoveryBackupInput) => Promise<RecoveryBackupAudit | null>
}

export interface FailureRecoveryAuditRow {
  source: FailureRecoverySource
  stage: FailureRecoveryStage
  rowId: string
  candidateId: string
  identityKey: string
  failureAt: string
  failureCategory: FailureCategory
  previousStatus: string
  nextStatus: string
  error: string | null
  existingResultId: string | null
  outcome:
    | 'would_requeue'
    | 'would_dead_letter'
    | 'would_reconcile_existing_result'
    | 'requeued'
    | 'dead_lettered'
    | 'reconciled_existing_result'
    | 'skipped'
  reason: string | null
}

export interface DeadLetterCount {
  source: FailureRecoverySource
  stage: FailureRecoveryStage
  count: number
  oldestFailureAt: string | null
}

export interface RecoveryBackupAudit {
  pipeline: { backup: PipelineBackupResult; verified: boolean }
  news: { backup: PipelineBackupResult; verified: boolean }
}

export interface RecoveryBackupInput {
  pipelineSqlitePath: string
  newsSqlitePath: string
  backupDir?: string
  now: string
}

export interface FailureRecoveryReport {
  mode: 'dry-run' | 'apply'
  action: FailureRecoveryAction
  filters: {
    source: FailureRecoverySource
    stage: FailureRecoveryStage
    since: string | null
    until: string | null
    failureCategory: FailureCategoryFilter | null
    candidateId: string | null
    limit: number
  }
  matched: number
  touched: number
  skipped: number
  truncated: boolean
  backup: RecoveryBackupAudit | null
  audit: FailureRecoveryAuditRow[]
  deadLetters: DeadLetterCount
}

interface RawRecoveryRow {
  rowId: string
  candidateId: string
  identityKey: string
  failureAt: string
  previousStatus: string
  error: string | null
  storedCategory: string | null
  existingResultId: string | null
}

function numberValue(value: unknown): number {
  return typeof value === 'bigint' ? Number(value) : Number(value ?? 0)
}

function stringOrNull(value: unknown): string | null {
  return value == null ? null : String(value)
}

function auditError(value: string | null): string | null {
  if (value === null) return null
  return value.length <= 500 ? value : `${value.slice(0, 497)}...`
}

function validateLimit(value: number | undefined): number {
  const limit = value ?? DEFAULT_RECOVERY_LIMIT
  if (!Number.isInteger(limit) || limit <= 0 || limit > MAX_RECOVERY_LIMIT) {
    throw new Error(`--limit must be an integer between 1 and ${MAX_RECOVERY_LIMIT}`)
  }
  return limit
}

function normalizeDate(value: string | undefined, name: '--since' | '--until'): string | undefined {
  if (!value) return undefined
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) throw new Error(`${name} must be a valid timestamp`)
  return date.toISOString()
}

export function classifyFailure(error: string | null, storedCategory?: string | null): FailureCategory {
  const text = `${storedCategory ?? ''} ${error ?? ''}`.toLowerCase()
  if (!text.trim()) return 'unknown'
  if (/no usable credentials|api[_ -]?key|unauthorized|authentication|\b401\b|\b403\b/.test(text)) {
    return 'authentication'
  }
  if (/\b429\b|rate.?limit|quota|credit|capacity exhausted|too many requests/.test(text)) return 'rate_limit'
  if (/timed?[ _-]?out|timeout|sigterm|sigkill/.test(text)) return 'timeout'
  if (/econn|enotfound|eai_again|connection|socket|network|fetch failed/.test(text)) return 'connection'
  if (/did not contain a json object|invalid json|schema_version|malformed|structured output|parse/.test(text)) {
    return 'malformed_output'
  }
  if (/no polymarket market found|source (?:item|data).*unavailable|not found for slug/.test(text)) return 'source_data'
  if (/provider circuit open|provider unavailable|ollama|openrouter|backend_unavailable/.test(text)) return 'provider'
  return 'other'
}

function categoryMatches(category: FailureCategory, filter?: FailureCategoryFilter): boolean {
  if (!filter) return true
  if (filter === 'provider_outage') {
    return ['authentication', 'rate_limit', 'timeout', 'connection', 'provider'].includes(category)
  }
  return category === filter
}

function tableHasColumn(db: SqliteDatabase, table: string, column: string): boolean {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<Record<string, unknown>>
  return rows.some((row) => String(row.name) === column)
}

function addColumnIfMissing(db: SqliteDatabase, table: string, column: string, definition: string): void {
  if (!tableHasColumn(db, table, column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`)
}

export function ensureFailureDispositionColumns(
  db: SqliteDatabase,
  source: FailureRecoverySource
): void {
  if (source === 'news') {
    addColumnIfMissing(
      db,
      'news_candidate_observations',
      'research_failure_status',
      "TEXT CHECK (research_failure_status IS NULL OR research_failure_status IN ('failed', 'dead_letter'))"
    )
    addColumnIfMissing(db, 'news_research_results', 'entity_manager_error', 'TEXT')
    addColumnIfMissing(db, 'news_research_results', 'entity_manager_error_category', 'TEXT')
    addColumnIfMissing(
      db,
      'news_research_results',
      'entity_manager_failure_status',
      "TEXT CHECK (entity_manager_failure_status IS NULL OR entity_manager_failure_status IN ('failed', 'dead_letter'))"
    )
    return
  }

  addColumnIfMissing(
    db,
    'pipeline_candidates',
    'research_failure_status',
    "TEXT CHECK (research_failure_status IS NULL OR research_failure_status IN ('failed', 'dead_letter'))"
  )
  addColumnIfMissing(
    db,
    'pipeline_research',
    'entity_manager_failure_status',
    "TEXT CHECK (entity_manager_failure_status IS NULL OR entity_manager_failure_status IN ('failed', 'dead_letter'))"
  )
}

function recoveryQuery(
  db: SqliteDatabase,
  input: {
    source: FailureRecoverySource
    stage: FailureRecoveryStage
    since?: string
    until?: string
    candidateId?: string
    limit: number
  }
): RawRecoveryRow[] {
  const params: unknown[] = []
  const filters: string[] = []
  if (input.since) {
    filters.push('julianday(failure_at) >= julianday(?)')
    params.push(input.since)
  }
  if (input.until) {
    filters.push('julianday(failure_at) <= julianday(?)')
    params.push(input.until)
  }
  if (input.candidateId) {
    filters.push('candidate_id = ?')
    params.push(input.candidateId)
  }
  params.push(input.limit + 1)
  const where = filters.length > 0 ? `WHERE ${filters.join(' AND ')}` : ''

  let sql: string
  if (input.source === 'news' && input.stage === 'research') {
    const disposition = tableHasColumn(db, 'news_candidate_observations', 'research_failure_status')
      ? 'c.research_failure_status'
      : 'NULL'
    sql = `
      SELECT * FROM (
        SELECT c.id AS row_id, c.id AS candidate_id, c.observation_dedupe_key AS identity_key,
          c.updated_at AS failure_at, c.status AS previous_status,
          c.research_error || CASE WHEN c.research_stderr IS NULL THEN '' ELSE '\n' || c.research_stderr END AS error,
          c.research_worker_status AS stored_category, r.id AS existing_result_id
        FROM news_candidate_observations c
        LEFT JOIN news_research_results r ON r.candidate_observation_id = c.id
        WHERE c.status = 'failed_research' AND COALESCE(${disposition}, 'failed') = 'failed'
      ) failures ${where}
      ORDER BY julianday(failure_at) ASC, row_id ASC LIMIT ?
    `
  } else if (input.source === 'news') {
    const disposition = tableHasColumn(db, 'news_research_results', 'entity_manager_failure_status')
      ? 'r.entity_manager_failure_status'
      : 'NULL'
    const error = tableHasColumn(db, 'news_research_results', 'entity_manager_error')
      ? 'r.entity_manager_error'
      : 'NULL'
    const category = tableHasColumn(db, 'news_research_results', 'entity_manager_error_category')
      ? 'r.entity_manager_error_category'
      : 'NULL'
    sql = `
      SELECT * FROM (
        SELECT r.id AS row_id, r.candidate_observation_id AS candidate_id,
          r.observation_dedupe_key AS identity_key, r.updated_at AS failure_at,
          r.status AS previous_status, ${error} AS error, ${category} AS stored_category,
          NULL AS existing_result_id
        FROM news_research_results r
        WHERE r.status = 'failed_entity_memory' AND COALESCE(${disposition}, 'failed') = 'failed'
      ) failures ${where}
      ORDER BY julianday(failure_at) ASC, row_id ASC LIMIT ?
    `
  } else if (input.stage === 'research') {
    const disposition = tableHasColumn(db, 'pipeline_candidates', 'research_failure_status')
      ? 'c.research_failure_status'
      : 'NULL'
    sql = `
      SELECT * FROM (
        SELECT c.id AS row_id, c.id AS candidate_id, c.dedupe_key AS identity_key,
          c.updated_at AS failure_at, c.status AS previous_status, c.research_error AS error,
          c.research_last_error_kind AS stored_category, r.id AS existing_result_id
        FROM pipeline_candidates c
        LEFT JOIN pipeline_research r ON r.candidate_id = c.id
        WHERE c.source = 'polymarket' AND c.status = 'research_failed'
          AND COALESCE(${disposition}, 'failed') = 'failed'
      ) failures ${where}
      ORDER BY julianday(failure_at) ASC, row_id ASC LIMIT ?
    `
  } else {
    const disposition = tableHasColumn(db, 'pipeline_research', 'entity_manager_failure_status')
      ? 'r.entity_manager_failure_status'
      : 'NULL'
    sql = `
      SELECT * FROM (
        SELECT r.id AS row_id, r.candidate_id AS candidate_id, c.dedupe_key AS identity_key,
          COALESCE(r.entity_manager_attempted_at, r.updated_at) AS failure_at,
          r.entity_manager_status AS previous_status, r.entity_manager_error AS error,
          NULL AS stored_category, NULL AS existing_result_id
        FROM pipeline_research r
        JOIN pipeline_candidates c ON c.id = r.candidate_id
        WHERE r.source = 'polymarket' AND r.entity_manager_status = 'failed'
          AND COALESCE(${disposition}, 'failed') = 'failed'
      ) failures ${where}
      ORDER BY julianday(failure_at) ASC, row_id ASC LIMIT ?
    `
  }

  return (db.prepare(sql).all(...params) as Array<Record<string, unknown>>).map((row) => ({
    rowId: String(row.row_id),
    candidateId: String(row.candidate_id),
    identityKey: String(row.identity_key),
    failureAt: String(row.failure_at),
    previousStatus: String(row.previous_status),
    error: stringOrNull(row.error),
    storedCategory: stringOrNull(row.stored_category),
    existingResultId: stringOrNull(row.existing_result_id),
  }))
}

function nextStatus(source: FailureRecoverySource, stage: FailureRecoveryStage, action: FailureRecoveryAction): string {
  if (action === 'dead-letter') return 'dead_letter'
  if (stage === 'research') return 'pending_research'
  return source === 'news' ? 'pending_entity_memory' : 'pending'
}

function applyRow(
  db: SqliteDatabase,
  source: FailureRecoverySource,
  stage: FailureRecoveryStage,
  action: FailureRecoveryAction,
  rowId: string
): number {
  if (action === 'dead-letter') {
    if (source === 'news' && stage === 'research') {
      return numberValue(db.prepare(`
        UPDATE news_candidate_observations SET research_failure_status = 'dead_letter', updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND status = 'failed_research' AND COALESCE(research_failure_status, 'failed') = 'failed'
      `).run(rowId).changes)
    }
    if (source === 'news') {
      return numberValue(db.prepare(`
        UPDATE news_research_results SET entity_manager_failure_status = 'dead_letter', updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND status = 'failed_entity_memory' AND COALESCE(entity_manager_failure_status, 'failed') = 'failed'
      `).run(rowId).changes)
    }
    if (stage === 'research') {
      return numberValue(db.prepare(`
        UPDATE pipeline_candidates SET research_failure_status = 'dead_letter', updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND status = 'research_failed' AND COALESCE(research_failure_status, 'failed') = 'failed'
      `).run(rowId).changes)
    }
    return numberValue(db.prepare(`
      UPDATE pipeline_research SET entity_manager_failure_status = 'dead_letter', updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND entity_manager_status = 'failed' AND COALESCE(entity_manager_failure_status, 'failed') = 'failed'
    `).run(rowId).changes)
  }

  if (source === 'news' && stage === 'research') {
    return numberValue(db.prepare(`
      UPDATE news_candidate_observations
      SET status = 'pending_research', last_research_job_id = NULL, research_worker_status = NULL,
        research_error = NULL, research_raw_response = NULL, research_stderr = NULL,
        research_failure_status = NULL, updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND status = 'failed_research' AND COALESCE(research_failure_status, 'failed') = 'failed'
    `).run(rowId).changes)
  }
  if (source === 'news') {
    return numberValue(db.prepare(`
      UPDATE news_research_results
      SET status = 'pending_entity_memory', entity_manager_error = NULL,
        entity_manager_error_category = NULL, entity_manager_failure_status = NULL,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND status = 'failed_entity_memory'
        AND response_status = 'ready_for_entity_memory'
        AND COALESCE(entity_manager_failure_status, 'failed') = 'failed'
    `).run(rowId).changes)
  }
  if (stage === 'research') {
    return numberValue(db.prepare(`
      UPDATE pipeline_candidates
      SET status = 'pending_research', research_error = NULL, research_attempted_at = NULL,
        research_retry_count = 0, research_next_retry_at = NULL, research_last_error_kind = NULL,
        research_failure_status = NULL, lease_owner = NULL, lease_expires_at = NULL,
        attempt_count = 0, updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND status = 'research_failed' AND COALESCE(research_failure_status, 'failed') = 'failed'
    `).run(rowId).changes)
  }
  return numberValue(db.prepare(`
    UPDATE pipeline_research
    SET entity_manager_status = 'pending', entity_manager_lease_owner = NULL,
      entity_manager_lease_expires_at = NULL, entity_manager_attempt_count = 0,
      entity_manager_attempted_at = NULL, entity_manager_next_retry_at = NULL,
      entity_manager_processed_at = NULL, entity_manager_error = NULL,
      entity_manager_failure_status = NULL, updated_at = CURRENT_TIMESTAMP
    WHERE id = ? AND entity_manager_status = 'failed'
      AND COALESCE(entity_manager_failure_status, 'failed') = 'failed'
  `).run(rowId).changes)
}

function reconcileExistingResearchResult(
  db: SqliteDatabase,
  source: FailureRecoverySource,
  rowId: string
): number {
  if (source === 'news') {
    return numberValue(db.prepare(`
      UPDATE news_candidate_observations
      SET status = 'researched', last_research_job_id = NULL, research_worker_status = NULL,
        research_error = NULL, research_raw_response = NULL, research_stderr = NULL,
        research_failure_status = NULL, updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND status = 'failed_research'
        AND EXISTS (SELECT 1 FROM news_research_results r WHERE r.candidate_observation_id = news_candidate_observations.id)
    `).run(rowId).changes)
  }
  return numberValue(db.prepare(`
    UPDATE pipeline_candidates
    SET status = 'researched', research_error = NULL, research_attempted_at = NULL,
      research_retry_count = 0, research_next_retry_at = NULL, research_last_error_kind = NULL,
      research_failure_status = NULL, lease_owner = NULL, lease_expires_at = NULL,
      attempt_count = 0, updated_at = CURRENT_TIMESTAMP
    WHERE id = ? AND status = 'research_failed'
      AND EXISTS (SELECT 1 FROM pipeline_research r WHERE r.candidate_id = pipeline_candidates.id)
  `).run(rowId).changes)
}

function deadLetterCount(db: SqliteDatabase, source: FailureRecoverySource, stage: FailureRecoveryStage): DeadLetterCount {
  let table: string
  let disposition: string
  let failureAt: string
  if (source === 'news' && stage === 'research') {
    table = 'news_candidate_observations'
    disposition = 'research_failure_status'
    failureAt = 'observed_at'
  } else if (source === 'news') {
    table = 'news_research_results'
    disposition = 'entity_manager_failure_status'
    failureAt = 'researched_at'
  } else if (stage === 'research') {
    table = 'pipeline_candidates'
    disposition = 'research_failure_status'
    failureAt = 'observed_at'
  } else {
    table = 'pipeline_research'
    disposition = 'entity_manager_failure_status'
    failureAt = 'researched_at'
  }
  if (!tableHasColumn(db, table, disposition)) return { source, stage, count: 0, oldestFailureAt: null }
  const row = db.prepare(`
    SELECT COUNT(*) AS n, MIN(${failureAt}) AS oldest FROM ${table} WHERE ${disposition} = 'dead_letter'
  `).get() as Record<string, unknown>
  return { source, stage, count: numberValue(row.n), oldestFailureAt: stringOrNull(row.oldest) }
}

export async function backupRecoveryStores(input: RecoveryBackupInput): Promise<RecoveryBackupAudit> {
  const pipelineBackup = await backupPipelineStore({
    sourcePath: input.pipelineSqlitePath,
    backupDir: input.backupDir,
    now: input.now,
  })
  const newsBackup = await backupNewsStore({
    sourcePath: input.newsSqlitePath,
    backupDir: input.backupDir,
    now: input.now,
  })
  const pipelineVerification = await verifyPipelineBackup(pipelineBackup.path, pipelineBackup.sourceTableCounts)
  const newsVerification = await verifyNewsBackup(newsBackup.path, newsBackup.sourceTableCounts)
  if (!pipelineVerification.ok || !newsVerification.ok) {
    throw new Error(
      `Refusing recovery because backup verification failed: pipeline=${pipelineVerification.integrity}, news=${newsVerification.integrity}`
    )
  }
  return {
    pipeline: { backup: pipelineBackup, verified: true },
    news: { backup: newsBackup, verified: true },
  }
}

export async function recoverFailedBacklog(options: FailureRecoveryOptions): Promise<FailureRecoveryReport> {
  const limit = validateLimit(options.limit)
  const since = normalizeDate(options.since, '--since')
  const until = normalizeDate(options.until, '--until')
  if (since && until && new Date(since) > new Date(until)) throw new Error('--since must be before --until')
  if (options.apply && !since && !options.candidateId) {
    throw new Error('Refusing unbounded write: --apply requires --since or --candidate-id')
  }

  const action = options.action ?? 'requeue'
  const pipelineSqlitePath = resolve(options.pipelineSqlitePath ?? DEFAULT_PIPELINE_SQLITE_PATH)
  const newsSqlitePath = resolve(options.newsSqlitePath ?? DEFAULT_NEWS_SQLITE_PATH)
  const storePath = options.source === 'news' ? newsSqlitePath : pipelineSqlitePath
  const db = options.apply
    ? new DatabaseSync(storePath)
    : new DatabaseSync(storePath, { readOnly: true, open: true })
  let backup: RecoveryBackupAudit | null = null
  try {
    const rawRows = recoveryQuery(db, {
      source: options.source,
      stage: options.stage,
      since,
      until,
      candidateId: options.candidateId,
      limit: options.failureCategory ? MAX_RECOVERY_LIMIT : limit,
    })
    const categorizedRows = rawRows
      .map((row) => ({ row, category: classifyFailure(row.error, row.storedCategory) }))
      .filter(({ category }) => categoryMatches(category, options.failureCategory))
    const truncated = rawRows.length > (options.failureCategory ? MAX_RECOVERY_LIMIT : limit)
      || categorizedRows.length > limit
    const rows = categorizedRows.slice(0, limit)
    const audit = rows.map(({ row, category }): FailureRecoveryAuditRow => {
      const duplicate = action === 'requeue' && options.stage === 'research' && row.existingResultId !== null
      const reason = duplicate
        ? `research result ${row.existingResultId} already exists; reconcile candidate status without an LLM replay`
        : null
      return {
        source: options.source,
        stage: options.stage,
        rowId: row.rowId,
        candidateId: row.candidateId,
        identityKey: row.identityKey,
        failureAt: row.failureAt,
        failureCategory: category,
        previousStatus: row.previousStatus,
        nextStatus: duplicate ? 'researched' : nextStatus(options.source, options.stage, action),
        error: auditError(row.error),
        existingResultId: row.existingResultId,
        outcome: duplicate
          ? options.apply ? 'reconciled_existing_result' : 'would_reconcile_existing_result'
          : options.apply
            ? action === 'requeue' ? 'requeued' : 'dead_lettered'
            : action === 'requeue' ? 'would_requeue' : 'would_dead_letter',
        reason,
      }
    })

    const eligible = audit
    if (options.apply && eligible.length > 0) {
      backup = await (options.backupBeforeWrite ?? backupRecoveryStores)({
        pipelineSqlitePath,
        newsSqlitePath,
        backupDir: options.backupDir,
        now: options.now ?? new Date().toISOString(),
      })
      ensureFailureDispositionColumns(db, options.source)
      db.exec('BEGIN IMMEDIATE')
      try {
        for (const row of eligible) {
          const changed = row.existingResultId !== null && action === 'requeue' && options.stage === 'research'
            ? reconcileExistingResearchResult(db, options.source, row.rowId)
            : applyRow(db, options.source, options.stage, action, row.rowId)
          if (changed !== 1) {
            row.outcome = 'skipped'
            row.reason = 'row changed after preview; no update applied'
          }
        }
        db.exec('COMMIT')
      } catch (error) {
        db.exec('ROLLBACK')
        throw error
      }
    }

    const touched = audit.filter((row) =>
      row.outcome === 'requeued'
      || row.outcome === 'dead_lettered'
      || row.outcome === 'reconciled_existing_result'
    ).length
    return {
      mode: options.apply ? 'apply' : 'dry-run',
      action,
      filters: {
        source: options.source,
        stage: options.stage,
        since: since ?? null,
        until: until ?? null,
        failureCategory: options.failureCategory ?? null,
        candidateId: options.candidateId ?? null,
        limit,
      },
      matched: audit.length,
      touched,
      skipped: audit.filter((row) => row.outcome === 'skipped').length,
      truncated,
      backup,
      audit,
      deadLetters: deadLetterCount(db, options.source, options.stage),
    }
  } finally {
    db.close()
  }
}

export function readAllDeadLetterCounts(input?: {
  pipelineSqlitePath?: string
  newsSqlitePath?: string
}): DeadLetterCount[] {
  const results: DeadLetterCount[] = []
  for (const source of ['news', 'polymarket'] as const) {
    const path = source === 'news'
      ? resolve(input?.newsSqlitePath ?? DEFAULT_NEWS_SQLITE_PATH)
      : resolve(input?.pipelineSqlitePath ?? DEFAULT_PIPELINE_SQLITE_PATH)
    const db = new DatabaseSync(path, { readOnly: true, open: true })
    try {
      for (const stage of ['research', 'entity-manager'] as const) results.push(deadLetterCount(db, source, stage))
    } finally {
      db.close()
    }
  }
  return results
}
