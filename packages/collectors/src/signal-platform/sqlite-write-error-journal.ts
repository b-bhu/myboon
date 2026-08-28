import { createHash, randomUUID } from 'node:crypto'
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  statSync,
  writeSync,
} from 'node:fs'
import { dirname, isAbsolute, resolve } from 'node:path'

import type { Signal } from './contracts'
import type { MetricCoverage } from './control-plane'

export const SQLITE_WRITE_JOURNAL_SCHEMA_VERSION = 'myboon.sqlite_write_health_event.v1' as const
const MAX_JOURNAL_BYTES = 64 * 1024 * 1024
const DEFAULT_HEARTBEAT_INTERVAL_MS = 60_000

export type SqliteWriteFailureCategory =
  | 'busy'
  | 'readonly'
  | 'io_error'
  | 'disk_full'
  | 'corrupt'
  | 'cannot_open'
  | 'permission'
  | 'unknown_sqlite_write_error'

export interface SqliteWriteHealthEventV1 {
  schemaVersion: typeof SQLITE_WRITE_JOURNAL_SCHEMA_VERSION
  eventId: string
  kind: 'collector_heartbeat' | 'write_error'
  observedAt: string
  sourceType: Signal['sourceType']
  storeId: string
  operation: string
  category: SqliteWriteFailureCategory | null
}

export interface SqliteWriteHealthJournalPort {
  observeSuccess(input: { sourceType: Signal['sourceType']; storeId: string; operation: string; observedAt?: string }): void
  observeFailure(input: {
    sourceType: Signal['sourceType']; storeId: string; operation: string; error: unknown; observedAt?: string
  }): boolean
  readCoverage(input: {
    sourceType: Signal['sourceType']; storeId: string; since: string; now: string; staleAfterMs: number
  }): MetricCoverage<number>
}

/**
 * Append-only sidecar health journal. It intentionally lives outside SQLite so
 * lock, readonly, full-disk, and I/O failures are not recorded in the failed
 * transaction. Events contain only typed categories and path digests.
 */
export class FileSqliteWriteHealthJournal implements SqliteWriteHealthJournalPort {
  readonly path: string
  private readonly readOnly: boolean
  private readonly heartbeatIntervalMs: number
  private readonly lastHeartbeat = new Map<string, number>()

  constructor(path: string, options: { readOnly?: boolean; heartbeatIntervalMs?: number } = {}) {
    if (!path.trim()) throw new Error('SQLite write-health journal path is required')
    this.path = resolve(path)
    this.readOnly = options.readOnly ?? false
    this.heartbeatIntervalMs = boundedInteger(
      options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS,
      'heartbeatIntervalMs', 1_000, 60 * 60_000,
    )
  }

  observeSuccess(input: {
    sourceType: Signal['sourceType']; storeId: string; operation: string; observedAt?: string
  }): void {
    if (this.readOnly) return
    const observedAt = validTimestamp(input.observedAt ?? new Date().toISOString(), 'observedAt')
    const key = `${input.sourceType}|${digest(input.storeId)}`
    const observedAtMs = Date.parse(observedAt)
    if (observedAtMs - (this.lastHeartbeat.get(key) ?? 0) < this.heartbeatIntervalMs) return
    this.append(event({ ...input, observedAt, kind: 'collector_heartbeat', category: null }))
    this.lastHeartbeat.set(key, observedAtMs)
  }

  observeFailure(input: {
    sourceType: Signal['sourceType']; storeId: string; operation: string; error: unknown; observedAt?: string
  }): boolean {
    if (this.readOnly) return false
    const category = classifySqliteWriteFailure(input.error)
    if (!category) return false
    this.append(event({
      ...input, observedAt: validTimestamp(input.observedAt ?? new Date().toISOString(), 'observedAt'),
      kind: 'write_error', category,
    }))
    return true
  }

  readCoverage(input: {
    sourceType: Signal['sourceType']; storeId: string; since: string; now: string; staleAfterMs: number
  }): MetricCoverage<number> {
    const since = validTimestamp(input.since, 'since')
    const now = validTimestamp(input.now, 'now')
    const staleAfterMs = boundedInteger(input.staleAfterMs, 'staleAfterMs', 1_000, 24 * 60 * 60_000)
    if (!existsSync(this.path)) return unavailable('SQLite write-health journal is missing')
    try {
      if (statSync(this.path).size > MAX_JOURNAL_BYTES) return unavailable('SQLite write-health journal exceeds its read bound')
      const storeId = digest(input.storeId)
      // SQLite health is physical-store scoped. One pipeline.sqlite heartbeat
      // covers its Polymarket, Calendar, and X logical adapters, while each
      // event retains source attribution for incident tracing.
      const rows = readFileSync(this.path, 'utf8').split(/\r?\n/).filter(Boolean).map(parseEvent)
        .filter((row) => row.storeId === storeId)
      const latestHeartbeat = rows.filter((row) => row.kind === 'collector_heartbeat')
        .reduce((latest, row) => Math.max(latest, Date.parse(row.observedAt)), Number.NEGATIVE_INFINITY)
      if (!Number.isFinite(latestHeartbeat)) return unavailable(`No collector heartbeat exists for ${input.sourceType} store`)
      if (Date.parse(now) - latestHeartbeat > staleAfterMs) return unavailable(`SQLite write-health collector is stale for ${input.sourceType} store`)
      const value = rows.filter((row) => row.kind === 'write_error'
        && row.observedAt >= since && row.observedAt <= now).length
      return { availability: 'available', value, measuredCount: rows.length, reason: null }
    } catch {
      return unavailable('SQLite write-health journal is unreadable or invalid')
    }
  }

