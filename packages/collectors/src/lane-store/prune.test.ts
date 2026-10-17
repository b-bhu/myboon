import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { SqliteNewsStore } from '../news/sqlite-store'
import { ensurePipelineSqliteSchema, openPipelineSqlite } from '../pipeline-store/sqlite-store'
import { RetiredLaneSqlitePathError } from './paths'
import { runLaneStorePrune, type LaneStorePruneAudit } from './prune'
import { parseLaneStorePruneArgs, runLaneStorePruneCommand } from './prune-command'

const nodeRequire = createRequire(__filename)
const { DatabaseSync } = nodeRequire('node:sqlite') as {
  DatabaseSync: new (path: string, options?: { readOnly?: boolean }) => {
    close(): void
    exec(sql: string): void
    prepare(sql: string): {
      get(...params: unknown[]): unknown
      all(...params: unknown[]): unknown[]
      run(...params: unknown[]): unknown
    }
  }
}

/** Old enough to be prunable for both the 14-day and the 7-day retentions. */
const OLD = '2026-09-20T00:00:00.000Z'
/** One hour before NOW: never prunable. */
const FRESH = '2026-10-16T23:00:00.000Z'
/** Reference "now"; every cutoff is NOW minus 14 or 7 days. */
const NOW = new Date('2026-10-17T00:00:00.000Z')

/** Tables of both lanes keyed by lane; the outboxes key on signal_id. */
const TABLE_KEY_COLUMN: Readonly<Record<string, string>> = {
  news_research_results: 'id',
  news_candidate_observations: 'id',
  news_source_runs: 'id',
  news_source_delivery_outbox: 'signal_id',
  pipeline_research: 'id',
  pipeline_candidates: 'id',
  pipeline_runs: 'id',
  pipeline_source_delivery_outbox: 'signal_id',
  pipeline_watchlist: 'id',
}

type SqliteFixtureDb = FixtureDb

interface FixtureStatement {
  get(...params: unknown[]): unknown
  all(...params: unknown[]): unknown[]
  run(...params: unknown[]): unknown
}

interface FixtureDb {
  close(): void
  exec(sql: string): void
  prepare(sql: string): FixtureStatement
}

function openFixtureDb(path: string, readOnly = false): FixtureDb {
  const db = new DatabaseSync(path, { readOnly })
  db.exec('PRAGMA foreign_keys = ON;')
  return db
}

function tableIds(path: string, table: string, keyColumn?: string): string[] {
  const db = openFixtureDb(path, true)
  try {
    const key = keyColumn ?? TABLE_KEY_COLUMN[table] ?? 'id'
    return (db.prepare(`SELECT ${key} AS key FROM ${table} ORDER BY ${key}`).all() as Array<Record<string, unknown>>)
      .map((row) => String(row.key))
  } finally {
    db.close()
  }
}

