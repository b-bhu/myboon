import assert from 'node:assert/strict'
import test from 'node:test'

import { isScoutEnabled, runGatedScout } from './scout-gate'

const DISABLED_LINE_LEVEL = 'info'
const DISABLED_LINE_STAGE = 'scout-news'
const DISABLED_LINE_MSG = 'scout disabled (SCOUT_ENABLED != "true"); exiting'

/** Env with a single SCOUT_ENABLED value; undefined means the key is unset. */
function envWith(value: string | undefined): Record<string, string | undefined> {
  return value === undefined ? {} : { SCOUT_ENABLED: value }
}

/** run is the client factory: it must never be touched when the gate is off. */
function fakeRun(calls: { run: number }): () => Promise<void> {
  return async () => { calls.run += 1 }
}

/** Test-fake exit: records the code instead of terminating the process. */
function fakeExit(codes: number[]): (code: number) => void {
  return (code) => { codes.push(code) }
}

function lineCollector(): { lines: string[]; log: (line: string) => void } {
  const lines: string[] = []
  return { lines, log: (line) => { lines.push(line) } }
}

test('isScoutEnabled is true only for the exact string "true"', () => {
  assert.equal(isScoutEnabled(envWith('true')), true)
  assert.equal(isScoutEnabled(envWith('TRUE')), false)
  assert.equal(isScoutEnabled(envWith('True')), false)
  assert.equal(isScoutEnabled(envWith('1')), false)
  assert.equal(isScoutEnabled(envWith('false')), false)
  assert.equal(isScoutEnabled(envWith('')), false)
  assert.equal(isScoutEnabled(envWith(undefined)), false)
})

test('an unset SCOUT_ENABLED exits 0 and never creates a client', async () => {
  const calls = { run: 0 }
  const codes: number[] = []
  const { lines, log } = lineCollector()

  await runGatedScout({
    env: envWith(undefined),
    run: fakeRun(calls),
    exit: fakeExit(codes),
    log,
  })

  assert.deepEqual(codes, [0])
  assert.equal(calls.run, 0)
  assert.equal(lines.length, 1)
  const parsed = JSON.parse(lines[0] ?? '') as Record<string, unknown>
  assert.equal(parsed.level, DISABLED_LINE_LEVEL)
  assert.equal(parsed.stage, DISABLED_LINE_STAGE)
  assert.equal(parsed.msg, DISABLED_LINE_MSG)
})

test('SCOUT_ENABLED=false exits 0 and never creates a client', async () => {
  const calls = { run: 0 }
  const codes: number[] = []
  const { lines, log } = lineCollector()

  await runGatedScout({
    env: envWith('false'),
    run: fakeRun(calls),
    exit: fakeExit(codes),
    log,
  })

  assert.deepEqual(codes, [0])
  assert.equal(calls.run, 0)
  assert.equal(lines.length, 1)
  assert.equal((JSON.parse(lines[0] ?? '') as Record<string, unknown>).msg, DISABLED_LINE_MSG)
})

test('casing and truthy strings do not enable the scout', async () => {
  for (const offValue of ['TRUE', '1', 'true ', 'yes']) {
    const calls = { run: 0 }
    const codes: number[] = []
    const { lines, log } = lineCollector()

    await runGatedScout({
      env: envWith(offValue),
      run: fakeRun(calls),
      exit: fakeExit(codes),
      log,
    })

    assert.deepEqual(codes, [0], offValue)
    assert.equal(calls.run, 0, offValue)
    assert.equal(lines.length, 1, offValue)
  }
})

test('SCOUT_ENABLED=true runs the scout once and does not exit', async () => {
  const calls = { run: 0 }
  const codes: number[] = []
  const { lines, log } = lineCollector()

  await runGatedScout({
    env: envWith('true'),
    run: fakeRun(calls),
    exit: fakeExit(codes),
    log,
  })

  assert.equal(calls.run, 1)
  assert.deepEqual(codes, [])
  assert.deepEqual(lines, [])
})