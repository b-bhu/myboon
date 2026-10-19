/**
 * #337 PR-B: an idempotent, re-runnable backfill of managed entity identity
 * into the real columns added by supabase/migrations/20261017120000_managed_entity_columns.sql
 * (#337 PR-A). Three phases run in this fixed order:
 *
 *   shared        linked managed rows copy summary, show_in_carousel and
 *                 metadata from their catalogue row; name/slug/type/aliases/
 *                 status are deliberately never touched.
 *   public_only   catalogue rows with no managed row are imported as linked
 *                 managed rows. The INSERT passes only id/identity_key/
 *                 catalog_entity_id/binding/created_operation: the #368 BEFORE
 *                 INSERT trigger fills the identity columns from the catalogue
 *                 (the linked path), and that is intentional.
 *   article_only  article-only managed rows (no catalog_entity_id) that are
 *                 still 'active' move to ARTICLE_ONLY_STATUS and are stamped
 *                 with a metadata marker, so a re-run is a no-op and a row
 *                 re-activated after review is never re-flagged.
 *
 * Candidates that collide with an existing article-only identity (name key,
 * alias key or slug) are never inserted; they are reported for #342 instead.
 * Write batches take pg_advisory_xact_lock(299, 4) — the same lock the V4
 * writers take — and a resumable cursor is persisted after every committed
 * batch and at every phase transition. The identical count keys are reported
 * in dry-run mode, where they mean what WOULD change under the same
 * statements executed inside one READ ONLY transaction that is rolled back.
 */

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { Pool, type PoolClient } from 'pg'
import { normalizeDatabaseCa } from '../signal-platform/database-ca'
import { entityIdentityKey, entityIdentityKeys } from './identity-key'

/**
 * The ONE place the backfill's target status for article-only rows lives.
 * Bucket may change the reviewed status here: a one-line change is enough,
 * because the metadata marker keeps previously flagged rows from being
 * re-flagged on any later run.
 */
export const ARTICLE_ONLY_STATUS = 'review' as const

/** Maximum and default keyset page size, shared by planning reads and write batches. */
export const BACKFILL_BATCH_SIZE = 200

/** Lease owner recorded for the backfill's own lease row. */
export const BACKFILL_LEASE_OWNER = 'entity-backfill-337'

/**
 * Deterministic operation id used as the created_operation of imported rows.
 * It satisfies the managed_knowledge_private.leases CHECK by construction
 * (progression-v2: + sha256 hex), and the lease row is inserted already
 * expired so it can never act as a live writer lease.
 */
export const BACKFILL_OPERATION_ID = `progression-v2:${createHash('sha256').update('myboon.entity_backfill.337.v1').digest('hex')}`

/** Metadata marker key that makes article-only flagging a one-shot. */
export const BACKFILL_MARKER_KEY = 'backfill_337'

const BACKFILL_REPORT_SCHEMA_VERSION = 'myboon.entity_backfill_337.report.v1'
const BACKFILL_CURSOR_SCHEMA_VERSION = 'myboon.entity_backfill_337.cursor.v1'

const DEFAULT_PAUSE_MS = 200
const MAX_PAUSE_MS = 60_000
/** The same advisory lock the V4 writers take (context_v1, article_writer_v1). */
const ADVISORY_LOCK_KEY_A = 299
const ADVISORY_LOCK_KEY_B = 4

export type BackfillPhase = 'shared' | 'public_only' | 'article_only' | 'done'
export type BackfillMode = 'dry_run' | 'write'
export type BackfillStatus = 'complete' | 'partial' | 'interrupted' | 'failed'

const PHASE_ORDER: readonly BackfillPhase[] = ['shared', 'public_only', 'article_only', 'done']

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

export interface BackfillCursor {
  schemaVersion: typeof BACKFILL_CURSOR_SCHEMA_VERSION
  operationId: string
  phase: BackfillPhase
  lastId: string | null
  updatedAt: string
}

export interface BackfillCounts {
  publicEntities: number
  managedEntities: number
  linkedManaged: number
  articleOnlyManaged: number
  publicOnlyCandidates: number
  collisionsSkipped: number
  sharedUpdated: number
  publicOnlyInserted: number
  articleOnlyFlagged: number
  batchesWritten: number
}

export interface BackfillCollisionMatch {
  managedEntityId: string
  managedName: string
  managedSlug: string
  kind: 'name_key' | 'alias_key' | 'slug'
  key: string
}

export interface BackfillCollision {
  publicEntityId: string
  publicName: string
  publicSlug: string
  matches: BackfillCollisionMatch[]
}

export interface BackfillNameKeyParityMismatch {
  id: string
  name: string
  sqlNameKey: string
  tsKey: string
}

export interface BackfillNameKeyDuplicateGroup {
  key: string
  publicEntityIds: string[]
}

export interface BackfillReport {
  schemaVersion: typeof BACKFILL_REPORT_SCHEMA_VERSION
  mode: BackfillMode
  status: BackfillStatus
  startedAt: string
  finishedAt: string
  batchSize: number
  articleOnlyStatus: string
  operationId: string
  counts: BackfillCounts
  collisions: BackfillCollision[]
  publicNameKeyDuplicates: BackfillNameKeyDuplicateGroup[]
  nameKeyParityMismatches: BackfillNameKeyParityMismatch[]
  warnings: string[]
  cursor: BackfillCursor | null
  /** Why a failed run stopped, with no connection material inside; null otherwise. */
  error: string | null
}

export interface BackfillArgs {
  write: boolean
  reportPath: string
  cursorPath: string | null
  batchSize: number
  pauseMs: number
  maxBatches: number | null
}

