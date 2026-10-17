import assert from 'node:assert/strict'
import test from 'node:test'
import {
  CHECKER_APP,
  CONDITION_REPEAT_MS,
  DISK_USED_PERCENT_THRESHOLD,
  DRAFT_APP,
  DRAFT_STALE_MAX_AGE_MS,
  PUBLISHER_APP,
  PUBLISH_STALE_MAX_AGE_MS,
  RESTART_BURST_THRESHOLD,
  RESTART_BURST_WINDOW_MS,
  SAMPLE_TTL_MS,
  SUPABASE_FAIL_THRESHOLD,
  checkDisk,
  checkConfigMissing,
  checkDraftStale,
  checkPublishStale,
  checkRestartBurst,
  checkSupabaseFails,
  emptyConditionState,
  planLogEntries,
  planSkipEntries,
  skipCheckApp,
  skipNoteCheck,
  stalenessGateReason,
  statfsUsedPercent,
  updateAppStatuses,
  updateRestartSamples,
  type ConditionResult,
  type Pm2AppSample,
  type Pm2AppSnapshot,
  type RestartSample,
} from './condition-checks'

const T = 1_700_000_000_000
const ISO = (at: number) => new Date(at).toISOString()

function restartSample(at: number, restartTime: number, pmId = 0, app = 'myboon-api'): RestartSample {
  return { app, pm_id: pmId, restart_time: restartTime, at }
}

function appSample(name: string, restartTime = 0, pmId = 0): Pm2AppSample {
  return { name, pmId, restartTime }
}

function appSnapshot(status: string): Pm2AppSnapshot {
  return { name: 'myboon-publisher', pmId: 0, status, restartTime: 0 }
}

function findResult(results: readonly ConditionResult[], condition: string, app?: string): ConditionResult {
  const found = results.filter((result) => result.condition === condition && (app === undefined || result.app === app))
  assert.equal(found.length, 1, `expected exactly one ${condition} result`)
  return found[0]
}

test('publish_stale: exactly 2h old is not stale, 2h+1ms is stale', () => {
  const boundary = checkPublishStale({ lastPublishedAt: ISO(T - PUBLISH_STALE_MAX_AGE_MS) }, T)
  assert.equal(boundary.breached, false)
  assert.equal(boundary.observed, PUBLISH_STALE_MAX_AGE_MS)
  assert.equal(boundary.threshold, PUBLISH_STALE_MAX_AGE_MS)

  const stale = checkPublishStale({ lastPublishedAt: ISO(T - PUBLISH_STALE_MAX_AGE_MS - 1) }, T)
  assert.equal(stale.breached, true)
  assert.equal(stale.observed, PUBLISH_STALE_MAX_AGE_MS + 1)
})

test('publish_stale: a fresh timestamp and a future timestamp never breach', () => {
  assert.equal(checkPublishStale({ lastPublishedAt: ISO(T - 1) }, T).breached, false)
  assert.equal(checkPublishStale({ lastPublishedAt: ISO(T + 60_000) }, T).breached, false)
})

test('publish_stale: no published row breaches without an observed age', () => {
  const empty = checkPublishStale({ lastPublishedAt: null }, T)
  assert.equal(empty.breached, true)
  assert.equal(empty.observed, undefined)
  const unparseable = checkPublishStale({ lastPublishedAt: 'not-a-date' }, T)
  assert.equal(unparseable.breached, true)
  assert.equal(unparseable.observed, undefined)
})

test('draft_stale: exactly 3h old is not stale, 3h+1ms is stale', () => {
  const boundary = checkDraftStale({ lastDraftCreatedAt: ISO(T - DRAFT_STALE_MAX_AGE_MS) }, T)
  assert.equal(boundary.breached, false)
  assert.equal(boundary.observed, DRAFT_STALE_MAX_AGE_MS)
  assert.equal(checkDraftStale({ lastDraftCreatedAt: ISO(T - DRAFT_STALE_MAX_AGE_MS - 1) }, T).breached, true)
  assert.equal(checkDraftStale({ lastDraftCreatedAt: null }, T).breached, true)
})

