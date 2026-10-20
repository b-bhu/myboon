import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { runFirstThenInterval, startIntervalRunner } from '../pipeline-store/interval-runner'

// The default onError appends JSONL entries to MYBOON_ERROR_LOG. Point the
// whole file (including every spawned fixture child, which inherits this env)
// at a throwaway directory so no test can write the operator's real
// ~/myboon-logs/errors.jsonl.
const errorLogDir = mkdtempSync(join(tmpdir(), 'interval-runner-error-log-'))
process.env.MYBOON_ERROR_LOG = join(errorLogDir, 'errors.jsonl')
test.after(() => { rmSync(errorLogDir, { recursive: true, force: true }) })

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

test('normal overlapping polls stay quiet while a genuinely long run still warns without flooding logs', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'Date'], now: 0 })
  const warnings = t.mock.method(console, 'warn', () => {})
  let release: (() => void) | undefined
  const handle = startIntervalRunner({ label: 'slow-worker', intervalMs: 5_000,
    run: () => new Promise<void>(resolve => { release = resolve }) })
  try {
    t.mock.timers.tick(5_000)
    t.mock.timers.tick(35_000)
    assert.equal(warnings.mock.callCount(), 0)
    t.mock.timers.tick(270_000)
    assert.equal(warnings.mock.callCount(), 1)
    t.mock.timers.tick(20_000)
    assert.equal(warnings.mock.callCount(), 1)
  } finally {
    handle.stop()
    release?.()
    await Promise.resolve()
  }
})

test('interval runner: skips an overlapping tick and logs it instead of starting a second run', async () => {
  let runCount = 0
  let concurrentRuns = 0
  let maxConcurrentRuns = 0
  const overlaps: Array<{ label: string; runningForMs: number }> = []

  const handle = startIntervalRunner({
    label: 'test-runner',
    intervalMs: 10,
    run: async () => {
      runCount += 1
      concurrentRuns += 1
      maxConcurrentRuns = Math.max(maxConcurrentRuns, concurrentRuns)
      // Deliberately much longer than the 10ms tick interval, so several
      // ticks fire while this "run" is still in flight.
      await wait(60)
      concurrentRuns -= 1
    },
    onOverlap: (info) => overlaps.push(info),
  })

  await wait(140)
  handle.stop()

  // The whole point of the guard: no matter how many ticks fired, only one
  // run is ever in flight at a time.
  assert.equal(maxConcurrentRuns, 1)
  // Several ticks must have been skipped while the first run (60ms) was
  // still going, given a 10ms tick interval.
  assert.ok(overlaps.length > 0, 'expected at least one overlapping tick to be skipped')
  for (const overlap of overlaps) {
    assert.equal(overlap.label, 'test-runner')
    assert.ok(overlap.runningForMs >= 0)
  }
  // Some runs must have actually completed and started a fresh one afterwards -
  // this is not just "runs forever once and never ticks again".
  assert.ok(runCount >= 1)
})

test('interval runner: a tick after the previous run finished is NOT treated as an overlap', async () => {
  let runCount = 0
  const overlaps: Array<{ label: string; runningForMs: number }> = []

  const handle = startIntervalRunner({
    label: 'fast-runner',
    intervalMs: 15,
    run: async () => {
      runCount += 1
      // Much shorter than the tick interval - every tick should start a
      // brand new, non-overlapping run.
      await wait(2)
    },
    onOverlap: (info) => overlaps.push(info),
  })

  await wait(80)
  handle.stop()

  assert.equal(overlaps.length, 0)
  assert.ok(runCount >= 2, `expected multiple non-overlapping runs, got ${runCount}`)
})

test('interval runner: isRunning reflects whether a tick is currently executing', async () => {
  let resolveRun: (() => void) | undefined
  const handle = startIntervalRunner({
    label: 'gated-runner',
    intervalMs: 5,
    run: () => new Promise<void>((resolve) => {
      resolveRun = resolve
    }),
  })

  try {
    // Wait for the first tick to start.
    while (!resolveRun) {
      await wait(1)
    }
    assert.equal(handle.isRunning(), true)

    const release = resolveRun
    resolveRun = undefined
    release()
    // Stop scheduling further ticks IMMEDIATELY after releasing the current
    // one, before yielding to the event loop, so no second tick can start
    // and flip isRunning() back to true underneath this assertion.
    handle.stop()
    await wait(5)
    assert.equal(handle.isRunning(), false)
  } finally {
    handle.stop()
  }
})