export interface BackfillRunOptions {
  pool: Pool
  write: boolean
  reportPath: string
  /** Required in write mode; accepted but never read or written in dry-run. */
  cursorPath?: string | null
  batchSize: number
  pauseMs: number
  maxBatches?: number
  /** Set stopped=true (e.g. from a signal handler) to stop after the current batch. */
  signal?: { stopped: boolean }
}

export interface BackfillCandidate {
  readonly id: string
  readonly name: string
  readonly slug: string
  readonly aliases: readonly string[]
}

export interface BackfillArticleOnlyRow {
  readonly id: string
  readonly name: string
  readonly slug: string
  readonly aliases: readonly string[]
  /** The row's SQL name_key column; '' when the row has no usable name key. */
  readonly nameKey: string
  /** A row created by this backfill operation never blocks (deterministic re-runs). */
  readonly createdOperation: string | null
}

interface ManagedScanRow extends BackfillCandidate {
  readonly nameKey: string
  readonly catalogEntityId: string | null
  readonly identityKey: string
  readonly createdOperation: string
}

interface PublicScanRow extends BackfillCandidate {
  readonly status: string
}

interface BackfillPlanning {
  readonly sharedIds: readonly string[]
  readonly publicOnlyIds: readonly string[]
  readonly articleOnlyIds: readonly string[]
}

interface BackfillRunState {
  counts: BackfillCounts
  warnings: string[]
  collisions: BackfillCollision[]
  publicNameKeyDuplicates: BackfillNameKeyDuplicateGroup[]
  nameKeyParityMismatches: BackfillNameKeyParityMismatch[]
  cursor: BackfillCursor | null
}

/** Pg connection for a statement: a Pool, or a PoolClient inside a transaction. */
type BackfillDb = Pool | PoolClient

/** Thrown when the stop flag fired between keyset pages; reported, never failed. */
class BackfillStoppedError extends Error {
  constructor() {
    super('The backfill was stopped between batches')
    this.name = 'BackfillStoppedError'
  }
}

// ---------------------------------------------------------------------------
// Pure helpers (exported, unit-tested without a database)
// ---------------------------------------------------------------------------

/** True for the exact uuid text Postgres returns (canonical lower case). */
export function isUuidText(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value)
}

/**
 * Host of a Postgres connection string, resolved the way libpq resolves it:
 * the `host` query parameter wins over the URL authority, so a socket URL
 * such as postgresql:///db?host=/var/run/postgresql reports the socket path,
 * and an IPv6 authority loses its brackets. An empty result means "no TCP
 * host" (default unix socket). A parse failure throws a TypeError that never
 * includes the URL text.
 */
