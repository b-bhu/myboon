import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import type { ExecutionTraceEvent, Signal } from './contracts'
import type { BoundedExecutionTraceReadPort } from './operator-trace'
import { validateExecutionTraceEvent } from './validation'

interface SqliteStatement { all(...params: unknown[]): unknown[] }
interface SqliteDatabase {
  close(): void
  exec(sql: string): void
  prepare(sql: string): SqliteStatement
}

const nodeRequire = createRequire(__filename)
const { DatabaseSync } = nodeRequire('node:sqlite') as {
  DatabaseSync: new (path: string, options: { readOnly: boolean; open: boolean }) => SqliteDatabase
}

export class SqliteBoundedExecutionTraceReader implements BoundedExecutionTraceReadPort {
  readonly sourceType: Signal['sourceType']
  private readonly db: SqliteDatabase
  private closed = false

  constructor(path: string, sourceType: Signal['sourceType']) {
    this.sourceType = sourceType
    this.db = new DatabaseSync(resolve(path), { readOnly: true, open: true })
    this.db.exec('PRAGMA busy_timeout = 5000;')
  }

  listTraceBounded(traceId: string, limit: number): ExecutionTraceEvent[] {
    this.assertOpen()
    if (!traceId.trim()) throw new Error('traceId must not be empty')
    if (!Number.isInteger(limit) || limit < 1 || limit > 251) throw new Error('limit must be between 1 and 251')
    const rows = this.db.prepare(`
      SELECT event_json FROM signal_execution_events
      WHERE trace_id = ? AND source_type = ?
      ORDER BY started_at ASC, event_id ASC LIMIT ?
    `).all(traceId, this.sourceType, limit) as Array<Record<string, unknown>>
    return rows.map((row) => {
      if (typeof row.event_json !== 'string') throw new Error('Execution event JSON is invalid')
      return validateExecutionTraceEvent(JSON.parse(row.event_json))
    })
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.db.close()
  }

  private assertOpen(): void {
    if (this.closed) throw new Error('SqliteBoundedExecutionTraceReader is closed')
  }
}