test('disk: exactly 80% is not high, 80.1% is high', () => {
  const atThreshold = checkDisk({ usedPercent: DISK_USED_PERCENT_THRESHOLD })
  assert.equal(atThreshold.breached, false)
  assert.equal(atThreshold.observed, DISK_USED_PERCENT_THRESHOLD)
  assert.equal(checkDisk({ usedPercent: 80.1 }).breached, true)
  assert.equal(checkDisk({ usedPercent: 79.9 }).breached, false)
})

test('statfsUsedPercent: df-style read, degenerate input unmeasurable', () => {
  // blocks=1000, free=200, nonRootAvail=150 -> used 800 of (800+150) usable.
  const percent = statfsUsedPercent({ blocks: 1_000, bfree: 200, bavail: 150 })
  assert.ok(percent !== null)
  assert.ok(Math.abs(percent - 84.2105263) < 0.00001)
  assert.equal(statfsUsedPercent({ blocks: 0, bfree: 0, bavail: 0 }), null)
})

test('restart_burst: 5 restarts in the window is not a breach, 6 is', () => {
  const prev = [restartSample(T - 5 * 60_000, 10)]
  const five = checkRestartBurst({ prev, current: [appSample('myboon-api', 15)] }, T)
  assert.equal(five[0]?.breached, false)
  assert.equal(five[0]?.observed, 5)
  assert.equal(five[0]?.threshold, RESTART_BURST_THRESHOLD)

  const six = checkRestartBurst({ prev, current: [appSample('myboon-api', 16)] }, T)
  assert.equal(six[0]?.breached, true)
  assert.equal(six[0]?.observed, 6)
})

test('restart_burst: sample outside the 15-minute window is ignored', () => {
  const prev = [restartSample(T - RESTART_BURST_WINDOW_MS - 60_000, 10)]
  const result = checkRestartBurst({ prev, current: [appSample('myboon-api', 50)] }, T)
  assert.equal(result[0]?.breached, false)
  assert.equal(result[0]?.observed, 0)

  // A sample at exactly the window start is inside.
  const atStart = checkRestartBurst(
    { prev: [restartSample(T - RESTART_BURST_WINDOW_MS, 10)], current: [appSample('myboon-api', 16)] },
    T,
  )
  assert.equal(atStart[0]?.breached, true)
})

test('restart_burst: decreasing restart_time and pm_id change are resets, not breaches', () => {
  const decreased = checkRestartBurst(
    { prev: [restartSample(T - 5 * 60_000, 100)], current: [appSample('myboon-api', 10)] },
    T,
  )
  assert.equal(decreased[0]?.breached, false)
  assert.equal(decreased[0]?.observed, 0)

  const pmIdChanged = checkRestartBurst(
    { prev: [restartSample(T - 5 * 60_000, 10, 0)], current: [appSample('myboon-api', 50, 1)] },
    T,
  )
  assert.equal(pmIdChanged[0]?.breached, false)
  assert.equal(pmIdChanged[0]?.observed, 0)

  const noHistory = checkRestartBurst({ prev: [], current: [appSample('myboon-api', 50)] }, T)
  assert.equal(noHistory[0]?.breached, false)
})

test('restart_burst: one result per current app, only the bursting app breaches', () => {
  const prev = [
    restartSample(T - 5 * 60_000, 0, 0, 'myboon-api'),
    restartSample(T - 5 * 60_000, 0, 3, 'myboon-news-feed-ingestor'),
  ]
  const results = checkRestartBurst(
    {
      prev,
      current: [appSample('myboon-api', 6), appSample('myboon-news-feed-ingestor', 2, 3)],
    },
    T,
  )
  assert.equal(results.length, 2)
  const api = findResult(results, 'restart_burst', 'myboon-api')
  assert.equal(api.breached, true)
  assert.equal(api.observed, 6)
  const news = findResult(results, 'restart_burst', 'myboon-news-feed-ingestor')
  assert.equal(news.breached, false)
})