export function backfillDatabaseHost(connectionString: string): string {
  // WHATWG URL rejects an empty host on an authority that carries credentials
  // (postgresql://u@/db?host=/tmp/sock — a socket shape libpq accepts).
  // Credentials never affect the resolved host, so a strict failure is
  // retried once without its userinfo; a second failure is the real error.
  let url: URL
  try {
    url = new URL(connectionString)
  } catch {
    try {
      url = new URL(connectionString.replace(/^(postgres(ql)?:\/\/)[^/?#]*@/i, '$1'))
    } catch {
      throw new TypeError('Invalid Postgres connection string: expected a postgres:// or postgresql:// URL')
    }
  }
  const queryHost = url.searchParams.get('host')
  if (queryHost !== null) return queryHost
  const hostname = decodeURIComponent(url.hostname)
  return hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname
}

/** Local connections (unix socket, localhost, 127.0.0.1) never need TLS. */
export function isLocalBackfillHost(host: string): boolean {
  const normalized = host.trim().toLowerCase()
  return normalized === '' || normalized.startsWith('/') || normalized === 'localhost' || normalized === '127.0.0.1'
}

/**
 * The backfill pool: at most 2 connections, a 20s statement timeout, a fixed
 * application_name, and TLS only for non-local hosts with optional CA
 * material from MYBOON_ENTITY_BACKFILL_DATABASE_CA. Construction opens no
 * connection, and the URL itself never appears in an error message.
 */
export function createBackfillPool(connectionString: string): Pool {
  const trimmed = typeof connectionString === 'string' ? connectionString.trim() : ''
  if (!/^postgres(ql)?:\/\//i.test(trimmed)) {
    throw new TypeError('MYBOON_ENTITY_BACKFILL_DATABASE_URL must be a postgres:// or postgresql:// URL')
  }
  const ca = normalizeDatabaseCa('MYBOON_ENTITY_BACKFILL_DATABASE_CA', process.env.MYBOON_ENTITY_BACKFILL_DATABASE_CA)
  const pool = new Pool({
    connectionString: trimmed,
    ssl: isLocalBackfillHost(backfillDatabaseHost(trimmed))
      ? false
      : { rejectUnauthorized: true, ...(ca ? { ca } : {}) },
    max: 2,
    connectionTimeoutMillis: 10_000,
    idleTimeoutMillis: 30_000,
    statement_timeout: 20_000,
    query_timeout: 25_000,
    application_name: 'myboon_entity_backfill_337',
  })
  // Idle connection errors must not crash the CLI or surface credentials.
  pool.on('error', () => {})
  return pool
}

const BACKFILL_VALUE_FLAGS = new Set(['--report', '--cursor', '--batch-size', '--pause-ms', '--max-batches'])

/**
 * Strict CLI parser in the style of run-reconcile-planning-dispatch.ts: every
 * value flag must appear exactly once with a value; --write switches to write
 * mode and requires --cursor; unknown, repeated or valueless arguments error.
 */
export function parseBackfillArgs(args: readonly string[]): BackfillArgs {
  const values = new Map<string, string>()
  let write = false
  for (let index = 0; index < args.length; index += 1) {
    const key = args[index]!
    if (key === '--write') {
      if (write) throw new Error('Duplicate --write')
      write = true
      continue
    }
    const value = args[index + 1]
    if (!BACKFILL_VALUE_FLAGS.has(key) || values.has(key) || !value?.trim() || value.startsWith('--')) {
      throw new Error(`Unknown, duplicated or valueless backfill argument: ${key}`)
    }
    values.set(key, value.trim())
    index += 1
  }
  const report = values.get('--report')
  if (!report) throw new Error('--report is required')
  const cursor = values.has('--cursor') ? resolve(values.get('--cursor')!) : null
  const batchSize = values.has('--batch-size')
    ? parseFlagInteger('--batch-size', values.get('--batch-size')!, 1, BACKFILL_BATCH_SIZE, 'between 1 and 200')
    : BACKFILL_BATCH_SIZE
  const pauseMs = values.has('--pause-ms')
    ? parseFlagInteger('--pause-ms', values.get('--pause-ms')!, 0, MAX_PAUSE_MS, `between 0 and ${MAX_PAUSE_MS}`)
    : DEFAULT_PAUSE_MS
  const maxBatches = values.has('--max-batches')
    ? parseFlagInteger('--max-batches', values.get('--max-batches')!, 1, Number.MAX_SAFE_INTEGER, 'a positive integer')
    : null
  if (write && cursor === null) throw new Error('--cursor is required in write mode')
  return {
    write,
    reportPath: resolve(report),
    cursorPath: cursor,
    batchSize,
    pauseMs,
    maxBatches,
  }
}

function parseFlagInteger(flag: string, raw: string, min: number, max: number, description: string): number {
  if (!/^-?[0-9]+$/.test(raw)) throw new Error(`${flag} must be an integer ${description}`)
  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${flag} must be an integer ${description}`)
  }
  return value
}

function isBackfillPhase(value: unknown): value is BackfillPhase {
  return typeof value === 'string' && (PHASE_ORDER as readonly string[]).includes(value)
}

/**
 * Strict cursor validation for load: exactly the five documented keys, the
 * current schema version and operation id, a known phase, and either null or
 * a (any-case, normalised to lower case) uuid as lastId.
 */
export function parseCursor(json: unknown): BackfillCursor {
  if (typeof json !== 'object' || json === null || Array.isArray(json)) {
    throw new Error('Invalid backfill cursor: expected a JSON object')
  }
  const record = json as Record<string, unknown>
  const keys = Object.keys(record)
  const expected = new Set(['schemaVersion', 'operationId', 'phase', 'lastId', 'updatedAt'])
  if (keys.length !== expected.size || keys.some((key) => !expected.has(key))) {
    throw new Error('Invalid backfill cursor: exactly schemaVersion, operationId, phase, lastId and updatedAt are required')
  }
  if (record.schemaVersion !== BACKFILL_CURSOR_SCHEMA_VERSION) {
    throw new Error(`Invalid backfill cursor: schemaVersion must be ${BACKFILL_CURSOR_SCHEMA_VERSION}`)
  }
  if (record.operationId !== BACKFILL_OPERATION_ID) {
    throw new Error('Invalid backfill cursor: operationId does not belong to this backfill operation')
  }
  if (!isBackfillPhase(record.phase)) {
    throw new Error('Invalid backfill cursor: phase must be shared, public_only, article_only or done')
  }
  let lastId: string | null = null
  if (record.lastId !== null) {
    const candidate = typeof record.lastId === 'string' ? record.lastId.toLowerCase() : undefined
    if (!isUuidText(candidate)) throw new Error('Invalid backfill cursor: lastId must be null or a uuid')
    lastId = candidate
  }
  if (typeof record.updatedAt !== 'string' || !Number.isFinite(Date.parse(record.updatedAt))) {
    throw new Error('Invalid backfill cursor: updatedAt must be an ISO date string')
  }
  return {
    schemaVersion: BACKFILL_CURSOR_SCHEMA_VERSION,
    operationId: record.operationId,
    phase: record.phase,
    lastId,
    updatedAt: record.updatedAt,
  }
}

/**
 * Candidates colliding with an article-only managed row are NOT inserted; the
 * caller reports them for #342 instead. Rows created by this backfill
 * operation never block, so collision detection stays deterministic across
 * interrupted and resumed runs. Match kinds, evaluated per candidate/row pair:
 *   name_key   entityIdentityKey(candidate.name) === row.nameKey (non-empty)
 *   alias_key  a shared non-empty identity key across name+aliases, evaluated
 *              only when name_key did not already match that row
 *   slug       lower(trim(slug)) equal on both sides (empty slugs never match)
 */
export function findCollisions(
  candidates: readonly BackfillCandidate[],
  articleOnlyRows: readonly BackfillArticleOnlyRow[],
): BackfillCollision[] {
  const blocking = articleOnlyRows.filter((row) => row.createdOperation !== BACKFILL_OPERATION_ID)
  const collisions: BackfillCollision[] = []
  for (const candidate of candidates) {
    const candidateNameKey = entityIdentityKey(candidate.name)
    const candidateKeys = entityIdentityKeys([candidate.name, ...candidate.aliases])
    const matches: BackfillCollisionMatch[] = []
    for (const row of blocking) {
      // alias_key is only evaluated when name_key did not already match this
      // row; slug matching is independent of both.
      const nameKeyMatched = Boolean(row.nameKey) && row.nameKey === candidateNameKey
      if (nameKeyMatched) {
        matches.push({ managedEntityId: row.id, managedName: row.name, managedSlug: row.slug, kind: 'name_key', key: candidateNameKey })
      }
      if (!nameKeyMatched) {
        const rowKeys = entityIdentityKeys([row.name, ...row.aliases])
        const shared = [...candidateKeys].filter((key) => rowKeys.has(key)).sort()
        if (shared.length > 0) {
          matches.push({ managedEntityId: row.id, managedName: row.name, managedSlug: row.slug, kind: 'alias_key', key: shared[0]! })
        }
      }
      const candidateSlug = candidate.slug.trim().toLowerCase()
      const rowSlug = row.slug.trim().toLowerCase()
      if (candidateSlug && rowSlug && candidateSlug === rowSlug) {
        matches.push({ managedEntityId: row.id, managedName: row.name, managedSlug: row.slug, kind: 'slug', key: candidateSlug })
      }
    }
    if (matches.length > 0) {
      collisions.push({ publicEntityId: candidate.id, publicName: candidate.name, publicSlug: candidate.slug, matches })
    }
  }
  return collisions
}

/**
 * The ids for the next write batch: the first batchSize ids strictly after
 * the last committed id (null cursor = from the start). Kept pure so the
 * keyset walk is unit-tested without a database. The caller must advance its
 * cursor with the returned batch's LAST id after the batch commits — leaving
 * the cursor unchanged would make the walk re-select the same batch forever.
 */
export function nextBatchIds(ids: readonly string[], lastId: string | null, batchSize: number): string[] {
  return ids.filter((id) => lastId === null || id > lastId).slice(0, batchSize)
}

// ---------------------------------------------------------------------------
// SQL
// ---------------------------------------------------------------------------

const PREFLIGHT_COLUMNS = ['name_key', 'status', 'show_in_carousel', 'metadata'] as const

const PREFLIGHT_SQL = `
  SELECT
    (SELECT count(*)::int FROM information_schema.columns
      WHERE table_schema = 'managed_knowledge_private' AND table_name = 'entities'
        AND column_name = ANY($1::text[])) AS columns_present,
    (SELECT count(*)::int FROM pg_trigger
      WHERE tgrelid = 'managed_knowledge_private.entities'::regclass
        AND tgname = 'managed_entities_fill_columns' AND NOT tgisinternal) AS triggers_present`

const MANAGED_SCAN_SQL = `
  SELECT id, name, slug, aliases, name_key, catalog_entity_id, identity_key, created_operation
  FROM managed_knowledge_private.entities
  WHERE id > $1::uuid
  ORDER BY id
  LIMIT $2`

const PUBLIC_SCAN_SQL = `
  SELECT id, name, slug, aliases, status
  FROM public.entities
  WHERE id > $1::uuid
  ORDER BY id
  LIMIT $2`

const SHARED_UPDATE_SQL = `
  UPDATE managed_knowledge_private.entities own
  SET summary = catalogue.summary,
      show_in_carousel = catalogue.show_in_carousel,
      metadata = catalogue.metadata,
      updated_at = greatest(own.updated_at, catalogue.updated_at)
  FROM public.entities catalogue
  WHERE own.catalog_entity_id = catalogue.id AND own.id = ANY($1::uuid[])
    AND (own.summary IS DISTINCT FROM catalogue.summary
      OR own.show_in_carousel IS DISTINCT FROM catalogue.show_in_carousel
      OR own.metadata IS DISTINCT FROM catalogue.metadata)
  RETURNING own.id`

const SHARED_WOULD_UPDATE_SQL = `
  SELECT own.id
  FROM managed_knowledge_private.entities own
  JOIN public.entities catalogue ON own.catalog_entity_id = catalogue.id
  WHERE own.id = ANY($1::uuid[])
    AND (own.summary IS DISTINCT FROM catalogue.summary
      OR own.show_in_carousel IS DISTINCT FROM catalogue.show_in_carousel
      OR own.metadata IS DISTINCT FROM catalogue.metadata)`

const PUBLIC_ONLY_INSERT_SQL = `
  INSERT INTO managed_knowledge_private.entities (id, identity_key, catalog_entity_id, binding, created_operation)
  SELECT catalogue.id,
         'catalog:' || catalogue.id::text,
         catalogue.id,
         jsonb_build_object(
           'id', catalogue.id, 'slug', catalogue.slug, 'name', catalogue.name, 'type', catalogue.type,
           'aliases', catalogue.aliases, 'summary', catalogue.summary, 'status', catalogue.status,
           'show_in_carousel', catalogue.show_in_carousel, 'metadata', catalogue.metadata,
           'created_at', catalogue.created_at, 'updated_at', catalogue.updated_at,
           'catalogEntityId', catalogue.id, 'identityKey', 'catalog:' || catalogue.id::text),
         $2
  FROM public.entities catalogue
  WHERE catalogue.id = ANY($1::uuid[])
    AND NOT EXISTS (SELECT 1 FROM managed_knowledge_private.entities managed
      WHERE managed.id = catalogue.id OR managed.catalog_entity_id = catalogue.id
        OR managed.identity_key = 'catalog:' || catalogue.id::text)
  ON CONFLICT DO NOTHING
  RETURNING id`

const PUBLIC_ONLY_WOULD_INSERT_SQL = `
  SELECT catalogue.id
  FROM public.entities catalogue
  WHERE catalogue.id = ANY($1::uuid[])
    AND NOT EXISTS (SELECT 1 FROM managed_knowledge_private.entities managed
      WHERE managed.id = catalogue.id OR managed.catalog_entity_id = catalogue.id
        OR managed.identity_key = 'catalog:' || catalogue.id::text)`

const ARTICLE_ONLY_UPDATE_SQL = `
  UPDATE managed_knowledge_private.entities
  SET status = $2,
      metadata = metadata || jsonb_build_object($3, jsonb_build_object(
        'article_only_review', true, 'previous_status', status)),
      updated_at = clock_timestamp()
  WHERE id = ANY($1::uuid[])
    AND catalog_entity_id IS NULL
    AND status = 'active'
    AND status IS DISTINCT FROM $2
    AND NOT (metadata ? $3)
  RETURNING id`

const ARTICLE_ONLY_WOULD_FLAG_SQL = `
  SELECT id
  FROM managed_knowledge_private.entities
  WHERE id = ANY($1::uuid[])
    AND catalog_entity_id IS NULL
    AND status = 'active'
    AND status IS DISTINCT FROM $2
    AND NOT (metadata ? $3)`

const LEASE_INSERT_SQL = `
  INSERT INTO managed_knowledge_private.leases (operation_id, owner, epoch, expires_at)
  VALUES ($1, $2, 1, clock_timestamp())
  ON CONFLICT (operation_id) DO NOTHING`

function phaseWriteStatement(phase: BackfillPhase, batchIds: readonly string[]): { text: string; values: unknown[] } {
  switch (phase) {
    case 'shared': return { text: SHARED_UPDATE_SQL, values: [batchIds] }
    case 'public_only': return { text: PUBLIC_ONLY_INSERT_SQL, values: [batchIds, BACKFILL_OPERATION_ID] }
    case 'article_only': return { text: ARTICLE_ONLY_UPDATE_SQL, values: [batchIds, ARTICLE_ONLY_STATUS, BACKFILL_MARKER_KEY] }
    case 'done': throw new RangeError('The done phase has no statement')
  }
}

function phaseDryStatement(phase: BackfillPhase, batchIds: readonly string[]): { text: string; values: unknown[] } {
  switch (phase) {
    case 'shared': return { text: SHARED_WOULD_UPDATE_SQL, values: [batchIds] }
    case 'public_only': return { text: PUBLIC_ONLY_WOULD_INSERT_SQL, values: [batchIds] }
    case 'article_only': return { text: ARTICLE_ONLY_WOULD_FLAG_SQL, values: [batchIds, ARTICLE_ONLY_STATUS, BACKFILL_MARKER_KEY] }
    case 'done': throw new RangeError('The done phase has no statement')
  }
}

function nextPhase(phase: BackfillPhase): BackfillPhase {
  const index = PHASE_ORDER.indexOf(phase)
  if (index < 0) throw new RangeError(`Unknown backfill phase: ${phase}`)
  return PHASE_ORDER[index + 1] ?? 'done'
}

// ---------------------------------------------------------------------------
// Boundary validation
// ---------------------------------------------------------------------------

function asRecord(row: unknown, context: string): Record<string, unknown> {
  if (typeof row !== 'object' || row === null) throw new TypeError(`${context}: query returned a non-object row`)
  return row as Record<string, unknown>
}

function requireUuid(record: Record<string, unknown>, column: string, context: string): string | null {
  const value = record[column]
  if (value === null) return null
  if (!isUuidText(value)) throw new TypeError(`${context}: column ${column} is not a lower-case uuid`)
  return value
}

function requireText(record: Record<string, unknown>, column: string, context: string): string {
  const value = record[column]
  if (typeof value !== 'string') throw new TypeError(`${context}: column ${column} is not text`)
  return value
}

function optionalText(record: Record<string, unknown>, column: string, context: string, warnings: string[]): string {
  const value = record[column]
  if (typeof value === 'string') return value
  if (value === null) {
    warnings.push(`${context}: column ${column} is null; treated as empty`)
    return ''
  }
  throw new TypeError(`${context}: column ${column} is not text`)
}

/**
 * Aliases tolerate non-array/null jsonb as [] and drop non-string entries,
 * but every tolerance is counted in the report's warnings.
 */
function normalizeAliases(value: unknown, context: string, warnings: string[]): string[] {
  if (value === null || value === undefined) return []
  if (!Array.isArray(value)) {
    warnings.push(`${context}: aliases is not an array; treated as empty`)
    return []
  }
  const aliases: string[] = []
  for (const entry of value) {
    if (typeof entry !== 'string') {
      warnings.push(`${context}: aliases contains a non-string entry; ignored`)
      continue
    }
    aliases.push(entry)
  }
  return aliases
}

function validateManagedRow(row: unknown, warnings: string[]): ManagedScanRow {
  const record = asRecord(row, 'managed entity scan')
  const id = requireUuid(record, 'id', 'managed entity scan')
  if (!id) throw new TypeError('managed entity scan: column id is null')
  const context = `managed entity ${id}`
  const name = requireText(record, 'name', context)
  if (!name.trim()) throw new TypeError(`${context} has an empty name column; the #368 columns are not populated`)
  return {
    id,
    name,
    slug: optionalText(record, 'slug', context, warnings),
    aliases: normalizeAliases(record.aliases, context, warnings),
    nameKey: requireText(record, 'name_key', context),
    catalogEntityId: requireUuid(record, 'catalog_entity_id', context),
    identityKey: requireText(record, 'identity_key', context),
    createdOperation: requireText(record, 'created_operation', context),
  }
}

function validatePublicRow(row: unknown, warnings: string[]): PublicScanRow {
  const record = asRecord(row, 'public entity scan')
  const id = requireUuid(record, 'id', 'public entity scan')
  if (!id) throw new TypeError('public entity scan: column id is null')
  const context = `public entity ${id}`
  const name = requireText(record, 'name', context)
  if (!name.trim()) throw new TypeError(`${context} has an empty name column`)
  return {
    id,
    name,
    slug: optionalText(record, 'slug', context, warnings),
    aliases: normalizeAliases(record.aliases, context, warnings),
    status: optionalText(record, 'status', context, warnings),
  }
}

/** Only valid uuid ids are accepted back from RETURNING, so counts stay trustworthy. */
function returnedBatchCount(rows: unknown[], context: string): number {
  for (const row of rows) {
    const record = asRecord(row, context)
    if (!isUuidText(record.id)) throw new TypeError(`${context}: returned row id is not a lower-case uuid`)
  }
  return rows.length
}

// ---------------------------------------------------------------------------
// File IO (cursor and report), both atomic tmp + rename
// ---------------------------------------------------------------------------

function writeJsonFileAtomic(path: string, value: unknown): void {
  const directory = dirname(path)
  if (directory && directory !== '.') mkdirSync(directory, { recursive: true })
  const temporary = `${path}.tmp-${process.pid}`
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8' })
  renameSync(temporary, path)
}

function defaultCursor(): BackfillCursor {
  return {
    schemaVersion: BACKFILL_CURSOR_SCHEMA_VERSION,
    operationId: BACKFILL_OPERATION_ID,
    phase: 'shared',
    lastId: null,
    updatedAt: new Date().toISOString(),
  }
}

function loadCursor(cursorPath: string): BackfillCursor {
  if (!existsSync(cursorPath)) return defaultCursor()
  const raw = readFileSync(cursorPath, { encoding: 'utf8' })
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error(`The backfill cursor file ${cursorPath} is not valid JSON`)
  }
  return parseCursor(parsed)
}

function persistCursor(state: BackfillRunState, cursorPath: string, phase: BackfillPhase, lastId: string | null): void {
  state.cursor = {
    schemaVersion: BACKFILL_CURSOR_SCHEMA_VERSION,
    operationId: BACKFILL_OPERATION_ID,
    phase,
    lastId,
    updatedAt: new Date().toISOString(),
  }
  writeJsonFileAtomic(cursorPath, state.cursor)
}

// ---------------------------------------------------------------------------
// Planning pass (read-only, keyset pagination, never OFFSET)
// ---------------------------------------------------------------------------

function emptyCounts(): BackfillCounts {
  return {
    publicEntities: 0,
    managedEntities: 0,
    linkedManaged: 0,
    articleOnlyManaged: 0,
    publicOnlyCandidates: 0,
    collisionsSkipped: 0,
    sharedUpdated: 0,
    publicOnlyInserted: 0,
    articleOnlyFlagged: 0,
    batchesWritten: 0,
  }
}

function createRunState(): BackfillRunState {
  return {
    counts: emptyCounts(),
    warnings: [],
    collisions: [],
    publicNameKeyDuplicates: [],
    nameKeyParityMismatches: [],
    cursor: null,
  }
}

async function scanManagedRows(db: BackfillDb, batchSize: number, warnings: string[], stop: { stopped: boolean }): Promise<ManagedScanRow[]> {
  const rows: ManagedScanRow[] = []
  let cursor = '00000000-0000-0000-0000-000000000000'
  for (;;) {
    if (stop.stopped) throw new BackfillStoppedError()
    const result = await db.query(MANAGED_SCAN_SQL, [cursor, batchSize])
    for (const row of result.rows) {
      const validated = validateManagedRow(row, warnings)
      rows.push(validated)
      cursor = validated.id
    }
    if (result.rows.length < batchSize) break
  }
  return rows
}

async function scanPublicRows(db: BackfillDb, batchSize: number, warnings: string[], stop: { stopped: boolean }): Promise<PublicScanRow[]> {
  const rows: PublicScanRow[] = []
  let cursor = '00000000-0000-0000-0000-000000000000'
  for (;;) {
    if (stop.stopped) throw new BackfillStoppedError()
    const result = await db.query(PUBLIC_SCAN_SQL, [cursor, batchSize])
    for (const row of result.rows) {
      const validated = validatePublicRow(row, warnings)
      rows.push(validated)
      cursor = validated.id
    }
    if (result.rows.length < batchSize) break
  }
  return rows
}

function findPublicNameKeyDuplicates(publicRows: readonly PublicScanRow[]): BackfillNameKeyDuplicateGroup[] {
  const groups = new Map<string, string[]>()
  for (const row of publicRows) {
    const key = entityIdentityKey(row.name)
    if (!key) continue
    const ids = groups.get(key) ?? []
    ids.push(row.id)
    groups.set(key, ids)
  }
  return [...groups.entries()]
    .filter(([, ids]) => ids.length > 1)
    .map(([key, ids]) => ({ key, publicEntityIds: ids }))
    .sort((left, right) => (left.key < right.key ? -1 : left.key > right.key ? 1 : 0))
}

function checkNameKeyParity(managedRows: readonly ManagedScanRow[]): BackfillNameKeyParityMismatch[] {
  const mismatches: BackfillNameKeyParityMismatch[] = []
  for (const row of managedRows) {
    const tsKey = entityIdentityKey(row.name)
    if (tsKey !== row.nameKey) mismatches.push({ id: row.id, name: row.name, sqlNameKey: row.nameKey, tsKey })
  }
  return mismatches
}

async function preflight(db: BackfillDb): Promise<void> {
  const result = await db.query(PREFLIGHT_SQL, [PREFLIGHT_COLUMNS])
  const record = asRecord(result.rows[0], 'managed entity preflight')
  if (record.columns_present !== PREFLIGHT_COLUMNS.length || record.triggers_present !== 1) {
    throw new Error('The #368 managed entity columns are not applied; nothing to backfill')
  }
}

/**
 * The full read-only planning pass over ALL managed and public rows: two
 * keyset scans, boundary validation, name_key parity, public-only candidates,
 * collisions (reported for #342, never blocking for anything else) and the
 * informational public name-key duplicate groups. Returns the per-phase id
 * lists; every list is sorted by id because the scans are.
 */
async function planBackfill(db: BackfillDb, batchSize: number, stop: { stopped: boolean }, state: BackfillRunState): Promise<BackfillPlanning> {
  const managedRows = await scanManagedRows(db, batchSize, state.warnings, stop)
  const publicRows = await scanPublicRows(db, batchSize, state.warnings, stop)

  state.nameKeyParityMismatches = checkNameKeyParity(managedRows)

  const linkedRows = managedRows.filter((row) => row.catalogEntityId !== null)
  const articleOnlyRows = managedRows.filter((row) => row.catalogEntityId === null)

  const managedIds = new Set(managedRows.map((row) => row.id))
  const linkedCatalogIds = new Set(linkedRows.map((row) => row.catalogEntityId as string))
  const managedIdentityKeys = new Set(managedRows.map((row) => row.identityKey))
  const candidates: BackfillCandidate[] = publicRows
    .filter((row) => !managedIds.has(row.id)
      && !linkedCatalogIds.has(row.id)
      && !managedIdentityKeys.has(`catalog:${row.id}`))
    .map((row) => ({ id: row.id, name: row.name, slug: row.slug, aliases: row.aliases }))

  const collisions = findCollisions(candidates, articleOnlyRows.map((row) => ({
    id: row.id, name: row.name, slug: row.slug, aliases: row.aliases, nameKey: row.nameKey, createdOperation: row.createdOperation,
  })))
  const collidingIds = new Set(collisions.map((collision) => collision.publicEntityId))

  state.counts.publicEntities = publicRows.length
  state.counts.managedEntities = managedRows.length
  state.counts.linkedManaged = linkedRows.length
  state.counts.articleOnlyManaged = articleOnlyRows.length
  state.counts.publicOnlyCandidates = candidates.length
  state.counts.collisionsSkipped = collisions.length
  state.collisions = collisions
  state.publicNameKeyDuplicates = findPublicNameKeyDuplicates(publicRows)

  return {
    sharedIds: linkedRows.map((row) => row.id),
    publicOnlyIds: candidates.filter((candidate) => !collidingIds.has(candidate.id)).map((candidate) => candidate.id),
    articleOnlyIds: articleOnlyRows.map((row) => row.id),
  }
}

/**
 * The planning pass inside one REPEATABLE READ, READ ONLY transaction so all
 * phase decisions come from a single snapshot in both modes. Write mode
 * commits it before any phase runs; dry-run keeps it open for the would-change
 * statements and rolls it back at the end.
 */
async function planBackfillInTransaction(pool: Pool, batchSize: number, stop: { stopped: boolean }, state: BackfillRunState): Promise<BackfillPlanning> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
    const planning = await planBackfill(client, batchSize, stop, state)
    await client.query('COMMIT')
    return planning
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    throw error
  } finally {
    client.release()
  }
}

