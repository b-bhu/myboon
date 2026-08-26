import { mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import {
  validateShadowResearchResult,
  type ShadowResearchResult,
  type ShadowResearchResultStore,
} from '../research-engine/shadow-evaluator'
import { canonicalJson } from './canonical-json'

interface SqliteRunResult { changes: number | bigint }
interface SqliteStatement {
  all(...params: unknown[]): unknown[]
  get(...params: unknown[]): unknown
  run(...params: unknown[]): SqliteRunResult
}
interface SqliteDatabase {
  close(): void
  exec(sql: string): void
  prepare(sql: string): SqliteStatement
}

const nodeRequire = createRequire(__filename)
const { DatabaseSync } = nodeRequire('node:sqlite') as {
  DatabaseSync: new (path: string) => SqliteDatabase
}

export class ShadowResearchResultConflictError extends Error {
  constructor(readonly evaluationId: string) {
    super(`Shadow research result ${evaluationId} already exists with a different immutable payload`)
    this.name = 'ShadowResearchResultConflictError'
  }
}

export class SqliteResearchShadowStore implements ShadowResearchResultStore {
  private readonly db: SqliteDatabase
  private closed = false

  constructor(path: string) {
    const resolved = resolve(path)
    mkdirSync(dirname(resolved), { recursive: true })
    this.db = new DatabaseSync(resolved)
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS signal_platform_research_shadow_results (
        evaluation_id TEXT PRIMARY KEY,
        work_id TEXT NOT NULL,
        signal_id TEXT NOT NULL,
        source_type TEXT NOT NULL,
        research_depth TEXT NOT NULL,
        status TEXT NOT NULL,
        failure_category TEXT,
        started_at TEXT NOT NULL,
        finished_at TEXT NOT NULL,
        canonical_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_research_shadow_work
        ON signal_platform_research_shadow_results(work_id, evaluation_id);
      CREATE INDEX IF NOT EXISTS idx_research_shadow_status
        ON signal_platform_research_shadow_results(status, finished_at, evaluation_id);
    `)
  }

  get(evaluationId: string): ShadowResearchResult | null {
    this.assertOpen()
    const row = this.db.prepare(`
      SELECT canonical_json FROM signal_platform_research_shadow_results
      WHERE evaluation_id = ?
    `).get(evaluationId) as { canonical_json?: unknown } | undefined
    return row === undefined ? null : parseResult(row.canonical_json)
  }

  append(result: ShadowResearchResult): { inserted: boolean, value: ShadowResearchResult } {
    this.assertOpen()
    const validated = validateShadowResearchResult(structuredClone(result))
    const encoded = canonicalJson(validated)
    const inserted = this.db.prepare(`
      INSERT OR IGNORE INTO signal_platform_research_shadow_results (
        evaluation_id, work_id, signal_id, source_type, research_depth,
        status, failure_category, started_at, finished_at, canonical_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      validated.evaluationId,
      validated.workId,
      validated.signalId,
      validated.sourceType,
      validated.researchDepth,
      validated.status,
      validated.failureCategory,
      validated.startedAt,
      validated.finishedAt,
      encoded,
      validated.finishedAt,
    )
    if (Number(inserted.changes) > 0) return { inserted: true, value: validated }
    const existing = this.get(validated.evaluationId)
    if (existing === null || canonicalJson(existing) !== encoded) {
      throw new ShadowResearchResultConflictError(validated.evaluationId)
    }
    return { inserted: false, value: existing }
  }

  listByWork(workId: string, limit = 100): ShadowResearchResult[] {
    this.assertOpen()
    if (!Number.isInteger(limit) || limit < 1 || limit > 1_000) throw new Error('limit must be between 1 and 1000')
    const rows = this.db.prepare(`
      SELECT canonical_json FROM signal_platform_research_shadow_results
      WHERE work_id = ? ORDER BY evaluation_id LIMIT ?
    `).all(workId, limit) as Array<{ canonical_json: unknown }>
    return rows.map((row) => parseResult(row.canonical_json))
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.db.close()
  }

  private assertOpen(): void {
    if (this.closed) throw new Error('Shadow research store is closed')
  }
}

function parseResult(value: unknown): ShadowResearchResult {
  if (typeof value !== 'string') throw new Error('Stored shadow result is invalid')
  return validateShadowResearchResult(JSON.parse(value) as ShadowResearchResult)
}
