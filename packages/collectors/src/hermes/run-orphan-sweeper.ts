import { loadDotenvChain, positiveInteger } from '../pipeline-store/cli-env'
import { startIntervalRunner } from '../pipeline-store/interval-runner'
import { HermesOrphanSweeper } from './orphan-sweeper'

loadDotenvChain()

const intervalMs = positiveInteger(process.env.HERMES_ORPHAN_SWEEP_INTERVAL_MS, 5 * 60_000)
const maxAgeMs = positiveInteger(process.env.HERMES_ORPHAN_MAX_AGE_MS, 15 * 60_000)
const killGraceMs = positiveInteger(process.env.HERMES_ORPHAN_KILL_GRACE_MS, 5_000)
const workspaceRoot = process.env.HERMES_ORPHAN_WORKSPACE_ROOT ?? process.cwd()

const sweeper = new HermesOrphanSweeper({ maxAgeMs, killGraceMs, workspaceRoot })

async function runOnce(): Promise<void> {
  await sweeper.sweep()
}

async function main(): Promise<void> {
  await runOnce()
  startIntervalRunner({ label: 'hermes-orphan-sweeper', intervalMs, run: runOnce })
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
})