async function sleep(ms: number): Promise<void> {
  await new Promise<void>((resolveSleep) => {
    setTimeout(resolveSleep, ms)
  })
}

// ---------------------------------------------------------------------------
// Phase execution
// ---------------------------------------------------------------------------

function applyBatchCount(state: BackfillRunState, phase: BackfillPhase, count: number): void {
  if (phase === 'shared') state.counts.sharedUpdated += count
  else if (phase === 'public_only') state.counts.publicOnlyInserted += count
  else if (phase === 'article_only') state.counts.articleOnlyFlagged += count
}

/**
 * One committed write batch: BEGIN, the same advisory lock the V4 writers
 * take, the phase statement scoped to this batch's ids, COMMIT. The caller
 * persists the cursor only after this transaction has committed.
 */
async function runWriteBatch(pool: Pool, phase: BackfillPhase, batchIds: readonly string[]): Promise<number> {
  const { text, values } = phaseWriteStatement(phase, batchIds)
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query('SELECT pg_advisory_xact_lock($1, $2)', [ADVISORY_LOCK_KEY_A, ADVISORY_LOCK_KEY_B])
    const result = await client.query(text, values)
    await client.query('COMMIT')
    return returnedBatchCount(result.rows, `${phase} backfill batch`)
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    throw error
  } finally {
    client.release()
  }
}

