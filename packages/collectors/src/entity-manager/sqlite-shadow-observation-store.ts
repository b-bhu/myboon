import { createHash } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import type { ExecutionTraceEvent } from '../signal-platform/contracts'
import { canonicalJson } from '../signal-platform/canonical-json'
import { validateExecutionTraceEvent } from '../signal-platform/validation'
import type { ShadowEntityObservation, ShadowEntityObservationPort } from './shared-worker'

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

export const ENTITY_SHADOW_OBSERVATION_SCHEMA_VERSION = 'myboon.entity_shadow_observation.v1' as const
export const ENTITY_SHADOW_OBSERVATION_TABLE = 'entity_manager_shadow_observations' as const

export interface DurableEntityShadowObservation {
  schemaVersion: typeof ENTITY_SHADOW_OBSERVATION_SCHEMA_VERSION
  observationId: string
  sourceType: ShadowEntityObservation['sourceType']
  workId: string
  packetId: string | null
  outcome: ShadowEntityObservation['outcome']
  failure: {
    category: NonNullable<ShadowEntityObservation['error']>['category']
    detail: string
    retryable: boolean
    incrementsAttempt: boolean
    retryAfterMs: number | null
  } | null
  executionEvent: ExecutionTraceEvent | null
  observedAt: string
}

export class EntityShadowObservationConflictError extends Error {
  constructor(readonly observationId: string) {
    super(`Entity shadow observation ${observationId} already exists with a different immutable payload`)
    this.name = 'EntityShadowObservationConflictError'
  }
}

/** Separate append-only SQLite sink; it never mutates canonical work or Supabase. */
export class SqliteEntityShadowObservationStore implements ShadowEntityObservationPort {
  private readonly db: SqliteDatabase
  private closed = false

