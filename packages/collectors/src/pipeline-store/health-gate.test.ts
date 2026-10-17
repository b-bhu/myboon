import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import type { ErrorLogEntry } from './error-log'
import {
  HEALTH_BACKOFF_BASE_MS,
  HEALTH_BACKOFF_MAX_MS,
  SupabaseHealthGate,
  healthBackoffMs,
  waitForSupabaseRunOnce,
} from './health-gate'

// Only the DEFAULT log sink could reach the operator's JSONL file; every test
// here injects its own sink, but point the file at a throwaway directory so a
// stray default append can never land in ~/myboon-logs/errors.jsonl.
const errorLogDir = mkdtempSync(join(tmpdir(), 'health-gate-error-log-'))
process.env.MYBOON_ERROR_LOG = join(errorLogDir, 'errors.jsonl')
test.after(() => { rmSync(errorLogDir, { recursive: true, force: true }) })

// Jitter factor 0.8 + 0.4 * 0.5 = 1.0, so the raw curve survives untouched.
const EXACT_JITTER = () => 0.5

test('health backoff constants are 30s base and 15min ceiling', () => {
  assert.equal(HEALTH_BACKOFF_BASE_MS, 30_000)
  assert.equal(HEALTH_BACKOFF_MAX_MS, 900_000)
})

test('the first failure jitters 30s into [24s, 36s] and n<1 is treated as 1', () => {
  assert.equal(healthBackoffMs(1, () => 0), 24_000)
  assert.equal(healthBackoffMs(1, EXACT_JITTER), 30_000)
  const top = healthBackoffMs(1, () => 0.999)
  assert.ok(top > 24_000 && top < 36_000, `expected a jittered first delay, got ${top}`)
  assert.equal(healthBackoffMs(0, () => 0), 24_000)
  assert.deepEqual(healthBackoffMs(-3, EXACT_JITTER), 30_000)
})

test('the doubling curve caps monotonically at 15 minutes', () => {
  assert.deepEqual(
    [1, 2, 3, 4, 5, 6, 7, 8].map((failures) => healthBackoffMs(failures, EXACT_JITTER)),
    [30_000, 60_000, 120_000, 240_000, 480_000, 900_000, 900_000, 900_000],
  )
  // The exponent is guarded: absurd counters must not overflow to Infinity.
  for (const failures of [50, 1_000, Number.MAX_SAFE_INTEGER]) {
    assert.equal(healthBackoffMs(failures, () => 0.999), HEALTH_BACKOFF_MAX_MS)
  }
})

test('a failing probe skips the tick and logs one down entry', async () => {
  let now = Date.parse('2026-10-08T12:00:00.000Z')
  let probes = 0
  const entries: ErrorLogEntry[] = []
  const gate = new SupabaseHealthGate({
    app: 'test-worker',
    probe: async () => { probes += 1; throw new Error('probe failed') },
    now: () => now,
    random: EXACT_JITTER,
    log: (entry) => entries.push(entry),
  })

  assert.equal(await gate.check(), false)
  assert.equal(probes, 1)
  assert.deepEqual(gate.snapshot(), {
    available: false,
    consecutiveFailures: 1,
    skippedTicks: 1,
    nextProbeAt: new Date(now + 30_000).toISOString(),
  })
  assert.equal(entries.length, 1)
  const down = entries[0]!
  assert.equal(down.app, 'test-worker')
  assert.equal(down.kind, 'supabase_unavailable')
  assert.equal(down.state, 'down')
  assert.ok(down.error instanceof Error && down.error.message === 'probe failed')
})

test('ticks inside the backoff window skip without probing and heartbeat every 10th skipped tick', async () => {
  let now = Date.parse('2026-10-08T12:00:00.000Z')
  let probes = 0
  const entries: ErrorLogEntry[] = []
  const gate = new SupabaseHealthGate({
    app: 'test-worker',
    probe: async () => { probes += 1; throw new Error('probe failed') },
    now: () => now,
    random: EXACT_JITTER,
    log: (entry) => entries.push(entry),
  })

  assert.equal(await gate.check(), false)
  // The gate stays closed for 30s after the first failure: every check inside
  // the window is a skipped tick and must not touch Supabase again.
  for (let skipped = 2; skipped <= 20; skipped += 1) {
    assert.equal(await gate.check(), false, `check at skipped=${skipped}`)
    const heartbeats = entries.filter((entry) => entry.state === 'still_down')
    assert.equal(heartbeats.length, Math.floor(skipped / 10), `still_down entries at skipped=${skipped}`)
    // The n-th heartbeat fires on the n-th tenth skipped tick.
    heartbeats.forEach((heartbeat, index) => assert.equal(heartbeat.count, 10 * (index + 1)))
  }
  assert.equal(probes, 1, 'no tick inside the window may probe')
  assert.deepEqual(entries.map((entry) => entry.state), ['down', 'still_down', 'still_down'])
  assert.deepEqual(entries.slice(1).map((entry) => entry.count), [10, 20])
})

