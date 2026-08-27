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
import { randomUUID } from 'node:crypto'
import { copyFileSync, linkSync, mkdirSync, readdirSync, renameSync, rmSync, statSync, unlinkSync } from 'node:fs'
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

export interface PipelineBackupResult {
  path: string
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
}

export interface PipelineRestoreResult {
  targetPath: string
  tableCounts: Record<string, number>
  verified: boolean
}

function filenameSafeTimestamp(iso: string): string {
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
}): Promise<PipelineBackupResult> {
  mkdirSync(options.backupDir, { recursive: true })
  const backupPath = join(
    options.backupDir,
    `${options.prefix}${filenameSafeTimestamp(options.createdAt)}${BACKUP_FILE_SUFFIX}`
  )

  const source = openReadWrite(options.sourcePath)
  let sourceTableCounts: Record<string, number>
  try {
    await sqliteBackup(source, backupPath)
    sourceTableCounts = readSelectedTableCounts(source, options.tables)
  } finally {
    source.close()
  }

  const backupDb = openReadOnly(backupPath)
  let tableCounts: Record<string, number>
  try {
    tableCounts = readSelectedTableCounts(backupDb, options.tables)
  } finally {
    backupDb.close()
  }

  return {
    path: backupPath,
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
  return backupSqliteStore({ sourcePath, backupDir, createdAt, prefix: BACKUP_FILE_PREFIX, tables: PIPELINE_TABLES })
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
  return verifySqliteBackup(backupPath, PIPELINE_TABLES, expected)
}

export async function verifyNewsBackup(
  backupPath: string,
  expected?: Record<string, number>
): Promise<PipelineBackupVerification> {
  return verifySqliteBackup(backupPath, NEWS_TABLES, expected)
}

async function verifySqliteBackup(
  backupPath: string,
  tables: readonly string[],
  expected?: Record<string, number>
): Promise<PipelineBackupVerification> {
  let integrity: string
  let tableCounts: Record<string, number>

  // Corruption can surface two different ways depending on how badly the
  // file is damaged: `PRAGMA integrity_check` can return a row describing
  // the damage (the common case), or SQLite can refuse to recognize the
  // file as a database at all and throw (e.g. a stomped header), in which
  // case even `new DatabaseSync(path, { readOnly: true })` itself can throw.
  // Both must be treated as "not ok" rather than allowed to propagate -
  // a verifier that crashes instead of reporting failure is not a verifier.
  try {
    const db = openReadOnly(resolve(backupPath))
    try {
      integrity = readIntegrityCheck(db)
      tableCounts = integrity === 'ok' ? readSelectedTableCounts(db, tables) : {}
    } finally {
      db.close()
    }
  } catch (error) {
    integrity = error instanceof Error ? error.message : String(error)
    tableCounts = {}
  }

  const mismatches: string[] = []
  if (expected) {
    for (const table of tables) {
      const expectedCount = expected[table] ?? 0
      const actualCount = tableCounts[table] ?? 0
      if (expectedCount !== actualCount) {
        mismatches.push(`${table}: expected ${expectedCount}, got ${actualCount}`)
      }
    }
  }

  return {
    ok: integrity === 'ok' && mismatches.length === 0,
    integrity,
    tableCounts,
    mismatches,
  }
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
  return restoreSqliteStore(options, verifyPipelineBackup)
}

/** News-store counterpart with the same pre-copy and post-copy guarantees. */
export async function restoreNewsStore(options: {
  backupPath: string
  targetPath: string
  force?: boolean
}): Promise<PipelineRestoreResult> {
  return restoreSqliteStore(options, verifyNewsBackup)
}

async function restoreSqliteStore(
  options: { backupPath: string; targetPath: string; force?: boolean },
  verify: (
    path: string,
    expected?: Record<string, number>,
  ) => Promise<PipelineBackupVerification>,
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

  const preCheck = await verify(backupPath)
  if (!preCheck.ok) {
    throw new Error(
      `Refusing to restore from a backup that fails verification: integrity="${preCheck.integrity}"` +
        (preCheck.mismatches.length > 0 ? `, mismatches=${preCheck.mismatches.join('; ')}` : '')
    )
  }

  mkdirSync(dirname(targetPath), { recursive: true })
  const temporaryPath = `${targetPath}.restore.${process.pid}.${randomUUID()}.tmp`
  let postCheck: PipelineBackupVerification
  try {
    copyFileSync(backupPath, temporaryPath)
    postCheck = await verify(temporaryPath, preCheck.tableCounts)
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
  const finalCheck = await verify(targetPath, preCheck.tableCounts)
  if (!finalCheck.ok) throw new Error(`Published restore target failed final verification: ${finalCheck.integrity}`)

  return {
    targetPath,
    tableCounts: finalCheck.tableCounts,
    verified: finalCheck.ok,
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
  timestamp: string
}

function parseBackupFileName(fileName: string, prefix: string): string | null {
  if (!fileName.startsWith(prefix) || !fileName.endsWith(BACKUP_FILE_SUFFIX)) return null
  return fileName.slice(prefix.length, fileName.length - BACKUP_FILE_SUFFIX.length)
}

/**
 * Keeps the `keep` newest backups in `backupDir` and deletes the rest.
 * "Newest" is determined by the timestamp encoded in the filename (sorted
 * lexicographically, which matches chronological order for ISO-derived
 * timestamps), not filesystem mtime - mtime is unreliable across copies
 * (e.g. restoring a backup elsewhere, or a filesystem that does not
 * preserve mtime on copy) whereas the filename is the backup's own record
 * of when it was taken.
 */
export async function pruneOldBackups(options?: {
  backupDir?: string
  keep?: number
  prefix?: string
}): Promise<string[]> {
  const backupDir = resolve(options?.backupDir ?? DEFAULT_BACKUP_DIR)
  const keep = options?.keep ?? 7
  const prefix = options?.prefix ?? BACKUP_FILE_PREFIX

  let entries: string[]
  try {
    entries = readdirSync(backupDir)
  } catch {
    return []
  }

  const infos: BackupFileInfo[] = []
  for (const entry of entries) {
    const timestamp = parseBackupFileName(basename(entry), prefix)
    if (timestamp === null) continue
    infos.push({ path: join(backupDir, entry), timestamp })
  }

  infos.sort((a, b) => (a.timestamp < b.timestamp ? 1 : a.timestamp > b.timestamp ? -1 : 0))

  const toDelete = infos.slice(Math.max(0, keep))
  const deleted: string[] = []
  for (const info of toDelete) {
    unlinkSync(info.path)
    deleted.push(info.path)
  }
  return deleted
}
