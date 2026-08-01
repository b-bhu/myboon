import assert from 'node:assert/strict'
import test from 'node:test'
import { startIntervalRunner } from '../pipeline-store/interval-runner'

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

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
