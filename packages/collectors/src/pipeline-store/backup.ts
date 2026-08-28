/**
 * Backup + restore routine for the SQLite pipeline store.
 *
 * Why this exists: pipeline state is moving off managed Postgres (which
 * backed itself up) onto a SQLite file on a VPS (whose disk does not).
 * Without a verified backup this migration is a net reduction in safety.
 * A backup that has never been restored is not a backup - which is why
 * `verifyPipelineBackup` and the restore round-trip exist alongside the
 * backup itself, not as an afterthought.
 *
 * Backup mechanism: this uses node:sqlite's online backup API
 * (`sqlite.backup(sourceDb, destPath)`), which wraps SQLite's real
 * `sqlite3_backup_*` C API - the same mechanism the `sqlite3` CLI's
 * `.backup` command uses. It copies pages under a lock that is safe to run
 * against a live WAL-mode database, unlike `fs.copyFile`, which can read a
 * torn/inconsistent set of pages off a database that is being written to
 * concurrently.
 *
 * Note: `DatabaseSync` instances do NOT expose a `.backup()` *method* on
 * this Node version (v24.10.0) - `Object.getOwnPropertyNames` on its
 * prototype confirms it is absent. What node:sqlite exports instead is a
 * module-level `backup(sourceDb, path, options?)` function that performs
 * the same online backup. It is used here in preference to the `VACUUM
 * INTO` fallback because it is the more direct, purpose-built API for
 * exactly this job (incremental, pausable, page-level copy) rather than a
 * SQL statement that happens to produce a safe copy as a side effect.
 * `VACUUM INTO` remains a valid alternative (atomic and WAL-safe) if a
 * future Node version ever removes the `backup` export.
 */

