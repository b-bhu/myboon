import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import type { EntityDraftInventory } from './cleanup-executor'

const nodeRequire = createRequire(__filename)
const { DatabaseSync } = nodeRequire('node:sqlite') as {
  DatabaseSync: new (path: string, options?: { readOnly?: boolean }) => SqliteDatabase
}

interface SqliteDatabase {
  close(): void
  exec(sql: string): void
  prepare(sql: string): {
    get(...params: unknown[]): unknown
    run(...params: unknown[]): unknown
  }
}

const DEFAULT_FENCE_LEASE_MS = 30 * 60_000

export class SqliteEntityDraftInventory implements EntityDraftInventory {
  private readonly db: SqliteDatabase
  private readonly leaseMs: number
  private readonly now: () => number

  constructor(path: string, options: { leaseMs?: number, now?: () => number } = {}) {
    this.db = new DatabaseSync(resolve(path))
    this.db.exec('PRAGMA journal_mode = WAL;')
    this.db.exec('PRAGMA busy_timeout = 5000;')
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS pipeline_entity_cleanup_leases (
        entity_id TEXT PRIMARY KEY,
        lease_owner TEXT NOT NULL,
        lease_expires_at_ms INTEGER NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS pipeline_entity_cleanup_leases_expiry_idx
        ON pipeline_entity_cleanup_leases (lease_expires_at_ms);
    `)
    this.leaseMs = options.leaseMs ?? DEFAULT_FENCE_LEASE_MS
    this.now = options.now ?? Date.now
    if (!Number.isInteger(this.leaseMs) || this.leaseMs <= 0) {
      throw new Error('Entity draft mutation-fence lease must be a positive integer.')
    }
  }

  async withMutationFence<T>(
    entityId: string,
    action: (actionableDraftCount: number) => Promise<T>,
  ): Promise<T> {
    const owner = randomUUID()
    const acquiredAt = this.now()
    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.db.prepare(`
        DELETE FROM pipeline_entity_cleanup_leases
        WHERE lease_expires_at_ms <= ?
      `).run(acquiredAt)
      this.db.prepare(`
        INSERT INTO pipeline_entity_cleanup_leases (
          entity_id, lease_owner, lease_expires_at_ms
        ) VALUES (?, ?, ?)
      `).run(entityId, owner, acquiredAt + this.leaseMs)
      this.db.exec('COMMIT')
    } catch (error) {
      try { this.db.exec('ROLLBACK') } catch { /* preserve the acquisition error */ }
      throw new Error(`Entity draft mutation fence is unavailable for ${entityId}.`, { cause: error })
    }

    try {
      const row = this.db.prepare(`
        SELECT count(*) AS count
        FROM pipeline_editor_drafts
        WHERE entity_id = ?
          AND status IN ('drafted', 'watching', 'needs_more_research')
      `).get(entityId) as { count?: number | bigint } | undefined
      return await action(Number(row?.count ?? 0))
    } finally {
      this.db.prepare(`
        DELETE FROM pipeline_entity_cleanup_leases
        WHERE entity_id = ? AND lease_owner = ?
      `).run(entityId, owner)
    }
  }

  close(): void {
    this.db.close()
  }
}
