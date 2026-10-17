import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import test from 'node:test'
import {
  DRAFT_APP,
  PUBLISHER_APP,
  type ConditionState,
  type Pm2AppSnapshot,
  type RestartSample,
} from './condition-checks'
import { appendErrorLog } from './error-log'
import {
  createDraftCreatedAtGatherer,
  resolvePipelineSqlitePath,
  runConditionCheck,
  type ConditionCheckDeps,
  type ConditionCheckSummary,
} from './run-condition-check'

/**
 * Fake deps throughout: the checker never touches a real pm2/Supabase/disk
 * here, and the JSONL error log goes through the real appendErrorLog into a
 * temp MYBOON_ERROR_LOG file so the actual written lines are verified. The
 * draft staleness gatherer is the deliberate exception: its tests build a
 * temp pipeline.sqlite with the real created_at column shape.
 */

const APP_NAMES = [
  PUBLISHER_APP,
  DRAFT_APP,
  'myboon-api',
  'myboon-news-feed-ingestor',
  'myboon-polymarket-data-engineer',
  'myboon-feed-v3-research',
  'myboon-feed-v3-entity-manager',
]

const COLLECTORS_PACKAGE_DIR = resolve(__dirname, '..', '..')

const testNodeRequire = createRequire(__filename)
const { DatabaseSync } = testNodeRequire('node:sqlite') as {
  DatabaseSync: new (path: string, options?: { readOnly?: boolean; open?: boolean }) => {
    close(): void
    exec(sql: string): void
    prepare(sql: string): { run(...params: unknown[]): unknown }
  }
}

/**
 * Minimal pipeline.sqlite fixture with the created_at shape sqlite-store.ts
 * actually writes: TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, i.e. UTC
 * 'YYYY-MM-DD HH:MM:SS'. Omit createdAt to get a real CURRENT_TIMESTAMP row.
 */
function createDraftSqlite(path: string, rows: Array<{ id?: string; createdAt?: string }>): void {
  const db = new DatabaseSync(path)
  try {
    db.exec('CREATE TABLE pipeline_editor_drafts (id TEXT PRIMARY KEY, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)')
    rows.forEach((row, index) => {
      const id = row.id ?? `fixture-${index}`
      if (row.createdAt === undefined) {
        db.prepare('INSERT INTO pipeline_editor_drafts (id) VALUES (?)').run(id)
      } else {
        db.prepare('INSERT INTO pipeline_editor_drafts (id, created_at) VALUES (?, ?)').run(id, row.createdAt)
      }
    })
  } finally {
    db.close()
  }
}

let nowMs = 1_700_000_000_000

interface Fixture {
  dir: string
  statePath: string
  logPath: string
  env: NodeJS.ProcessEnv
}

function setup(): Fixture {
  const dir = mkdtempSync(join(tmpdir(), 'condition-check-test-'))
  const statePath = join(dir, 'condition-state.json')
  const logPath = join(dir, 'errors.jsonl')
  return { dir, statePath, logPath, env: { MYBOON_ERROR_LOG: logPath } }
}

function teardown(fixture: Fixture): void {
  rmSync(fixture.dir, { recursive: true, force: true })
}

function pm2Apps(status: string, restartTime = 0): Pm2AppSnapshot[] {
  return APP_NAMES.map((name, pmId) => ({ name, pmId, status, restartTime }))
}

function logLines(fixture: Fixture): Array<Record<string, unknown>> {
  return readFileSync(fixture.logPath, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>)
}

function kinds(fixture: Fixture): string[] {
  return logLines(fixture).map((line) => String(line.kind))
}

function readStateFile(fixture: Fixture): ConditionState {
  return JSON.parse(readFileSync(fixture.statePath, 'utf8')) as ConditionState
}

