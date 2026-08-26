import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import type { NewsCandidateObservationRow } from '../news/store'
import type { PipelineCandidateRow, PipelineStoreCandidateStatus } from '../pipeline-store/store'
import { adaptLegacyNewsSignal } from './adapters/news'
import { adaptLegacyPolymarketSignal } from './adapters/polymarket'
import type {
  LegacySignalBackfillCandidate,
  LegacySignalBackfillFilters,
  LegacySignalBackfillReadPort,
} from './operator-backfill'

interface SqliteStatement { all(...params: unknown[]): unknown[] }
interface SqliteDatabase { close(): void; exec(sql: string): void; prepare(sql: string): SqliteStatement }
const nodeRequire = createRequire(__filename)
const { DatabaseSync } = nodeRequire('node:sqlite') as {
  DatabaseSync: new (path: string, options: { readOnly: true; open: true }) => SqliteDatabase
}

abstract class SqliteLegacyBackfillReader implements LegacySignalBackfillReadPort {
  abstract readonly sourceType: LegacySignalBackfillCandidate['sourceType']
  protected readonly db: SqliteDatabase
  private closed = false

  constructor(path: string) {
    this.db = new DatabaseSync(resolve(path), { readOnly: true, open: true })
    this.db.exec('PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;')
  }

  abstract list(input: {
    filters: Omit<LegacySignalBackfillFilters, 'sourceType'>
    limit: number
  }): Promise<LegacySignalBackfillCandidate[]>

  close(): void {
    if (this.closed) return
    this.closed = true
    this.db.close()
  }

  protected assertOpen(): void {
    if (this.closed) throw new Error('SQLite legacy backfill reader is closed')
  }
}

export class SqliteNewsLegacyBackfillReader extends SqliteLegacyBackfillReader {
  readonly sourceType = 'news' as const

  async list(input: {
    filters: Omit<LegacySignalBackfillFilters, 'sourceType'>
    limit: number
  }): Promise<LegacySignalBackfillCandidate[]> {
    this.assertOpen()
    const { clauses, params } = queryFilters(input.filters)
    params.push(limit(input.limit))
    const rows = this.db.prepare(`
      SELECT * FROM news_candidate_observations
      WHERE ${clauses.join(' AND ')}
      ORDER BY observed_at ASC, id ASC LIMIT ?
    `).all(...params) as Array<Record<string, unknown>>
    return rows.map((raw) => {
      const legacy = newsRow(raw)
      return {
        sourceType: this.sourceType,
        legacyId: legacy.id,
        observedAt: legacy.observedAt,
        signal: adaptLegacyNewsSignal(legacy),
      }
    })
  }
}

export class SqlitePolymarketLegacyBackfillReader extends SqliteLegacyBackfillReader {
  readonly sourceType = 'polymarket' as const

  async list(input: {
    filters: Omit<LegacySignalBackfillFilters, 'sourceType'>
    limit: number
  }): Promise<LegacySignalBackfillCandidate[]> {
    this.assertOpen()
    const { clauses, params } = queryFilters(input.filters)
    params.push(limit(input.limit))
    const rows = this.db.prepare(`
      SELECT * FROM pipeline_candidates
      WHERE ${clauses.join(' AND ')}
      ORDER BY observed_at ASC, id ASC LIMIT ?
    `).all(...params) as Array<Record<string, unknown>>
    return rows.map((raw) => {
      const legacy = polymarketRow(raw)
      return {
        sourceType: this.sourceType,
        legacyId: legacy.id,
        observedAt: legacy.observedAt,
        signal: adaptLegacyPolymarketSignal(legacy),
      }
    })
  }
}

function queryFilters(filters: Omit<LegacySignalBackfillFilters, 'sourceType'>): {
  clauses: string[]; params: unknown[]
} {
  const clauses = ['1 = 1']
  const params: unknown[] = []
  if (filters.legacyId) { clauses.push('id = ?'); params.push(filters.legacyId) }
  if (filters.since) { clauses.push('observed_at >= ?'); params.push(filters.since) }
  if (filters.until) { clauses.push('observed_at < ?'); params.push(filters.until) }
  return { clauses, params }
}

function newsRow(row: Record<string, unknown>): NewsCandidateObservationRow {
  return {
    id: String(row.id), sourceRunId: nullable(row.source_run_id), sourceId: String(row.source_id),
    sourceName: String(row.source_name), urlId: String(row.url_id), urlLabel: String(row.url_label),
    sourceUrl: String(row.source_url), canonicalArticleUrl: String(row.canonical_article_url),
    headline: String(row.headline), visibleSummary: nullable(row.visible_summary),
    publishedAt: nullable(row.published_at), observedAt: String(row.observed_at),
    headlineHash: String(row.headline_hash), summaryHash: nullable(row.summary_hash),
    contentHash: String(row.content_hash), articleIdentityKey: String(row.article_identity_key),
    observationDedupeKey: String(row.observation_dedupe_key),
    dedupeOutcome: String(row.dedupe_outcome) as NewsCandidateObservationRow['dedupeOutcome'],
    status: String(row.status) as NewsCandidateObservationRow['status'],
    lastResearchJobId: nullable(row.last_research_job_id),
    researchWorkerStatus: nullable(row.research_worker_status), researchError: nullable(row.research_error),
    researchRawResponse: nullable(row.research_raw_response), researchStderr: nullable(row.research_stderr),
    rawCandidate: json(row.raw_candidate) as NewsCandidateObservationRow['rawCandidate'],
    createdAt: String(row.created_at), updatedAt: String(row.updated_at),
  }
}

function polymarketRow(row: Record<string, unknown>): PipelineCandidateRow {
  return {
    id: String(row.id), source: String(row.source), area: String(row.area),
    candidateType: String(row.candidate_type), marketId: String(row.market_id), slug: String(row.slug),
    title: String(row.title), tagSlug: String(row.tag_slug), tagLabel: nullable(row.tag_label),
    observedAt: String(row.observed_at), whatChanged: String(row.what_changed), whyFlagged: String(row.why_flagged),
    score: number(row.score), scoreBreakdown: json(row.score_breakdown), metrics: json(row.metrics),
    evidenceRefs: json(row.evidence_refs), status: String(row.status) as PipelineStoreCandidateStatus,
    dedupeKey: String(row.dedupe_key), researchError: nullable(row.research_error),
    researchAttemptedAt: nullable(row.research_attempted_at), researchRetryCount: number(row.research_retry_count),
    researchNextRetryAt: nullable(row.research_next_retry_at), researchLastErrorKind: nullable(row.research_last_error_kind),
    researchFamilyKey: nullable(row.research_family_key), researchClusterKey: nullable(row.research_cluster_key),
    researchDepth: nullable(row.research_depth) as PipelineCandidateRow['researchDepth'],
    leaseOwner: nullable(row.lease_owner), leaseExpiresAt: nullable(row.lease_expires_at),
    attemptCount: number(row.attempt_count), createdAt: String(row.created_at), updatedAt: String(row.updated_at),
  }
}

function json(value: unknown): unknown {
  if (typeof value !== 'string') return value
  return JSON.parse(value)
}

function nullable(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value)
}

function number(value: unknown): number {
  return typeof value === 'bigint' ? Number(value) : Number(value ?? 0)
}

function limit(value: number): number {
  if (!Number.isInteger(value) || value < 1 || value > 501) throw new Error('Backfill reader limit must be 1-501')
  return value
}