test('supabase: 2 consecutive fails is not a breach, the 3rd is; success resets', () => {
  const two = checkSupabaseFails({ prevConsecutive: 1, failed: true })
  assert.equal(two.breached, false)
  assert.equal(two.observed, 2)

  const three = checkSupabaseFails({ prevConsecutive: 2, failed: true, error: new Error('probe down') })
  assert.equal(three.breached, true)
  assert.equal(three.observed, SUPABASE_FAIL_THRESHOLD)
  assert.ok(three.error instanceof Error)

  const reset = checkSupabaseFails({ prevConsecutive: 5, failed: false })
  assert.equal(reset.breached, false)
  assert.equal(reset.observed, 0)
})

test('config_missing: a missing Supabase env breaches carrying the env error, a present env is healthy', () => {
  const missing = checkConfigMissing({
    envMissing: true,
    error: new Error('Missing required Supabase env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY'),
  })
  assert.equal(missing.condition, 'config_missing')
  assert.equal(missing.app, CHECKER_APP)
  assert.equal(missing.breached, true)
  assert.ok(missing.error instanceof Error)

  const present = checkConfigMissing({ envMissing: false })
  assert.equal(present.condition, 'config_missing')
  assert.equal(present.breached, false)
  assert.equal(present.error, undefined)
})

test('planLogEntries: config_missing follows breach/repeat/clear cadence and never moves the supabase counter', () => {
  const breach = checkConfigMissing({ envMissing: true, error: new Error('Missing required Supabase env: SUPABASE_URL') })
  const first = planLogEntries(emptyConditionState(), [breach], T)
  assert.equal(first.entries.length, 1)
  assert.equal(first.entries[0]?.kind, 'config_missing')
  assert.equal(first.breached['config_missing:condition-check'], true)
  assert.equal(first.supabaseConsecutiveFailures, undefined, 'a config-missing run must not touch the counter')

  const repeat = planLogEntries(
    { ...emptyConditionState(), breached: first.breached, lastLoggedAt: first.lastLoggedAt },
    [breach],
    T + CONDITION_REPEAT_MS,
  )
  assert.equal(repeat.entries.length, 1)
  assert.equal(repeat.entries[0]?.kind, 'config_missing')

  const cleared = planLogEntries(
    { ...emptyConditionState(), breached: first.breached, lastLoggedAt: first.lastLoggedAt },
    [checkConfigMissing({ envMissing: false })],
    T + CONDITION_REPEAT_MS,
  )
  assert.equal(cleared.entries.length, 1)
  assert.equal(cleared.entries[0]?.kind, 'condition_cleared')
  assert.equal(cleared.entries[0]?.condition, 'config_missing')
  assert.equal('config_missing:condition-check' in cleared.breached, false)
})

test('stalenessGateReason: unreadable pm2, missing app and non-online status all skip; online does not', () => {
  assert.equal(stalenessGateReason(null, 'myboon-publisher'), 'pm2 jlist unavailable')
  assert.equal(stalenessGateReason([], 'myboon-publisher'), 'app missing from pm2 jlist')
  assert.equal(stalenessGateReason([appSnapshot('stopped')], 'myboon-publisher'), 'app status stopped')
  assert.equal(stalenessGateReason([appSnapshot('launching')], 'myboon-publisher'), 'app status launching')
  assert.ok(stalenessGateReason([{ name: 'other-app', pmId: 1, status: 'online', restartTime: 0 }], 'myboon-publisher') !== null)
  assert.equal(stalenessGateReason([appSnapshot('online')], 'myboon-publisher'), null)
  // pm2 casings are not uniform across versions; status must compare loosely.
  assert.equal(stalenessGateReason([appSnapshot('ONLINE')], 'myboon-publisher'), null)
})