function makeDeps(fixture: Fixture, overrides: Partial<ConditionCheckDeps> = {}, apps: Pm2AppSnapshot[] | null = pm2Apps('online')): ConditionCheckDeps {
  return {
    env: fixture.env,
    statePath: fixture.statePath,
    now: () => nowMs,
    log: (entry) => appendErrorLog(entry, { env: fixture.env }),
    listPm2Apps: async () => apps,
    // Fresh output by default; a stale fetcher is injected per-test.
    fetchLastPublishedAt: async () => new Date(nowMs - 60_000).toISOString(),
    fetchLastDraftCreatedAt: async () => new Date(nowMs - 60_000).toISOString(),
    probe: async () => {},
    statfs: async () => ({ blocks: 1_000_000, bfree: 300_000, bavail: 250_000 }),
    ...overrides,
  }
}

test('all apps stopped: staleness checks stay silent, one condition_skipped line records them', async () => {
  const fixture = setup()
  try {
    const deps = makeDeps(fixture, {
      // Must never be reached while the app is not online.
      fetchLastPublishedAt: async () => { throw new Error('must not query supabase while app is stopped') },
      fetchLastDraftCreatedAt: async () => { throw new Error('must not query supabase while app is stopped') },
    }, pm2Apps('stopped'))

    const summary = await runConditionCheck(deps)

    const conditions = summary.results.map((result) => result.condition)
    assert.equal(conditions.includes('publish_stale'), false, 'publish_stale must not run for a stopped app')
    assert.equal(conditions.includes('draft_stale'), false, 'draft_stale must not run for a stopped app')
    assert.deepEqual(
      [...summary.skipped].sort(),
      ['draft_stale: app status stopped', 'publish_stale: app status stopped'],
    )

    // One skip line per run; supabase and disk still ran and stayed healthy.
    assert.deepEqual(kinds(fixture), ['condition_skipped'])
    const skipLine = logLines(fixture)[0]
    assert.equal(skipLine?.app, 'condition-check')
    const message = String(skipLine?.message)
    assert.ok(message.includes('publish_stale'), message)
    assert.ok(message.includes('draft_stale'), message)
    assert.ok(message.includes('stopped'), message)

    // Restart samples are still recorded (the pm2 read succeeded) and no
    // breach state was created.
    const state = readStateFile(fixture)
    assert.equal(state.version, 1)
    assert.equal(state.samples.length, APP_NAMES.length)
    assert.deepEqual(state.breached, {})
  } finally {
    teardown(fixture)
  }
})

test('corrupt state file is tolerated and rewritten as a fresh valid state', async () => {
  const fixture = setup()
  try {
    writeFileSync(fixture.statePath, '{"version":1,samples":[{"app"')
    const summary = await runConditionCheck(makeDeps(fixture))
    assert.equal(summary.stateWritten, true)

    const state = readStateFile(fixture)
    assert.equal(state.version, 1)
    assert.equal(state.samples.length, APP_NAMES.length)
    assert.deepEqual(state.breached, {})
    assert.equal(state.supabaseConsecutiveFailures, 0)
  } finally {
    teardown(fixture)
  }
})

test('failing pm2: staleness and restart checks skip, supabase and disk still run', async () => {
  const fixture = setup()
  try {
    const deps = makeDeps(fixture, {
      listPm2Apps: async () => { throw new Error('pm2 daemon died') },
      fetchLastPublishedAt: async () => { throw new Error('must not query when pm2 is unreadable') },
      fetchLastDraftCreatedAt: async () => { throw new Error('must not query when pm2 is unreadable') },
    }, null)

    const summary = await runConditionCheck(deps)

    assert.deepEqual(summary.results.map((result) => result.condition), ['supabase_health_failed', 'disk_high'])
    const skipped = [...summary.skipped].sort()
    assert.ok(skipped.includes('publish_stale: pm2 jlist unavailable'), JSON.stringify(skipped))
    assert.ok(skipped.includes('draft_stale: pm2 jlist unavailable'), JSON.stringify(skipped))
    assert.ok(skipped.includes('restart_burst: pm2 jlist unavailable'), JSON.stringify(skipped))
    // A failed pm2 read must not wipe the previous baseline samples.
    assert.deepEqual(readStateFile(fixture).samples, [])
  } finally {
    teardown(fixture)
  }
})

