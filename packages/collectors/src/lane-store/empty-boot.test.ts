import assert from 'node:assert/strict'
import { mkdtempSync, existsSync, readdirSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { SqliteNewsStore } from '../news/sqlite-store'
import {
  LANE_SQLITE_FILENAMES,
  RETIRED_LANE_SQLITE_FILENAMES,
} from './paths'
import { SqlitePipelineStore } from '../pipeline-store/sqlite-store'

const { DatabaseSync } = createRequire(__filename)('node:sqlite') as {
  DatabaseSync: new (path: string, options?: { readOnly?: boolean }) => {
    prepare(sql: string): { get(...params: unknown[]): unknown }
    close(): void
  }
}

function hasTable(path: string, tableName: string): boolean {
  const db = new DatabaseSync(path, { readOnly: true })
  try {
    const row = db.prepare('SELECT name FROM sqlite_master WHERE type = \'table\' AND name = ?').get(tableName) as
      | { name?: unknown }
      | undefined
    return Boolean(row?.name)
  } finally {
    db.close()
  }
}

test('empty boot creates only the lane-named stores, never the retired files', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lane-store-empty-boot-'))
  try {
    const pipelinePath = join(dir, LANE_SQLITE_FILENAMES.polymarket)
    const newsPath = join(dir, LANE_SQLITE_FILENAMES.news)
    const pipeline = new SqlitePipelineStore(pipelinePath)
    const news = new SqliteNewsStore(newsPath)
    try {
      assert.ok(existsSync(pipelinePath), 'polymarket lane store file must exist after empty boot')
      assert.ok(existsSync(newsPath), 'news lane store file must exist after empty boot')

      for (const table of ['pipeline_candidates', 'pipeline_research', 'pipeline_watchlist']) {
        assert.ok(hasTable(pipelinePath, table), `pipeline lane store must create ${table}`)
      }
      assert.ok(hasTable(newsPath, 'news_candidate_observations'), 'news lane store must create news_candidate_observations')

      const files = readdirSync(dir)
      for (const retired of RETIRED_LANE_SQLITE_FILENAMES) {
        assert.ok(!files.includes(retired), `retired file ${retired} must not be created`)
      }
    } finally {
      pipeline.close()
      news.close()
    }
    assert.ok(!existsSync(join(dir, 'news.sqlite')), 'no retired news.sqlite after boot')
    assert.ok(!existsSync(join(dir, 'pipeline.sqlite')), 'no retired pipeline.sqlite after boot')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})