test('planLogEntries: first breach logs once with observable fields', () => {
  const stale: ConditionResult = { condition: 'publish_stale', app: 'myboon-publisher', breached: true, observed: 9_000_000, threshold: PUBLISH_STALE_MAX_AGE_MS }
  const plan1 = planLogEntries(emptyConditionState(), [stale], T)
  assert.equal(plan1.entries.length, 1)
  const entry = plan1.entries[0]
  assert.equal(entry?.kind, 'publish_stale')
  assert.equal(entry?.app, 'myboon-publisher')
  assert.equal(entry?.condition, 'publish_stale')
  assert.equal(entry?.observed, 9_000_000)
  assert.equal(entry?.threshold, PUBLISH_STALE_MAX_AGE_MS)
  assert.equal(entry?.error instanceof Error, true)
  assert.equal(plan1.breached['publish_stale:myboon-publisher'], true)
  assert.equal(plan1.lastLoggedAt['publish_stale:myboon-publisher'], T)
})

test('planLogEntries: repeat suppressed before 30 min, fires at exactly 30 min', () => {
  const stale: ConditionResult = { condition: 'draft_stale', app: 'myboon-editor-draft', breached: true, observed: 11_000_000, threshold: DRAFT_STALE_MAX_AGE_MS }
  const first = planLogEntries(emptyConditionState(), [stale], T)
  assert.equal(first.entries.length, 1)

  const within = planLogEntries(
    { ...emptyConditionState(), breached: first.breached, lastLoggedAt: first.lastLoggedAt },
    [{ ...stale }],
    T + CONDITION_REPEAT_MS - 1,
  )
  assert.equal(within.entries.length, 0)

  const exact = planLogEntries(
    { ...emptyConditionState(), breached: first.breached, lastLoggedAt: first.lastLoggedAt },
    [{ ...stale }],
    T + CONDITION_REPEAT_MS,
  )
  assert.equal(exact.entries.length, 1)
  assert.equal(exact.entries[0]?.kind, 'draft_stale')
})

test('planLogEntries: recovery logs condition_cleared once and clears state', () => {
  const breached = { 'publish_stale:myboon-publisher': true } as Record<string, boolean>
  const lastLoggedAt = { 'publish_stale:myboon-publisher': T } as Record<string, number>
  const recovered = planLogEntries(
    { ...emptyConditionState(), breached, lastLoggedAt },
    [{ condition: 'publish_stale', app: 'myboon-publisher', breached: false, observed: 5, threshold: PUBLISH_STALE_MAX_AGE_MS }],
    T + 60_000,
  )
  assert.equal(recovered.entries.length, 1)
  const cleared = recovered.entries[0]
  assert.equal(cleared?.kind, 'condition_cleared')
  assert.equal(cleared?.condition, 'publish_stale')
  assert.equal(cleared?.app, 'myboon-publisher')
  assert.equal('publish_stale:myboon-publisher' in recovered.breached, false)
  assert.equal('publish_stale:myboon-publisher' in recovered.lastLoggedAt, false)

  // A healthy check on a never-breached condition stays silent.
  const quiet = planLogEntries(
    emptyConditionState(),
    [{ condition: 'publish_stale', app: 'myboon-publisher', breached: false, observed: 5, threshold: PUBLISH_STALE_MAX_AGE_MS }],
    T + 60_000,
  )
  assert.equal(quiet.entries.length, 0)
})

test('planLogEntries: skipped conditions leave breach state frozen (no repeat, no clear)', () => {
  const breached = { 'publish_stale:myboon-publisher': true } as Record<string, boolean>
  // Only the supabase check ran this time (publish_stale was skipped).
  const result = planLogEntries(
    { ...emptyConditionState(), breached, lastLoggedAt: { 'publish_stale:myboon-publisher': T } as Record<string, number> },
    [checkSupabaseFails({ prevConsecutive: 0, failed: false })],
    T + 60_000,
  )
  assert.equal(result.entries.length, 0)
  assert.equal(result.breached['publish_stale:myboon-publisher'], true)
})