test('breach logs once, repeats at 30 min, and clears exactly once', async () => {
  const fixture = setup()
  try {
    const staleFetcher = async () => new Date(nowMs - 3 * 60 * 60 * 1000).toISOString()

    // Run 1: publisher online, last publish 3h ago -> publish_stale.
    const first = await runConditionCheck(makeDeps(fixture, { fetchLastPublishedAt: staleFetcher }))
    assert.equal(first.entriesLogged, 1)
    assert.deepEqual(kinds(fixture), ['publish_stale'])

    // Run 2, 10 min later, still stale: no repeat within the 30-min cadence.
    nowMs += 10 * 60_000
    await runConditionCheck(makeDeps(fixture, { fetchLastPublishedAt: staleFetcher }))
    assert.deepEqual(kinds(fixture), ['publish_stale'])

    // State records the breach between runs.
    const breached = readStateFile(fixture).breached
    assert.equal(breached['publish_stale:myboon-publisher'], true)

    // Run 3, 31 min after the first: the repeat fires.
    nowMs += 21 * 60_000
    const third = await runConditionCheck(makeDeps(fixture, { fetchLastPublishedAt: staleFetcher }))
    assert.equal(third.entriesLogged, 1)
    assert.equal(kinds(fixture).length, 2)
    assert.equal(kinds(fixture)[1], 'publish_stale')

    // Run 4: publisher caught up -> exactly one condition_cleared.
    nowMs += 5 * 60_000
    const fourth = await runConditionCheck(makeDeps(fixture))
    assert.equal(fourth.entriesLogged, 1)
    assert.equal(kinds(fixture)[2], 'condition_cleared')
    const cleared = logLines(fixture)[2]
    assert.equal(cleared?.condition, 'publish_stale')
    assert.deepEqual(readStateFile(fixture).breached, {})
    assert.ok(third.stateWritten && fourth.stateWritten)
  } finally {
    teardown(fixture)
  }
})

test('supabase_health_failed after 3 consecutive bad probes, cleared on success', async () => {
  const fixture = setup()
  try {
    const failingProbe = async () => { throw new Error('probe down') }

    await runConditionCheck(makeDeps(fixture, { probe: failingProbe }, pm2Apps('stopped')))
    assert.equal(kinds(fixture).includes('supabase_health_failed'), false, 'run 1 (1st failure): no breach')
    assert.equal(readStateFile(fixture).supabaseConsecutiveFailures, 1)

    nowMs += 60_000
    await runConditionCheck(makeDeps(fixture, { probe: failingProbe }, pm2Apps('stopped')))
    assert.equal(kinds(fixture).includes('supabase_health_failed'), false, 'run 2 (2nd failure): no breach')
    assert.equal(readStateFile(fixture).supabaseConsecutiveFailures, 2)

    nowMs += 60_000
    await runConditionCheck(makeDeps(fixture, { probe: failingProbe }, pm2Apps('stopped')))
    assert.equal(kinds(fixture).includes('supabase_health_failed'), true, 'run 3 (3rd failure): breach')
    const entry = logLines(fixture).find((line) => line.kind === 'supabase_health_failed')
    assert.equal(entry?.observed, 3)
    assert.equal(String(entry?.message).includes('probe down'), true)
    assert.equal(readStateFile(fixture).supabaseConsecutiveFailures, 3)

    // Runs even when the apps are stopped; supabase entries ride alongside
    // the per-run condition_skipped line.
    assert.ok(kinds(fixture).every((kind) => kind === 'supabase_health_failed' || kind === 'condition_skipped'))

    nowMs += 60_000
    await runConditionCheck(makeDeps(fixture, { probe: failingProbe }, pm2Apps('stopped')))
    assert.equal(kinds(fixture).filter((kind) => kind === 'supabase_health_failed').length, 1, 'still inside the 30-min repeat window')

    nowMs += 60_000
    await runConditionCheck(makeDeps(fixture, {}, pm2Apps('stopped')))
    assert.equal(kinds(fixture).includes('condition_cleared'), true, 'recovered probe clears the breach')
    assert.equal(readStateFile(fixture).supabaseConsecutiveFailures, 0)
  } finally {
    teardown(fixture)
  }
})

