import assert from 'node:assert/strict'
import test from 'node:test'

import { isStageEnabled, runGatedStage } from './stage-gate'

/** #512: the shared on/off gate for any V4 stage (scout, analyst). Off never calls run. */
function harness(env: Record<string, string | undefined>) {
  const calls = { run: 0 }
  const codes: number[] = []
  const lines: string[] = []
  const opts = {
    flag: 'ANALYST_ENABLED',
    stage: 'analyst',
    env,
    exit: (code: number) => { codes.push(code) },
    log: (line: string) => { lines.push(line) },
    run: async () => { calls.run += 1 },
  }
  return { calls, codes, lines, opts }
}

test('isStageEnabled is true only for the exact string "true" on the named flag', () => {
  for (const v of ['TRUE', 'True', '1', 'false', '', undefined]) {
    assert.equal(isStageEnabled('ANALYST_ENABLED', v === undefined ? {} : { ANALYST_ENABLED: v }), false, String(v))
  }
  assert.equal(isStageEnabled('ANALYST_ENABLED', { ANALYST_ENABLED: 'true' }), true)
  // Another stage's flag does not turn this one on.
  assert.equal(isStageEnabled('ANALYST_ENABLED', { SCOUT_ENABLED: 'true' }), false)
})

test('off: one JSON info line naming the stage and flag, exit 0, run never called', async () => {
  const h = harness({})
  await runGatedStage(h.opts)
  assert.equal(h.calls.run, 0)
  assert.deepEqual(h.codes, [0])
  assert.equal(h.lines.length, 1)
  const line = JSON.parse(h.lines[0]!)
  assert.equal(line.level, 'info')
  assert.equal(line.stage, 'analyst')
  assert.match(line.msg, /ANALYST_ENABLED/)
})

test('on: run is awaited once and exit is not called', async () => {
  const h = harness({ ANALYST_ENABLED: 'true' })
  await runGatedStage(h.opts)
  assert.equal(h.calls.run, 1)
  assert.deepEqual(h.codes, [])
  assert.deepEqual(h.lines, [])
})

test('on: a failing run rejects (the entrypoint sets the exit code)', async () => {
  const h = harness({ ANALYST_ENABLED: 'true' })
  await assert.rejects(runGatedStage({ ...h.opts, run: async () => { throw new Error('boom') } }), /boom/)
})
