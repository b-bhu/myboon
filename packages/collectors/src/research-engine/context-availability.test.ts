import assert from 'node:assert/strict'
import test from 'node:test'
import { ArticleContextAvailabilityGate, ArticleContextProbeError, errorClassOf } from './context-availability'

// Health-gate jitter factor 0.8 + 0.4 * 0.5 = 1.0: the raw backoff curve
// survives untouched, keeping these assertions deterministic.
const EXACT_JITTER = () => 0.5

test('storage outage gates claims, backs off probes and resumes only after a successful read', async () => {
  let now = Date.parse('2026-10-08T12:00:00Z')
  let healthy = false
  let probes = 0
  const gate = new ArticleContextAvailabilityGate(async () => {
    probes += 1
    if (!healthy) throw new Error('database unavailable')
  }, () => now, undefined, EXACT_JITTER)
  assert.equal(gate.claimsAllowed, false)
  assert.equal(await gate.check(), false)
  healthy = true
  now += 29_999
  assert.equal(await gate.check(), false)
  assert.equal(probes, 1)
  now += 1
  assert.equal(await gate.check(), true)
  assert.equal(gate.claimsAllowed, true)
  assert.equal(probes, 2)
  // Healthy snapshot reads 0 even though a passing probe does not clear the
  // internal counter (Ref #336): status consumers read >0 as degraded, and the
  // curve keeps its own count.
  assert.equal(gate.snapshot().consecutiveFailures, 0)
  // The persisted internal count survived the passing probe: the next failure
  // lands on the NEXT curve step, the ~60 s band, not the first 30 s step.
  gate.invalidate()
  assert.equal(gate.claimsAllowed, false)
  assert.equal(Date.parse(gate.snapshot().nextProbeAt!) - now, 60_000)
  assert.equal(await gate.check(), false)
  now += 30_000
  assert.equal(await gate.check(), false)
  now += 30_000
  assert.equal(await gate.check(), true)
})

test('concurrent callers share one probe and outage backoff caps at fifteen minutes', async () => {
  let now = 0
  let release!: () => void
  let probes = 0
  const wait = new Promise<void>(resolve => { release = resolve })
  const gate = new ArticleContextAvailabilityGate(async () => {
    probes += 1
    if (probes === 1) await wait
    throw new Error('offline')
  }, () => now, undefined, EXACT_JITTER)
  const first = gate.check()
  const second = gate.check()
  assert.equal(probes, 1)
  release()
  assert.deepEqual(await Promise.all([first, second]), [false, false])
  for (const delay of [30_000, 60_000, 120_000, 240_000, 480_000]) {
    now += delay
    assert.equal(await gate.check(), false)
  }
  assert.equal(probes, 6)
  assert.equal(Date.parse(gate.snapshot().nextProbeAt!) - now, 900_000)
})

test('a successful old probe cannot reopen claims after a newer dependency failure', async () => {
  let now = 0
  let release!: () => void
  const waiting = new Promise<void>(resolve => { release = resolve })
  const gate = new ArticleContextAvailabilityGate(() => waiting, () => now, undefined, EXACT_JITTER)
  const pending = gate.check()
  gate.invalidate()
  release()
  assert.equal(await pending, false)
  assert.equal(gate.claimsAllowed, false)
  assert.equal(await gate.check(), false)
  now += 30_000
  assert.equal(await gate.check(), true)
})

test('healthy probes wait five minutes, but a newly observed outage retries after thirty seconds', async () => {
  let now = 0
  let probes = 0
  // Invalidate uses the shared curve through this.random, so pin the jitter.
  const gate = new ArticleContextAvailabilityGate(async () => { probes += 1 }, () => now, undefined, EXACT_JITTER)
  assert.equal(await gate.check(), true)
  assert.equal(gate.snapshot().nextProbeAt, new Date(300_000).toISOString())
  now = 299_999
  assert.equal(await gate.check(), true)
  assert.equal(probes, 1)
  now = 300_000
  assert.equal(await gate.check(), true)
  assert.equal(probes, 2)
  now += 1_000
  gate.invalidate()
  assert.equal(gate.claimsAllowed, false)
  assert.equal(Date.parse(gate.snapshot().nextProbeAt!) - now, 30_000)
  now += 29_999
  assert.equal(await gate.check(), false)
  now += 1
  assert.equal(await gate.check(), true)
  assert.equal(probes, 3)
})