test('planLogEntries: restart_burst breaches are keyed per app', () => {
  const results: ConditionResult[] = [
    { condition: 'restart_burst', app: 'myboon-api', breached: true, observed: 7, threshold: RESTART_BURST_THRESHOLD },
    { condition: 'restart_burst', app: 'myboon-news-feed-ingestor', breached: false, observed: 0, threshold: RESTART_BURST_THRESHOLD },
  ]
  const plan1 = planLogEntries(emptyConditionState(), results, T)
  assert.equal(plan1.entries.length, 1)
  assert.equal(plan1.entries[0]?.app, 'myboon-api')
  assert.equal(plan1.breached['restart_burst:myboon-api'], true)
  assert.equal('restart_burst:myboon-news-feed-ingestor' in plan1.breached, false)
})

test('planLogEntries: supabase counter flows through when the check ran', () => {
  const withCheck = planLogEntries(emptyConditionState(), [checkSupabaseFails({ prevConsecutive: 2, failed: true })], T)
  assert.equal(withCheck.supabaseConsecutiveFailures, 3)
  const withoutCheck = planLogEntries(emptyConditionState(), [], T)
  assert.equal(withoutCheck.supabaseConsecutiveFailures, undefined)
})

test('updateRestartSamples: keeps samples within ~20 min, drops older, appends the current run', () => {
  const prev = [
    restartSample(T - SAMPLE_TTL_MS - 60_000, 10, 0, 'myboon-api'),
    restartSample(T - SAMPLE_TTL_MS, 11, 0, 'myboon-api'),
    restartSample(T - 60_000, 12, 0, 'myboon-api'),
  ]
  const next = updateRestartSamples(prev, [appSample('myboon-api', 20), appSample('myboon-editor-draft', 1, 2)], T)
  // A sample exactly at the TTL boundary is dropped ("within the last ~20 min").
  const kept = next.filter((sample) => sample.at === T - SAMPLE_TTL_MS - 60_000 || sample.at === T - SAMPLE_TTL_MS)
  assert.equal(kept.length, 0)
  assert.equal(next.filter((sample) => sample.at === T - 60_000).length, 1)
  const appended = next.filter((sample) => sample.at === T)
  assert.equal(appended.length, 2)
  assert.equal(appended[0]?.restart_time, 20)
  assert.equal(appended[1]?.app, 'myboon-editor-draft')
})

test('skipNoteCheck / skipCheckApp: a note maps to its check, and the clear names the gating app', () => {
  assert.equal(skipNoteCheck('publish_stale: app status stopped'), 'publish_stale')
  assert.equal(skipNoteCheck('disk_high: statfs exploded'), 'disk_high')
  assert.equal(skipNoteCheck('restart_burst: pm2 jlist unavailable'), 'restart_burst')
  assert.equal(skipCheckApp('publish_stale'), PUBLISHER_APP)
  assert.equal(skipCheckApp('draft_stale'), DRAFT_APP)
  assert.equal(skipCheckApp('restart_burst'), CHECKER_APP)
  assert.equal(skipCheckApp('disk_high'), CHECKER_APP)
})

