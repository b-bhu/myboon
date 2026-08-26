import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { canonicalJson } from './canonical-json'
import type { FailureCategory, ResearchWorkItem, Signal } from './contracts'
import {
  RECOVERY_AUDIT_EVENT_SCHEMA_VERSION,
  type RecoveryAuditEventV1,
  type RecoveryCandidate,
  type RecoveryFilters,
  type RecoveryStage,
  type RecoveryStorePort,
  type RecoveryTargetStatus,
} from './operator-recovery'
import { stableContractId } from './adapters/identity'
import { validateResearchWorkItem } from './validation'

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
  DatabaseSync: new (path: string, options?: { readOnly?: boolean; open?: boolean }) => SqliteDatabase
}

export const RECOVERY_AUDIT_TABLE = 'signal_platform_recovery_events' as const

const TARGET_EXPRESSION = `CASE
  WHEN w.status = 'retry_wait'
    AND json_extract(w.work_json, '$.retryTargetStatus') IN ('research_pending', 'deep_pending', 'synthesis_pending', 'entity_pending')
    THEN json_extract(w.work_json, '$.retryTargetStatus')
  WHEN EXISTS (SELECT 1 FROM signal_platform_research_packets p WHERE p.work_id = w.work_id)
    THEN 'entity_pending'
  WHEN json_extract(w.work_json, '$.researchDepth') = 'deep'
    AND EXISTS (SELECT 1 FROM signal_platform_evidence e WHERE e.work_id = w.work_id)
    THEN 'deep_pending'
  WHEN EXISTS (SELECT 1 FROM signal_platform_evidence e WHERE e.work_id = w.work_id)
    THEN 'synthesis_pending'
  ELSE 'research_pending'
END`

export class SqliteRecoveryStorePort implements RecoveryStorePort {
  readonly sourceType: Signal['sourceType']
  private readonly db: SqliteDatabase
  private readonly readOnly: boolean
  private closed = false

  constructor(path: string, sourceType: Signal['sourceType'], options: { readOnly?: boolean } = {}) {
    this.sourceType = sourceType
    this.readOnly = options.readOnly === true
    this.db = new DatabaseSync(
      resolve(path),
      this.readOnly ? { readOnly: true, open: true } : {},
    )
    this.db.exec('PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;')
  }

  async listRecoverable(input: {
    filters: Omit<RecoveryFilters, 'sourceType'>
    limit: number
  }): Promise<RecoveryCandidate[]> {
    this.assertOpen()
    const clauses = [
      `w.source_type = ?`,
      `w.status IN ('expired', 'dead_letter', 'retry_wait')`,
    ]
    const params: unknown[] = [this.sourceType]
    if (input.filters.failureCategory) { clauses.push('w.failure_category = ?'); params.push(input.filters.failureCategory) }
    if (input.filters.workId) { clauses.push('w.work_id = ?'); params.push(input.filters.workId) }
    if (input.filters.since) { clauses.push('w.updated_at >= ?'); params.push(input.filters.since) }
    if (input.filters.until) { clauses.push('w.updated_at < ?'); params.push(input.filters.until) }
    if (input.filters.stage) {
      clauses.push(`${TARGET_EXPRESSION} = ?`)
      params.push(targetForStage(input.filters.stage))
    }
    params.push(boundedLimit(input.limit))
    const rows = this.db.prepare(`
      SELECT w.work_id, w.trace_id, w.status, w.failure_category,
        w.attempt_count, w.updated_at, ${TARGET_EXPRESSION} AS target_status
      FROM signal_platform_research_work w
      WHERE ${clauses.join(' AND ')}
      ORDER BY w.updated_at ASC, w.work_id ASC LIMIT ?
    `).all(...params) as Array<Record<string, unknown>>
    return rows.map((row) => ({
      sourceType: this.sourceType,
      workId: String(row.work_id),
      traceId: String(row.trace_id),
      fromStatus: row.status as RecoveryCandidate['fromStatus'],
      targetStatus: row.target_status as RecoveryTargetStatus,
      failureCategory: row.failure_category as FailureCategory | null,
      attemptCount: Number(row.attempt_count),
      updatedAt: String(row.updated_at),
    }))
  }

