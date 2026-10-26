import assert from 'node:assert/strict'
import test from 'node:test'

import { takeHealthSnapshot } from './health'
import type { V4HealthSnapshot, V4HealthSource, V4Stage } from './health'
import { createStageLogger } from './logger'

const STAGE: V4Stage = 'analyst'
const HOUR_MS = 3_600_000
const FIXED_NOW = new Date('2026-10-25T12:00:00.000Z')
const EXPECTED_SINCE_MS = FIXED_NOW.getTime() - HOUR_MS

/** Clock pinned to FIXED_NOW so `at` and the one-hour window are predictable. */
function fixedNow(): Date {
  return FIXED_NOW
}

/** Source whose windowed reads reject; names listed in `failing` fail instead. */
function fakeSource(values: FakeValues, failing: string[] = []): {
  source: V4HealthSource
  windows: { leaseExpiries: number[]; signalsSince: number[] }
} {
  const windows = { leaseExpiries: [] as number[], signalsSince: [] as number[] }
  const shouldFail = (name: string) => failing.includes(name)
  const source: V4HealthSource = {
    async queueDepth() {
      if (shouldFail('queueDepth')) throw new Error('queueDepth unavailable')
      return values.queueDepth === undefined ? 0 : values.queueDepth
    },
    async oldestClaimAgeMs() {
      if (shouldFail('oldestClaimAgeMs')) throw new Error('oldestClaimAgeMs unavailable')
      return values.oldestClaimAgeMs ?? null
    },
    async leaseExpiries(_stage, sinceMs) {
      windows.leaseExpiries.push(sinceMs)
      if (shouldFail('leaseExpiries')) throw new Error('leaseExpiries unavailable')
      return values.leaseExpiries === undefined ? 0 : values.leaseExpiries
    },
    async deadLetterCount() {
      if (shouldFail('deadLetterCount')) throw new Error('deadLetterCount unavailable')
      return values.deadLetterCount === undefined ? 0 : values.deadLetterCount
    },
    async advisoryLockHolder() {
      if (shouldFail('advisoryLockHolder')) throw new Error('advisoryLockHolder unavailable')
      return values.advisoryLockHolder ?? null
    },
    async signalsSince(_stage, sinceMs) {
      windows.signalsSince.push(sinceMs)
      if (shouldFail('signalsSince')) throw new Error('signalsSince unavailable')
      return values.signalsSince === undefined ? 0 : values.signalsSince
    },
  }
  return { source, windows }
}

// Fields whose reads may legitimately answer null instead of a number.
type FakeValues = {
  queueDepth?: number | null
  oldestClaimAgeMs?: number | null
  leaseExpiries?: number | null
  deadLetterCount?: number | null
  advisoryLockHolder?: { pid: number; since: string } | null
  signalsSince?: number | null
}

function lineCollector(): { lines: string[]; write: (line: string) => void } {
  const lines: string[] = []
  return { lines, write: (line) => { lines.push(line) } }
}

test('takeHealthSnapshot returns every metric on the happy path', async () => {
  const { source } = fakeSource({
    queueDepth: 7,
    oldestClaimAgeMs: 45_000,
    leaseExpiries: 2,
    deadLetterCount: 1,
    advisoryLockHolder: { pid: 4242, since: '2026-10-25T11:30:00Z' },
    signalsSince: 11,
  })

  const snapshot = await takeHealthSnapshot(STAGE, source, fixedNow)

  const expected: V4HealthSnapshot = {
    stage: STAGE,
    at: '2026-10-25T12:00:00.000Z',
    queueDepth: 7,
    oldestClaimAgeMs: 45_000,
    leaseExpiriesLastHour: 2,
    deadLetterCount: 1,
    advisoryLockHolder: { pid: 4242, since: '2026-10-25T11:30:00Z' },
    signalsPerHour: 11,
    errors: [],
  }
  assert.deepEqual(snapshot, expected)
})

test('takeHealthSnapshot windows the timed reads to the last hour on the injected clock', async () => {
  const { source, windows } = fakeSource({
    queueDepth: 0,
    oldestClaimAgeMs: null,
    leaseExpiries: 0,
    deadLetterCount: 0,
    advisoryLockHolder: null,
    signalsSince: 0,
  })

  const snapshot = await takeHealthSnapshot(STAGE, source, fixedNow)

  assert.equal(snapshot.at, '2026-10-25T12:00:00.000Z')
  assert.deepEqual(windows.leaseExpiries, [EXPECTED_SINCE_MS])
  assert.deepEqual(windows.signalsSince, [EXPECTED_SINCE_MS])
  assert.equal(snapshot.leaseExpiriesLastHour, 0)
  assert.equal(snapshot.signalsPerHour, 0)
})

