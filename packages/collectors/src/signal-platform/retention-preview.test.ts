import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  formatRetentionPreviewJson,
  previewSqliteRetention,
  RETENTION_PREVIEW_SCHEMA_VERSION,
} from './retention-preview'
import { parseRetentionPreviewArgs, runRetentionPreviewCli } from './run-retention-preview'

interface Statement { all(...params: unknown[]): unknown[] }
interface Database { close(): void; exec(sql: string): void; prepare(sql: string): Statement }
const nodeRequire = createRequire(__filename)
const { DatabaseSync } = nodeRequire('node:sqlite') as { DatabaseSync: new(path: string) => Database }

const BEFORE = '2026-08-26T12:00:00.000Z'

function tables(path: string): string[] {
  const db = new DatabaseSync(path)
  try {
    return (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as Array<{ name: string }>)
      .map((row) => row.name)
  } finally { db.close() }
}

function seedOperationalDatabase(path: string, sourceType: 'news' | 'polymarket'): void {
  const db = new DatabaseSync(path)
  try {
    db.exec(`
      CREATE TABLE signal_platform_research_work (
        work_id TEXT PRIMARY KEY, status TEXT, updated_at TEXT, source_type TEXT
      );
      CREATE TABLE signal_execution_events (
        event_id TEXT PRIMARY KEY, status TEXT, finished_at TEXT, source_type TEXT, stage TEXT
      );
      CREATE TABLE signal_platform_research_shadow_results (
        evaluation_id TEXT PRIMARY KEY, status TEXT, finished_at TEXT, source_type TEXT, research_depth TEXT
      );
      CREATE TABLE entity_manager_shadow_observations (
        observation_id TEXT PRIMARY KEY, outcome TEXT, observed_at TEXT,
        source_type TEXT, canonical_json TEXT
      );
      CREATE TABLE entities (id TEXT PRIMARY KEY, secret TEXT);
      CREATE TABLE entity_memories (id TEXT PRIMARY KEY, secret TEXT);

      INSERT INTO signal_platform_research_work VALUES
        ('work-complete', 'complete', '2026-08-20T00:00:00.000Z', 'news'),
        ('work-dead', 'dead_letter', '2026-08-21T00:00:00.000Z', 'news'),
        ('work-expired', 'expired', '2026-08-22T00:00:00.000Z', 'news'),
        ('work-live', 'retrieval_leased', '2026-08-01T00:00:00.000Z', 'news'),
        ('work-ready', 'research_pending', '2026-08-01T00:00:00.000Z', 'news'),
        ('work-new', 'complete', '2026-08-27T00:00:00.000Z', 'news');
      INSERT INTO signal_execution_events VALUES
        ('event-done', 'succeeded', '2026-08-20T01:00:00.000Z', 'news', 'synthesis'),
        ('event-live', 'started', NULL, 'news', 'retrieval'),
        ('event-retry', 'retry_wait', '2026-08-20T02:00:00.000Z', 'news', 'retrieval'),
        ('event-new', 'failed', '2026-08-27T00:00:00.000Z', 'news', 'synthesis');
      INSERT INTO signal_platform_research_shadow_results VALUES
        ('shadow-old', 'skipped', '2026-08-20T00:00:00.000Z', 'news', 'light'),
        ('shadow-new', 'failed', '2026-08-27T00:00:00.000Z', 'news', 'standard');
      INSERT INTO entity_manager_shadow_observations VALUES
        ('entity-shadow-old', 'accepted', '2026-08-20T02:00:00.000Z', '${sourceType}', '{"private":"shadow prose"}'),
        ('entity-shadow-rejected', 'rejected', '2026-08-21T02:00:00.000Z', '${sourceType}', '{"credential":"sk-shadow-secret"}'),
        ('entity-shadow-new', 'accepted', '2026-08-27T02:00:00.000Z', '${sourceType}', '{"private":"current"}');
      INSERT INTO entities VALUES ('entity-secret', 'sk-this-must-not-appear');
      INSERT INTO entity_memories VALUES ('memory-secret', 'private prose');
    `)
  } finally { db.close() }
}

