import { mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import type { ExecutionTraceEvent } from './contracts'
import { canonicalJson } from './canonical-json'
import {
  ExecutionEventConflictError,
  type ExecutionAggregateQuery,
  type ExecutionAggregateRow,
  type ExecutionAggregateStatus,
  type ExecutionEventAppendResult,
  type ExecutionLedger,
} from './execution-ledger'
import { validateExecutionTraceEvent } from './validation'

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

export const EXECUTION_LEDGER_TABLE = 'signal_execution_events' as const

/**
 * Immutable append-only execution ledger. Point it at either pipeline.sqlite
 * or news.sqlite; table creation is additive and isolated from legacy stores.
 */
export class SqliteExecutionLedger implements ExecutionLedger {
  private readonly db: SqliteDatabase

  constructor(path: string, options: { readOnly?: boolean } = {}) {
    const resolved = resolve(path)
    if (!options.readOnly) mkdirSync(dirname(resolved), { recursive: true })
    this.db = new DatabaseSync(resolved, options.readOnly ? { readOnly: true, open: true } : {})
    if (options.readOnly) {
      this.db.exec('PRAGMA busy_timeout = 5000;')
      return
    }
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS ${EXECUTION_LEDGER_TABLE} (
        event_id TEXT PRIMARY KEY,
        event_schema_version TEXT NOT NULL,
        trace_id TEXT NOT NULL,
        signal_id TEXT,
        work_id TEXT,
        packet_id TEXT,
        source_type TEXT NOT NULL,
        stage TEXT NOT NULL,
        attempt INTEGER NOT NULL,
        started_at TEXT NOT NULL,
        finished_at TEXT,
        status TEXT NOT NULL,
        failure_category TEXT,
        provider TEXT,
        model TEXT,
        fallback_provider TEXT,
        fallback_model TEXT,
        fallback_used INTEGER NOT NULL,
        prompt_version TEXT,
        policy_version TEXT,
        research_contract_version TEXT,
        provider_calls INTEGER NOT NULL,
        repair_calls INTEGER NOT NULL,
        input_tokens INTEGER NOT NULL,
        output_tokens INTEGER NOT NULL,
        tool_calls INTEGER NOT NULL,
        budget_exceeded INTEGER NOT NULL,
        queue_wait_ms INTEGER NOT NULL,
        wall_time_ms INTEGER NOT NULL,
        event_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_signal_execution_events_trace
        ON ${EXECUTION_LEDGER_TABLE}(trace_id, started_at, event_id);
      CREATE INDEX IF NOT EXISTS idx_signal_execution_events_work
        ON ${EXECUTION_LEDGER_TABLE}(work_id, started_at);
      CREATE INDEX IF NOT EXISTS idx_signal_execution_events_aggregate
        ON ${EXECUTION_LEDGER_TABLE}(source_type, stage, status, started_at);
    `)
  }

  append(input: ExecutionTraceEvent): ExecutionEventAppendResult {
    const event = validateExecutionTraceEvent(input)
    const eventJson = canonicalJson(event)
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const existing = this.db.prepare(
        `SELECT event_json FROM ${EXECUTION_LEDGER_TABLE} WHERE event_id = ?`,
      ).get(event.eventId) as { event_json?: unknown } | undefined
      if (existing) {
        // Normalize additive v1 fields before comparing so replay of an event
        // written before AC20 remains idempotent instead of becoming a false
        // immutable conflict merely because explicit null provenance was added.
        const normalizedExisting = canonicalJson(parseEvent(existing.event_json))
        if (normalizedExisting !== eventJson) throw new ExecutionEventConflictError(event.eventId)
        this.db.exec('COMMIT')
        return { inserted: false, event }
      }
      this.db.prepare(`
        INSERT INTO ${EXECUTION_LEDGER_TABLE} (
          event_id, event_schema_version, trace_id, signal_id, work_id, packet_id,
          source_type, stage, attempt, started_at, finished_at, status,
          failure_category, provider, model, fallback_provider, fallback_model,
          fallback_used, prompt_version, policy_version, research_contract_version,
          provider_calls, repair_calls, input_tokens, output_tokens, tool_calls,
          budget_exceeded, queue_wait_ms, wall_time_ms, event_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        event.eventId, event.schemaVersion, event.traceId, event.signalId, event.workId, event.packetId,
        event.sourceType, event.stage, event.attempt, event.startedAt, event.finishedAt, event.status,
        event.failureCategory, event.provider, event.model, event.fallbackProvider, event.fallbackModel,
        event.fallbackUsed ? 1 : 0, event.promptVersion, event.policyVersion, event.researchContractVersion,
        event.providerCalls, event.repairCalls, event.inputTokens, event.outputTokens, event.toolCalls,
        event.budgetExceeded ? 1 : 0, event.queueWaitMs, event.wallTimeMs, eventJson, event.createdAt,
      )
      this.db.exec('COMMIT')
      return { inserted: true, event }
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  get(eventId: string): ExecutionTraceEvent | null {
    const row = this.db.prepare(
      `SELECT event_json FROM ${EXECUTION_LEDGER_TABLE} WHERE event_id = ?`,
    ).get(eventId) as { event_json?: unknown } | undefined
    return row ? parseEvent(row.event_json) : null
  }

  listTrace(traceId: string): ExecutionTraceEvent[] {
    const rows = this.db.prepare(`
      SELECT event_json FROM ${EXECUTION_LEDGER_TABLE}
      WHERE trace_id = ? ORDER BY started_at ASC, event_id ASC
    `).all(traceId) as Array<{ event_json?: unknown }>
    return rows.map((row) => parseEvent(row.event_json))
  }

  readAggregateStatus(query: ExecutionAggregateQuery = {}): ExecutionAggregateStatus {
    const clauses: string[] = []
    const params: unknown[] = []
    if (query.sourceType) { clauses.push('source_type = ?'); params.push(query.sourceType) }
    if (query.stage) { clauses.push('stage = ?'); params.push(query.stage) }
    if (query.since) { clauses.push('started_at >= ?'); params.push(query.since) }
    if (query.until) { clauses.push('started_at < ?'); params.push(query.until) }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : ''
    const raw = this.db.prepare(`
      SELECT event_schema_version, source_type, stage, status, failure_category,
        provider, model, fallback_provider, fallback_model, fallback_used,
        json_extract(event_json, '$.configuredPrimaryProvider') AS configured_primary_provider,
        json_extract(event_json, '$.configuredPrimaryModel') AS configured_primary_model,
        json_extract(event_json, '$.fallbackReason') AS fallback_reason,
        json_extract(event_json, '$.outputSchemaValid') AS output_schema_valid,
        prompt_version, policy_version, research_contract_version,
        COUNT(*) AS event_count,
        SUM(provider_calls) AS provider_calls,
        SUM(repair_calls) AS repair_calls,
        SUM(input_tokens) AS input_tokens,
        SUM(output_tokens) AS output_tokens,
        SUM(tool_calls) AS tool_calls,
        SUM(budget_exceeded) AS budget_exceeded_count,
        SUM(wall_time_ms) AS total_wall_time_ms
      FROM ${EXECUTION_LEDGER_TABLE} ${where}
      GROUP BY event_schema_version, source_type, stage, status, failure_category,
        provider, model, fallback_provider, fallback_model, fallback_used,
        json_extract(event_json, '$.configuredPrimaryProvider'),
        json_extract(event_json, '$.configuredPrimaryModel'),
        json_extract(event_json, '$.fallbackReason'),
        json_extract(event_json, '$.outputSchemaValid'),
        prompt_version, policy_version, research_contract_version
      ORDER BY source_type, stage, status, provider
    `).all(...params) as Array<Record<string, unknown>>
    const rows: ExecutionAggregateRow[] = raw.map((row) => ({
      eventSchemaVersion: row.event_schema_version as ExecutionAggregateRow['eventSchemaVersion'],
      sourceType: row.source_type as ExecutionAggregateRow['sourceType'],
      stage: row.stage as ExecutionAggregateRow['stage'],
      status: row.status as ExecutionAggregateRow['status'],
      failureCategory: row.failure_category as ExecutionAggregateRow['failureCategory'],
      provider: row.provider as string | null,
      model: row.model as string | null,
      fallbackProvider: row.fallback_provider as string | null,
      fallbackModel: row.fallback_model as string | null,
      fallbackUsed: Number(row.fallback_used) === 1,
      configuredPrimaryProvider: row.configured_primary_provider as string | null,
      configuredPrimaryModel: row.configured_primary_model as string | null,
      fallbackReason: row.fallback_reason as ExecutionAggregateRow['fallbackReason'],
      outputSchemaValid: row.output_schema_valid === null ? null : Number(row.output_schema_valid) === 1,
      promptVersion: row.prompt_version as string | null,
      policyVersion: row.policy_version as string | null,
      researchContractVersion: row.research_contract_version as string | null,
      eventCount: Number(row.event_count),
      providerCalls: Number(row.provider_calls),
      repairCalls: Number(row.repair_calls),
      inputTokens: Number(row.input_tokens),
      outputTokens: Number(row.output_tokens),
      toolCalls: Number(row.tool_calls),
      budgetExceededCount: Number(row.budget_exceeded_count),
      totalWallTimeMs: Number(row.total_wall_time_ms),
    }))
    const activeClauses = ['s.status = ?']
    const activeParams: unknown[] = ['started']
    if (query.sourceType) { activeClauses.push('s.source_type = ?'); activeParams.push(query.sourceType) }
    if (query.stage) { activeClauses.push('s.stage = ?'); activeParams.push(query.stage) }
    if (query.since) { activeClauses.push('s.started_at >= ?'); activeParams.push(query.since) }
    if (query.until) { activeClauses.push('s.started_at < ?'); activeParams.push(query.until) }
    const active = this.db.prepare(`
      SELECT COUNT(*) AS active_count FROM (
        SELECT s.trace_id, s.work_id, s.source_type, s.stage, s.attempt
        FROM ${EXECUTION_LEDGER_TABLE} s
        WHERE ${activeClauses.join(' AND ')}
          AND NOT EXISTS (
            SELECT 1 FROM ${EXECUTION_LEDGER_TABLE} terminal
            WHERE terminal.status <> 'started'
              AND terminal.trace_id = s.trace_id
              AND COALESCE(terminal.work_id, '') = COALESCE(s.work_id, '')
              AND terminal.source_type = s.source_type
              AND terminal.stage = s.stage
              AND terminal.attempt = s.attempt
          )
        GROUP BY s.trace_id, s.work_id, s.source_type, s.stage, s.attempt
      )
    `).get(...activeParams) as Record<string, unknown> | undefined
    return {
      totalEvents: rows.reduce((sum, row) => sum + row.eventCount, 0),
      activeEvents: Number(active?.active_count ?? 0),
      rows,
    }
  }

  close(): void {
    this.db.close()
  }
}

function parseEvent(value: unknown): ExecutionTraceEvent {
  if (typeof value !== 'string') throw new Error('Execution ledger contains a non-string event_json')
  return validateExecutionTraceEvent(JSON.parse(value))
}