/**
 * The import lease is written once per write run, in its own committed
 * transaction, before the public_only phase. It is already expired on
 * purpose: expires_at is the insert moment, so the writers' stale-lease check
 * always rejects it and it can never act as a live writer lease. Re-runs hit
 * ON CONFLICT DO NOTHING, which keeps interrupted/resumed runs deterministic.
 */
async function writeBackfillLease(pool: Pool): Promise<void> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query(LEASE_INSERT_SQL, [BACKFILL_OPERATION_ID, BACKFILL_LEASE_OWNER])
    await client.query('COMMIT')
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    throw error
  } finally {
    client.release()
  }
}

function phaseLists(planning: BackfillPlanning): Record<BackfillPhase, readonly string[]> {
  return { shared: planning.sharedIds, public_only: planning.publicOnlyIds, article_only: planning.articleOnlyIds, done: [] }
}

async function runWritePhases(
  pool: Pool,
  planning: BackfillPlanning,
  cursorPath: string,
  batchSize: number,
  pauseMs: number,
  maxBatches: number | null,
  stop: { stopped: boolean },
  state: BackfillRunState,
): Promise<BackfillStatus> {
  const lists = phaseLists(planning)
  const started = state.cursor!
  let phase = started.phase
  let lastId = started.lastId
  let leaseWritten = false
  for (;;) {
    if (phase === 'done') return 'complete'
    // An operator stop wins over the maxBatches cap: the committed batches
    // are already durable, and the cursor below is already up to date.
    if (stop.stopped) return 'interrupted'
    if (maxBatches !== null && state.counts.batchesWritten >= maxBatches) return 'partial'
    if (phase === 'public_only' && !leaseWritten) {
      await writeBackfillLease(pool)
      leaseWritten = true
    }
    const batchIds = nextBatchIds(lists[phase], lastId, batchSize)
    if (batchIds.length === 0) {
      phase = nextPhase(phase)
      lastId = null
      persistCursor(state, cursorPath, phase, null)
      continue
    }
    const changed = await runWriteBatch(pool, phase, batchIds)
    applyBatchCount(state, phase, changed)
    state.counts.batchesWritten += 1
    // The local keyset cursor must advance with the committed batch's last id:
    // a persisted cursor alone would re-select the same batch and loop forever.
    lastId = batchIds[batchIds.length - 1]!
    persistCursor(state, cursorPath, phase, lastId)
    if (pauseMs > 0) await sleep(pauseMs)
  }
}