function tableCounts(path: string): Record<string, number> {
  const db = openFixtureDb(path, true)
  try {
    // Only the tables that actually exist in this lane file: each lane store
    // owns a different subset.
    const tables = (db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`)
      .all() as Array<Record<string, unknown>>).map((row) => String(row.name))
    return Object.fromEntries(tables.map((table) => {
      const row = db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count?: unknown }
      return [table, Number(row?.count ?? 0)]
    }))
  } finally {
    db.close()
  }
}

function insertNewsSourceRun(db: SqliteFixtureDb, id: string, status: string, updatedAt: string): void {
  db.prepare(`
    INSERT INTO news_source_runs (id, job_id, source_id, source_name, url_id, url_label, source_url, status, created_at, updated_at)
    VALUES (?, ?, 'src-1', 'Source', 'url-1', 'URL', 'https://example.test/source', ?, ?, ?)
  `).run(id, `job-${id}`, status, updatedAt, updatedAt)
}

function insertNewsObservation(db: SqliteFixtureDb, id: string, status: string, updatedAt: string, failureStatus?: string): void {
  db.prepare(`
    INSERT INTO news_candidate_observations (
      id, source_id, source_name, url_id, url_label, source_url, canonical_article_url,
      headline, observed_at, headline_hash, content_hash, article_identity_key,
      observation_dedupe_key, dedupe_outcome, status, research_failure_status, created_at, updated_at
    ) VALUES (?, 'src-1', 'Source', 'url-1', 'URL', 'https://example.test/source', 'https://example.test/article',
      'Headline', ?, 'hh', 'ch', 'ai', ?, 'new_candidate', ?, ?, ?, ?)
  `).run(id, updatedAt, `dedupe-${id}`, status, failureStatus ?? null, updatedAt, updatedAt)
}

function insertNewsResearchResult(db: SqliteFixtureDb, id: string, observationId: string, status: string, updatedAt: string, failureStatus?: string): void {
  db.prepare(`
    INSERT INTO news_research_results (
      id, candidate_observation_id, source_id, source_name, url_id, url_label, source_url,
      canonical_article_url, article_identity_key, observation_dedupe_key, research_job_id,
      status, response_status, source_signal, research_summary, article_claims, verified_facts,
      unresolved_claims, entity_hints, evidence, open_questions, limitations, errors, raw_response,
      entity_manager_failure_status, researched_at, created_at, updated_at
    ) VALUES (?, ?, 'src-1', 'Source', 'url-1', 'URL', 'https://example.test/source',
      'https://example.test/article', 'ai', 'dedupe', ?, ?,
      'ready_for_entity_memory', '{}', '{}', '{}', '{}', '{}', '{}', '{}', '{}', '{}', '{}', '{}',
      ?, ?, ?, ?)
  `).run(id, observationId, `job-${id}`, status, failureStatus ?? null, updatedAt, updatedAt, updatedAt)
}

function insertNewsOutbox(db: SqliteFixtureDb, signalId: string, state: string, updatedAt: string): void {
  db.prepare(`
    INSERT INTO news_source_delivery_outbox (signal_id, source_type, payload_digest, payload_json, state, created_at, updated_at, delivered_at)
    VALUES (?, 'news', 'digest', '{}', ?, ?, ?, ?)
  `).run(signalId, state, updatedAt, updatedAt, state === 'delivered' ? updatedAt : null)
}

function insertPipelineRun(db: SqliteFixtureDb, id: string, status: string, updatedAt: string): void {
  db.prepare(`
    INSERT INTO pipeline_runs (id, source, source_area, stage, status, counts, metadata, created_at, updated_at)
    VALUES (?, 'polymarket', 'markets', 'collect', ?, '{}', '{}', ?, ?)
  `).run(id, status, updatedAt, updatedAt)
}

function insertPipelineCandidate(db: SqliteFixtureDb, id: string, status: string, updatedAt: string, failureStatus?: string): void {
  db.prepare(`
    INSERT INTO pipeline_candidates (
      id, source, area, candidate_type, market_id, slug, title, tag_slug,
      observed_at, what_changed, why_flagged, status, research_failure_status, dedupe_key, created_at, updated_at
    ) VALUES (?, 'polymarket', 'markets', 'new_market', ?, ?, 'Title', 'sports',
      ?, '{}', '{}', ?, ?, ?, ?, ?)
  `).run(id, `market-${id}`, `slug-${id}`, updatedAt, status, failureStatus ?? null, `dedupe-${id}`, updatedAt, updatedAt)
}

function insertPipelineResearch(
  db: SqliteFixtureDb,
  id: string,
  candidateId: string,
  status: string,
  updatedAt: string,
  entityManagerStatus?: string,
  entityManagerFailureStatus?: string,
): void {
  db.prepare(`
    INSERT INTO pipeline_research (
      id, candidate_id, source, area, slug, title, candidate_type, research_mode,
      summary, notes, uncertainty, editor_notes, status, research_depth,
      research_family_key, research_cluster_key, entity_manager_status,
      entity_manager_failure_status, researched_at, created_at, updated_at
    ) VALUES (?, ?, 'polymarket', 'markets', ?, 'Title', 'new_market', 'standard',
      'summary', 'notes', 'uncertainty', 'editor notes', ?, 'market_structure_only',
      'family', 'cluster', ?, ?, ?, ?, ?)
  `).run(
    id, candidateId, `slug-${candidateId}`, status,
    entityManagerStatus ?? 'pending', entityManagerFailureStatus ?? null,
    updatedAt, updatedAt, updatedAt,
  )
}

function insertPipelineOutbox(db: SqliteFixtureDb, signalId: string, state: string, updatedAt: string): void {
  db.prepare(`
    INSERT INTO pipeline_source_delivery_outbox (signal_id, source_type, payload_digest, payload_json, observed_at, state, created_at, updated_at, delivered_at)
    VALUES (?, 'polymarket', 'digest', '{}', ?, ?, ?, ?, ?)
  `).run(signalId, updatedAt, state, updatedAt, updatedAt, state === 'delivered' ? updatedAt : null)
}

function insertWatchlistRow(db: SqliteFixtureDb, id: string, updatedAt: string): void {
  db.prepare(`
    INSERT INTO pipeline_watchlist (
      id, source, area, tag_slug, tag_label, market_id, slug, title,
      event_slug, event_title, end_date, is_manual_pin, rank_in_area,
      watch_score, score_breakdown, selection_reason, latest_observed_at,
      latest_yes_price, latest_volume, latest_volume_24h, latest_liquidity,
      status, created_at, updated_at
    ) VALUES (?, 'polymarket', 'markets', 'sports', 'Sports', ?, ?, ?, ?, 'Event', '2026-12-31T00:00:00.000Z', 0, 1, 0.5, '{}', 'watchlist', NULL, NULL, NULL, NULL, NULL, 'active', ?, ?)
  `).run(id, `market-${id}`, `slug-${id}`, `title-${id}`, `event-${id}`, updatedAt, updatedAt)
}

/**
 * News lane fixture. Returns the surviving ids per table expected after a
 * successful apply run (cutoffs NOW-14d for the run/observation/research
 * tables, NOW-7d for the outbox).
 */
function seedNewsLane(dir: string): { path: string; survivors: Record<string, string[]>; deletedPerTable: Record<string, number> } {
  const path = join(dir, 'news-lane.sqlite')
  const store = new SqliteNewsStore(path)
  store.close()
  const db = openFixtureDb(path)
  try {
    insertNewsSourceRun(db, 'run-old-succeeded', 'succeeded', OLD)
    insertNewsSourceRun(db, 'run-old-failed-permanent', 'failed_permanent', OLD)
    insertNewsSourceRun(db, 'run-fresh-succeeded', 'succeeded', FRESH)
    insertNewsSourceRun(db, 'run-old-running', 'running', OLD)
    insertNewsSourceRun(db, 'run-old-retry', 'retry_scheduled', OLD)
    insertNewsSourceRun(db, 'run-old-queued', 'queued', OLD)
    insertNewsSourceRun(db, 'run-old-transient', 'failed_transient', OLD)

    insertNewsObservation(db, 'obs-old-handed', 'handed_to_entity_memory', OLD)
    insertNewsResearchResult(db, 'res-old-handed', 'obs-old-handed', 'handed_to_entity_memory', OLD)
    insertNewsObservation(db, 'obs-old-researched', 'researched', OLD)
    insertNewsResearchResult(db, 'res-old-researched-handed', 'obs-old-researched', 'handed_to_entity_memory', OLD)
    insertNewsObservation(db, 'obs-old-pending-child', 'researched', OLD)
    insertNewsResearchResult(db, 'res-old-pending', 'obs-old-pending-child', 'pending_entity_memory', OLD)
    insertNewsObservation(db, 'obs-old-failed-research', 'failed_research', OLD, 'failed')
    insertNewsObservation(db, 'obs-old-deadletter', 'failed_research', OLD, 'dead_letter')
    insertNewsObservation(db, 'obs-old-rejected', 'rejected', OLD)
    insertNewsObservation(db, 'obs-old-observed-only', 'observed_only', OLD)
    // Old terminal parent whose result child only JUST became terminal: the
    // child is too young to prune, so the parent survives with it.
    insertNewsObservation(db, 'obs-old-rejected-fresh-child', 'rejected', OLD)
    insertNewsResearchResult(db, 'res-fresh-handed-under-old-parent', 'obs-old-rejected-fresh-child', 'handed_to_entity_memory', FRESH)
    insertNewsObservation(db, 'obs-fresh-handed', 'handed_to_entity_memory', FRESH)
    insertNewsResearchResult(db, 'res-fresh-handed', 'obs-fresh-handed', 'handed_to_entity_memory', FRESH)

    insertNewsOutbox(db, 'out-old-delivered', 'delivered', OLD)
    insertNewsOutbox(db, 'out-old-pending', 'pending', OLD)
    insertNewsOutbox(db, 'out-fresh-delivered', 'delivered', FRESH)
  } finally {
    db.close()
  }
  return {
    path,
    survivors: {
      news_source_runs: ['run-fresh-succeeded', 'run-old-queued', 'run-old-retry', 'run-old-running', 'run-old-transient'],
      news_candidate_observations: [
        'obs-fresh-handed', 'obs-old-deadletter', 'obs-old-failed-research',
        'obs-old-pending-child', 'obs-old-rejected-fresh-child',
      ],
      news_research_results: ['res-fresh-handed', 'res-fresh-handed-under-old-parent', 'res-old-pending'],
      news_source_delivery_outbox: ['out-fresh-delivered', 'out-old-pending'],
    },
    deletedPerTable: {
      news_research_results: 2,
      news_candidate_observations: 4,
      news_source_runs: 2,
      news_source_delivery_outbox: 1,
    },
  }
}

/**
 * Polymarket lane fixture, same shape as seedNewsLane. The candidate
 * pc-old-published-em-processing keeps a research child whose entity-manager
 * lease is stuck mid-flight ('processing'): the candidate must survive.
 */
function seedPipelineLane(dir: string): { path: string; survivors: Record<string, string[]>; deletedPerTable: Record<string, number> } {
  const path = join(dir, 'polymarket-lane.sqlite')
  const db = openPipelineSqlite(path)
  try {
    ensurePipelineSqliteSchema(db)
  } finally {
    db.close()
  }
  const fixture = openFixtureDb(path)
  try {
    insertPipelineRun(fixture, 'prow-old-succeeded', 'succeeded', OLD)
    insertPipelineRun(fixture, 'prow-old-failed', 'failed', OLD)
    insertPipelineRun(fixture, 'prow-old-skipped', 'skipped', OLD)
    insertPipelineRun(fixture, 'prow-old-partial', 'partial', OLD)
    insertPipelineRun(fixture, 'prow-old-running', 'running', OLD)
    insertPipelineRun(fixture, 'prow-fresh-succeeded', 'succeeded', FRESH)

    insertWatchlistRow(fixture, 'wl-old', OLD)

    insertPipelineCandidate(fixture, 'pc-old-stale', 'stale_expired', OLD)
    insertPipelineCandidate(fixture, 'pc-old-skip', 'skipped_recently_researched', OLD)
    insertPipelineCandidate(fixture, 'pc-old-rejected-with-research', 'rejected', OLD)
    insertPipelineResearch(fixture, 'pres-old-rejected', 'pc-old-rejected-with-research', 'rejected', OLD)
    insertPipelineCandidate(fixture, 'pc-old-published-processed', 'published', OLD)
    insertPipelineResearch(fixture, 'pres-old-published-processed', 'pc-old-published-processed', 'published', OLD, 'processed')
    insertPipelineCandidate(fixture, 'pc-old-published-em-processing', 'published', OLD)
    insertPipelineResearch(fixture, 'pres-old-edited-em-processing', 'pc-old-published-em-processing', 'edited', OLD, 'processing')
    insertPipelineCandidate(fixture, 'pc-old-published-em-pending', 'published', OLD)
    insertPipelineResearch(fixture, 'pres-old-edited-em-pending', 'pc-old-published-em-pending', 'edited', OLD, 'pending')
    insertPipelineCandidate(fixture, 'pc-old-published-em-failed', 'published', OLD)
    insertPipelineResearch(fixture, 'pres-old-edited-em-failed', 'pc-old-published-em-failed', 'edited', OLD, 'failed', 'failed')
    insertPipelineCandidate(fixture, 'pc-old-pending', 'pending_research', OLD)
    // Fresh terminal candidate whose entity-manager lifecycle is fully
    // settled: everything survives (nothing old enough to prune).
    insertPipelineCandidate(fixture, 'pc-fresh-published-em-settled', 'published', FRESH)
    insertPipelineResearch(fixture, 'pres-fresh-edited-processed', 'pc-fresh-published-em-settled', 'edited', FRESH, 'processed')
    // Old terminal candidate whose research child only JUST settled: too
    // young to prune, so the parent survives with it.
    insertPipelineCandidate(fixture, 'pc-old-published-fresh-child', 'published', OLD)
    insertPipelineResearch(fixture, 'pres-fresh-processed-under-old-candidate', 'pc-old-published-fresh-child', 'edited', FRESH, 'processed')
    insertPipelineCandidate(fixture, 'pc-old-failed', 'research_failed', OLD, 'failed')
    insertPipelineCandidate(fixture, 'pc-old-deadletter', 'research_failed', OLD, 'dead_letter')
    insertPipelineCandidate(fixture, 'pc-fresh-rejected', 'rejected', FRESH)

    insertPipelineOutbox(fixture, 'pout-old-delivered', 'delivered', OLD)
    insertPipelineOutbox(fixture, 'pout-old-pending', 'pending', OLD)
    insertPipelineOutbox(fixture, 'pout-fresh-delivered', 'delivered', FRESH)
  } finally {
    fixture.close()
  }
  return {
    path,
    survivors: {
      pipeline_runs: ['prow-fresh-succeeded', 'prow-old-running'],
      pipeline_candidates: [
        'pc-fresh-published-em-settled', 'pc-fresh-rejected', 'pc-old-deadletter', 'pc-old-failed', 'pc-old-pending',
        'pc-old-published-em-failed', 'pc-old-published-em-pending', 'pc-old-published-em-processing',
        'pc-old-published-fresh-child',
      ],
      pipeline_research: [
        'pres-fresh-edited-processed', 'pres-fresh-processed-under-old-candidate',
        'pres-old-edited-em-failed', 'pres-old-edited-em-pending', 'pres-old-edited-em-processing',
      ],
      pipeline_source_delivery_outbox: ['pout-fresh-delivered', 'pout-old-pending'],
      pipeline_watchlist: ['wl-old'],
    },
    deletedPerTable: {
      pipeline_research: 2,
      pipeline_candidates: 4,
      pipeline_runs: 4,
      pipeline_source_delivery_outbox: 1,
    },
  }
}

/** Runs the prune in both modes and asserts dry run and apply agree on counts. */
function auditFor(laneResult: LaneStorePruneAudit['lanes'][number], table: string): LaneStorePruneAudit['lanes'][number]['tables'][number] {
  return laneResult.tables.find((entry) => entry.table === table) as LaneStorePruneAudit['lanes'][number]['tables'][number]
}

function tablesOf(audit: LaneStorePruneAudit, lane: string): LaneStorePruneAudit['lanes'][number] {
  return audit.lanes.find((entry) => entry.lane === lane) as LaneStorePruneAudit['lanes'][number]
}

test('dry run counts eligible rows and deletes nothing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lane-prune-dry-'))
  try {
    const news = seedNewsLane(dir)
    const pipeline = seedPipelineLane(dir)
    const before = { news: tableCounts(news.path), pipeline: tableCounts(pipeline.path) }

    const audit = runLaneStorePrune({ paths: { news: news.path, polymarket: pipeline.path }, now: NOW })

    assert.equal(audit.mode, 'dry_run')
    assert.equal(audit.nowIso, NOW.toISOString())
    assert.deepEqual(audit.totals, { eligibleRows: 9 + 11 })
    const newsLane = tablesOf(audit, 'news')
    const pipelineLane = tablesOf(audit, 'polymarket')
    assert.equal(newsLane.status, 'pruned')
    assert.equal(pipelineLane.status, 'pruned')
    for (const [table, expected] of Object.entries(news.deletedPerTable)) {
      const result = auditFor(newsLane, table)
      assert.equal(result.eligibleRows, expected, `${table} dry-run count`)
      assert.equal(result.retentionDays, table.includes('outbox') ? 7 : 14)
    }
    for (const [table, expected] of Object.entries(pipeline.deletedPerTable)) {
      assert.equal(auditFor(pipelineLane, table).eligibleRows, expected, `${table} dry-run count`)
    }
    assert.deepEqual(tableCounts(news.path), before.news)
    assert.deepEqual(tableCounts(pipeline.path), before.pipeline)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('apply deletes only old terminal rows and is idempotent', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lane-prune-apply-'))
  try {
    const news = seedNewsLane(dir)
    const pipeline = seedPipelineLane(dir)

    const audit = runLaneStorePrune({ paths: { news: news.path, polymarket: pipeline.path }, now: NOW, apply: true })

    assert.equal(audit.mode, 'apply')
    assert.deepEqual(audit.totals, { deletedRows: 9 + 11 })
    for (const lane of [tablesOf(audit, 'news'), tablesOf(audit, 'polymarket')]) {
      assert.equal(lane.status, 'pruned')
    }
    for (const [table, expected] of Object.entries(news.deletedPerTable)) {
      assert.equal(auditFor(tablesOf(audit, 'news'), table).deletedRows, expected, `${table} deleted`)
    }
    for (const [table, expected] of Object.entries(pipeline.deletedPerTable)) {
      assert.equal(auditFor(tablesOf(audit, 'polymarket'), table).deletedRows, expected, `${table} deleted`)
    }

    for (const fixture of [news, pipeline]) {
      for (const [table, expected] of Object.entries(fixture.survivors)) {
        assert.deepEqual(tableIds(fixture.path, table).sort(), [...expected].sort(), `${table} survivors`)
      }
    }

    const secondRun = runLaneStorePrune({ paths: { news: news.path, polymarket: pipeline.path }, now: NOW, apply: true })
    assert.deepEqual(secondRun.totals, { deletedRows: 0 })
    for (const lane of secondRun.lanes) {
      for (const table of lane.tables) assert.equal(table.deletedRows, 0, `${lane.lane}/${table.table} second run`)
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('missing lane file is reported and never created, even with --apply', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lane-prune-missing-'))
  try {
    const news = seedNewsLane(dir)
    const missingPath = join(dir, 'not-here', 'polymarket-lane.sqlite')

    const audit = runLaneStorePrune({ paths: { news: news.path, polymarket: missingPath }, now: NOW, apply: true })

    const pipelineLane = tablesOf(audit, 'polymarket')
    assert.equal(pipelineLane.status, 'missing')
    assert.deepEqual(pipelineLane.tables, [])
    assert.equal(existsSync(missingPath), false, 'prune must never create a missing lane file')

    const newsLane = tablesOf(audit, 'news')
    assert.equal(newsLane.status, 'pruned')
    assert.equal(auditFor(newsLane, 'news_source_runs').deletedRows, 2)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('command resolves lane paths from env; retired filenames throw before any store opens', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lane-prune-cmd-'))
  try {
    const news = seedNewsLane(dir)
    const pipeline = seedPipelineLane(dir)

    const audit = await runLaneStorePruneCommand(
      { apply: false, now: NOW },
      { env: { NEWS_SQLITE_PATH: news.path, PIPELINE_SQLITE_PATH: pipeline.path } },
    )
    assert.equal(tablesOf(audit, 'news').status, 'pruned')
    assert.equal(tablesOf(audit, 'polymarket').status, 'pruned')
    assert.deepEqual(audit.totals, { eligibleRows: 9 + 11 })

    await assert.rejects(
      () => runLaneStorePruneCommand({ apply: true }, { env: { NEWS_SQLITE_PATH: join(dir, 'news.sqlite') } }),
      RetiredLaneSqlitePathError,
    )
    await assert.rejects(
      () => runLaneStorePruneCommand({ apply: true }, { env: { PIPELINE_SQLITE_PATH: join(dir, 'pipeline.sqlite') } }),
      RetiredLaneSqlitePathError,
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('parseLaneStorePruneArgs validates flags', () => {
  assert.deepEqual(parseLaneStorePruneArgs([]), { apply: false })
  assert.deepEqual(parseLaneStorePruneArgs(['--apply']), { apply: true })
  const now = parseLaneStorePruneArgs(['--now=2026-10-17T00:00:00.000Z']).now as Date
  assert.equal(now.getTime(), NOW.getTime())
  assert.equal(parseLaneStorePruneArgs(['--apply', '--now=2026-10-17T00:00:00.000Z']).apply, true)
  assert.throws(() => parseLaneStorePruneArgs(['--nope']), /Unknown prune argument/)
  assert.throws(() => parseLaneStorePruneArgs(['--now=yesterday']), /ISO timestamp/)
  assert.throws(() => parseLaneStorePruneArgs(['--apply', '--apply']), /only once/)
  assert.throws(() => parseLaneStorePruneArgs(['--now=2026-10-17T00:00:00.000Z', '--now=2026-10-17T00:00:00.000Z']), /only once/)
})