  private append(value: SqliteWriteHealthEventV1): void {
    mkdirSync(dirname(this.path), { recursive: true })
    const bytes = Buffer.from(`${JSON.stringify(value)}\n`, 'utf8')
    const descriptor = openSync(this.path, 'a', 0o600)
    try {
      writeSync(descriptor, bytes)
      fsyncSync(descriptor)
    } finally {
      closeSync(descriptor)
    }
  }
}

export function resolveSqliteWriteHealthJournalPath(
  env: Readonly<Record<string, string | undefined>> = process.env,
  packageDirectory = resolve(__dirname, '..', '..'),
): string {
  const configured = env.FEED_V3_SQLITE_WRITE_ERROR_JOURNAL_PATH?.trim()
    || '.data/feed-v3-sqlite-write-errors.jsonl'
  return isAbsolute(configured) ? resolve(configured) : resolve(packageDirectory, configured)
}

export function sqliteStoreId(path: string): string {
  return createHash('sha256').update(resolve(path), 'utf8').digest('hex')
}

export function classifySqliteWriteFailure(error: unknown): SqliteWriteFailureCategory | null {
  if (!error || typeof error !== 'object') return null
  const record = error as { code?: unknown; errcode?: unknown; message?: unknown }
  const code = `${String(record.code ?? '')}|${String(record.errcode ?? '')}`.toUpperCase()
  const message = String(record.message ?? '').toLowerCase()
  if (/SQLITE_BUSY|SQLITE_LOCKED/.test(code) || /database (?:is )?(?:locked|busy)/.test(message)) return 'busy'
  if (/SQLITE_READONLY/.test(code) || /read-?only/.test(message)) return 'readonly'
  if (/SQLITE_FULL/.test(code) || /database or disk is full|disk full/.test(message)) return 'disk_full'
  if (/SQLITE_IOERR/.test(code) || /disk i\/o error|i\/o error/.test(message)) return 'io_error'
  if (/SQLITE_CORRUPT|SQLITE_NOTADB/.test(code) || /malformed|not a database/.test(message)) return 'corrupt'
  if (/SQLITE_CANTOPEN/.test(code) || /unable to open database/.test(message)) return 'cannot_open'
  if (/SQLITE_PERM|SQLITE_AUTH/.test(code) || /permission denied/.test(message)) return 'permission'
  if (/^SQLITE_(?:ERROR|PROTOCOL|INTERRUPT|NOMEM)/.test(code)) return 'unknown_sqlite_write_error'
  return null
}

function event(input: {
  kind: SqliteWriteHealthEventV1['kind']; observedAt: string; sourceType: Signal['sourceType'];
  storeId: string; operation: string; category: SqliteWriteFailureCategory | null
}): SqliteWriteHealthEventV1 {
  return {
    schemaVersion: SQLITE_WRITE_JOURNAL_SCHEMA_VERSION,
    eventId: `sqlite_health_${randomUUID()}`,
    kind: input.kind,
    observedAt: input.observedAt,
    sourceType: input.sourceType,
    storeId: digest(input.storeId),
    operation: boundedText(input.operation, 'operation'),
    category: input.category,
  }
}

function parseEvent(line: string): SqliteWriteHealthEventV1 {
  const value = JSON.parse(line) as Record<string, unknown>
  const keys = new Set(['schemaVersion', 'eventId', 'kind', 'observedAt', 'sourceType', 'storeId', 'operation', 'category'])
  for (const key of Object.keys(value)) if (!keys.has(key)) throw new Error(`Unknown SQLite health event key: ${key}`)
  if (value.schemaVersion !== SQLITE_WRITE_JOURNAL_SCHEMA_VERSION
    || (value.kind !== 'collector_heartbeat' && value.kind !== 'write_error')
    || !['news', 'polymarket', 'market_calendar', 'x'].includes(String(value.sourceType))) {
    throw new Error('Invalid SQLite health event')
  }
  const category = value.category
  if (value.kind === 'collector_heartbeat' ? category !== null : ![
    'busy', 'readonly', 'io_error', 'disk_full', 'corrupt', 'cannot_open', 'permission', 'unknown_sqlite_write_error',
  ].includes(String(category))) throw new Error('Invalid SQLite health event category')
  return {
    schemaVersion: SQLITE_WRITE_JOURNAL_SCHEMA_VERSION,
    eventId: boundedText(value.eventId, 'eventId'),
    kind: value.kind,
    observedAt: validTimestamp(value.observedAt, 'observedAt'),
    sourceType: value.sourceType as Signal['sourceType'],
    storeId: digest(value.storeId),
    operation: boundedText(value.operation, 'operation'),
    category: category as SqliteWriteFailureCategory | null,
  }
}

function unavailable(reason: string): MetricCoverage<number> {
  return { availability: 'unavailable', value: null, measuredCount: 0, reason }
}

function validTimestamp(value: unknown, field: string): string {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) throw new Error(`${field} must be a timestamp`)
  return value
}

function digest(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) throw new Error('storeId must be a SHA-256 digest')
  return value
}

function boundedText(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 128) throw new Error(`${field} must be bounded text`)
  return value.trim()
}

function boundedInteger(value: number, field: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${field} must be between ${minimum} and ${maximum}`)
  }
  return value
}
