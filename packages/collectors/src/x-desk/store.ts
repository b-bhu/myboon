import { createHash } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import {
  ENTITY_MEMORY_CHANGES_START_CURSOR,
  entityMemoryChangesCursorAt,
  type EntityMemoryChangeV1,
  type EntityKnowledgeMemoryV1,
} from '../entity-manager/entity-knowledge-reader'
import type { XDeskDecision, XDeskStoredCandidate } from './types'

const nodeRequire = createRequire(__filename)
const { DatabaseSync } = nodeRequire('node:sqlite') as {
  DatabaseSync: new (path: string) => SqliteDatabase
}

const COLLECTORS_PACKAGE_DIR = resolve(__dirname, '..', '..')
const DEFAULT_DB_PATH = resolve(COLLECTORS_PACKAGE_DIR, '.data', 'x-desk.sqlite')
const CURSOR_KEY = 'entity_memory_cursor'
const INITIAL_CUTOFF_KEY = 'initial_cutoff'

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

function databasePath(path = DEFAULT_DB_PATH): string {
  if (path === ':memory:') return path
  return resolve(process.cwd(), path)
}

function candidateId(memoryId: string, updatedAt: string): string {
  return `x_${createHash('sha256').update(`${memoryId}\0${updatedAt}`, 'utf8').digest('hex').slice(0, 32)}`
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function parseMemory(value: unknown): EntityKnowledgeMemoryV1 {
  if (typeof value !== 'string') throw new Error('X desk candidate has no memory payload')
  return JSON.parse(value) as EntityKnowledgeMemoryV1
}

function mapCandidate(row: Record<string, unknown>): XDeskStoredCandidate {
  return {
    id: String(row.id),
    memoryId: String(row.memory_id),
    memoryUpdatedAt: String(row.memory_updated_at),
    changedAt: String(row.changed_at),
    entityId: String(row.entity_id),
    entitySlug: stringOrNull(row.entity_slug),
    entityName: stringOrNull(row.entity_name),
    status: String(row.status) as XDeskStoredCandidate['status'],
    postText: stringOrNull(row.post_text),
    rationale: stringOrNull(row.rationale),
    confidence: numberOrNull(row.confidence),
    attemptCount: Number(row.attempt_count),
    lastError: stringOrNull(row.last_error),
    memory: parseMemory(row.memory_json),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  }
}

export class XDeskStore {
  private readonly db: SqliteDatabase

  constructor(path?: string) {
    const resolved = databasePath(path)
    if (resolved !== ':memory:') mkdirSync(dirname(resolved), { recursive: true })
    this.db = new DatabaseSync(resolved)
    this.db.exec('PRAGMA journal_mode = WAL;')
    this.db.exec('PRAGMA busy_timeout = 5000;')
    this.ensureSchema()
  }

  close(): void {
    this.db.close()
  }

  private ensureSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS x_desk_state (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS x_post_candidates (
        id TEXT PRIMARY KEY,
        memory_id TEXT NOT NULL,
        memory_updated_at TEXT NOT NULL,
        changed_at TEXT NOT NULL,
        entity_id TEXT NOT NULL,
        entity_slug TEXT,
        entity_name TEXT,
        source_type TEXT NOT NULL CHECK (source_type = 'news'),
        memory_json TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('pending', 'retry_wait', 'ready', 'skipped', 'failed')),
        post_text TEXT,
        rationale TEXT,
        confidence REAL CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
        attempt_count INTEGER NOT NULL DEFAULT 0,
        next_attempt_at TEXT,
        last_error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (memory_id, memory_updated_at)
      );

      CREATE TABLE IF NOT EXISTS x_post_notifications (
        candidate_id TEXT PRIMARY KEY,
        target TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('pending', 'retry_wait', 'sent', 'failed')),
        attempt_count INTEGER NOT NULL DEFAULT 0,
        next_attempt_at TEXT,
        last_error TEXT,
        delivered_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (candidate_id) REFERENCES x_post_candidates(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS x_post_candidates_work_idx
        ON x_post_candidates (status, next_attempt_at, changed_at DESC);
      CREATE INDEX IF NOT EXISTS x_post_candidates_review_idx
        ON x_post_candidates (status, created_at DESC);
      CREATE INDEX IF NOT EXISTS x_post_notifications_work_idx
        ON x_post_notifications (status, next_attempt_at, created_at);
    `)
  }

  private state(key: string): string | null {
    const row = this.db.prepare('SELECT value FROM x_desk_state WHERE key = ?').get(key) as Record<string, unknown> | undefined
    return row ? String(row.value) : null
  }

  private setState(key: string, value: string, observedAt: string): void {
    this.db.prepare(`
      INSERT INTO x_desk_state (key, value, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `).run(key, value, observedAt)
  }

  cursor(): string {
    return this.state(CURSOR_KEY) ?? ENTITY_MEMORY_CHANGES_START_CURSOR
  }

  initialCutoff(proposed: string, observedAt: string): string {
    const existing = this.state(INITIAL_CUTOFF_KEY)
    if (existing) return existing
    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.setState(INITIAL_CUTOFF_KEY, proposed, observedAt)
      if (!this.state(CURSOR_KEY)) {
        this.setState(CURSOR_KEY, entityMemoryChangesCursorAt(proposed), observedAt)
      }
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
    return proposed
  }

  enqueuePage(changes: EntityMemoryChangeV1[], nextCursor: string, observedAt: string): number {
    let inserted = 0
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const statement = this.db.prepare(`
        INSERT OR IGNORE INTO x_post_candidates (
          id, memory_id, memory_updated_at, changed_at, entity_id,
          source_type, memory_json, status, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, 'news', ?, 'pending', ?, ?)
      `)
      for (const change of changes) {
        const result = statement.run(
          candidateId(change.memory.id, change.memory.updatedAt),
          change.memory.id,
          change.memory.updatedAt,
          change.changedAt,
          change.memory.entityId,
          JSON.stringify(change.memory),
          observedAt,
          observedAt,
        ) as { changes?: number }
        inserted += Number(result.changes ?? 0)
      }
      this.setState(CURSOR_KEY, nextCursor, observedAt)
      this.db.exec('COMMIT')
      return inserted
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  fetchWork(limit: number, now: string, maxAttempts: number): XDeskStoredCandidate[] {
    const rows = this.db.prepare(`
      SELECT * FROM x_post_candidates
      WHERE attempt_count < ?
        AND (status = 'pending' OR (status = 'retry_wait' AND next_attempt_at <= ?))
      ORDER BY changed_at DESC, id DESC
      LIMIT ?
    `).all(maxAttempts, now, limit) as Array<Record<string, unknown>>
    return rows.map(mapCandidate)
  }

  recentPostTexts(limit: number): string[] {
    const rows = this.db.prepare(`
      SELECT post_text FROM x_post_candidates
      WHERE status = 'ready' AND post_text IS NOT NULL
      ORDER BY updated_at DESC
      LIMIT ?
    `).all(limit) as Array<Record<string, unknown>>
    return rows.map((row) => String(row.post_text))
  }

  recordDecisions(
    decisions: XDeskDecision[],
    entities: Map<string, { slug: string, name: string }>,
    candidates: XDeskStoredCandidate[],
    observedAt: string,
  ): void {
    const candidateById = new Map(candidates.map((candidate) => [candidate.id, candidate]))
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const statement = this.db.prepare(`
        UPDATE x_post_candidates SET
          entity_slug = ?, entity_name = ?, status = ?, post_text = ?,
          rationale = ?, confidence = ?, attempt_count = attempt_count + 1,
          next_attempt_at = NULL, last_error = NULL, updated_at = ?
        WHERE id = ?
      `)
      for (const decision of decisions) {
        const candidate = candidateById.get(decision.candidateId)
        if (!candidate) throw new Error(`Unknown X desk decision candidate: ${decision.candidateId}`)
        const entity = entities.get(candidate.entityId)
        statement.run(
          entity?.slug ?? null,
          entity?.name ?? null,
          decision.action === 'recommend' ? 'ready' : 'skipped',
          decision.postText,
          decision.rationale,
          decision.confidence,
          observedAt,
          decision.candidateId,
        )
      }
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  recordFailure(candidateIds: string[], error: string, nextAttemptAt: string, maxAttempts: number, observedAt: string): void {
    const statement = this.db.prepare(`
      UPDATE x_post_candidates SET
        status = CASE WHEN attempt_count + 1 >= ? THEN 'failed' ELSE 'retry_wait' END,
        attempt_count = attempt_count + 1,
        next_attempt_at = CASE WHEN attempt_count + 1 >= ? THEN NULL ELSE ? END,
        last_error = ?, updated_at = ?
      WHERE id = ?
    `)
    this.db.exec('BEGIN IMMEDIATE')
    try {
      for (const id of candidateIds) statement.run(maxAttempts, maxAttempts, nextAttemptAt, error, observedAt, id)
      this.db.exec('COMMIT')
    } catch (failure) {
      this.db.exec('ROLLBACK')
      throw failure
    }
  }

  fetchNotificationWork(
    target: string,
    limit: number,
    now: string,
    maxAttempts: number,
  ): XDeskStoredCandidate[] {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      // A corrected destination should immediately recover unsent work. Sent
      // receipts remain immutable so a configuration change cannot replay an
      // already delivered recommendation.
      this.db.prepare(`
        UPDATE x_post_notifications SET
          target = ?, status = 'pending', attempt_count = 0,
          next_attempt_at = NULL, last_error = NULL, updated_at = ?
        WHERE target <> ? AND status <> 'sent'
      `).run(target, now, target)
      this.db.prepare(`
        INSERT OR IGNORE INTO x_post_notifications (
          candidate_id, target, status, created_at, updated_at
        )
        SELECT id, ?, 'pending', ?, ?
        FROM x_post_candidates
        WHERE status = 'ready'
      `).run(target, now, now)
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }

    const rows = this.db.prepare(`
      SELECT candidate.*
      FROM x_post_candidates AS candidate
      JOIN x_post_notifications AS notification
        ON notification.candidate_id = candidate.id
      WHERE notification.target = ?
        AND notification.attempt_count < ?
        AND (
          notification.status = 'pending'
          OR (notification.status = 'retry_wait' AND notification.next_attempt_at <= ?)
        )
      ORDER BY candidate.confidence DESC, candidate.changed_at DESC, candidate.id DESC
      LIMIT ?
    `).all(target, maxAttempts, now, limit) as Array<Record<string, unknown>>
    return rows.map(mapCandidate)
  }

  recordNotificationsSent(candidateIds: string[], target: string, observedAt: string): void {
    const statement = this.db.prepare(`
      UPDATE x_post_notifications SET
        status = 'sent', attempt_count = attempt_count + 1,
        next_attempt_at = NULL, last_error = NULL,
        delivered_at = ?, updated_at = ?
      WHERE candidate_id = ? AND target = ?
    `)
    this.db.exec('BEGIN IMMEDIATE')
    try {
      for (const id of candidateIds) statement.run(observedAt, observedAt, id, target)
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  recordNotificationFailure(
    candidateIds: string[],
    target: string,
    error: string,
    nextAttemptAt: string,
    maxAttempts: number,
    observedAt: string,
  ): void {
    const statement = this.db.prepare(`
      UPDATE x_post_notifications SET
        status = CASE WHEN attempt_count + 1 >= ? THEN 'failed' ELSE 'retry_wait' END,
        attempt_count = attempt_count + 1,
        next_attempt_at = CASE WHEN attempt_count + 1 >= ? THEN NULL ELSE ? END,
        last_error = ?, updated_at = ?
      WHERE candidate_id = ? AND target = ?
    `)
    this.db.exec('BEGIN IMMEDIATE')
    try {
      for (const id of candidateIds) {
        statement.run(maxAttempts, maxAttempts, nextAttemptAt, error, observedAt, id, target)
      }
      this.db.exec('COMMIT')
    } catch (failure) {
      this.db.exec('ROLLBACK')
      throw failure
    }
  }

  list(status: XDeskStoredCandidate['status'], limit: number): XDeskStoredCandidate[] {
    const rows = this.db.prepare(`
      SELECT * FROM x_post_candidates
      WHERE status = ?
      ORDER BY updated_at DESC
      LIMIT ?
    `).all(status, limit) as Array<Record<string, unknown>>
    return rows.map(mapCandidate)
  }

  listReadySince(since: string, limit: number): XDeskStoredCandidate[] {
    const rows = this.db.prepare(`
      SELECT * FROM x_post_candidates
      WHERE status = 'ready' AND changed_at >= ?
      ORDER BY changed_at DESC, updated_at DESC, id DESC
      LIMIT ?
    `).all(since, limit) as Array<Record<string, unknown>>
    return rows.map(mapCandidate)
  }
}

export const __xDeskStoreTesting = { candidateId }