function seedDeepRegistry(path: string, tempPath: string): void {
  const db = new DatabaseSync(path)
  try {
    db.exec(`
      CREATE TABLE deep_research_active_executions (
        unit_name TEXT PRIMARY KEY, deadline_at TEXT, temp_path TEXT
      );
      INSERT INTO deep_research_active_executions VALUES
        ('deep-old.service', '2026-08-20T00:00:00.000Z', '${tempPath.replaceAll("'", "''")}'),
        ('deep-current.service', '2026-08-27T00:00:00.000Z', '/secret/current-workspace');
    `)
  } finally { db.close() }
}

test('retention preview inventories only cutoff terminal rows and redacts deep paths and entity data', () => {
  const dir = mkdtempSync(join(tmpdir(), 'retention-preview-'))
  const newsPath = join(dir, 'news.sqlite')
  const pipelinePath = join(dir, 'pipeline.sqlite')
  const registryPath = join(dir, 'deep.sqlite')
  const tempArtifact = join(dir, 'deep-temp')
  mkdirSync(tempArtifact)
  seedOperationalDatabase(newsPath, 'news')
  seedOperationalDatabase(pipelinePath, 'polymarket')
  seedDeepRegistry(registryPath, tempArtifact)
  const newsTablesBefore = tables(newsPath)
  const pipelineTablesBefore = tables(pipelinePath)
  const registryTablesBefore = tables(registryPath)
  try {
    const report = previewSqliteRetention({
      before: BEFORE,
      sampleLimit: 2,
      databases: [
        { database: 'news', path: newsPath },
        { database: 'pipeline', path: pipelinePath },
      ],
      deepRegistryPath: registryPath,
      generatedAt: BEFORE,
    })
    assert.equal(report.schemaVersion, RETENTION_PREVIEW_SCHEMA_VERSION)
    assert.equal(report.readOnly, true)
    assert.equal(report.mutationSupported, false)
    assert.deepEqual(report.databases.map((database) => database.database), ['news', 'pipeline'])
    const work = report.databases[0]!.tables.find((table) => table.table === 'signal_platform_research_work')!
    assert.equal(work.eligibleCount, 3)
    assert.equal(work.sampleTruncated, true)
    assert.deepEqual(work.samples.map((sample) => sample.id), ['work-complete', 'work-dead'])
    assert.equal(work.samples.some((sample) => sample.id === 'work-live' || sample.id === 'work-ready'), false)
    const events = report.databases[0]!.tables.find((table) => table.table === 'signal_execution_events')!
    assert.deepEqual(events.samples.map((sample) => sample.id), ['event-done'])
    const shadow = report.databases[0]!.tables.find(
      (table) => table.table === 'signal_platform_research_shadow_results',
    )!
    assert.deepEqual(shadow.samples.map((sample) => sample.id), ['shadow-old'])
    const newsEntityShadow = report.databases[0]!.tables.find(
      (table) => table.table === 'entity_manager_shadow_observations',
    )!
    assert.equal(newsEntityShadow.eligibleCount, 2)
    assert.deepEqual(newsEntityShadow.samples.map((sample) => sample.id), [
      'entity-shadow-old', 'entity-shadow-rejected',
    ])
    assert.ok(newsEntityShadow.samples.every((sample) => sample.sourceType === 'news'))
    assert.ok(newsEntityShadow.samples.every((sample) => sample.stage === 'entity'))
    const pipelineEntityShadow = report.databases[1]!.tables.find(
      (table) => table.table === 'entity_manager_shadow_observations',
    )!
    assert.ok(pipelineEntityShadow.samples.every((sample) => sample.sourceType === 'polymarket'))
    assert.equal(report.deepRegistry?.table.eligibleCount, 1)
    assert.equal(report.deepRegistry?.table.samples[0]?.tempArtifactPresent, true)
    assert.ok(report.databases[0]!.size.totalBytes > 0)

    const json = formatRetentionPreviewJson(report)
    assert.equal(json.includes(tempArtifact), false)
    assert.equal(json.includes('/secret/current-workspace'), false)
    assert.equal(json.includes('entity-secret'), false)
    assert.equal(json.includes('memory-secret'), false)
    assert.equal(json.includes('sk-this-must-not-appear'), false)
    assert.equal(json.includes('private prose'), false)
    assert.equal(json.includes('shadow prose'), false)
    assert.equal(json.includes('sk-shadow-secret'), false)
    assert.deepEqual(tables(newsPath), newsTablesBefore)
    assert.deepEqual(tables(pipelinePath), pipelineTablesBefore)
    assert.deepEqual(tables(registryPath), registryTablesBefore)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('missing databases and absent tables are reported without creating files or schemas', () => {
  const dir = mkdtempSync(join(tmpdir(), 'retention-missing-'))
  const unrelatedPath = join(dir, 'unrelated.sqlite')
  const missingPath = join(dir, 'missing.sqlite')
  const db = new DatabaseSync(unrelatedPath)
  db.exec('CREATE TABLE legacy_rows (id TEXT PRIMARY KEY); INSERT INTO legacy_rows VALUES (\'kept\');')
  db.close()
  try {
    const report = previewSqliteRetention({
      before: BEFORE,
      sampleLimit: 10,
      databases: [
        { database: 'news', path: unrelatedPath },
        { database: 'pipeline', path: missingPath },
      ],
      deepRegistryPath: join(dir, 'missing-deep.sqlite'),
      generatedAt: BEFORE,
    })
    assert.equal(report.databases[0]?.availability, 'available')
    assert.ok(report.databases[0]?.tables.every((table) => !table.present))
    assert.equal(report.databases[1]?.availability, 'missing')
    assert.equal(report.deepRegistry?.availability, 'missing')
    assert.equal(existsSync(missingPath), false)
    assert.deepEqual(tables(unrelatedPath), ['legacy_rows'])
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('CLI requires an explicit cutoff, supports news/pipeline/both, and exposes no mutation flag', () => {
  assert.deepEqual(parseRetentionPreviewArgs([
    '--before', BEFORE, '--store', 'pipeline', '--limit', '7', '--pipeline-db', '/tmp/pipeline.sqlite',
  ]), {
    store: 'pipeline', before: BEFORE, sampleLimit: 7, pipelinePath: '/tmp/pipeline.sqlite',
  })
  assert.throws(() => parseRetentionPreviewArgs([]), /--before is required/)
  assert.throws(() => parseRetentionPreviewArgs(['--before', BEFORE, '--store', 'invalid']), /news, pipeline, or both/)
  assert.throws(() => parseRetentionPreviewArgs(['--before', BEFORE, '--limit', '501']), /between 1 and 500/)
  assert.throws(() => parseRetentionPreviewArgs(['--before', BEFORE, '--apply', 'true']), /Unknown argument/)
})

test('CLI composition emits bounded both-store JSON without creating missing databases', () => {
  const dir = mkdtempSync(join(tmpdir(), 'retention-cli-'))
  const newsPath = join(dir, 'news.sqlite')
  const pipelinePath = join(dir, 'pipeline.sqlite')
  seedOperationalDatabase(newsPath, 'news')
  try {
    const parsed = JSON.parse(runRetentionPreviewCli([
      '--before', BEFORE,
      '--store', 'both',
      '--limit', '1',
      '--news-db', newsPath,
      '--pipeline-db', pipelinePath,
      '--deep-registry', join(dir, 'deep.sqlite'),
    ], {}, new Date(BEFORE))) as Record<string, unknown>
    assert.equal(parsed.schemaVersion, RETENTION_PREVIEW_SCHEMA_VERSION)
    assert.equal((parsed.databases as unknown[]).length, 2)
    assert.equal(existsSync(pipelinePath), false)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
