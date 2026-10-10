import assert from 'node:assert/strict'
import test from 'node:test'
import { ArticleContextAvailabilityGate } from './context-availability'

test('storage outage gates claims, backs off probes and resumes only after a successful read', async () => {
  let now = Date.parse('2026-10-08T12:00:00Z')
  let healthy = false
  let probes = 0
  const gate = new ArticleContextAvailabilityGate(async () => {
    probes += 1
    if (!healthy) throw new Error('database unavailable')
  }, () => now)
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
  assert.equal(gate.snapshot().consecutiveFailures, 0)
  gate.invalidate()
  assert.equal(gate.claimsAllowed, false)
  assert.equal(await gate.check(), false)
  now += 30_000
  assert.equal(await gate.check(), true)
})

test('concurrent callers share one probe and outage backoff stops at five minutes', async () => {
  let now = 0
  let release!: () => void
  let probes = 0
  const wait = new Promise<void>(resolve => { release = resolve })
  const gate = new ArticleContextAvailabilityGate(async () => {
    probes += 1
    if (probes === 1) await wait
    throw new Error('offline')
  }, () => now)
  const first = gate.check()
  const second = gate.check()
  assert.equal(probes, 1)
  release()
  assert.deepEqual(await Promise.all([first, second]), [false, false])
  for (const delay of [30_000, 60_000, 120_000, 240_000, 300_000]) {
    now += delay
    assert.equal(await gate.check(), false)
  }
  assert.equal(probes, 6)
  assert.equal(Date.parse(gate.snapshot().nextProbeAt!) - now, 300_000)
})

test('a successful old probe cannot reopen claims after a newer dependency failure', async () => {
  let now = 0
  let release!: () => void
  const waiting = new Promise<void>(resolve => { release = resolve })
  const gate = new ArticleContextAvailabilityGate(() => waiting, () => now)
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
  const gate = new ArticleContextAvailabilityGate(async () => { probes += 1 }, () => now)
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

test('repeated invalidation preserves an already known outage backoff', async () => {
  let now = 0
  const gate = new ArticleContextAvailabilityGate(async () => { throw new Error('offline') }, () => now)
  for (const delay of [0, 30_000, 60_000, 120_000, 240_000]) {
    now += delay
    assert.equal(await gate.check(), false)
    const deadline = gate.snapshot().nextProbeAt
    gate.invalidate()
    assert.equal(gate.snapshot().nextProbeAt, deadline)
  }
  assert.equal(Date.parse(gate.snapshot().nextProbeAt!) - now, 300_000)
})