  async prepareApply(): Promise<void> {
    this.assertOpen()
    if (this.readOnly) throw new Error('Read-only recovery store cannot apply changes')
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS ${RECOVERY_AUDIT_TABLE} (
        event_id TEXT PRIMARY KEY,
        schema_version TEXT NOT NULL,
        operation_id TEXT NOT NULL,
        backup_receipt_id TEXT NOT NULL,
        source_type TEXT NOT NULL,
        work_id TEXT NOT NULL,
        trace_id TEXT NOT NULL,
        from_status TEXT NOT NULL,
        to_status TEXT NOT NULL,
        prior_failure_category TEXT,
        attempt_count INTEGER NOT NULL,
        recovered_at TEXT NOT NULL,
        event_json TEXT NOT NULL,
        FOREIGN KEY(work_id) REFERENCES signal_platform_research_work(work_id),
        UNIQUE(operation_id, work_id)
      );
      CREATE INDEX IF NOT EXISTS idx_signal_platform_recovery_operation
        ON ${RECOVERY_AUDIT_TABLE}(operation_id, recovered_at, event_id);
      CREATE INDEX IF NOT EXISTS idx_signal_platform_recovery_trace
        ON ${RECOVERY_AUDIT_TABLE}(trace_id, recovered_at, event_id);
    `)
  }

  async recoverCandidate(input: {
    candidate: RecoveryCandidate
    operationId: string
    backupReceiptId: string
    recoveredAt: string
  }): Promise<RecoveryAuditEventV1 | null> {
    this.assertOpen()
    if (this.readOnly) throw new Error('Read-only recovery store cannot apply changes')
    if (input.candidate.sourceType !== this.sourceType) return null
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const raw = this.db.prepare(`
        SELECT work_json, ${TARGET_EXPRESSION} AS target_status
        FROM signal_platform_research_work w
        WHERE w.work_id = ? AND w.source_type = ? AND w.status = ? AND w.updated_at = ?
      `).get(
        input.candidate.workId, this.sourceType,
        input.candidate.fromStatus, input.candidate.updatedAt,
      ) as Record<string, unknown> | undefined
      if (!raw || raw.target_status !== input.candidate.targetStatus) {
        this.db.exec('ROLLBACK')
        return null
      }
      const current = parseWork(raw.work_json)
      const updated = validateResearchWorkItem({
        ...current,
        status: input.candidate.targetStatus,
        nextAttemptAt: null,
        retryTargetStatus: null,
        leaseOwner: null,
        leaseId: null,
        leaseExpiresAt: null,
        failureCategory: null,
        failureDetail: null,
        updatedAt: input.recoveredAt,
      })
      const result = this.db.prepare(`
        UPDATE signal_platform_research_work SET
          status = ?, next_attempt_at = NULL,
          lease_owner = NULL, lease_id = NULL, lease_expires_at = NULL,
          failure_category = NULL, failure_detail = NULL,
          attempt_started_for_lease = 0, updated_at = ?, work_json = ?
        WHERE work_id = ? AND source_type = ? AND status = ? AND updated_at = ?
      `).run(
        updated.status, updated.updatedAt, canonicalJson(updated), updated.workId,
        this.sourceType, input.candidate.fromStatus, input.candidate.updatedAt,
      )
      if (Number(result.changes) !== 1) {
        this.db.exec('ROLLBACK')
        return null
      }
      const event: RecoveryAuditEventV1 = {
        schemaVersion: RECOVERY_AUDIT_EVENT_SCHEMA_VERSION,
        eventId: stableContractId('recovery_event', input.operationId, updated.workId),
        operationId: input.operationId,
        backupReceiptId: input.backupReceiptId,
        sourceType: this.sourceType,
        workId: updated.workId,
        traceId: updated.traceId,
        fromStatus: input.candidate.fromStatus,
        toStatus: input.candidate.targetStatus,
        priorFailureCategory: input.candidate.failureCategory,
        attemptCount: updated.attemptCount,
        recoveredAt: input.recoveredAt,
      }
      this.db.prepare(`
        INSERT INTO ${RECOVERY_AUDIT_TABLE} (
          event_id, schema_version, operation_id, backup_receipt_id, source_type,
          work_id, trace_id, from_status, to_status, prior_failure_category,
          attempt_count, recovered_at, event_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        event.eventId, event.schemaVersion, event.operationId, event.backupReceiptId,
        event.sourceType, event.workId, event.traceId, event.fromStatus, event.toStatus,
        event.priorFailureCategory, event.attemptCount, event.recoveredAt, canonicalJson(event),
      )
      this.db.exec('COMMIT')
      return event
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  listRecoveryEvents(operationId: string, limit: number): RecoveryAuditEventV1[] {
    this.assertOpen()
    const rows = this.db.prepare(`
      SELECT event_json FROM ${RECOVERY_AUDIT_TABLE}
      WHERE operation_id = ? ORDER BY recovered_at, event_id LIMIT ?
    `).all(operationId, boundedLimit(limit)) as Array<Record<string, unknown>>
    return rows.map((row) => JSON.parse(String(row.event_json)) as RecoveryAuditEventV1)
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.db.close()
  }

  private assertOpen(): void {
    if (this.closed) throw new Error('SqliteRecoveryStorePort is closed')
  }
}

function parseWork(value: unknown): ResearchWorkItem {
  if (typeof value !== 'string') throw new Error('Recovery store contains non-string work JSON')
  return validateResearchWorkItem(JSON.parse(value))
}

function targetForStage(stage: RecoveryStage): RecoveryTargetStatus {
  if (stage === 'retrieval') return 'research_pending'
  if (stage === 'deep') return 'deep_pending'
  if (stage === 'synthesis') return 'synthesis_pending'
  return 'entity_pending'
}

function boundedLimit(limit: number): number {
  if (!Number.isInteger(limit) || limit <= 0 || limit > 501) throw new Error('limit must be between 1 and 501')
  return limit
}
