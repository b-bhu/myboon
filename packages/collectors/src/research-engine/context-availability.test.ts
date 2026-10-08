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