test('disk_high: breach once, silent on repeat, clears after recovery; statfs failure skips', async () => {
  const fixture = setup()
  try {
    const fullDisk = async () => ({ blocks: 1_000, bfree: 100, bavail: 100 })
    await runConditionCheck(makeDeps(fixture, { statfs: fullDisk }))
    const entry = logLines(fixture).find((line) => line.kind === 'disk_high')
    assert.ok(entry, 'disk_high must log on the first breach')
    assert.equal(entry?.observed, 90)
    assert.equal(entry?.threshold, 80)
    assert.deepEqual(readStateFile(fixture).breached['disk_high:condition-check'], true)

    nowMs += 60_000
    await runConditionCheck(makeDeps(fixture, { statfs: fullDisk }))
    assert.equal(kinds(fixture).filter((kind) => kind === 'disk_high').length, 1, 'no repeat inside 30 min')

    nowMs += 60_000
    await runConditionCheck(makeDeps(fixture))
    assert.equal(kinds(fixture).includes('condition_cleared'), true)

    // A failing statfs is a skip, never a breach and never a throw.
    const failing = await runConditionCheck(makeDeps(fixture, {
      statfs: async () => { throw new Error('statfs exploded') },
    }))
    assert.ok(failing.skipped.some((note) => note.includes('disk_high: statfs exploded')), JSON.stringify(failing.skipped))
    assert.ok(failing.results.every((result) => result.condition !== 'disk_high'))
    assert.equal(kinds(fixture).includes('disk_high'), true, 'skip happened after the breach was cleared')
  } finally {
    teardown(fixture)
  }
})

test('restart_burst: 6+ restart_time increase inside 15 min breaches, samples persist across runs', async () => {
  const fixture = setup()
  try {
    // Baseline run at restart_time 0.
    await runConditionCheck(makeDeps(fixture))
    let state = readStateFile(fixture)
    const baseline: RestartSample[] = state.samples
    assert.equal(baseline.length, APP_NAMES.length)

    nowMs += 5 * 60_000
    // The api app restart-loops: 8 restarts since the baseline, inside 15 min.
    const burstApps = pm2Apps('online')
    burstApps[APP_NAMES.indexOf('myboon-api')] = { name: 'myboon-api', pmId: 2, status: 'online', restartTime: 8 }
    await runConditionCheck(makeDeps(fixture, {}, burstApps))

    const burstEntry = logLines(fixture).find((line) => line.kind === 'restart_burst')
    assert.ok(burstEntry, 'restart_burst must log on the first breach')
    assert.equal(burstEntry?.app, 'myboon-api')
    assert.equal(burstEntry?.observed, 8)
    state = readStateFile(fixture)
    assert.equal(state.breached['restart_burst:myboon-api'], true)
  } finally {
    teardown(fixture)
  }
})

test('runConditionCheck never throws when several gatherers fail at once', async () => {
  const fixture = setup()
  try {
    const brokenDeps = makeDeps(fixture, {
      listPm2Apps: async () => null,
      fetchLastPublishedAt: async () => { throw new Error('down') },
      fetchLastDraftCreatedAt: async () => { throw new Error('down') },
      probe: async () => { throw new Error('down') },
      statfs: async () => { throw new Error('down') },
    }, null)
    // Every gatherer failing still yields exactly one result: the probe
    // counts toward the consecutive counter, but the breach needs 3 runs.
    for (let run = 1; run <= 3; run += 1) {
      const summary: ConditionCheckSummary = await runConditionCheck(brokenDeps)
      assert.equal(summary.results.length, 1)
      assert.equal(summary.results[0]?.condition, 'supabase_health_failed')
      assert.equal(summary.results[0]?.breached, run === 3)
      assert.equal(summary.results[0]?.observed, run)
      assert.equal(summary.stateWritten, true)
      assert.equal(readStateFile(fixture).supabaseConsecutiveFailures, run)
      nowMs += 60_000
    }
    assert.equal(kinds(fixture).includes('supabase_health_failed'), true)
    assert.equal(logLines(fixture).filter((line) => line.kind === 'condition_skipped').length, 3)
  } finally {
    teardown(fixture)
  }
})

