import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  FileRuntimeControlStore,
  RuntimeControlFileError,
  defaultRuntimeControl,
  stageRuntimeControl,
} from './runtime-control'
import { parseRuntimeControlArgs, runRuntimeControlCommand } from './runtime-control-command'

const NOW = '2026-08-26T12:00:00.000Z'

test('dry-run is default and does not create a durable control file', () => {
  const fixture = tempFile('dry-run')
  try {
    const result = new FileRuntimeControlStore(fixture.path).run({
      stage: 'research', action: 'drain', now: NOW,
    })
    assert.equal(result.mode, 'dry_run')
    assert.equal(result.current.stages.research.desiredState, 'running')
    assert.equal(result.proposed.stages.research.desiredState, 'draining')
    assert.equal(result.proposed.revision, 1)
    assert.equal(existsSync(fixture.path), false)
  } finally { fixture.close() }
})

test('explicit apply writes atomically with mode 0600 and preserves the other stage', () => {
  const fixture = tempFile('apply')
  try {
    const store = new FileRuntimeControlStore(fixture.path)
    const drained = store.run({ stage: 'research', action: 'drain', apply: true, now: NOW })
    assert.equal(drained.mode, 'apply')
    assert.equal(statSync(fixture.path).mode & 0o777, 0o600)
    assert.equal(store.read().stages.research.desiredState, 'draining')
    assert.equal(store.read().stages.entity.desiredState, 'running')
    assert.equal(existsSync(`${fixture.path}.lock`), false)
    assert.equal(fixture.entries().some((entry) => entry.endsWith('.tmp')), false)

    const entity = store.run({
      stage: 'entity', action: 'drain', apply: true, now: '2026-08-26T12:01:00.000Z',
    })
    assert.equal(entity.proposed.revision, 2)
    assert.equal(store.read().stages.research.desiredState, 'draining')
    assert.equal(store.read().stages.entity.desiredState, 'draining')

    const resumed = store.run({
      stage: 'research', action: 'resume', apply: true, now: '2026-08-26T12:02:00.000Z',
    })
    assert.equal(resumed.proposed.revision, 3)
    assert.equal(stageRuntimeControl(store.read(), 'research').desiredState, 'running')
    const replay = store.run({
      stage: 'research', action: 'resume', apply: true, now: '2026-08-26T12:03:00.000Z',
    })
    assert.equal(replay.changed, false)
    assert.equal(replay.proposed.revision, 3)
  } finally { fixture.close() }
})

test('missing control defaults to running while malformed durable state fails closed', () => {
  assert.equal(stageRuntimeControl(defaultRuntimeControl(), 'research').desiredState, 'running')
  const fixture = tempFile('malformed')
  try {
    const store = new FileRuntimeControlStore(fixture.path)
    store.run({ stage: 'research', action: 'drain', apply: true, now: NOW })
    const invalid = structuredClone(store.read()) as unknown as { schemaVersion: string }
    invalid.schemaVersion = 'unknown'
    // Use the same atomic writer boundary indirectly by replacing through a
    // separate fixture file created for validation-only input.
    const corruptPath = join(fixture.dir, 'corrupt.json')
    writeFileSync(corruptPath, JSON.stringify(invalid), { mode: 0o600 })
    assert.throws(() => new FileRuntimeControlStore(corruptPath).read(), RuntimeControlFileError)
  } finally { fixture.close() }
})

test('reclaims abandoned partial locks but never steals a live owner lock', () => {
  const fixture = tempFile('stale-lock')
  try {
    const lockPath = `${fixture.path}.lock`
    writeFileSync(lockPath, '', { mode: 0o600 })
    const old = new Date(Date.now() - 120_000)
    utimesSync(lockPath, old, old)
    const store = new FileRuntimeControlStore(fixture.path)
    const result = store.run({ stage: 'research', action: 'drain', apply: true, now: NOW })
    assert.equal(result.changed, true)
    assert.equal(existsSync(lockPath), false)

    writeFileSync(lockPath, JSON.stringify({
      pid: process.pid, token: 'live-owner', createdAt: NOW,
    }), { mode: 0o600 })
    assert.throws(
      () => store.run({ stage: 'entity', action: 'drain', apply: true, now: NOW }),
      /Another runtime control update is in progress/,
    )

    const exited = spawnSync(process.execPath, ['-e', 'process.exit(0)'])
    assert.ok(exited.pid)
    writeFileSync(lockPath, JSON.stringify({
      pid: exited.pid, token: 'dead-owner', createdAt: NOW,
    }), { mode: 0o600 })
    const reclaimed = store.run({ stage: 'entity', action: 'drain', apply: true, now: NOW })
    assert.equal(reclaimed.changed, true)
    assert.equal(existsSync(lockPath), false)
  } finally { fixture.close() }
})

test('CLI parser requires exact stage/action and command injects only the file store', () => {
  assert.deepEqual(parseRuntimeControlArgs(['--stage', 'research', '--action', 'drain']), {
    stage: 'research', action: 'drain', apply: false,
  })
  assert.deepEqual(parseRuntimeControlArgs(['--action', 'resume', '--stage', 'entity', '--apply']), {
    stage: 'entity', action: 'resume', apply: true,
  })
  assert.throws(() => parseRuntimeControlArgs(['--stage', 'deep', '--action', 'drain']), /Unsupported/)
  assert.throws(() => parseRuntimeControlArgs(['--stage', 'research']), /--action is required/)
  let receivedPath = ''
  let receivedApply: boolean | undefined
  const fixture = tempFile('injected')
  try {
    const result = runRuntimeControlCommand(['--stage', 'research', '--action', 'drain'], {
      env: { FEED_V3_RUNTIME_CONTROL_PATH: '/tmp/runtime-control-test.json' },
      now: () => new Date(NOW),
      createStore: (path) => ({
        run(input) {
          receivedPath = path
          receivedApply = input.apply
          return new FileRuntimeControlStore(fixture.path).run(input)
        },
      }),
    })
    assert.equal(receivedPath, '/tmp/runtime-control-test.json')
    assert.equal(receivedApply, false)
    assert.equal(result.mode, 'dry_run')
    assert.equal(existsSync(fixture.path), false)
  } finally { fixture.close() }
})

function tempFile(label: string) {
  const dir = mkdtempSync(join(tmpdir(), `runtime-control-${label}-`))
  return {
    dir,
    path: join(dir, 'control.json'),
    entries: () => readdirSync(dir),
    close: () => rmSync(dir, { recursive: true, force: true }),
  }
}