import { createRequire } from 'node:module'
import { createHash, randomUUID } from 'node:crypto'
import {
  copyFileSync,
  linkSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'

const nodeRequire = createRequire(__filename)
const { DatabaseSync, backup: sqliteBackup } = nodeRequire('node:sqlite') as {
  DatabaseSync: new (path: string, options?: { readOnly?: boolean; open?: boolean }) => SqliteDatabase
  backup: (
    source: SqliteDatabase,
    destination: string,
    options?: { rate?: number; progress?: (info: { totalPages: number; remainingPages: number }) => void }
  ) => Promise<number>
}

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

const COLLECTORS_PACKAGE_DIR = resolve(__dirname, '..', '..')
const DEFAULT_SOURCE_PATH = resolve(COLLECTORS_PACKAGE_DIR, '.data', 'pipeline.sqlite')
const DEFAULT_BACKUP_DIR = resolve(COLLECTORS_PACKAGE_DIR, '.data', 'backups')

// Every table the pipeline store owns. Kept in one place so backup and
// verify agree on exactly what "the data" means; a table added to the
// schema in sqlite-store.ts must be added here too.
const PIPELINE_TABLES = [
  'pipeline_watchlist',
  'pipeline_candidates',
  'pipeline_research',
  'pipeline_editor_decisions',
  'pipeline_editor_drafts',
  'pipeline_runs',
  'signal_platform_signals',
  'signal_platform_signal_observations',
  'signal_platform_triage_decisions',
  'signal_platform_research_work',
  'signal_platform_evidence',
  'signal_platform_research_packets',
  'signal_platform_recovery_events',
  'signal_execution_events',
  'signal_platform_research_shadow_results',
  'entity_manager_shadow_observations',
  'deep_research_active_executions',
] as const

const NEWS_TABLES = [
  'news_source_runs',
  'news_candidate_observations',
  'news_research_results',
  'signal_platform_signals',
  'signal_platform_signal_observations',
  'signal_platform_triage_decisions',
  'signal_platform_research_work',
  'signal_platform_evidence',
  'signal_platform_research_packets',
  'signal_platform_recovery_events',
  'signal_execution_events',
  'signal_platform_research_shadow_results',
  'entity_manager_shadow_observations',
  'deep_research_active_executions',
] as const

// The shared signal ledger is additive and may live in either legacy DB. Old
// databases remain valid until a SqliteExecutionLedger first opens them.
const OPTIONAL_TABLES = new Set<string>([
  'signal_platform_signals',
  'signal_platform_signal_observations',
  'signal_platform_triage_decisions',
  'signal_platform_research_work',
  'signal_platform_evidence',
  'signal_platform_research_packets',
  'signal_platform_recovery_events',
  'signal_execution_events',
  'signal_platform_research_shadow_results',
  'entity_manager_shadow_observations',
  'deep_research_active_executions',
])

const BACKUP_FILE_PREFIX = 'pipeline-'
const BACKUP_FILE_SUFFIX = '.sqlite'
const BACKUP_MANIFEST_SUFFIX = '.manifest.json'
export const SQLITE_BACKUP_MANIFEST_SCHEMA_VERSION = 'myboon.sqlite_backup_manifest.v1' as const

export type SqliteBackupStoreKind = 'pipeline' | 'news'

export interface SqliteBackupManifest {
  schemaVersion: typeof SQLITE_BACKUP_MANIFEST_SCHEMA_VERSION
  store: SqliteBackupStoreKind
  createdAt: string
  /** Identifies the source without disclosing its directory. */
  source: { fileName: string; pathSha256: string }
  backup: { fileName: string; sha256: string; sizeBytes: number }
  integrity: string
  sqliteSchema: { userVersion: number; sha256: string }
  tableCounts: Record<string, number>
}

export interface PipelineBackupResult {
  path: string
  manifestPath: string
  manifest: SqliteBackupManifest
  sizeBytes: number
  /** Counts read back from the freshly written backup FILE. */
  tableCounts: Record<string, number>
  /**
   * Counts read from the SOURCE database immediately after the backup
   * completed (same connection, before close). This is what
   * verifyPipelineBackup should receive as `expected` - comparing the backup
   * against the backup's own counts can never detect a dropped row (PR
   * review finding).
   */
  sourceTableCounts: Record<string, number>
  createdAt: string
}

export interface PipelineBackupVerification {
  ok: boolean
  integrity: string
  tableCounts: Record<string, number>
  mismatches: string[]
  manifestPath: string
  manifest: SqliteBackupManifest | null
}

export interface PipelineRestoreResult {
  targetPath: string
  tableCounts: Record<string, number>
  verified: boolean
  backupSha256: string
}

function filenameSafeTimestamp(iso: string): string {
  let canonical = false
  try {
    canonical = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(iso) && new Date(iso).toISOString() === iso
  } catch { canonical = false }
  if (!canonical) {
    throw new Error('Backup createdAt must be a canonical ISO-8601 UTC timestamp')
  }
  return iso.replace(/:/g, '-').replace(/\./g, '-')
}

function openReadWrite(path: string): SqliteDatabase {
  return new DatabaseSync(path)
}

function openReadOnly(path: string): SqliteDatabase {
  return new DatabaseSync(path, { readOnly: true, open: true })
}

function readTableCounts(db: SqliteDatabase): Record<string, number> {
  return readSelectedTableCounts(db, PIPELINE_TABLES)
}

function readSelectedTableCounts(db: SqliteDatabase, tables: readonly string[]): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const table of tables) {
    if (OPTIONAL_TABLES.has(table)) {
      const exists = db.prepare(
        "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?"
      ).get(table) as Record<string, unknown> | undefined
      if (!exists) continue
    }
    const row = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as Record<string, unknown>
    const raw = row?.n
    counts[table] = typeof raw === 'bigint' ? Number(raw) : Number(raw ?? 0)
  }
  return counts
}