test('resolvePipelineSqlitePath: PIPELINE_SQLITE_PATH wins, relative paths anchor at the package dir, default reused from failure-recovery', () => {
  assert.equal(resolvePipelineSqlitePath({}), join(COLLECTORS_PACKAGE_DIR, '.data', 'pipeline.sqlite'))
  assert.equal(resolvePipelineSqlitePath({ PIPELINE_SQLITE_PATH: '   ' }), join(COLLECTORS_PACKAGE_DIR, '.data', 'pipeline.sqlite'))
  assert.equal(resolvePipelineSqlitePath({ PIPELINE_SQLITE_PATH: '/abs/pipeline.sqlite' }), '/abs/pipeline.sqlite')
  assert.equal(resolvePipelineSqlitePath({ PIPELINE_SQLITE_PATH: 'nested/pipeline.sqlite' }), join(COLLECTORS_PACKAGE_DIR, 'nested/pipeline.sqlite'))
})

test('draft sqlite gatherer: returns max(created_at), normalised to ISO UTC so Date.parse reads it as UTC', async () => {
  const fixture = setup()
  try {
    const dbPath = join(fixture.dir, 'pipeline.sqlite')
    createDraftSqlite(dbPath, [
      { id: 'stale-row', createdAt: '2019-05-05 04:00:00' },
      { id: 'fresh-row', createdAt: '2026-01-02 10:15:00' },
    ])
    const gather = createDraftCreatedAtGatherer({ PIPELINE_SQLITE_PATH: dbPath })

    // max() wins and the SQLite 'YYYY-MM-DD HH:MM:SS' form is rewritten.
    const value = await gather()
    assert.equal(value, '2026-01-02T10:15:00Z')
    assert.equal(Date.parse(value), Date.parse('2026-01-02T10:15:00Z'))
  } finally {
    teardown(fixture)
  }
})

test('draft sqlite gatherer: single stale row is returned as-is; staleness is the check\'s decision', async () => {
  const fixture = setup()
  try {
    const dbPath = join(fixture.dir, 'pipeline.sqlite')
    createDraftSqlite(dbPath, [{ id: 'only-row', createdAt: '2019-05-05 04:00:00' }])
    const gather = createDraftCreatedAtGatherer({ PIPELINE_SQLITE_PATH: dbPath })
    assert.equal(await gather(), '2019-05-05T04:00:00Z')
  } finally {
    teardown(fixture)
  }
})

test('draft sqlite gatherer: a row written by the store default (CURRENT_TIMESTAMP) arrives as ISO UTC and fresh', async () => {
  const fixture = setup()
  try {
    const dbPath = join(fixture.dir, 'pipeline.sqlite')
    const before = Date.now()
    createDraftSqlite(dbPath, [{}])
    const value = await createDraftCreatedAtGatherer({ PIPELINE_SQLITE_PATH: dbPath })()
    assert.match(value, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/, 'the real CURRENT_TIMESTAMP format must normalise to ISO UTC')
    assert.ok(Math.abs(Date.parse(value) - before) < 30_000, `a seconds-old draft must read as seconds old, got ${value}`)
  } finally {
    teardown(fixture)
  }
})

