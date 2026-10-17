import { createRequire } from 'node:module'
import { existsSync } from 'node:fs'
import {
  ensurePipelineSqliteSchema,
  openPipelineSqlite,
  resolvePipelineSqlitePath,
} from '../pipeline-store/sqlite-store'

const nodeRequire = createRequire(__filename)
const { DatabaseSync } = nodeRequire('node:sqlite') as {
  DatabaseSync: new (path: string, options?: { readOnly?: boolean; open?: boolean }) => SeedSqliteDatabase
}

interface SeedSqliteStatement {
  all(...params: unknown[]): unknown[]
  get(...params: unknown[]): unknown
  run(...params: unknown[]): unknown
}

export interface SeedSqliteDatabase {
  close(): void
  exec(sql: string): void
  prepare(sql: string): SeedSqliteStatement
}

export interface SeedActiveWatchlistResult {
  /** Active rows found in the retired source file. */
  sourceActive: number
  inserted: number
  updated: number
  unchanged: number
  /** Active rows in the target after the seed (projected for dry-run). */
  targetActiveAfter: number
}

export interface SeedActiveWatchlistOptions {
  /** The retired pipeline.sqlite copy to read from; opened read-only, never created. */
  fromPath: string
  /** The polymarket lane store to seed; resolved through resolvePipelineSqlitePath. */
  toPath: string
  dryRun?: boolean
}

const WATCHLIST_TABLE = 'pipeline_watchlist'

type SeedRow = Record<string, unknown>

function canonicalValue(value: unknown): string {
  if (value === null || value === undefined) return 'null'
  if (typeof value === 'bigint') return value.toString()
  return JSON.stringify(value) ?? String(value)
}

function rowDiffers(existing: SeedRow, incoming: SeedRow, columns: readonly string[]): boolean {
  return columns.some((column) => canonicalValue(existing[column]) !== canonicalValue(incoming[column]))
}

function activeCount(db: SeedSqliteDatabase): number {
  const row = db.prepare(`SELECT COUNT(*) AS count FROM ${WATCHLIST_TABLE} WHERE status = 'active'`).get() as
    | { count?: unknown }
    | undefined
  return typeof row?.count === 'number' ? row.count : Number(row?.count ?? 0)
}

function tableColumns(db: SeedSqliteDatabase, tableName: string): string[] {
  const rows = db.prepare(`PRAGMA table_info(${tableName})`).all() as Array<Record<string, unknown>>
  return rows
    .filter((row) => typeof row.name === 'string')
    .map((row) => String(row.name))
}

/**
 * Copy active pipeline_watchlist rows from a retired pipeline.sqlite into the
 * polymarket lane store, idempotently (second run: inserted=0). The source is
 * opened read-only straight with node:sqlite - it is intentionally the retired
 * file, so it does NOT go through the lane path helper - and must already
 * exist. The target is opened through SqlitePipelineStore so its schema
 * self-creates. The copy runs in one transaction; `dryRun` computes the same
 * counts and writes nothing (a not-yet-existing target is never created).
 */
export function seedActiveWatchlist(options: SeedActiveWatchlistOptions): SeedActiveWatchlistResult {
  const { fromPath, toPath, dryRun = false } = options
  if (!existsSync(fromPath)) {
    throw new Error(`Watchlist seed source does not exist: ${fromPath}`)
  }
  const targetPath = resolvePipelineSqlitePath(toPath)
  const dryRunTargetExists = dryRun && existsSync(targetPath)

  const source = new DatabaseSync(fromPath, { readOnly: true })
  try {
    const sourceColumns = tableColumns(source, WATCHLIST_TABLE)
    if (sourceColumns.length === 0) {
      throw new Error(`Watchlist seed source has no ${WATCHLIST_TABLE} table: ${fromPath}`)
    }
    const sourceRows = source
      .prepare(`SELECT * FROM ${WATCHLIST_TABLE} WHERE status = 'active'`)
      .all() as SeedRow[]
    const sourceActive = sourceRows.length

    // Dry-run against a not-yet-existing target: nothing would conflict, no
    // file is created.
    if (dryRun && !dryRunTargetExists) {
      return { sourceActive, inserted: sourceActive, updated: 0, unchanged: 0, targetActiveAfter: sourceActive }
    }

    const target: SeedSqliteDatabase = dryRun
      ? new DatabaseSync(targetPath, { readOnly: true })
      : openPipelineSqlite(targetPath)
    if (!dryRun) ensurePipelineSqliteSchema(target)
    try {
      const columns = sourceColumns.filter((column) => targetColumns(target).includes(column))
      const insertSql = `INSERT INTO ${WATCHLIST_TABLE} (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`
      const updateByIdSql = `UPDATE ${WATCHLIST_TABLE} SET ${columns.map((column) => `${column} = ?`).join(', ')} WHERE id = ?`
      const updateByAreaSlugSql = `UPDATE ${WATCHLIST_TABLE} SET ${columns.map((column) => `${column} = ?`).join(', ')} WHERE area = ? AND slug = ?`

      const targetRows = target.prepare(`SELECT * FROM ${WATCHLIST_TABLE}`).all() as SeedRow[]
      const byId = new Map<string, SeedRow>()
      const byAreaSlug = new Map<string, SeedRow>()
      for (const row of targetRows) {
        byId.set(String(row.id), row)
        byAreaSlug.set(`${String(row.area)}\u0000${String(row.slug)}`, row)
      }

      // Classify against the pre-state, so re-running gives identical counts.
      const updates: Array<{ sql: string; keys: unknown[]; values: unknown[]; wasActive: boolean }> = []
      const inserts: unknown[][] = []
      let unchanged = 0
      for (const sourceRow of sourceRows) {
        const byIdRow = byId.get(String(sourceRow.id))
        const areaSlugRow = byAreaSlug.get(`${String(sourceRow.area)}\u0000${String(sourceRow.slug)}`)
        const existing = byIdRow ?? areaSlugRow
        if (!existing) {
          inserts.push(columns.map((column) => sourceRow[column]))
          continue
        }
        if (!rowDiffers(existing, sourceRow, columns)) {
          unchanged += 1
          continue
        }
        updates.push({
          sql: byIdRow ? updateByIdSql : updateByAreaSlugSql,
          keys: byIdRow ? [sourceRow.id] : [sourceRow.area, sourceRow.slug],
          values: columns.map((column) => sourceRow[column]),
          wasActive: existing.status === 'active',
        })
      }

      if (dryRun) {
        return {
          sourceActive,
          inserted: inserts.length,
          updated: updates.length,
          unchanged,
          targetActiveAfter: activeCount(target) + inserts.length + updates.filter((update) => !update.wasActive).length,
        }
      }

      target.exec('BEGIN')
      try {
        for (const update of updates) {
          target.prepare(update.sql).run(...update.values, ...update.keys)
        }
        for (const values of inserts) {
          target.prepare(insertSql).run(...values)
        }
        target.exec('COMMIT')
      } catch (error) {
        try {
          target.exec('ROLLBACK')
        } catch {
          // Ignore rollback failure so the original error surfaces.
        }
        throw error
      }
      return {
        sourceActive,
        inserted: inserts.length,
        updated: updates.length,
        unchanged,
        targetActiveAfter: activeCount(target),
      }
    } finally {
      target.close()
    }
  } finally {
    source.close()
  }
}

function targetColumns(target: SeedSqliteDatabase): string[] {
  return tableColumns(target, WATCHLIST_TABLE)
}