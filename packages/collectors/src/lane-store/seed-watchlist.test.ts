import assert from 'node:assert/strict'
import { mkdtempSync, existsSync, renameSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  ensurePipelineSqliteSchema,
  openPipelineSqlite,
  resolvePipelineSqlitePath,
} from '../pipeline-store/sqlite-store'
import { RetiredLaneSqlitePathError } from './paths'
import { seedActiveWatchlist } from './seed-watchlist'

const { DatabaseSync } = createRequire(__filename)('node:sqlite') as {
  DatabaseSync: new (path: string, options?: { readOnly?: boolean; open?: boolean }) => {
    prepare(sql: string): { get(...params: unknown[]): unknown; all(...params: unknown[]): unknown[]; run(...params: unknown[]): unknown }
    close(): void
  }
}

interface WatchlistFixtureRow {
  id: string
  area: string
  slug: string
  status?: 'active' | 'inactive'
  watchScore?: number
}

let stagingCounter = 0

/**
 * Builds a source file named `pipeline.sqlite` (the retired name the seed CLI
 * reads) without going through the lane helper: schema is created via the
 * real store under a safe temp name, the file is then renamed.
 */
function buildLegacySource(dir: string, rows: WatchlistFixtureRow[]): string {
  const stagedPath = join(dir, `seed-source-staging-${stagingCounter += 1}.sqlite`)
  const db = openPipelineSqlite(stagedPath)
  try {
    ensurePipelineSqliteSchema(db)
    for (const row of rows) {
      db.prepare(`
        INSERT INTO pipeline_watchlist (
          id, source, area, tag_slug, tag_label, market_id, slug, title,
          event_slug, event_title, end_date, is_manual_pin, rank_in_area,
          watch_score, score_breakdown, selection_reason, latest_observed_at,
          latest_yes_price, latest_volume, latest_volume_24h, latest_liquidity,
          status, created_at, updated_at
        ) VALUES (?, 'polymarket', ?, 'sports', 'Sports', ?, ?, ?, ?, 'Event', '2026-12-31T00:00:00.000Z', 0, 1, ?, '{}', 'watchlist', NULL, NULL, NULL, NULL, NULL, ?, '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z')
      `).run(
        row.id, row.area, `market-${row.slug}`, row.slug, `title-${row.slug}`,
        `event-${row.slug}`, row.watchScore ?? 0.5, row.status ?? 'active',
      )
    }
  } finally {
    db.close()
  }
  const legacyPath = join(dir, 'pipeline.sqlite')
  renameSync(stagedPath, legacyPath)
  return legacyPath
}

function watchlistCount(path: string): number {
  const db = new DatabaseSync(path, { readOnly: true })
  try {
    const row = db.prepare('SELECT COUNT(*) AS count FROM pipeline_watchlist').get() as { count?: unknown }
    return Number(row?.count ?? 0)
  } finally {
    db.close()
  }
}