  constructor(path: string, private readonly now: () => Date = () => new Date()) {
    const resolved = resolve(path)
    mkdirSync(dirname(resolved), { recursive: true })
    this.db = new DatabaseSync(resolved)
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS ${ENTITY_SHADOW_OBSERVATION_TABLE} (
        observation_id TEXT PRIMARY KEY,
        schema_version TEXT NOT NULL,
        source_type TEXT NOT NULL,
        work_id TEXT NOT NULL,
        packet_id TEXT,
        outcome TEXT NOT NULL,
        failure_category TEXT,
        observed_at TEXT NOT NULL,
        canonical_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_entity_shadow_work
        ON ${ENTITY_SHADOW_OBSERVATION_TABLE}(work_id, observation_id);
      CREATE INDEX IF NOT EXISTS idx_entity_shadow_outcome
        ON ${ENTITY_SHADOW_OBSERVATION_TABLE}(source_type, outcome, observed_at, observation_id);
    `)
  }

  async observe(input: ShadowEntityObservation): Promise<void> {
    this.append(input)
  }

  append(input: ShadowEntityObservation): { inserted: boolean, value: DurableEntityShadowObservation } {
    this.assertOpen()
    const value = durableObservation(input, this.now)
    const encoded = canonicalJson(value)
    const inserted = this.db.prepare(`
      INSERT OR IGNORE INTO ${ENTITY_SHADOW_OBSERVATION_TABLE} (
        observation_id, schema_version, source_type, work_id, packet_id,
        outcome, failure_category, observed_at, canonical_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      value.observationId,
      value.schemaVersion,
      value.sourceType,
      value.workId,
      value.packetId,
      value.outcome,
      value.failure?.category ?? null,
      value.observedAt,
      encoded,
      value.observedAt,
    )
    if (Number(inserted.changes) > 0) return { inserted: true, value }
    const existing = this.get(value.observationId)
    // Shadow never advances the work cursor, so the same sampled work may be
    // measured again with different wall-clock timestamps. Preserve the first
    // immutable measurement and treat an otherwise identical outcome as an
    // idempotent replay.
    if (!existing || canonicalJson(semanticObservation(existing)) !== canonicalJson(semanticObservation(value))) {
      throw new EntityShadowObservationConflictError(value.observationId)
    }
    return { inserted: false, value: existing }
  }

  get(observationId: string): DurableEntityShadowObservation | null {
    this.assertOpen()
    const row = this.db.prepare(`
      SELECT canonical_json FROM ${ENTITY_SHADOW_OBSERVATION_TABLE}
      WHERE observation_id = ?
    `).get(observationId) as { canonical_json?: unknown } | undefined
    return row ? parseObservation(row.canonical_json) : null
  }

  listByWork(workId: string, limit = 100): DurableEntityShadowObservation[] {
    this.assertOpen()
    if (!Number.isInteger(limit) || limit < 1 || limit > 1_000) {
      throw new RangeError('limit must be an integer between 1 and 1000')
    }
    return (this.db.prepare(`
      SELECT canonical_json FROM ${ENTITY_SHADOW_OBSERVATION_TABLE}
      WHERE work_id = ? ORDER BY observation_id LIMIT ?
    `).all(workId, limit) as Array<{ canonical_json: unknown }>).map((row) => parseObservation(row.canonical_json))
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.db.close()
  }

  private assertOpen(): void {
    if (this.closed) throw new Error('Entity shadow observation store is closed')
  }
}

function semanticObservation(value: DurableEntityShadowObservation): Record<string, unknown> {
  let executionEvent: Record<string, unknown> | null = null
  if (value.executionEvent) {
    const {
      startedAt: _startedAt,
      finishedAt: _finishedAt,
      createdAt: _createdAt,
      queueWaitMs: _queueWaitMs,
      wallTimeMs: _wallTimeMs,
      ...stableExecution
    } = value.executionEvent
    executionEvent = stableExecution
  }
  return {
    schemaVersion: value.schemaVersion,
    observationId: value.observationId,
    sourceType: value.sourceType,
    workId: value.workId,
    packetId: value.packetId,
    outcome: value.outcome,
    failure: value.failure,
    executionEvent,
  }
}

function durableObservation(
  input: ShadowEntityObservation,
  now: () => Date,
): DurableEntityShadowObservation {
  if (!input.workId || input.workId.length > 256) throw new TypeError('Shadow observation workId is invalid')
  const executionEvent = input.executionEvent ? validateExecutionTraceEvent(input.executionEvent) : null
  const failure = input.error ? {
    category: input.error.category,
    detail: executionEvent?.failureDetail ?? `${input.error.category.replaceAll('_', ' ')}; details redacted`,
    retryable: input.error.retryable,
    incrementsAttempt: input.error.incrementsAttempt,
    retryAfterMs: input.error.retryAfterMs ?? null,
  } : null
  const observedAt = executionEvent?.finishedAt ?? now().toISOString()
  const identity = canonicalJson({
    schemaVersion: ENTITY_SHADOW_OBSERVATION_SCHEMA_VERSION,
    sourceType: input.sourceType,
    workId: input.workId,
    packetId: input.packetId,
    outcome: input.outcome,
    failureCategory: input.error?.category ?? null,
    executionEventId: executionEvent?.eventId ?? null,
  })
  return Object.freeze({
    schemaVersion: ENTITY_SHADOW_OBSERVATION_SCHEMA_VERSION,
    observationId: `entity-shadow:${createHash('sha256').update(identity).digest('hex')}`,
    sourceType: input.sourceType,
    workId: input.workId,
    packetId: input.packetId,
    outcome: input.outcome,
    failure,
    executionEvent,
    observedAt,
  })
}

function parseObservation(value: unknown): DurableEntityShadowObservation {
  if (typeof value !== 'string') throw new Error('Stored Entity shadow observation is invalid')
  const parsed = JSON.parse(value) as DurableEntityShadowObservation
  if (parsed.schemaVersion !== ENTITY_SHADOW_OBSERVATION_SCHEMA_VERSION || !parsed.observationId) {
    throw new Error('Stored Entity shadow observation has an invalid contract')
  }
  if (parsed.executionEvent) validateExecutionTraceEvent(parsed.executionEvent)
  return parsed
}