test('planSkipEntries: first sighting logs once, unchanged notes are silent, first-seen timestamps persist', () => {
  const first = planSkipEntries(undefined, ['publish_stale: app status stopped', 'draft_stale: app status stopped'], T)
  assert.equal(first.entries.length, 1)
  const skippedEntry = first.entries[0]
  assert.equal(skippedEntry?.kind, 'condition_skipped')
  assert.equal(skippedEntry?.app, CHECKER_APP)
  assert.match((skippedEntry?.error as Error).message, /^checks skipped: publish_stale: app status stopped; draft_stale: app status stopped$/)
  assert.deepEqual(Object.keys(first.activeSkips).sort(), ['draft_stale: app status stopped', 'publish_stale: app status stopped'])
  assert.equal(first.activeSkips['publish_stale: app status stopped'], T)

  // Same notes next run: nothing logs and the first-seen stamps survive.
  const same = planSkipEntries(first.activeSkips, ['publish_stale: app status stopped', 'draft_stale: app status stopped'], T)
  assert.equal(same.entries.length, 0)
  assert.equal(same.activeSkips['publish_stale: app status stopped'], T)

  // A further run without the injected fetchers (real gatherer errors) still
  // counts as the same reasons and stays silent.
  const again = planSkipEntries(same.activeSkips, ['publish_stale: app status stopped', 'draft_stale: app status stopped'], T + CONDITION_REPEAT_MS)
  assert.equal(again.entries.length, 0)
})

test('planSkipEntries: a changed set logs only the delta - new sighting plus one clear per resolved note', () => {
  const prev = planSkipEntries(undefined, ['publish_stale: app status stopped', 'draft_stale: app status stopped'], T)

  // pm2 goes unreadable: the app-status notes resolve, the pm2 note appears.
  const changed = planSkipEntries(
    prev.activeSkips,
    ['publish_stale: pm2 jlist unavailable', 'draft_stale: pm2 jlist unavailable', 'restart_burst: pm2 jlist unavailable'],
    T + 60_000,
  )
  assert.equal(changed.entries.length, 3, 'one condition_skipped line plus one clear per resolved note')
  assert.equal(changed.entries[0]?.kind, 'condition_skipped')
  const skippedEntry = changed.entries[0]
  assert.match((skippedEntry?.error as Error).message, /^checks skipped: publish_stale: pm2 jlist unavailable/)
  const clears = changed.entries.slice(1)
  assert.deepEqual(clears.map((entry) => entry.kind), ['condition_cleared', 'condition_cleared'])
  assert.deepEqual(clears.map((entry) => entry.condition), ['publish_stale_skipped', 'draft_stale_skipped'])
  assert.deepEqual(clears.map((entry) => entry.app), [PUBLISHER_APP, DRAFT_APP])
  assert.equal(Object.keys(changed.activeSkips).length, 3)

  // Full recovery: every note clears on its own.
  const recovered = planSkipEntries(changed.activeSkips, [], T + 120_000)
  assert.equal(recovered.entries.length, 3)
  assert.match((recovered.entries[0]?.error as Error).message, /^no longer skipped: publish_stale: pm2 jlist unavailable$/)
  assert.deepEqual(Object.keys(recovered.activeSkips), [])
})

test('updateAppStatuses: readable pm2 updates the gated apps, unreadable pm2 keeps last-known statuses', () => {
  const updated = updateAppStatuses(
    { [PUBLISHER_APP]: 'online' },
    [
      { name: PUBLISHER_APP, pmId: 0, status: 'stopped', restartTime: 0 },
      { name: 'myboon-api', pmId: 2, status: 'online', restartTime: 0 },
    ],
  )
  assert.deepEqual(updated, { [PUBLISHER_APP]: 'stopped' })

  const untouched = updateAppStatuses({ [PUBLISHER_APP]: 'stopped', [DRAFT_APP]: 'launching' }, null)
  assert.deepEqual(untouched, { [PUBLISHER_APP]: 'stopped', [DRAFT_APP]: 'launching' })

  assert.deepEqual(updateAppStatuses(undefined, null), {})
})

test('emptyConditionState: version is always 1', () => {
  assert.deepEqual(emptyConditionState(), {
    version: 1,
    samples: [],
    supabaseConsecutiveFailures: 0,
    breached: {},
    lastLoggedAt: {},
  })
})