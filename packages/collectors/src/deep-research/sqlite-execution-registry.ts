import { mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import type { DeepResearchSystemdController } from './systemd-controller'
import type { DeepResearchExecutionRegistry } from './executor'
import type { DeepResearchExecutionMetadata } from './types'

interface Statement { run(...params: unknown[]): { changes: number | bigint }; all(...params: unknown[]): unknown[]; get(...params: unknown[]): unknown }
interface Database { exec(sql: string): void; prepare(sql: string): Statement; close(): void }
const nodeRequire = createRequire(__filename)
const { DatabaseSync } = nodeRequire('node:sqlite') as {
  DatabaseSync: new(path: string, options?: { readOnly?: boolean }) => Database
}

export const DEEP_RESEARCH_EXECUTION_TABLE = 'deep_research_active_executions' as const

/** Durable process registry used by the executor and a boot-time orphan audit. */
export class SqliteDeepResearchExecutionRegistry implements DeepResearchExecutionRegistry {
  private readonly db: Database
  private readonly tablePresent: boolean

  constructor(path: string, options: { readOnly?: boolean } = {}) {
    const resolved = resolve(path)
    if (!options.readOnly) mkdirSync(dirname(resolved), { recursive: true })
    this.db = new DatabaseSync(resolved, options.readOnly ? { readOnly: true } : {})
    if (options.readOnly) {
      this.tablePresent = this.db.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
      ).get(DEEP_RESEARCH_EXECUTION_TABLE) !== undefined
      return
    }
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS ${DEEP_RESEARCH_EXECUTION_TABLE} (
        unit_name TEXT PRIMARY KEY,
        job_id TEXT NOT NULL,
        work_id TEXT NOT NULL,
        trace_id TEXT NOT NULL,
        started_at TEXT NOT NULL,
        deadline_at TEXT NOT NULL,
        temp_path TEXT NOT NULL,
        profile_path TEXT NOT NULL,
        metadata_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_deep_research_execution_deadline
        ON ${DEEP_RESEARCH_EXECUTION_TABLE}(deadline_at, unit_name);
    `)
    this.tablePresent = true
  }

  register(metadata: DeepResearchExecutionMetadata): void {
    validateMetadata(metadata)
    const json = JSON.stringify(metadata)
    const existing = this.db.prepare(
      `SELECT metadata_json FROM ${DEEP_RESEARCH_EXECUTION_TABLE} WHERE unit_name = ?`,
    ).get(metadata.unitName) as { metadata_json?: unknown } | undefined
    if (existing !== undefined) {
      if (existing.metadata_json !== json) throw new Error(`Conflicting deep-research unit ${metadata.unitName}`)
      return
    }
    this.db.prepare(`INSERT INTO ${DEEP_RESEARCH_EXECUTION_TABLE} (
      unit_name, job_id, work_id, trace_id, started_at, deadline_at, temp_path, profile_path, metadata_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      metadata.unitName, metadata.jobId, metadata.workId, metadata.traceId,
      metadata.startedAt, metadata.deadlineAt, metadata.tempPath, metadata.profilePath, json,
    )
  }

  unregister(unitName: string): void {
    this.db.prepare(`DELETE FROM ${DEEP_RESEARCH_EXECUTION_TABLE} WHERE unit_name = ?`).run(unitName)
  }

  list(): readonly DeepResearchExecutionMetadata[] {
    if (!this.tablePresent) return []
    const rows = this.db.prepare(
      `SELECT metadata_json FROM ${DEEP_RESEARCH_EXECUTION_TABLE} ORDER BY started_at, unit_name`,
    ).all() as Array<{ metadata_json?: unknown }>
    return rows.map((row) => {
      if (typeof row.metadata_json !== 'string') throw new Error('Deep-research registry row is corrupt')
      const metadata = JSON.parse(row.metadata_json) as DeepResearchExecutionMetadata
      validateMetadata(metadata)
      return Object.freeze({ ...metadata })
    })
  }

  close(): void { this.db.close() }
}

export interface DeepResearchOrphanAuditEntry {
  metadata: DeepResearchExecutionMetadata
  unitActive: boolean | null
  tempPathPresent: boolean | null
  deadlineExpired: boolean
  auditError: 'systemd_status_unavailable' | 'filesystem_status_unavailable' | null
}

export interface DeepResearchOrphanAuditSnapshot {
  schemaVersion: 'myboon.deep_research_orphan_audit.v1'
  auditedAt: string
  registeredExecutions: number
  entries: DeepResearchOrphanAuditEntry[]
}

/** Audits only. It never kills units, deletes workspaces, or unregisters rows. */
export async function auditDeepResearchOrphans(input: {
  registry: Pick<DeepResearchExecutionRegistry, 'list'>
  systemd: Pick<DeepResearchSystemdController, 'isUnitActive'>
  pathExists(path: string): Promise<boolean>
  now?: () => Date
}): Promise<DeepResearchOrphanAuditSnapshot> {
  const now = input.now?.() ?? new Date()
  const entries = await Promise.all(input.registry.list().map(async (metadata) => {
    let unitActive: boolean | null = null
    let tempPathPresent: boolean | null = null
    let auditError: DeepResearchOrphanAuditEntry['auditError'] = null
    try { unitActive = await input.systemd.isUnitActive(metadata.unitName) } catch { auditError = 'systemd_status_unavailable' }
    try { tempPathPresent = await input.pathExists(metadata.tempPath) } catch {
      if (auditError === null) auditError = 'filesystem_status_unavailable'
    }
    return Object.freeze({
      metadata: Object.freeze({ ...metadata }), unitActive, tempPathPresent,
      deadlineExpired: Date.parse(metadata.deadlineAt) <= now.getTime(), auditError,
    })
  }))
  return Object.freeze({
    schemaVersion: 'myboon.deep_research_orphan_audit.v1' as const,
    auditedAt: now.toISOString(), registeredExecutions: entries.length, entries,
  })
}

function validateMetadata(value: DeepResearchExecutionMetadata): void {
  if (typeof value !== 'object' || value === null
    || !value.unitName.endsWith('.service')
    || !value.jobId || !value.workId || !value.traceId
    || !['news', 'polymarket', 'market_calendar', 'x'].includes(value.sourceType)
    || !Number.isFinite(Date.parse(value.startedAt)) || !Number.isFinite(Date.parse(value.deadlineAt))
    || !value.tempPath.startsWith('/') || !value.profilePath.startsWith('/')) {
    throw new Error('Invalid deep-research execution metadata')
  }
}
