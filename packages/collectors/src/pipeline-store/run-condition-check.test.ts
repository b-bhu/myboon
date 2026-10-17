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
import { DEFAULT_PIPELINE_SQLITE_PATH, resolvePipelineSqlitePath } from './sqlite-store'
import { DEFAULT_PIPELINE_SQLITE_PATH as FAILURE_RECOVERY_PIPELINE_DEFAULT } from './failure-recovery'
import {
  createDraftCreatedAtGatherer,
  main,
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
  return {
    dir,
    statePath,
    logPath,
    // Supabase env present by default so the injected default probe runs;
    // the env-missing tests pass their own bare env instead.
    env: {
      MYBOON_ERROR_LOG: logPath,
      SUPABASE_URL: 'http://127.0.0.1:54321',
      SUPABASE_SERVICE_ROLE_KEY: 'test-service-role-key',
    },
  }
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

test('missing state file and repeated stopped runs: condition_skipped logs once, state persists statuses and skip notes, stdout still lists every skip', async () => {
  const fixture = setup()
  try {
    // No state file exists yet, so this doubles as the missing-state-file
    // case: the cadence starts fresh and the first sighting logs.
    const deps = makeDeps(fixture, {
      fetchLastPublishedAt: async () => { throw new Error('must not query supabase while app is stopped') },
      fetchLastDraftCreatedAt: async () => { throw new Error('must not query supabase while app is stopped') },
    }, pm2Apps('stopped'))

    const first = await runConditionCheck(deps)
    assert.deepEqual(kinds(fixture), ['condition_skipped'])
    assert.ok(first.skipped.length >= 2)
    assert.ok(String(logLines(fixture)[0]?.message).includes('checks skipped:'))

    // The notes persist in the state file keyed by reason, with the
    // last-known statuses of the two gated apps.
    let state = readStateFile(fixture)
    assert.deepEqual(
      Object.keys(state.activeSkips ?? {}).sort(),
      ['draft_stale: app status stopped', 'publish_stale: app status stopped'],
    )
    assert.equal(state.appStatus?.[PUBLISHER_APP], 'stopped')
    assert.equal(state.appStatus?.[DRAFT_APP], 'stopped')

    // Runs 2 and 3 with the same stopped fleet: silent in the log, while the
    // stdout summary still lists every skip of every run.
    nowMs += 60_000
    const second = await runConditionCheck(deps)
    nowMs += 60_000
    await runConditionCheck(deps)
    assert.equal(
      logLines(fixture).filter((line) => line.kind === 'condition_skipped').length,
      1,
      'repeated stopped runs must not log again',
    )
    assert.deepEqual(
      [...second.skipped].sort(),
      ['draft_stale: app status stopped', 'publish_stale: app status stopped'],
    )
    // First-seen timestamps persist for the still-active notes.
    state = readStateFile(fixture)
    for (const seenAt of Object.values(state.activeSkips ?? {})) {
      assert.equal(typeof seenAt, 'number')
      assert.ok((seenAt as number) <= nowMs)
    }
  } finally {
    teardown(fixture)
  }
})

test('corrupt skip-cadence fields in the state file are dropped and the cadence starts fresh', async () => {
  const fixture = setup()
  try {
    // A state file with the new fields typed wrong (value shapes the
    // parser cannot trust) must behave like a file without them.
    writeFileSync(fixture.statePath, JSON.stringify({
      version: 1,
      samples: [],
      supabaseConsecutiveFailures: 0,
      breached: {},
      lastLoggedAt: {},
      appStatus: { [PUBLISHER_APP]: 42 },
      activeSkips: { 'publish_stale: app status stopped': 'yes' },
    }))
    const deps = makeDeps(fixture, {
      fetchLastPublishedAt: async () => { throw new Error('must not run') },
      fetchLastDraftCreatedAt: async () => { throw new Error('must not run') },
    }, pm2Apps('stopped'))

    await runConditionCheck(deps)
    assert.deepEqual(kinds(fixture), ['condition_skipped'], 'untrusted cadence fields mean a fresh cadence')
    nowMs += 60_000
    await runConditionCheck(deps)
    assert.equal(logLines(fixture).filter((line) => line.kind === 'condition_skipped').length, 1)
    // The rewrite stores only well-typed fields.
    const state = readStateFile(fixture)
    assert.deepEqual(Object.keys(state.activeSkips ?? {}).sort(), ['draft_stale: app status stopped', 'publish_stale: app status stopped'])
    assert.equal(state.appStatus?.[PUBLISHER_APP], 'stopped')
  } finally {
    teardown(fixture)
  }
})

test('online -> stopped logs the skip; back online closes each gate with one clear and staleness resumes', async () => {
  const fixture = setup()
  try {
    // Baseline: everything online and healthy - completely silent.
    await runConditionCheck(makeDeps(fixture))
    assert.equal(existsSync(fixture.logPath), false)
    assert.equal(readStateFile(fixture).appStatus?.[PUBLISHER_APP], 'online')

    // Apps go down: the online -> not-online transition logs one
    // condition_skipped line naming the reasons.
    nowMs += 60_000
    const stoppedDeps = makeDeps(fixture, {
      fetchLastPublishedAt: async () => { throw new Error('must not run') },
      fetchLastDraftCreatedAt: async () => { throw new Error('must not run') },
    }, pm2Apps('stopped'))
    await runConditionCheck(stoppedDeps)
    assert.deepEqual(kinds(fixture), ['condition_skipped'])
    assert.equal(readStateFile(fixture).appStatus?.[PUBLISHER_APP], 'stopped')

    // Repeated stopped runs stay silent.
    nowMs += 60_000
    await runConditionCheck(stoppedDeps)
    assert.deepEqual(kinds(fixture), ['condition_skipped'])

    // Apps come back: exactly one condition_cleared per gated check
    // (condition "<check>_skipped") and staleness resumes.
    nowMs += 60_000
    const back = await runConditionCheck(makeDeps(fixture))
    const clears = logLines(fixture).filter((line) => line.kind === 'condition_cleared')
    assert.equal(clears.length, 2)
    assert.deepEqual(clears.map((line) => line.condition).sort(), ['draft_stale_skipped', 'publish_stale_skipped'])
    const publishClear = clears.find((line) => line.condition === 'publish_stale_skipped')
    assert.equal(publishClear?.app, PUBLISHER_APP)
    assert.ok(String(publishClear?.message).includes('no longer skipped: publish_stale: app status stopped'))
    const publishResult = back.results.find((result) => result.condition === 'publish_stale')
    assert.ok(publishResult, 'publish_stale must run again once the app is online')
    assert.equal(publishResult.breached, false)
    const draftResult = back.results.find((result) => result.condition === 'draft_stale')
    assert.ok(draftResult && draftResult.breached === false)

    // The skip state is drained; a further online run logs nothing new.
    assert.deepEqual(Object.keys(readStateFile(fixture).activeSkips ?? {}), [])
    nowMs += 60_000
    await runConditionCheck(makeDeps(fixture))
    assert.equal(logLines(fixture).filter((line) => line.kind === 'condition_cleared').length, 2, 'no further clears')
    assert.equal(logLines(fixture).filter((line) => line.kind === 'condition_skipped').length, 1, 'no further skips')
    assert.equal(readStateFile(fixture).appStatus?.[DRAFT_APP], 'online')
  } finally {
    teardown(fixture)
  }
})

test('statfs failure: skip logs once and stays silent while it persists, clears when statfs recovers', async () => {
  const fixture = setup()
  try {
    const failing = async () => { throw new Error('statfs exploded') }
    await runConditionCheck(makeDeps(fixture, { statfs: failing }))
    assert.deepEqual(kinds(fixture), ['condition_skipped'])
    assert.deepEqual(Object.keys(readStateFile(fixture).activeSkips ?? {}), ['disk_high: statfs exploded'])

    // Same failure next run: silent (only the changed reasons log).
    nowMs += 60_000
    await runConditionCheck(makeDeps(fixture, { statfs: failing }))
    assert.deepEqual(kinds(fixture), ['condition_skipped'])

    // Statfs recovers: one clear carrying condition <check>_skipped.
    nowMs += 60_000
    const recovered = await runConditionCheck(makeDeps(fixture))
    const clears = logLines(fixture).filter((line) => line.kind === 'condition_cleared')
    assert.equal(clears.length, 1)
    assert.equal(clears[0]?.condition, 'disk_high_skipped')
    assert.equal(clears[0]?.app, 'condition-check')
    const disk = recovered.results.find((result) => result.condition === 'disk_high')
    assert.ok(disk && disk.breached === false, 'disk_high must run again after statfs recovers')
    assert.deepEqual(Object.keys(readStateFile(fixture).activeSkips ?? {}), [])
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

    // The healthy config_missing check rides along (env present); supabase
    // and disk still ran.
    assert.deepEqual(summary.results.map((result) => result.condition), ['config_missing', 'supabase_health_failed', 'disk_high'])
    assert.equal(summary.results.find((result) => result.condition === 'config_missing')?.breached, false)
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
    // The Supabase env was present throughout: config_missing never breaches.
    assert.equal(kinds(fixture).includes('config_missing'), false)
  } finally {
    teardown(fixture)
  }
})

test('missing Supabase env: config_missing breaches once, repeats at 30 min, the probe never runs or counts', async () => {
  const fixture = setup()
  try {
    // env carries no Supabase credentials and no probe is injected, so the
    // run reaches the default missing-env path: config_missing, never a
    // supabase_health_failed result.
    const deps = makeDeps(fixture, { env: { MYBOON_ERROR_LOG: fixture.logPath }, probe: undefined })

    const first = await runConditionCheck(deps)
    assert.deepEqual(kinds(fixture), ['config_missing'])
    const entry = logLines(fixture)[0]
    assert.equal(entry?.app, 'condition-check')
    assert.equal(String(entry?.message).includes('Missing required Supabase env'), true)
    assert.equal(readStateFile(fixture).breached['config_missing:condition-check'], true)
    assert.equal(first.results.some((result) => result.condition === 'supabase_health_failed'), false)
    assert.equal(readStateFile(fixture).supabaseConsecutiveFailures, 0, 'the counter is left as the previous state had it')

    // Runs 2 and 3, still inside the 30-min cadence: silent.
    nowMs += 10 * 60_000
    await runConditionCheck(deps)
    nowMs += 10 * 60_000
    await runConditionCheck(deps)
    assert.deepEqual(kinds(fixture), ['config_missing'], 'no repeat inside 30 min')
    assert.equal(readStateFile(fixture).supabaseConsecutiveFailures, 0)

    // Run 4, 30 min after the first breach: config_missing fires again.
    nowMs += 10 * 60_000
    await runConditionCheck(deps)
    assert.equal(kinds(fixture).filter((kind) => kind === 'config_missing').length, 2)
    assert.equal(readStateFile(fixture).supabaseConsecutiveFailures, 0)
  } finally {
    teardown(fixture)
  }
})

test('missing Supabase env: a stale state file with supabase failures and a breach logs no supabase_health_failed', async () => {
  const fixture = setup()
  try {
    // An older run left a 5-failure counter and a still-breached
    // supabase_health_failed flag behind: an env-missing run must not log any
    // supabase_health_failed line (nor clear the stale breach), and the
    // counter must stay exactly as the file held it.
    writeFileSync(fixture.statePath, JSON.stringify({
      version: 1,
      samples: [],
      supabaseConsecutiveFailures: 5,
      breached: { 'supabase_health_failed:condition-check': true },
      lastLoggedAt: { 'supabase_health_failed:condition-check': nowMs - 60 * 60_000 },
    }))
    const deps = makeDeps(fixture, { env: { MYBOON_ERROR_LOG: fixture.logPath }, probe: undefined })

    await runConditionCheck(deps)
    assert.equal(kinds(fixture).includes('supabase_health_failed'), false)
    assert.equal(kinds(fixture).includes('condition_cleared'), false, 'the stale supabase breach stays frozen, it is not cleared')
    assert.equal(kinds(fixture).filter((kind) => kind === 'config_missing').length, 1)
    assert.equal(readStateFile(fixture).supabaseConsecutiveFailures, 5)
    assert.equal(readStateFile(fixture).breached['config_missing:condition-check'], true)
  } finally {
    teardown(fixture)
  }
})

test('missing Supabase env restored: exactly one condition_cleared for config_missing', async () => {
  const fixture = setup()
  try {
    const bareEnv: NodeJS.ProcessEnv = { MYBOON_ERROR_LOG: fixture.logPath }
    const missingDeps = makeDeps(fixture, { env: bareEnv, probe: undefined })
    await runConditionCheck(missingDeps)
    nowMs += 60_000
    await runConditionCheck(missingDeps)
    assert.deepEqual(kinds(fixture), ['config_missing'])
    assert.equal(readStateFile(fixture).breached['config_missing:condition-check'], true)

    // Env restored (credentials appear) with the healthy default probe: the
    // config check reports healthy and closes the breach exactly once.
    nowMs += 60_000
    bareEnv.SUPABASE_URL = 'http://127.0.0.1:54321'
    bareEnv.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key'
    const restored = await runConditionCheck(makeDeps(fixture, { env: bareEnv }))
    assert.equal(restored.results.some((result) => result.condition === 'config_missing' && result.breached), false)
    assert.equal(kinds(fixture).filter((kind) => kind === 'condition_cleared').length, 1, 'exactly one condition_cleared on recovery')
    const cleared = logLines(fixture).find((line) => line.kind === 'condition_cleared')
    assert.equal(cleared?.condition, 'config_missing')
    assert.equal(readStateFile(fixture).breached['config_missing:condition-check'], undefined)
    assert.equal(kinds(fixture).filter((kind) => kind === 'config_missing').length, 1, 'no second config_missing line')
  } finally {
    teardown(fixture)
  }
})

test('main: loadEnv runs before the check run (dotenv chain first) and the run exits 0', async () => {
  const order: string[] = []
  const exitCodes: number[] = []
  await main({
    loadEnv: () => { order.push('loadEnv') },
    run: async () => {
      order.push('run')
      return { now: 0, results: [], skipped: [], entriesLogged: 0, stateWritten: true }
    },
    exit: (code) => { order.push('exit'); exitCodes.push(code) },
  })
  assert.deepEqual(order, ['loadEnv', 'run', 'exit'])
  assert.deepEqual(exitCodes, [0])
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
    // Every gatherer failing still yields exactly two results: the healthy
    // config_missing check (the Supabase env is present here) and the probe
    // result - which counts toward the consecutive counter, but the breach
    // needs 3 runs.
    for (let run = 1; run <= 3; run += 1) {
      const summary: ConditionCheckSummary = await runConditionCheck(brokenDeps)
      assert.equal(summary.results.length, 2)
      assert.equal(summary.results[0]?.condition, 'config_missing')
      assert.equal(summary.results[0]?.breached, false)
      assert.equal(summary.results[1]?.condition, 'supabase_health_failed')
      assert.equal(summary.results[1]?.breached, run === 3)
      assert.equal(summary.results[1]?.observed, run)
      assert.equal(summary.stateWritten, true)
      assert.equal(readStateFile(fixture).supabaseConsecutiveFailures, run)
      nowMs += 60_000
    }
    assert.equal(kinds(fixture).includes('supabase_health_failed'), true)
    // Skip cadence: the identical skip reasons log condition_skipped once on
    // first sighting; the two later runs with the same reasons stay silent.
    assert.equal(logLines(fixture).filter((line) => line.kind === 'condition_skipped').length, 1)
  } finally {
    teardown(fixture)
  }
})