test('a failing read turns only that field null and adds one error entry', async () => {
  const { source } = fakeSource(
    { queueDepth: 3, oldestClaimAgeMs: null, leaseExpiries: 0, deadLetterCount: 4, advisoryLockHolder: null, signalsSince: 5 },
    ['deadLetterCount'],
  )
  const oneSecondLater = () => new Date(FIXED_NOW.getTime() + 1_000)

  const snapshot = await takeHealthSnapshot(STAGE, source, oneSecondLater)

  assert.equal(snapshot.stage, STAGE)
  assert.equal(snapshot.at, '2026-10-25T12:00:01.000Z')
  assert.equal(snapshot.queueDepth, 3)
  assert.equal(snapshot.deadLetterCount, null)
  assert.equal(snapshot.signalsPerHour, 5)
  assert.deepEqual(snapshot.errors, ['deadLetterCount: deadLetterCount unavailable'])
})

test('a rejected oldestClaimAgeMs is null with an error entry, not silently empty', async () => {
  const { source } = fakeSource({ oldestClaimAgeMs: null }, ['oldestClaimAgeMs'])

  const snapshot = await takeHealthSnapshot(STAGE, source, fixedNow)

  assert.equal(snapshot.oldestClaimAgeMs, null)
  assert.deepEqual(snapshot.errors, ['oldestClaimAgeMs: oldestClaimAgeMs unavailable'])
})

test('every failing read fails soft: all fields null, all errors recorded, no throw', async () => {
  const allFailing = ['queueDepth', 'oldestClaimAgeMs', 'leaseExpiries', 'deadLetterCount', 'advisoryLockHolder', 'signalsSince']
  const { source } = fakeSource({}, allFailing)

  const snapshot = await takeHealthSnapshot(STAGE, source, fixedNow)

  assert.equal(snapshot.stage, STAGE)
  assert.equal(snapshot.at, '2026-10-25T12:00:00.000Z')
  assert.equal(snapshot.queueDepth, null)
  assert.equal(snapshot.oldestClaimAgeMs, null)
  assert.equal(snapshot.leaseExpiriesLastHour, null)
  assert.equal(snapshot.deadLetterCount, null)
  assert.equal(snapshot.advisoryLockHolder, null)
  assert.equal(snapshot.signalsPerHour, null)
  assert.deepEqual(snapshot.errors, [
    'queueDepth: queueDepth unavailable',
    'oldestClaimAgeMs: oldestClaimAgeMs unavailable',
    'leaseExpiriesLastHour: leaseExpiries unavailable',
    'deadLetterCount: deadLetterCount unavailable',
    'advisoryLockHolder: advisoryLockHolder unavailable',
    'signalsPerHour: signalsSince unavailable',
  ])
})

test('a legitimate null advisory-lock holder carries no error entry', async () => {
  const { source } = fakeSource({
    queueDepth: 0,
    oldestClaimAgeMs: null,
    leaseExpiries: 0,
    deadLetterCount: 0,
    advisoryLockHolder: null,
    signalsSince: 0,
  })

  const snapshot = await takeHealthSnapshot(STAGE, source, fixedNow)

  assert.equal(snapshot.advisoryLockHolder, null)
  assert.deepEqual(snapshot.errors, [])
})

test('null metric values are plain nulls, not errors, across every nullable field', async () => {
  const { source } = fakeSource({
    queueDepth: null,
    oldestClaimAgeMs: null,
    leaseExpiries: null,
    deadLetterCount: null,
    advisoryLockHolder: null,
    signalsSince: null,
  })

  const snapshot = await takeHealthSnapshot(STAGE, source, fixedNow)

  assert.equal(snapshot.queueDepth, null)
  assert.equal(snapshot.oldestClaimAgeMs, null)
  assert.equal(snapshot.leaseExpiriesLastHour, null)
  assert.equal(snapshot.deadLetterCount, null)
  assert.equal(snapshot.advisoryLockHolder, null)
  assert.equal(snapshot.signalsPerHour, null)
  assert.deepEqual(snapshot.errors, [])
})

test('a null read rides alongside healthy reads without an error entry', async () => {
  const { source } = fakeSource({ queueDepth: 3, leaseExpiries: 1, deadLetterCount: null, signalsSince: 8 })

  const snapshot = await takeHealthSnapshot(STAGE, source, fixedNow)

  assert.equal(snapshot.queueDepth, 3)
  assert.equal(snapshot.leaseExpiriesLastHour, 1)
  assert.equal(snapshot.deadLetterCount, null)
  assert.equal(snapshot.signalsPerHour, 8)
  assert.deepEqual(snapshot.errors, [])
})