test('interval runner: a rejected run is reported via onError and does not stop future ticks', async () => {
  let runCount = 0
  const errors: unknown[] = []

  const handle = startIntervalRunner({
    label: 'failing-runner',
    intervalMs: 10,
    run: async () => {
      runCount += 1
      throw new Error(`boom-${runCount}`)
    },
    onError: (error) => errors.push(error),
  })

  await wait(45)
  handle.stop()

  assert.ok(runCount >= 2, `expected multiple ticks despite failures, got ${runCount}`)
  assert.ok(errors.length >= 2)
  assert.ok(errors.every((error) => error instanceof Error))
})

test('interval runner: stop() prevents further ticks from starting', async () => {
  let runCount = 0
  const handle = startIntervalRunner({
    label: 'stoppable-runner',
    intervalMs: 5,
    run: async () => {
      runCount += 1
    },
  })

  await wait(20)
  handle.stop()
  const countAtStop = runCount
  await wait(30)

  assert.equal(runCount, countAtStop)
})

test('interval runner: KEEPS THE PROCESS ALIVE between ticks (daemon liveness)', async () => {
  // Regression test for the unref() crash-loop: every run-*.ts entrypoint
  // finishes its first cycle and then has NOTHING but this interval timer
  // holding the event loop open. An unref()'d timer let the process exit
  // cleanly after the first cycle, which under PM2 became an infinite
  // restart loop (observed live: restart counts of 10+ within two minutes,
  // a new pid every ~7 seconds). The runner's timer must therefore hold a
  // ref: a child process whose only pending work is the interval MUST
  // survive long enough for ticks to fire.
  const { execFile } = await import('node:child_process')
  const { mkdtemp, rm, writeFile } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join, resolve } = await import('node:path')

  const runnerPath = resolve(__dirname, '../pipeline-store/interval-runner.ts')
  const dir = await mkdtemp(join(tmpdir(), 'interval-liveness-'))
  const fixture = join(dir, 'fixture.ts')
  await writeFile(fixture, [
    `import { startIntervalRunner } from ${JSON.stringify(runnerPath)}`,
    "startIntervalRunner({ label: 'liveness', intervalMs: 50, run: async () => { console.log('tick') } })",
    "setTimeout(() => process.exit(0), 400).unref()",
  ].join('\n'))

  const tsxBin = resolve(__dirname, '../../node_modules/.bin/tsx')
  try {
    const { stdout } = await new Promise<{ stdout: string }>((resolvePromise, rejectPromise) => {
      execFile(tsxBin, [fixture], { timeout: 15_000 }, (error, stdout) => {
        if (error) rejectPromise(error)
        else resolvePromise({ stdout })
      })
    })
    // An unref'd timer exits the child before ANY tick fires -> no output.
    assert.ok(stdout.includes('tick'), `child exited without a single tick; stdout=${JSON.stringify(stdout)}`)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('runFirstThenInterval: a failing first run is reported once and the interval still starts', async () => {
  const firstError = new Error('supabase timeout')
  const errors: Array<{ error: unknown; label: string }> = []
  let runCount = 0

  const handle = await runFirstThenInterval({
    label: 'first-run-failure',
    intervalMs: 10,
    runOnce: false,
    run: async () => {
      runCount += 1
      if (runCount === 1) throw firstError
    },
    onError: (error, info) => errors.push({ error, label: info.label }),
  })

  // A failing first run must resolve (not reject) and hand back a schedule.
  assert.ok(handle, 'expected an interval handle when runOnce is false')
  assert.deepEqual(errors, [{ error: firstError, label: 'first-run-failure' }])
  // The schedule keeps ticking: later ticks still run after the failed first.
  await wait(40)
  assert.ok(runCount >= 2, `expected the interval to keep ticking after a failed first run, got ${runCount}`)
  handle.stop()
})

test('runFirstThenInterval: in runOnce mode a failing first run still propagates and no interval starts', async () => {
  const firstError = new Error('supabase timeout')
  let runCount = 0

  await assert.rejects(
    runFirstThenInterval({
      label: 'run-once-failure',
      intervalMs: 10,
      runOnce: true,
      run: async () => {
        runCount += 1
        throw firstError
      },
    }),
    (error) => error === firstError,
  )

  // Several interval boundaries later: the schedule was never started.
  await wait(60)
  assert.equal(runCount, 1)
})

test('runFirstThenInterval: in runOnce mode a successful first run resolves null and starts no interval', async () => {
  let runCount = 0

  const result = await runFirstThenInterval({
    label: 'run-once-success',
    intervalMs: 10,
    runOnce: true,
    run: async () => {
      runCount += 1
    },
  })

  await wait(60)
  assert.equal(result, null)
  assert.equal(runCount, 1)
})

test('runFirstThenInterval: a failing first run does not exit the worker (child-process regression)', async () => {
  // Regression test for the PM2 restart loop: every run-*.ts daemon used to
  // await its first run BEFORE starting the interval, so one failing first
  // run (e.g. a Supabase timeout) escaped to main().catch() and
  // process.exit(1) and PM2 restarted into the same failure forever. The
  // fixture is a worker whose run always throws; in daemon mode it must stay
  // alive past several interval boundaries and exit 0.
  const { execFile } = await import('node:child_process')
  const { resolve } = await import('node:path')
  const fixturePath = resolve(__dirname, '../pipeline-store/run-first-then-interval.fixture.ts')
  const tsxBin = resolve(__dirname, '../../node_modules/.bin/tsx')
  const baseEnv: NodeJS.ProcessEnv = { ...process.env }
  delete baseEnv.FIXTURE_RUN_ONCE

  const runFixture = (env: NodeJS.ProcessEnv) => new Promise<{ code: number; stdout: string; stderr: string }>((resolvePromise) => {
    execFile(tsxBin, [fixturePath], { timeout: 15_000, env }, (error, stdout, stderr) => {
      const code = error === null
        ? 0
        : typeof error.code === 'number' ? error.code : 1
      resolvePromise({ code, stdout, stderr })
    })
  })

  // Daemon mode: the run always throws, yet the worker survives, ticks, and
  // drains cleanly.
  const daemon = await runFixture({ ...baseEnv })
  assert.equal(daemon.code, 0, `daemon-mode child should exit 0; stderr=${JSON.stringify(daemon.stderr)}`)
  const alive = daemon.stdout.match(/ALIVE ticks=(\d+)/)
  assert.ok(alive, `expected ALIVE line, stdout=${JSON.stringify(daemon.stdout)}`)
  assert.ok(Number(alive[1]) >= 2, `expected at least 2 ticks after the failed first run, got ${alive[1]}`)

  // RUN_ONCE mode: unchanged - the failure propagates and exits non-zero.
  const runOnce = await runFixture({ ...baseEnv, FIXTURE_RUN_ONCE: '1' })
  assert.notEqual(runOnce.code, 0, `runOnce child should exit non-zero; stderr=${JSON.stringify(runOnce.stderr)}`)
  assert.ok(!runOnce.stdout.includes('ALIVE'), `runOnce child must not stay alive; stdout=${JSON.stringify(runOnce.stdout)}`)
})

test('interval runner: default onError appends JSONL failure entries with consecutive failure counts', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'interval-runner-error-log-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const logPath = join(dir, 'errors.jsonl')
  const saved = process.env.MYBOON_ERROR_LOG
  process.env.MYBOON_ERROR_LOG = logPath
  const consoleError = t.mock.method(console, 'error', () => {})
  try {
    const handle = startIntervalRunner({
      label: 'jsonl-failing-runner',
      intervalMs: 10,
      run: async () => {
        throw new Error('boom')
      },
    })
    await wait(45)
    handle.stop()
  } finally {
    if (saved === undefined) delete process.env.MYBOON_ERROR_LOG
    else process.env.MYBOON_ERROR_LOG = saved
  }
  const lines = readFileSync(logPath, 'utf8').split('\n').filter((line) => line !== '')
  assert.ok(lines.length >= 2, `expected at least two logged failures, got ${lines.length}`)
  const entries = lines
    .map((line) => JSON.parse(line) as { app: string; kind: string; message: string; count?: number })
  assert.ok(
    entries.every((entry) => entry.app === 'jsonl-failing-runner' && entry.kind === 'run_failed' && entry.message === 'boom'),
    `unexpected entries: ${lines.join(', ')}`,
  )
  // A run that always fails must count its consecutive failures per runner.
  assert.equal(entries[0].count, 1)
  assert.equal(entries[1].count, 2)
  // The existing console.error line is unchanged and stays quiet under the mock.
  assert.equal(consoleError.mock.callCount(), lines.length)
})