test('pipeline sqlite path: resolution lives in sqlite-store (default, absolute override, cwd-relative), shared via failure-recovery', () => {
  // No path -> the sqlite-store default: an absolute <collectors>/.data/pipeline.sqlite.
  assert.equal(resolvePipelineSqlitePath(), DEFAULT_PIPELINE_SQLITE_PATH)
  assert.equal(DEFAULT_PIPELINE_SQLITE_PATH, join(COLLECTORS_PACKAGE_DIR, '.data', 'pipeline.sqlite'))
  // failure-recovery re-exports the same constant: one source of truth.
  assert.equal(FAILURE_RECOVERY_PIPELINE_DEFAULT, DEFAULT_PIPELINE_SQLITE_PATH)
  // An absolute PIPELINE_SQLITE_PATH passes through untouched, and ':memory:'
  // keeps its test-seam meaning.
  assert.equal(resolvePipelineSqlitePath('/abs/pipeline.sqlite'), '/abs/pipeline.sqlite')
  assert.equal(resolvePipelineSqlitePath(':memory:'), ':memory:')
  // A relative path anchors at the process working directory, matching the
  // other runners' '.data/...' env defaults.
  assert.equal(resolvePipelineSqlitePath('nested/pipeline.sqlite'), resolve(process.cwd(), 'nested/pipeline.sqlite'))
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

    // Missing store: skip, never breach, never create. The draft read is
    // local - it never touches the Supabase env or the config_missing check.
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