async function backupSqliteStore(options: {
  sourcePath: string
  backupDir: string
  createdAt: string
  prefix: string
  tables: readonly string[]
  store: SqliteBackupStoreKind
}): Promise<PipelineBackupResult> {
  mkdirSync(options.backupDir, { recursive: true })
  const backupPath = join(
    options.backupDir,
    `${options.prefix}${filenameSafeTimestamp(options.createdAt)}${BACKUP_FILE_SUFFIX}`
  )
  const manifestPath = backupManifestPath(backupPath)
  assertBackupOutputsAbsent(backupPath, manifestPath)

  const temporaryPath = join(options.backupDir, `.${basename(backupPath)}.${process.pid}.${randomUUID()}.tmp`)
  const temporaryManifestPath = `${temporaryPath}${BACKUP_MANIFEST_SUFFIX}`

  const source = openReadWrite(options.sourcePath)
  let sourceTableCounts: Record<string, number>
  try {
    await sqliteBackup(source, temporaryPath)
    sourceTableCounts = readSelectedTableCounts(source, options.tables)
  } catch (error) {
    rmSync(temporaryPath, { force: true })
    throw error
  } finally {
    source.close()
  }

  let backupDb: SqliteDatabase
  try {
    backupDb = openReadOnly(temporaryPath)
  } catch (error) {
    rmSync(temporaryPath, { force: true })
    throw error
  }
  let tableCounts: Record<string, number>
  let integrity: string
  let sqliteSchema: SqliteBackupManifest['sqliteSchema']
  try {
    integrity = readIntegrityCheck(backupDb)
    if (integrity !== 'ok') throw new Error(`New backup failed integrity verification: ${integrity}`)
    tableCounts = readSelectedTableCounts(backupDb, options.tables)
    sqliteSchema = readSchemaIdentity(backupDb)
  } catch (error) {
    rmSync(temporaryPath, { force: true })
    throw error
  } finally {
    backupDb.close()
  }

  const manifest: SqliteBackupManifest = {
    schemaVersion: SQLITE_BACKUP_MANIFEST_SCHEMA_VERSION,
    store: options.store,
    createdAt: options.createdAt,
    source: {
      fileName: basename(options.sourcePath),
      pathSha256: sha256(Buffer.from(resolve(options.sourcePath), 'utf8')),
    },
    backup: {
      fileName: basename(backupPath),
      sha256: sha256(readFileSync(temporaryPath)),
      sizeBytes: fileSize(temporaryPath),
    },
    integrity,
    sqliteSchema,
    tableCounts,
  }

  try {
    writeFileSync(temporaryManifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
    publishNoReplace(temporaryPath, backupPath)
    try {
      publishNoReplace(temporaryManifestPath, manifestPath)
    } catch (error) {
      // The database link was created by this invocation. Remove that link so
      // a manifest collision cannot leave an apparently usable orphan backup.
      unlinkSync(backupPath)
      throw error
    }
  } finally {
    rmSync(temporaryPath, { force: true })
    rmSync(temporaryManifestPath, { force: true })
  }

  return {
    path: backupPath,
    manifestPath,
    manifest,
    sizeBytes: fileSize(backupPath),
    tableCounts,
    sourceTableCounts,
    createdAt: options.createdAt,
  }
}

function readIntegrityCheck(db: SqliteDatabase): string {
  const row = db.prepare('PRAGMA integrity_check').get() as Record<string, unknown> | undefined
  const value = row?.integrity_check
  return typeof value === 'string' ? value : String(value ?? 'unknown')
}

function fileSize(path: string): number {
  return statSync(path).size
}

export function backupManifestPath(backupPath: string): string {
  return `${resolve(backupPath)}${BACKUP_MANIFEST_SUFFIX}`
}

function readSchemaIdentity(db: SqliteDatabase): SqliteBackupManifest['sqliteSchema'] {
  const versionRow = db.prepare('PRAGMA user_version').get() as Record<string, unknown> | undefined
  const rawVersion = versionRow?.user_version
  const userVersion = typeof rawVersion === 'bigint' ? Number(rawVersion) : Number(rawVersion ?? 0)
  const schemaRows = db.prepare(
    "SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name"
  ).all() as Array<Record<string, unknown>>
  return {
    userVersion,
    sha256: sha256(Buffer.from(JSON.stringify(schemaRows), 'utf8')),
  }
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function assertBackupOutputsAbsent(backupPath: string, manifestPath: string): void {
  for (const path of [backupPath, manifestPath]) {
    try {
      statSync(path)
      throw new Error(`Refusing to replace existing backup output "${path}"`)
    } catch (error) {
      if (isNodeError(error) && error.code === 'ENOENT') continue
      throw error
    }
  }
}

function publishNoReplace(sourcePath: string, targetPath: string): void {
  try {
    linkSync(sourcePath, targetPath)
  } catch (error) {
    if (isNodeError(error) && error.code === 'EEXIST') {
      throw new Error(`Refusing to replace existing backup output "${targetPath}"`)
    }
    throw error
  }
}

/**
 * Runs SQLite's online backup mechanism (node:sqlite's `backup()`, which
 * wraps `sqlite3_backup_*`) against a live source database and writes the
 * result to `<backupDir>/pipeline-<timestamp>.sqlite`.
 *
 * Table counts are read back from the freshly written backup FILE, not the
 * source database - that is the first half of proving the backup is real
 * (the other half is `verifyPipelineBackup`, which a caller should run next).
 */
export async function backupPipelineStore(options?: {
  sourcePath?: string
  backupDir?: string
  now?: string
}): Promise<PipelineBackupResult> {
  const sourcePath = resolve(options?.sourcePath ?? DEFAULT_SOURCE_PATH)
  const backupDir = resolve(options?.backupDir ?? DEFAULT_BACKUP_DIR)
  const createdAt = options?.now ?? new Date().toISOString()
  return backupSqliteStore({
    sourcePath, backupDir, createdAt, prefix: BACKUP_FILE_PREFIX, tables: PIPELINE_TABLES, store: 'pipeline',
  })
}

export async function backupNewsStore(options?: {
  sourcePath?: string
  backupDir?: string
  now?: string
}): Promise<PipelineBackupResult> {
  return backupSqliteStore({
    sourcePath: resolve(options?.sourcePath ?? resolve(COLLECTORS_PACKAGE_DIR, '.data', 'news.sqlite')),
    backupDir: resolve(options?.backupDir ?? DEFAULT_BACKUP_DIR),
    createdAt: options?.now ?? new Date().toISOString(),
    prefix: 'news-',
    tables: NEWS_TABLES,
    store: 'news',
  })
}

/**
 * Opens a backup file read-only and verifies it is actually restorable:
 * runs `PRAGMA integrity_check`, counts rows in every pipeline table, and
 * (if `expected` counts are supplied) reports any mismatch. This is the
 * genuine restore-verification step - it opens and reads the file rather
 * than trusting whatever `backupPipelineStore` claims.
 */
export async function verifyPipelineBackup(
  backupPath: string,
  expected?: Record<string, number>
): Promise<PipelineBackupVerification> {
  return verifySqliteBackup(backupPath, 'pipeline', PIPELINE_TABLES, expected)
}

export async function verifyNewsBackup(
  backupPath: string,
  expected?: Record<string, number>
): Promise<PipelineBackupVerification> {
  return verifySqliteBackup(backupPath, 'news', NEWS_TABLES, expected)
}

async function verifySqliteBackup(
  backupPath: string,
  store: SqliteBackupStoreKind,
  tables: readonly string[],
  expected?: Record<string, number>,
  manifestOverride?: SqliteBackupManifest,
): Promise<PipelineBackupVerification> {
  const resolvedBackupPath = resolve(backupPath)
  const manifestPath = backupManifestPath(resolvedBackupPath)
  let integrity: string
  let tableCounts: Record<string, number>
  let sqliteSchema: SqliteBackupManifest['sqliteSchema'] | null = null

  // Corruption can surface two different ways depending on how badly the
  // file is damaged: `PRAGMA integrity_check` can return a row describing
  // the damage (the common case), or SQLite can refuse to recognize the
  // file as a database at all and throw (e.g. a stomped header), in which
  // case even `new DatabaseSync(path, { readOnly: true })` itself can throw.
  // Both must be treated as "not ok" rather than allowed to propagate -
  // a verifier that crashes instead of reporting failure is not a verifier.
  try {
    const db = openReadOnly(resolvedBackupPath)
    try {
      integrity = readIntegrityCheck(db)
      tableCounts = integrity === 'ok' ? readSelectedTableCounts(db, tables) : {}
      sqliteSchema = integrity === 'ok' ? readSchemaIdentity(db) : null
    } finally {
      db.close()
    }
  } catch (error) {
    integrity = error instanceof Error ? error.message : String(error)
    tableCounts = {}
  }

  const mismatches: string[] = []
  let manifest: SqliteBackupManifest | null = manifestOverride ?? null
  if (!manifest) {
    try {
      manifest = parseBackupManifest(readFileSync(manifestPath, 'utf8'))
    } catch (error) {
      mismatches.push(`manifest: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  if (manifest) {
    if (manifest.store !== store) mismatches.push(`manifest store: expected ${store}, got ${manifest.store}`)
    if (!manifestOverride && manifest.backup.fileName !== basename(resolvedBackupPath)) {
      mismatches.push(`manifest backup filename: expected ${basename(resolvedBackupPath)}, got ${manifest.backup.fileName}`)
    }
    let actualSize: number | null = null
    let actualDigest: string | null = null
    try {
      const bytes = readFileSync(resolvedBackupPath)
      actualSize = bytes.byteLength
      actualDigest = sha256(bytes)
    } catch (error) {
      mismatches.push(`backup bytes: ${error instanceof Error ? error.message : String(error)}`)
    }
    if (actualSize !== null && manifest.backup.sizeBytes !== actualSize) {
      mismatches.push(`backup size: expected ${manifest.backup.sizeBytes}, got ${actualSize}`)
    }
    if (actualDigest !== null && manifest.backup.sha256 !== actualDigest) {
      mismatches.push(`backup sha256: expected ${manifest.backup.sha256}, got ${actualDigest}`)
    }
    if (manifest.integrity !== integrity) {
      mismatches.push(`integrity: manifest ${manifest.integrity}, actual ${integrity}`)
    }
    if (sqliteSchema && (
      manifest.sqliteSchema.userVersion !== sqliteSchema.userVersion
      || manifest.sqliteSchema.sha256 !== sqliteSchema.sha256
    )) {
      mismatches.push('sqlite schema does not match manifest')
    }
    compareTableCounts(tables, manifest.tableCounts, tableCounts, mismatches, 'manifest')
  }
  if (expected) {
    compareTableCounts(tables, expected, tableCounts, mismatches, 'expected')
  }

  return {
    ok: integrity === 'ok' && mismatches.length === 0,
    integrity,
    tableCounts,
    mismatches,
    manifestPath,
    manifest,
  }
}

function compareTableCounts(
  tables: readonly string[],
  expected: Record<string, number>,
  actual: Record<string, number>,
  mismatches: string[],
  source: 'manifest' | 'expected',
): void {
  for (const table of tables) {
    const expectedHasTable = Object.prototype.hasOwnProperty.call(expected, table)
    const actualHasTable = Object.prototype.hasOwnProperty.call(actual, table)
    if (source === 'manifest' && expectedHasTable !== actualHasTable) {
      mismatches.push(`${table}: manifest table presence does not match backup`)
      continue
    }
    const expectedCount = expected[table] ?? 0
    const actualCount = actual[table] ?? 0
    if (expectedCount !== actualCount) {
      mismatches.push(`${table}: ${source} ${expectedCount}, got ${actualCount}`)
    }
  }
}

function parseBackupManifest(raw: string): SqliteBackupManifest {
  let value: unknown
  try { value = JSON.parse(raw) } catch { throw new Error('missing or invalid JSON') }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('must be an object')
  const record = value as Record<string, unknown>
  assertExactKeys(record, [
    'schemaVersion', 'store', 'createdAt', 'source', 'backup', 'integrity', 'sqliteSchema', 'tableCounts',
  ], 'manifest')
  if (record.schemaVersion !== SQLITE_BACKUP_MANIFEST_SCHEMA_VERSION) throw new Error('unsupported schemaVersion')
  if (record.store !== 'pipeline' && record.store !== 'news') throw new Error('store is invalid')
  if (typeof record.createdAt !== 'string' || !Number.isFinite(Date.parse(record.createdAt))) {
    throw new Error('createdAt is invalid')
  }
  const source = requiredRecord(record.source, 'source')
  const backup = requiredRecord(record.backup, 'backup')
  const sqliteSchema = requiredRecord(record.sqliteSchema, 'sqliteSchema')
  const tableCounts = requiredRecord(record.tableCounts, 'tableCounts')
  assertExactKeys(source, ['fileName', 'pathSha256'], 'source')
  assertExactKeys(backup, ['fileName', 'sha256', 'sizeBytes'], 'backup')
  assertExactKeys(sqliteSchema, ['userVersion', 'sha256'], 'sqliteSchema')
  if (typeof source.fileName !== 'string' || source.fileName.length === 0 || source.fileName.includes('/') || source.fileName.includes('\\')) {
    throw new Error('source.fileName is invalid')
  }
  assertSha256(source.pathSha256, 'source.pathSha256')
  if (typeof backup.fileName !== 'string' || backup.fileName.length === 0 || basename(backup.fileName) !== backup.fileName) {
    throw new Error('backup.fileName is invalid')
  }
  const expectedFileName = `${record.store === 'pipeline' ? BACKUP_FILE_PREFIX : 'news-'}${filenameSafeTimestamp(record.createdAt)}${BACKUP_FILE_SUFFIX}`
  if (backup.fileName !== expectedFileName) throw new Error('backup.fileName does not match store and createdAt')
  assertSha256(backup.sha256, 'backup.sha256')
  if (!Number.isSafeInteger(backup.sizeBytes) || Number(backup.sizeBytes) <= 0) throw new Error('backup.sizeBytes is invalid')
  if (record.integrity !== 'ok') throw new Error('integrity must be ok')
  if (!Number.isSafeInteger(sqliteSchema.userVersion) || Number(sqliteSchema.userVersion) < 0) {
    throw new Error('sqliteSchema.userVersion is invalid')
  }
  assertSha256(sqliteSchema.sha256, 'sqliteSchema.sha256')
  const validatedCounts: Record<string, number> = {}
  const allowedTables = new Set(record.store === 'pipeline' ? PIPELINE_TABLES : NEWS_TABLES)
  for (const [name, count] of Object.entries(tableCounts)) {
    if (!allowedTables.has(name as (typeof PIPELINE_TABLES)[number] | (typeof NEWS_TABLES)[number])) {
      throw new Error(`tableCounts.${name || '<empty>'} is not part of the ${record.store} inventory`)
    }
    if (!name || !Number.isSafeInteger(count) || Number(count) < 0) throw new Error(`tableCounts.${name || '<empty>'} is invalid`)
    validatedCounts[name] = Number(count)
  }
  return {
    schemaVersion: SQLITE_BACKUP_MANIFEST_SCHEMA_VERSION,
    store: record.store,
    createdAt: record.createdAt,
    source: { fileName: source.fileName, pathSha256: source.pathSha256 as string },
    backup: { fileName: backup.fileName, sha256: backup.sha256 as string, sizeBytes: Number(backup.sizeBytes) },
    integrity: 'ok',
    sqliteSchema: { userVersion: Number(sqliteSchema.userVersion), sha256: sqliteSchema.sha256 as string },
    tableCounts: validatedCounts,
  }
}

function assertExactKeys(record: Record<string, unknown>, keys: readonly string[], field: string): void {
  const allowed = new Set(keys)
  for (const key of Object.keys(record)) if (!allowed.has(key)) throw new Error(`${field}.${key} is unknown`)
  for (const key of keys) if (!(key in record)) throw new Error(`${field}.${key} is required`)
}

function requiredRecord(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${field} is invalid`)
  return value as Record<string, unknown>
}

function assertSha256(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) throw new Error(`${field} is invalid`)
}

/**
 * Restores a backup file to `targetPath`. Refuses to overwrite an existing
 * target unless `force` is set. Verifies the backup's integrity BEFORE
 * touching the target - a corrupt backup must never be allowed to clobber
 * a good target - then copies to a same-directory temporary file, verifies
 * that copy, and atomically renames it over the target. An interrupted or
 * failed verification therefore leaves any existing target intact.
 */
export async function restorePipelineStore(options: {
  backupPath: string
  targetPath: string
  force?: boolean
}): Promise<PipelineRestoreResult> {
  return restoreSqliteStore(options, 'pipeline', PIPELINE_TABLES)
}

/** News-store counterpart with the same pre-copy and post-copy guarantees. */
export async function restoreNewsStore(options: {
  backupPath: string
  targetPath: string
  force?: boolean
}): Promise<PipelineRestoreResult> {
  return restoreSqliteStore(options, 'news', NEWS_TABLES)
}

async function restoreSqliteStore(
  options: { backupPath: string; targetPath: string; force?: boolean },
  store: SqliteBackupStoreKind,
  tables: readonly string[],
): Promise<PipelineRestoreResult> {
  const backupPath = resolve(options.backupPath)
  const targetPath = resolve(options.targetPath)

  assertRestoreSidecarsAbsent(targetPath)

  let targetExists = true
  try {
    statSync(targetPath)
  } catch {
    targetExists = false
  }
  if (targetExists && !options.force) {
    throw new Error(
      `Refusing to overwrite existing target "${targetPath}" without force: true`
    )
  }

  const preCheck = await verifySqliteBackup(backupPath, store, tables)
  if (!preCheck.ok) {
    throw new Error(
      `Refusing to restore from a backup that fails verification: integrity="${preCheck.integrity}"` +
        (preCheck.mismatches.length > 0 ? `, mismatches=${preCheck.mismatches.join('; ')}` : '')
    )
  }
  if (!preCheck.manifest) throw new Error('Refusing to restore without a valid backup manifest')

  mkdirSync(dirname(targetPath), { recursive: true })
  const temporaryPath = `${targetPath}.restore.${process.pid}.${randomUUID()}.tmp`
  let postCheck: PipelineBackupVerification
  try {
    copyFileSync(backupPath, temporaryPath)
    postCheck = await verifySqliteBackup(temporaryPath, store, tables, preCheck.tableCounts, preCheck.manifest)
    if (!postCheck.ok) {
      throw new Error(
        `Restored copy failed verification: integrity="${postCheck.integrity}"`
        + (postCheck.mismatches.length > 0 ? `, mismatches=${postCheck.mismatches.join('; ')}` : ''),
      )
    }
    // Recheck immediately before publication. Restoring a main DB over live
    // WAL/SHM state can replay unrelated pages into the verified copy.
    assertRestoreSidecarsAbsent(targetPath)
    if (options.force) {
      renameSync(temporaryPath, targetPath)
    } else {
      // link(2) is an atomic no-replace publication on the same filesystem.
      // Unlike rename, it cannot clobber a target created after our first
      // existence check.
      try {
        linkSync(temporaryPath, targetPath)
      } catch (error) {
        if (isNodeError(error) && error.code === 'EEXIST') {
          throw new Error(`Refusing to overwrite existing target "${targetPath}" without force: true`)
        }
        throw error
      }
    }
  } finally {
    rmSync(temporaryPath, { force: true })
  }

  assertRestoreSidecarsAbsent(targetPath)
  const finalCheck = await verifySqliteBackup(targetPath, store, tables, preCheck.tableCounts, preCheck.manifest)
  if (!finalCheck.ok) throw new Error(`Published restore target failed final verification: ${finalCheck.integrity}`)

  return {
    targetPath,
    tableCounts: finalCheck.tableCounts,
    verified: finalCheck.ok,
    backupSha256: preCheck.manifest.backup.sha256,
  }
}

function assertRestoreSidecarsAbsent(targetPath: string): void {
  const present = [`${targetPath}-wal`, `${targetPath}-shm`].filter((path) => {
    try { statSync(path); return true } catch { return false }
  })
  if (present.length > 0) {
    throw new Error(
      `Refusing restore while SQLite sidecars exist for "${targetPath}"; stop/checkpoint the owning workers first`,
    )
  }
}

function isNodeError(value: unknown): value is NodeJS.ErrnoException {
  return value instanceof Error && 'code' in value
}

interface BackupFileInfo {
  path: string
  manifestPath: string
  timestamp: string
}

function parseBackupFileName(fileName: string, prefix: string): string | null {
  if (!fileName.startsWith(prefix) || !fileName.endsWith(BACKUP_FILE_SUFFIX)) return null
  const timestamp = fileName.slice(prefix.length, fileName.length - BACKUP_FILE_SUFFIX.length)
  return /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z$/.test(timestamp) ? timestamp : null
}

export interface BackupPruneAudit {
  mode: 'dry_run' | 'apply'
  backupDir: string
  prefix: string
  keep: number
  limit: number
  matchedBackups: number
  retainedBackupPaths: string[]
  candidateBackupPaths: string[]
  candidateDeletePaths: string[]
  deletedPaths: string[]
  limited: boolean
  auditedAt: string
}

/** Plans exact paths first. Deletion is opt-in and bounded by `limit`. */
export async function pruneOldBackups(options?: {
  backupDir?: string
  keep?: number
  prefix?: string
  limit?: number
  apply?: boolean
  now?: string
}): Promise<BackupPruneAudit> {
  const backupDir = resolve(options?.backupDir ?? DEFAULT_BACKUP_DIR)
  const keep = options?.keep ?? 7
  const limit = options?.limit ?? 100
  const prefix = options?.prefix ?? BACKUP_FILE_PREFIX
  if (!Number.isSafeInteger(keep) || keep < 1) throw new Error('keep must be a positive integer')
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) {
    throw new Error('limit must be an integer between 1 and 1000')
  }

  let entries: string[]
  try {
    entries = readdirSync(backupDir)
  } catch {
    entries = []
  }

  const infos: BackupFileInfo[] = []
  for (const entry of entries) {
    const timestamp = parseBackupFileName(basename(entry), prefix)
    if (timestamp === null) continue
    const path = join(backupDir, entry)
    infos.push({ path, manifestPath: backupManifestPath(path), timestamp })
  }

  infos.sort((a, b) => (a.timestamp < b.timestamp ? 1 : a.timestamp > b.timestamp ? -1 : 0))

  // Apply the bounded deletion budget to the oldest backups first.
  const allCandidates = infos.slice(keep).reverse()
  const candidates = allCandidates.slice(0, limit)
  const candidateDeletePaths = candidates.flatMap((info) => (
    pathExists(info.manifestPath) ? [info.path, info.manifestPath] : [info.path]
  ))
  const deletedPaths: string[] = []
  if (options?.apply) {
    for (const path of candidateDeletePaths) {
      unlinkSync(path)
      deletedPaths.push(path)
    }
  }
  return {
    mode: options?.apply ? 'apply' : 'dry_run',
    backupDir,
    prefix,
    keep,
    limit,
    matchedBackups: infos.length,
    retainedBackupPaths: infos.slice(0, keep).map((info) => info.path),
    candidateBackupPaths: candidates.map((info) => info.path),
    candidateDeletePaths,
    deletedPaths,
    limited: allCandidates.length > candidates.length,
    auditedAt: options?.now ?? new Date().toISOString(),
  }
}

function pathExists(path: string): boolean {
  try { statSync(path); return true } catch { return false }
}
