import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import type { EntityDraftInventory } from './cleanup-executor'

const nodeRequire = createRequire(__filename)
const { DatabaseSync } = nodeRequire('node:sqlite') as {
  DatabaseSync: new (path: string, options?: { readOnly?: boolean }) => SqliteDatabase
}

interface SqliteDatabase {
  close(): void
  prepare(sql: string): { get(...params: unknown[]): unknown }
}

export class SqliteEntityDraftInventory implements EntityDraftInventory {
  private readonly db: SqliteDatabase

  constructor(path: string) {
    this.db = new DatabaseSync(resolve(path), { readOnly: true })
  }

  async count(entityId: string): Promise<number> {
    const row = this.db.prepare(`
      SELECT count(*) AS count
      FROM pipeline_editor_drafts
      WHERE entity_id = ?
        AND status IN ('drafted', 'watching', 'needs_more_research')
    `).get(entityId) as { count?: number | bigint } | undefined
    return Number(row?.count ?? 0)
  }

  close(): void {
    this.db.close()
  }
}