test('a recovered probe logs one recovered entry with downtime and skipped-tick count, then resets', async () => {
  let now = Date.parse('2026-10-08T12:00:00.000Z')
  let healthy = false
  let probes = 0
  const entries: ErrorLogEntry[] = []
  const gate = new SupabaseHealthGate({
    app: 'test-worker',
    probe: async () => { probes += 1; if (!healthy) throw new Error('probe failed') },
    now: () => now,
    random: EXACT_JITTER,
    log: (entry) => entries.push(entry),
  })

  // Fill the outage: one failed probe tick plus 19 in-window skipped ticks.
  assert.equal(await gate.check(), false)
  for (let skipped = 2; skipped <= 20; skipped += 1) await gate.check()
  healthy = true
  now += 30_000
  assert.equal(await gate.check(), true)
  assert.equal(probes, 2)

  const recovered = entries.at(-1)!
  assert.equal(recovered.state, 'recovered')
  assert.equal(recovered.downtimeMs, 30_000, 'downtime runs from the first observed failure')
  assert.equal(recovered.count, 20, 'every skipped tick of the outage is counted')
  assert.ok(recovered.error instanceof Error && recovered.error.message.includes('probe failed'))
  assert.deepEqual(gate.snapshot(), {
    available: true,
    consecutiveFailures: 0,
    skippedTicks: 0,
    nextProbeAt: null,
  })
  assert.deepEqual(entries.map((entry) => entry.state), ['down', 'still_down', 'still_down', 'recovered'])
  assert.equal(entries.filter((entry) => entry.state === 'recovered').length, 1)
})

test('a second failed probe during an outage logs no second down entry', async () => {
  let now = 0
  let probes = 0
  const entries: ErrorLogEntry[] = []
  const gate = new SupabaseHealthGate({
    app: 'test-worker',
    probe: async () => { probes += 1; throw new Error('still down') },
    now: () => now,
    random: EXACT_JITTER,
    log: (entry) => entries.push(entry),
  })

  assert.equal(await gate.check(), false)
  now = 30_000
  assert.equal(await gate.check(), false)
  now += 60_000
  assert.equal(await gate.check(), false)
  assert.equal(probes, 3)
  assert.equal(entries.length, 1, 'the down transition is logged once per outage')
  assert.equal(entries[0]!.state, 'down')
  assert.equal(gate.snapshot().consecutiveFailures, 3)
  assert.equal(gate.snapshot().nextProbeAt, new Date(now + 120_000).toISOString())
})

test('concurrent callers share one in-flight probe and each counts as its own skipped tick', async () => {
  let probes = 0
  let release!: () => void
  const waiting = new Promise<void>((resolve) => { release = resolve })
  const entries: ErrorLogEntry[] = []
  const gate = new SupabaseHealthGate({
    app: 'test-worker',
    probe: async () => { probes += 1; await waiting; throw new Error('probe failed') },
    now: () => 0,
    random: EXACT_JITTER,
    log: (entry) => entries.push(entry),
  })

  const first = gate.check()
  const second = gate.check()
  assert.equal(probes, 1)
  release()
  assert.deepEqual(await Promise.all([first, second]), [false, false])
  assert.equal(gate.snapshot().skippedTicks, 2)
  assert.deepEqual(entries.map((entry) => entry.state), ['down'])
})

test('a probe throwing a non-Error value is handled like any failure', async () => {
  const entries: ErrorLogEntry[] = []
  const gate = new SupabaseHealthGate({
    app: 'test-worker',
    probe: async () => { throw 'string failure' },
    now: () => 0,
    random: EXACT_JITTER,
    log: (entry) => entries.push(entry),
  })

  assert.equal(await gate.check(), false)
  assert.equal(entries.length, 1)
  assert.equal(entries[0]!.state, 'down', 'a down transition happened')
  assert.equal(entries[0]!.error, 'string failure')
  // formatErrorLogLine never needed Error-like input; a raw string must survive it.
  const line = JSON.stringify({ error: entries[0]!.error })
  assert.ok(line.includes('string failure'))
})

test('a throwing log sink never makes check() throw', async () => {
  let now = 0
  let healthy = false
  const gate = new SupabaseHealthGate({
    app: 'test-worker',
    probe: async () => { if (!healthy) throw new Error('probe failed') },
    now: () => now,
    random: EXACT_JITTER,
    log: () => { throw new Error('log sink exploded') },
  })

  assert.equal(await gate.check(), false)
  healthy = true
  now = 30_000
  assert.equal(await gate.check(), true)
  assert.equal(gate.snapshot().available, true)
})

test('waitForSupabaseRunOnce probes 3 times, sleeps twice, logs one down entry and rejects', async () => {
  const attempts: number[] = []
  const slept: number[] = []
  const entries: ErrorLogEntry[] = []
  const failure = new Error('probe failed')

  await assert.rejects(
    waitForSupabaseRunOnce({
      app: 'test-worker',
      probe: async () => { attempts.push(attempts.length + 1); throw failure },
      sleep: async (ms) => { slept.push(ms) },
      log: (entry) => entries.push(entry),
    }),
    (error) => error instanceof Error
      && error.message === 'Supabase unavailable after 3 health probe attempts'
      && (error as { cause?: unknown }).cause === failure,
  )

  assert.deepEqual(attempts, [1, 2, 3])
  assert.deepEqual(slept, [10_000, 10_000])
  assert.equal(entries.length, 1)
  const down = entries[0]!
  assert.equal(down.app, 'test-worker')
  assert.equal(down.kind, 'supabase_unavailable')
  assert.equal(down.state, 'down')
  assert.equal(down.count, 3)
  assert.equal(down.error, failure)
})

test('waitForSupabaseRunOnce returns after the first success without logging anything', async () => {
  let probes = 0
  const slept: number[] = []
  const entries: ErrorLogEntry[] = []

  await waitForSupabaseRunOnce({
    app: 'test-worker',
    probe: async () => { probes += 1; if (probes === 1) throw new Error('first attempt fails') },
    sleep: async (ms) => { slept.push(ms) },
    log: (entry) => entries.push(entry),
  })

  assert.equal(probes, 2)
  assert.deepEqual(slept, [10_000])
  assert.deepEqual(entries, [])
})