test('healthy cadence is bounded and configurable without changing outage backoff', async () => {
  let now = 0
  const gate = new ArticleContextAvailabilityGate(async () => undefined, () => now, 60_000)
  assert.equal(await gate.check(), true)
  assert.equal(Date.parse(gate.snapshot().nextProbeAt!), 60_000)
  for (const invalid of [0, 29_999, 300_001, 60_000.5, NaN]) {
    assert.throws(() => new ArticleContextAvailabilityGate(async () => undefined, () => now, invalid), RangeError)
  }
})

test('a cycle advances one step: invalidate while down adds none (Ref #336)', async () => {
  let now = 0
  const gate = new ArticleContextAvailabilityGate(async () => { throw new Error('offline') }, () => now, undefined, EXACT_JITTER)
  // One failure per down cycle: the probe. invalidate() while down is the same
  // failure observed again, so a failed cycle advances exactly one curve step
  // (30s, 60s, 120s, 240s, then the 900s cap) instead of two.
  for (const delay of [0, 30_000, 60_000, 120_000, 240_000, 480_000]) {
    now += delay
    assert.equal(await gate.check(), false)
    const failures = gate.snapshot().consecutiveFailures
    const probeDeadline = gate.snapshot().nextProbeAt
    gate.invalidate()
    assert.equal(gate.snapshot().consecutiveFailures, failures)
    assert.equal(gate.snapshot().nextProbeAt, probeDeadline)
  }
  assert.equal(Date.parse(gate.snapshot().nextProbeAt!) - now, 900_000)
})

test('invalidate while down keeps the failure count and deadline; siblings count once (Ref #336)', async () => {
  let now = 0
  const gate = new ArticleContextAvailabilityGate(async () => { throw new Error('offline') }, () => now, undefined, EXACT_JITTER)
  assert.equal(await gate.check(), false)
  // Probe failure: step 1, about 30 s.
  assert.equal(gate.snapshot().consecutiveFailures, 1)
  const firstDeadline = gate.snapshot().nextProbeAt
  const generation = gate.currentGeneration
  gate.invalidate()
  assert.equal(gate.currentGeneration, generation + 1)
  // invalidate() while down bumps the identity and stays down.
  assert.equal(gate.snapshot().available, false)
  // ...but neither the curve nor the deadline move; two sibling invalidations
  // in the same cycle count once.
  gate.invalidate()
  assert.equal(gate.snapshot().consecutiveFailures, 1)
  assert.equal(gate.snapshot().nextProbeAt, firstDeadline)
  now += 30_000
  assert.equal(await gate.check(), false)
  // The next cycle still follows the curve: one failed probe per cycle.
  assert.equal(gate.snapshot().consecutiveFailures, 2)
  assert.equal(Date.parse(gate.snapshot().nextProbeAt!) - now, 60_000)
})

test('invalidation keeps growing the retry while probes pass; recordHealthy resets it (Ref #336)', async () => {
  let now = 0
  const gate = new ArticleContextAvailabilityGate(async () => undefined, () => now, undefined, EXACT_JITTER)
  assert.equal(await gate.check(), true)
  gate.invalidate()
  assert.equal(Date.parse(gate.snapshot().nextProbeAt!) - now, 30_000)
  now += 30_000
  assert.equal(await gate.check(), true)
  gate.invalidate()
  assert.equal(Date.parse(gate.snapshot().nextProbeAt!) - now, 60_000)
  now += 60_000
  assert.equal(await gate.check(), true)
  gate.invalidate()
  assert.equal(Date.parse(gate.snapshot().nextProbeAt!) - now, 120_000)
  // Record healthy only counts while the gate is up again: after the passing
  // probe reopens it, real work resets the curve so the next invalidate is
  // back on the first step.
  now += 120_000
  assert.equal(await gate.check(), true)
  gate.recordHealthy(gate.currentGeneration)
  gate.invalidate()
  assert.equal(Date.parse(gate.snapshot().nextProbeAt!) - now, 30_000)
})