async function runDryRunPhases(
  client: PoolClient,
  planning: BackfillPlanning,
  batchSize: number,
  stop: { stopped: boolean },
  state: BackfillRunState,
): Promise<BackfillStatus> {
  const lists = phaseLists(planning)
  for (const phase of ['shared', 'public_only', 'article_only'] as const) {
    const ids = lists[phase]
    for (let start = 0; start < ids.length; start += batchSize) {
      if (stop.stopped) return 'interrupted'
      const { text, values } = phaseDryStatement(phase, ids.slice(start, start + batchSize))
      const result = await client.query(text, values)
      applyBatchCount(state, phase, returnedBatchCount(result.rows, `${phase} dry-run statement`))
    }
  }
  return 'complete'
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

function validateRunOptions(options: BackfillRunOptions): {
  pool: Pool
  write: boolean
  reportPath: string
  cursorPath: string | null
  batchSize: number
  pauseMs: number
  maxBatches: number | null
} {
  const pool = options?.pool as Pool | undefined
  if (!pool || typeof pool.query !== 'function') throw new TypeError('runBackfill requires a pg Pool')
  if (typeof options.reportPath !== 'string' || !options.reportPath.trim()) {
    throw new TypeError('runBackfill requires a report path')
  }
  const cursorPath = options.cursorPath ?? null
  if (options.write && !cursorPath) throw new TypeError('runBackfill requires a cursor path in write mode')
  if (!Number.isSafeInteger(options.batchSize) || options.batchSize < 1 || options.batchSize > BACKFILL_BATCH_SIZE) {
    throw new RangeError(`runBackfill batchSize must be an integer between 1 and ${BACKFILL_BATCH_SIZE}`)
  }
  if (!Number.isSafeInteger(options.pauseMs) || options.pauseMs < 0 || options.pauseMs > MAX_PAUSE_MS) {
    throw new RangeError(`runBackfill pauseMs must be an integer between 0 and ${MAX_PAUSE_MS}`)
  }
  if (options.maxBatches !== undefined && (!Number.isSafeInteger(options.maxBatches) || options.maxBatches < 1)) {
    throw new RangeError('runBackfill maxBatches must be a positive integer when given')
  }
  return {
    pool,
    write: options.write,
    reportPath: options.reportPath,
    cursorPath,
    batchSize: options.batchSize,
    pauseMs: options.pauseMs,
    maxBatches: options.maxBatches ?? null,
  }
}

/**
 * Run the backfill end to end. The report is always written (complete,
 * partial, interrupted and also failed, with an error message that carries no
 * connection material); in write mode the cursor advances only after
 * committed batches, so any failure resumes from the persisted state.
 */
export async function runBackfill(options: BackfillRunOptions): Promise<BackfillReport> {
  const validated = validateRunOptions(options)
  const stop = options.signal ?? { stopped: false }
  const startedAt = new Date().toISOString()
  const state = createRunState()
  let status: BackfillStatus = 'complete'
  let failure: unknown = null
  try {
    if (validated.write) {
      state.cursor = loadCursor(validated.cursorPath!)
      await preflight(validated.pool)
      const planning = await planBackfillInTransaction(validated.pool, validated.batchSize, stop, state)
      if (state.nameKeyParityMismatches.length > 0) {
        const first = state.nameKeyParityMismatches[0]!
        throw new Error(
          `Managed entity name_key parity mismatch on ${state.nameKeyParityMismatches.length} row(s); `
          + `first: id ${first.id} sqlNameKey "${first.sqlNameKey}" vs TypeScript entityIdentityKey "${first.tsKey}"; aborting before any write`,
        )
      }
      status = await runWritePhases(
        validated.pool, planning, validated.cursorPath!, validated.batchSize, validated.pauseMs, validated.maxBatches, stop, state,
      )
    } else {
      const client = await validated.pool.connect()
      let began = false
      try {
        await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
        began = true
        await preflight(client)
        const planning = await planBackfill(client, validated.batchSize, stop, state)
        // Dry-run only reports parity mismatches; dry-run never throws for them.
        status = await runDryRunPhases(client, planning, validated.batchSize, stop, state)
        await client.query('ROLLBACK')
      } catch (error) {
        if (began) await client.query('ROLLBACK').catch(() => {})
        throw error
      } finally {
        client.release()
      }
    }
  } catch (error) {
    if (error instanceof BackfillStoppedError) status = 'interrupted'
    else {
      status = 'failed'
      failure = error
    }
  }
  const report: BackfillReport = {
    schemaVersion: BACKFILL_REPORT_SCHEMA_VERSION,
    mode: validated.write ? 'write' : 'dry_run',
    status,
    startedAt,
    finishedAt: new Date().toISOString(),
    batchSize: validated.batchSize,
    articleOnlyStatus: ARTICLE_ONLY_STATUS,
    operationId: BACKFILL_OPERATION_ID,
    counts: state.counts,
    collisions: state.collisions,
    publicNameKeyDuplicates: state.publicNameKeyDuplicates,
    nameKeyParityMismatches: state.nameKeyParityMismatches,
    warnings: state.warnings,
    cursor: state.cursor,
    error: failure instanceof Error ? failure.message : failure === null ? null : String(failure),
  }
  writeJsonFileAtomic(validated.reportPath, report)
  return report
}