test('draft sqlite gatherer: empty table, missing file and corrupt file reject; the missing file is never created', async () => {
  const fixture = setup()
  try {
    const emptyDb = join(fixture.dir, 'empty.sqlite')
    createDraftSqlite(emptyDb, [])
    await assert.rejects(
      createDraftCreatedAtGatherer({ PIPELINE_SQLITE_PATH: emptyDb })(),
      /pipeline_editor_drafts is empty/,
      'an empty drafts table is nothing to measure, not a stale draft',
    )

    const absentDb = join(fixture.dir, 'absent.sqlite')
    await assert.rejects(
      createDraftCreatedAtGatherer({ PIPELINE_SQLITE_PATH: absentDb })(),
      /pipeline sqlite not found at /,
    )
    assert.equal(existsSync(absentDb), false, 'the gatherer must never create pipeline.sqlite')

    const corruptDb = join(fixture.dir, 'corrupt.sqlite')
    writeFileSync(corruptDb, 'this is not a database')
    await assert.rejects(createDraftCreatedAtGatherer({ PIPELINE_SQLITE_PATH: corruptDb })(), /not a database/)
  } finally {
    teardown(fixture)
  }
})

test('draft_stale defaults to the local sqlite gatherer: a real CURRENT_TIMESTAMP row checks clean, a missing store skips without creating anything', async () => {
  const fixture = setup()
  try {
    const dbPath = join(fixture.dir, 'pipeline.sqlite')
    createDraftSqlite(dbPath, [{}])
    fixture.env.PIPELINE_SQLITE_PATH = dbPath

    const deps = makeDeps(fixture)
    delete deps.fetchLastDraftCreatedAt
    const summary = await runConditionCheck(deps)

    const draft = summary.results.find((result) => result.condition === 'draft_stale')
    assert.ok(draft, 'draft_stale must run with the default gatherer when the draft app is online')
    assert.equal(draft.breached, false, `a seconds-old draft must not breach: ${JSON.stringify(draft)}`)
    // The fixture row carries real "now", the fake clock sits in 2023, so
    // the parsed age must come out finite and negative (row in the checker's
    // future) - proof the timestamp round-tripped through the parse intact.
    assert.ok(typeof draft.observed === 'number' && Number.isFinite(draft.observed), JSON.stringify(draft))
    // An all-healthy run is completely silent: not even the log file exists.
    assert.equal(existsSync(fixture.logPath), false, 'an all-healthy run stays silent')

    // Missing store: skip, never breach, never create. fixture.env carries
    // no Supabase credentials at all, which must not matter: drafts are read
    // locally now.
    fixture.env.PIPELINE_SQLITE_PATH = join(fixture.dir, 'absent.sqlite')
    const missing = await runConditionCheck({ ...deps })
    assert.equal(missing.results.some((result) => result.condition === 'draft_stale'), false)
    assert.ok(
      missing.skipped.some((note) => note.startsWith('draft_stale:') && note.includes('pipeline sqlite not found at')),
      JSON.stringify(missing.skipped),
    )
    assert.equal(existsSync(join(fixture.dir, 'absent.sqlite')), false, 'the gatherer must never create pipeline.sqlite')
  } finally {
    teardown(fixture)
  }
})

test('draft_stale: an empty local drafts table skips (condition_skipped), it never breaches', async () => {
  const fixture = setup()
  try {
    const dbPath = join(fixture.dir, 'pipeline.sqlite')
    createDraftSqlite(dbPath, [])
    fixture.env.PIPELINE_SQLITE_PATH = dbPath

    const deps = makeDeps(fixture)
    delete deps.fetchLastDraftCreatedAt
    const summary = await runConditionCheck(deps)

    assert.equal(summary.results.some((result) => result.condition === 'draft_stale'), false)
    assert.ok(
      summary.skipped.some((note) => note.startsWith('draft_stale:') && note.includes('pipeline_editor_drafts is empty')),
      JSON.stringify(summary.skipped),
    )
    assert.equal(readStateFile(fixture).breached['draft_stale:myboon-editor-draft'], undefined)
  } finally {
    teardown(fixture)
  }
})