test('recordHealthy resets only real work of the captured generation while available (Ref #407)', async () => {
  let now = 0
  const gate = new ArticleContextAvailabilityGate(async () => undefined, () => now, undefined, EXACT_JITTER)
  await gate.check()
  const stale = gate.currentGeneration
  gate.invalidate()
  assert.equal(gate.snapshot().consecutiveFailures, 1)
  // While the gate is down nothing counts, whether the generation is stale or current.
  gate.recordHealthy(stale)
  gate.recordHealthy(gate.currentGeneration)
  assert.equal(gate.snapshot().consecutiveFailures, 1)
  now += 30_000
  await gate.check()
  // With the gate up again the healthy snapshot reads 0 either way, so the
  // oracle is the curve: pre-invalidate work stays stale, and the skipped
  // reset keeps the internal count on step two for the next failure:
  gate.recordHealthy(stale)
  gate.invalidate()
  assert.equal(Date.parse(gate.snapshot().nextProbeAt!) - now, 60_000)
  // After the gate recovers, current-generation work resets it to step one:
  now += 60_000
  await gate.check()
  gate.recordHealthy(gate.currentGeneration)
  gate.invalidate()
  assert.equal(Date.parse(gate.snapshot().nextProbeAt!) - now, 30_000)
})

test('healthy snapshot reads 0; current-generation real work restarts the curve at step one (Ref #336)', async () => {
  let now = 0
  let healthy = false
  const gate = new ArticleContextAvailabilityGate(async () => {
    if (!healthy) throw new Error('offline')
  }, () => now, undefined, EXACT_JITTER)
  assert.equal(await gate.check(), false)
  assert.equal(gate.snapshot().consecutiveFailures, 1)
  healthy = true
  now += 30_000
  assert.equal(await gate.check(), true)
  // Healthy again: status consumers read 0 while the curve still holds the
  // earlier failure; only real work resets it.
  assert.equal(gate.snapshot().consecutiveFailures, 0)
  gate.recordHealthy(gate.currentGeneration)
  gate.invalidate()
  assert.equal(Date.parse(gate.snapshot().nextProbeAt!) - now, 30_000)
})

test('the outage backoff now uses the shared 15-min jittered health curve (Ref #346)', async () => {
  let now = 0
  const gate = new ArticleContextAvailabilityGate(async () => { throw new Error('offline') }, () => now, undefined, () => 0)
  assert.equal(await gate.check(), false)
  assert.equal(gate.snapshot().consecutiveFailures, 1)
  // random() = 0 lands on the jitter floor: 0.8 * 30s.
  assert.equal(Date.parse(gate.snapshot().nextProbeAt!) - now, 24_000)
})

test('a rejected probe records reader failures and clears them after recovery', async () => {
  let now = Date.parse('2026-10-08T12:00:00Z')
  let healthy = false
  const gate = new ArticleContextAvailabilityGate(async () => {
    if (!healthy) throw new ArticleContextProbeError([{ reader: 'managed', errorClass: 'SELF_SIGNED_CERT_IN_CHAIN' }])
  }, () => now, undefined, EXACT_JITTER)
  assert.equal(await gate.check(), false)
  const snapshot = gate.snapshot()
  assert.equal(snapshot.available, false)
  assert.deepEqual(snapshot.lastFailure, [{ reader: 'managed', errorClass: 'SELF_SIGNED_CERT_IN_CHAIN' }])
  assert.equal(Object.isFrozen(snapshot.lastFailure), true)
  healthy = true
  now += 30_000
  assert.equal(await gate.check(), true)
  assert.equal(gate.snapshot().lastFailure, null)
})

test('an unclassified probe failure exposes only the error name, never its message', async () => {
  let now = 0
  const gate = new ArticleContextAvailabilityGate(async () => {
    throw new Error('db password=hunter2 offline')
  }, () => now, undefined, EXACT_JITTER)
  assert.equal(await gate.check(), false)
  assert.deepEqual(gate.snapshot().lastFailure, [{ reader: 'probe', errorClass: 'Error' }])
  assert.equal(JSON.stringify(gate.snapshot()).includes('hunter2'), false)
})

test('errorClassOf prefers a well-formed code, then the error name, never message text', () => {
  assert.equal(errorClassOf(Object.assign(new Error('self signed certificate in certificate chain secret-url'), {
    code: 'SELF_SIGNED_CERT_IN_CHAIN',
  })), 'SELF_SIGNED_CERT_IN_CHAIN')
  assert.equal(errorClassOf({ code: '57P01' }), '57P01')
  assert.equal(errorClassOf(new TypeError('fetch failed key=abc')), 'TypeError')
  assert.equal(errorClassOf('offline'), 'unknown')
  assert.equal(errorClassOf(Object.assign(new Error('secret-url'), { code: 'bad code' })), 'Error')
})