test('seed copies only active watchlist rows and is idempotent', () => {
  const dir = mkdtempSync(join(tmpdir(), 'watchlist-seed-'))
  try {
    const fromPath = buildLegacySource(dir, [
      { id: 'w-1', area: 'markets', slug: 'aaa' },
      { id: 'w-2', area: 'markets', slug: 'bbb' },
      { id: 'w-3', area: 'markets', slug: 'ccc' },
      { id: 'w-4', area: 'other', slug: 'ddd' },
      { id: 'w-5', area: 'other', slug: 'eee' },
      { id: 'w-6', area: 'markets', slug: 'inactive-1', status: 'inactive' },
      { id: 'w-7', area: 'markets', slug: 'inactive-2', status: 'inactive' },
      { id: 'w-8', area: 'other', slug: 'inactive-3', status: 'inactive' },
    ])
    const toPath = join(dir, 'polymarket-lane.sqlite')

    const first = seedActiveWatchlist({ fromPath, toPath })
    assert.deepEqual(first, { sourceActive: 5, inserted: 5, updated: 0, unchanged: 0, targetActiveAfter: 5 })
    assert.equal(watchlistCount(toPath), 5)
    assert.equal(watchlistCount(fromPath), 8, 'inactive rows stay in the source only')

    const second = seedActiveWatchlist({ fromPath, toPath })
    assert.deepEqual(second, { sourceActive: 5, inserted: 0, updated: 0, unchanged: 5, targetActiveAfter: 5 })
    assert.equal(watchlistCount(toPath), 5)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('dry-run reports counts, writes nothing, and creates no file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'watchlist-seed-dry-'))
  try {
    const fromPath = buildLegacySource(dir, [
      { id: 'w-1', area: 'markets', slug: 'aaa' },
      { id: 'w-2', area: 'markets', slug: 'bbb', status: 'inactive' },
    ])
    const toPath = join(dir, 'polymarket-lane.sqlite')

    const planned = seedActiveWatchlist({ fromPath, toPath, dryRun: true })
    assert.deepEqual(planned, { sourceActive: 1, inserted: 1, updated: 0, unchanged: 0, targetActiveAfter: 1 })
    assert.ok(!existsSync(toPath), 'dry run must not create the target file')

    seedActiveWatchlist({ fromPath, toPath })
    const before = watchlistCount(toPath)
    const reassured = seedActiveWatchlist({ fromPath, toPath, dryRun: true })
    assert.deepEqual(reassured, { sourceActive: 1, inserted: 0, updated: 0, unchanged: 1, targetActiveAfter: 1 })
    assert.equal(watchlistCount(toPath), before, 'dry run must not write to an existing target')
    assert.equal(watchlistCount(fromPath), 2)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('seed failures: missing source (no target created) and retired target basename', () => {
  const dir = mkdtempSync(join(tmpdir(), 'watchlist-seed-err-'))
  try {
    const toPath = join(dir, 'polymarket-lane.sqlite')
    assert.throws(
      () => seedActiveWatchlist({ fromPath: join(dir, 'missing-pipeline.sqlite'), toPath }),
      /Watchlist seed source does not exist/,
    )
    assert.ok(!existsSync(toPath), 'failed seed must not create the target')

    const fromPath = buildLegacySource(dir, [{ id: 'w-1', area: 'markets', slug: 'aaa' }])
    assert.throws(
      () => seedActiveWatchlist({ fromPath, toPath: join(dir, 'pipeline.sqlite') }),
      RetiredLaneSqlitePathError,
    )
    assert.equal(resolvePipelineSqlitePath(toPath), toPath)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('seed respects UNIQUE (area, slug) by updating the colliding single row', () => {
  const dir = mkdtempSync(join(tmpdir(), 'watchlist-seed-uniq-'))
  try {
    const toPath = resolvePipelineSqlitePath(join(dir, 'polymarket-lane.sqlite'))
    const target = openPipelineSqlite(toPath)
    try {
      ensurePipelineSqliteSchema(target)
      target.prepare(`
        INSERT INTO pipeline_watchlist (id, source, area, tag_slug, market_id, slug, title, watch_score, selection_reason, status)
        VALUES ('target-1', 'polymarket', 'markets', 'sports', 'market-s1', 's1', 'Old title', 0.1, 'seed-test', 'active')
      `).run()
    } finally {
      target.close()
    }

    const fromPath = buildLegacySource(dir, [{ id: 'source-1', area: 'markets', slug: 's1', watchScore: 0.9 }])

    const first = seedActiveWatchlist({ fromPath, toPath })
    assert.deepEqual(first, { sourceActive: 1, inserted: 0, updated: 1, unchanged: 0, targetActiveAfter: 1 })
    assert.equal(watchlistCount(toPath), 1, 'UNIQUE (area, slug) forbids a second row')

    const second = seedActiveWatchlist({ fromPath, toPath })
    assert.deepEqual(second, { sourceActive: 1, inserted: 0, updated: 0, unchanged: 1, targetActiveAfter: 1 })
    assert.equal(watchlistCount(toPath), 1)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})