test('the stage logger emits one parseable JSON line per call', () => {
  const { lines, write } = lineCollector()
  const logger = createStageLogger(STAGE, { write, now: fixedNow })

  logger.info('claimed one article', { articleId: 7 })

  assert.equal(lines.length, 1)
  const line = lines[0] ?? ''
  assert.ok(line.endsWith('\n'), 'the write payload is one newline-terminated line')
  const parsed = JSON.parse(line) as Record<string, unknown>
  assert.equal(parsed.ts, '2026-10-25T12:00:00.000Z')
  assert.equal(parsed.level, 'info')
  assert.equal(parsed.stage, STAGE)
  assert.equal(parsed.msg, 'claimed one article')
  assert.equal(parsed.articleId, 7)
})

test('the stage logger writes warn and error levels', () => {
  const { lines, write } = lineCollector()
  const logger = createStageLogger(STAGE, { write, now: fixedNow })

  logger.warn('slow claim', {})
  logger.error('provider failed', {})

  assert.equal(lines.length, 2)
  assert.equal((JSON.parse(lines[0] ?? '') as Record<string, unknown>).level, 'warn')
  assert.equal((JSON.parse(lines[1] ?? '') as Record<string, unknown>).level, 'error')
})

test('the stage logger redacts secret-like keys everywhere in the entry', () => {
  const { lines, write } = lineCollector()
  const logger = createStageLogger(STAGE, { write, now: fixedNow })

  logger.info('config load', {
    apiKey: 'sk-live-123',
    accessToken: 'tok-456',
    webhookUrl: 'https://hook.example/123',
    password: 'hunter2',
    dbSecretRotation: 'abc',
    nested: { serviceToken: 'zzz', plain: 'ok' },
    plain: 'still visible',
  })

  const parsed = JSON.parse(lines[0] ?? '') as Record<string, unknown>
  assert.equal(parsed.apiKey, '[redacted]')
  assert.equal(parsed.accessToken, '[redacted]')
  assert.equal(parsed.webhookUrl, '[redacted]')
  assert.equal(parsed.password, '[redacted]')
  assert.equal(parsed.dbSecretRotation, '[redacted]')
  assert.deepEqual(parsed.nested, { serviceToken: '[redacted]', plain: 'ok' })
  assert.equal(parsed.plain, 'still visible')
  assert.ok(!(lines[0] ?? '').includes('sk-live-123'))
  assert.ok(!(lines[0] ?? '').includes('hunter2'))
})

test('the stage logger serializes Error objects as { name, message }', () => {
  const { lines, write } = lineCollector()
  const logger = createStageLogger(STAGE, { write, now: fixedNow })
  const boom = new Error('connect ECONNREFUSED')

  logger.error('read failed', { cause: boom })

  const parsed = JSON.parse(lines[0] ?? '') as { cause: { name: string; message: string } }
  assert.deepEqual(parsed.cause, { name: 'Error', message: 'connect ECONNREFUSED' })
  // No multi-line stack in the output: pm2 log files stay line-parseable.
  assert.equal((((lines[0] ?? '').match(/\\n/g)) ?? []).length, 0)
  assert.ok(!(lines[0] ?? '').includes('at '), lines[0])
})

test('the stage logger keeps circular-input safe and stays usable after it', () => {
  const { lines, write } = lineCollector()
  const logger = createStageLogger(STAGE, { write, now: fixedNow })
  const circular: Record<string, unknown> = {}
  circular.self = circular

  logger.info('cyclic fields', { payload: circular })
  logger.info('after the fall', {})

  assert.equal(lines.length, 2)
  const parsed = JSON.parse(lines[0] ?? '') as Record<string, unknown>
  assert.equal(parsed.msg, 'cyclic fields')
  const payload = parsed.payload as Record<string, unknown>
  assert.equal(payload.self, '[circular]')
  assert.ok(JSON.parse(lines[1] ?? ''), 'the logger still emits after a failed entry')
})

test('health() emits the snapshot fields as a single info line', () => {
  const { lines, write } = lineCollector()
  const logger = createStageLogger(STAGE, { write, now: fixedNow })
  const snapshot: V4HealthSnapshot = {
    stage: STAGE,
    at: '2026-10-25T12:00:00.000Z',
    queueDepth: 7,
    oldestClaimAgeMs: 45_000,
    leaseExpiriesLastHour: 2,
    deadLetterCount: 0,
    advisoryLockHolder: null,
    signalsPerHour: 11,
    errors: ['deadLetterCount: read failed'],
  }

  logger.health(snapshot)

  assert.equal(lines.length, 1)
  const parsed = JSON.parse(lines[0] ?? '') as Record<string, unknown>
  assert.equal(parsed.level, 'info')
  assert.equal(parsed.msg, 'health')
  assert.equal(parsed.stage, STAGE)
  assert.equal(parsed.at, '2026-10-25T12:00:00.000Z')
  assert.equal(parsed.queueDepth, 7)
  assert.equal(parsed.leaseExpiriesLastHour, 2)
  assert.equal(parsed.signalsPerHour, 11)
  assert.deepEqual(parsed.errors, ['deadLetterCount: read failed'])
})