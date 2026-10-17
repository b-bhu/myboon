/**
 * Child-process fixture for the runFirstThenInterval regression test in
 * polymarket/interval-runner.test.ts. It is not executed by the test runner:
 * the test spawns it through tsx and asserts on its exit code and stdout.
 *
 * The run always throws (the Supabase-timeout scenario). In daemon mode that
 * must not exit the worker - the process stays alive, keeps ticking, reports
 * ALIVE ticks=<n> on stdout and exits 0. In RUN_ONCE mode the failure
 * propagates and the process exits non-zero before any ALIVE line.
 */
import { runFirstThenInterval } from './interval-runner'

let ticks = 0

const handlePromise = runFirstThenInterval({
  label: 'run-first-then-interval-fixture',
  intervalMs: 50,
  runOnce: process.env.FIXTURE_RUN_ONCE === '1',
  run: async () => {
    ticks += 1
    throw new Error('fixture: simulated Supabase timeout')
  },
})

void handlePromise.then((handle) => {
  // Daemon mode: the failing first run was reported (to stderr, via the
  // default onError) and the schedule still started. Prove the worker
  // survived past several interval boundaries, then drain.
  setTimeout(() => {
    console.log(`ALIVE ticks=${ticks}`)
    handle?.stop()
    process.exit(0)
  }, 300)
}, () => {
  // RUN_ONCE mode: unchanged propagate-and-exit behaviour.
  process.exit(1)
})