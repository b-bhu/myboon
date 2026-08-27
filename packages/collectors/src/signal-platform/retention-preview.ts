import { existsSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { redactControlPlaneValue } from './control-plane-format'

export const RETENTION_PREVIEW_SCHEMA_VERSION = 'myboon.retention_preview.v1' as const

export type RetentionDatabaseKind = 'news' | 'pipeline'
export type RetentionTableName =
  | 'signal_platform_research_work'
  | 'signal_execution_events'
  | 'signal_platform_research_shadow_results'
  | 'entity_manager_shadow_observations'
  | 'deep_research_active_executions'

export interface RetentionPreviewSample {
  id: string
  status: string
  occurredAt: string
  sourceType?: string
  stage?: string
  researchDepth?: string
  tempArtifactPresent?: boolean
}

export interface RetentionTablePreview {
  table: RetentionTableName
  present: boolean
  eligibleCount: number
  sampleLimit: number
  samples: RetentionPreviewSample[]
  sampleTruncated: boolean
}

export interface RetentionDatabaseSize {
  mainBytes: number
  walBytes: number
  shmBytes: number
  totalBytes: number
}

export interface RetentionDatabasePreview {
  database: RetentionDatabaseKind
  availability: 'available' | 'missing' | 'unavailable'
  errorCode: 'DATABASE_READ_UNAVAILABLE' | null
  size: RetentionDatabaseSize
  tables: RetentionTablePreview[]
}

export interface DeepRegistryRetentionPreview {
  availability: 'available' | 'missing' | 'unavailable'
  errorCode: 'DATABASE_READ_UNAVAILABLE' | null
  size: RetentionDatabaseSize
  table: RetentionTablePreview
}

export interface RetentionPreviewReport {
  schemaVersion: typeof RETENTION_PREVIEW_SCHEMA_VERSION
  generatedAt: string
  before: string
  sampleLimit: number
  readOnly: true
  mutationSupported: false
  databases: RetentionDatabasePreview[]
  deepRegistry: DeepRegistryRetentionPreview | null
}

interface Statement {
  all(...params: unknown[]): unknown[]
  get(...params: unknown[]): unknown
}
interface Database {
  close(): void
  exec(sql: string): void
  prepare(sql: string): Statement
}

const nodeRequire = createRequire(__filename)
const { DatabaseSync } = nodeRequire('node:sqlite') as {
  DatabaseSync: new(path: string, options: { readOnly: true; open: true }) => Database
}

const DATABASE_TABLES: readonly RetentionTableName[] = [
  'signal_platform_research_work',
  'signal_execution_events',
  'signal_platform_research_shadow_results',
  'entity_manager_shadow_observations',
]

/**
 * Reads only independently disposable operational records. It deliberately
 * has no entity, memory, signal, evidence, packet, mutation, or schema path.
 */
export function previewSqliteRetention(input: {
  before: string
  sampleLimit: number
  databases: Array<{ database: RetentionDatabaseKind; path: string }>
  deepRegistryPath?: string | null
  generatedAt?: string
  pathExists?: (path: string) => boolean
}): RetentionPreviewReport {
  timestamp(input.before, 'before')
  const generatedAt = input.generatedAt ?? new Date().toISOString()
  timestamp(generatedAt, 'generatedAt')
  const sampleLimit = boundedLimit(input.sampleLimit)
  const pathExists = input.pathExists ?? existsSync
  const databases = input.databases.map((entry) => previewDatabase(
    entry.database, entry.path, input.before, sampleLimit, pathExists,
  ))
  return {
    schemaVersion: RETENTION_PREVIEW_SCHEMA_VERSION,
    generatedAt,
    before: input.before,
    sampleLimit,
    readOnly: true,
    mutationSupported: false,
    databases,
    deepRegistry: input.deepRegistryPath
      ? previewDeepRegistry(input.deepRegistryPath, input.before, sampleLimit, pathExists)
      : null,
  }
}

export function formatRetentionPreviewJson(report: RetentionPreviewReport): string {
  return JSON.stringify(redactControlPlaneValue(report), null, 2)
}

function previewDatabase(
  database: RetentionDatabaseKind,
  path: string,
  before: string,
  sampleLimit: number,
  pathExists: (path: string) => boolean,
): RetentionDatabasePreview {
  const resolved = resolve(path)
  if (!pathExists(resolved)) return {
    database, availability: 'missing', errorCode: null, size: databaseSize(resolved),
    tables: DATABASE_TABLES.map((table) => absentTable(table, sampleLimit)),
  }
  let db: Database | null = null
  try {
    db = openReadOnly(resolved)
    return {
      database,
      availability: 'available',
      errorCode: null,
      size: databaseSize(resolved),
      tables: DATABASE_TABLES.map((table) => previewTable(db!, table, before, sampleLimit)),
    }
  } catch {
    return {
      database, availability: 'unavailable', errorCode: 'DATABASE_READ_UNAVAILABLE',
      size: databaseSize(resolved),
      tables: DATABASE_TABLES.map((table) => absentTable(table, sampleLimit)),
    }
  } finally {
    db?.close()
  }
}

function previewDeepRegistry(
  path: string,
  before: string,
  sampleLimit: number,
  pathExists: (path: string) => boolean,
): DeepRegistryRetentionPreview {
  const resolved = resolve(path)
  if (!pathExists(resolved)) return {
    availability: 'missing', errorCode: null, size: databaseSize(resolved),
    table: absentTable('deep_research_active_executions', sampleLimit),
  }
  let db: Database | null = null
  try {
    db = openReadOnly(resolved)
    return {
      availability: 'available', errorCode: null, size: databaseSize(resolved),
      table: previewTable(
        db, 'deep_research_active_executions', before, sampleLimit, pathExists,
      ),
    }
  } catch {
    return {
      availability: 'unavailable', errorCode: 'DATABASE_READ_UNAVAILABLE',
      size: databaseSize(resolved),
      table: absentTable('deep_research_active_executions', sampleLimit),
    }
  } finally {
    db?.close()
  }
}

function openReadOnly(path: string): Database {
  const db = new DatabaseSync(path, { readOnly: true, open: true })
  db.exec('PRAGMA query_only = ON; PRAGMA busy_timeout = 5000;')
  return db
}

function previewTable(
  db: Database,
  table: RetentionTableName,
  before: string,
  sampleLimit: number,
  pathExists: (path: string) => boolean = existsSync,
): RetentionTablePreview {
  if (!tableExists(db, table)) return absentTable(table, sampleLimit)
  const query = retentionQuery(table)
  const count = db.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE ${query.where}`)
    .get(...query.params(before)) as Record<string, unknown> | undefined
  const eligibleCount = Number(count?.count ?? 0)
  const rows = db.prepare(`${query.select} FROM ${table} WHERE ${query.where} ${query.order} LIMIT ?`)
    .all(...query.params(before), sampleLimit) as Array<Record<string, unknown>>
  return {
    table,
    present: true,
    eligibleCount,
    sampleLimit,
    samples: rows.map((row) => sampleFor(table, row, pathExists)),
    sampleTruncated: eligibleCount > rows.length,
  }
}

function retentionQuery(table: RetentionTableName): {
  select: string
  where: string
  order: string
  params(before: string): unknown[]
} {
  if (table === 'signal_platform_research_work') return {
    select: 'SELECT work_id AS id, status, updated_at AS occurred_at, source_type',
    where: "updated_at < ? AND status IN ('complete', 'dead_letter', 'expired')",
    order: 'ORDER BY updated_at, work_id',
    params: (before) => [before],
  }
  if (table === 'signal_execution_events') return {
    select: 'SELECT event_id AS id, status, finished_at AS occurred_at, source_type, stage',
    where: "finished_at < ? AND status IN ('succeeded', 'failed', 'skipped', 'expired', 'dead_letter')",
    order: 'ORDER BY finished_at, event_id',
    params: (before) => [before],
  }
  if (table === 'signal_platform_research_shadow_results') return {
    select: 'SELECT evaluation_id AS id, status, finished_at AS occurred_at, source_type, research_depth',
    where: "finished_at < ? AND status IN ('succeeded', 'failed', 'skipped')",
    order: 'ORDER BY finished_at, evaluation_id',
    params: (before) => [before],
  }
  if (table === 'entity_manager_shadow_observations') return {
    select: "SELECT observation_id AS id, outcome AS status, observed_at AS occurred_at, source_type, 'entity' AS stage",
    where: "observed_at < ? AND outcome IN ('accepted', 'rejected')",
    order: 'ORDER BY observed_at, observation_id',
    params: (before) => [before],
  }
  return {
    select: "SELECT unit_name AS id, 'expired_registry' AS status, deadline_at AS occurred_at, temp_path",
    where: 'deadline_at < ?',
    order: 'ORDER BY deadline_at, unit_name',
    params: (before) => [before],
  }
}

function sampleFor(
  table: RetentionTableName,
  row: Record<string, unknown>,
  pathExists: (path: string) => boolean,
): RetentionPreviewSample {
  const sample: RetentionPreviewSample = {
    id: String(row.id), status: String(row.status), occurredAt: String(row.occurred_at),
  }
  if (typeof row.source_type === 'string') sample.sourceType = row.source_type
  if (typeof row.stage === 'string') sample.stage = row.stage
  if (typeof row.research_depth === 'string') sample.researchDepth = row.research_depth
  if (table === 'deep_research_active_executions' && typeof row.temp_path === 'string') {
    try { sample.tempArtifactPresent = pathExists(row.temp_path) } catch { sample.tempArtifactPresent = false }
  }
  return sample
}

function tableExists(db: Database, table: RetentionTableName): boolean {
  return Boolean(db.prepare(
    "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?",
  ).get(table))
}

function absentTable(table: RetentionTableName, sampleLimit: number): RetentionTablePreview {
  return { table, present: false, eligibleCount: 0, sampleLimit, samples: [], sampleTruncated: false }
}

function databaseSize(path: string): RetentionDatabaseSize {
  const size = (candidate: string): number => {
    try { return statSync(candidate).size } catch { return 0 }
  }
  const mainBytes = size(path)
  const walBytes = size(`${path}-wal`)
  const shmBytes = size(`${path}-shm`)
  return { mainBytes, walBytes, shmBytes, totalBytes: mainBytes + walBytes + shmBytes }
}

function boundedLimit(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 500) {
    throw new Error('sampleLimit must be an integer between 1 and 500')
  }
  return value
}

function timestamp(value: string, field: string): void {
  if (!value.trim() || !Number.isFinite(Date.parse(value))) throw new Error(`${field} must be a valid timestamp`)
}
