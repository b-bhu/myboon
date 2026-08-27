import { loadDotenvChain } from '../pipeline-store/cli-env'
import {
  Phase2CheckArgumentError,
  runPhase2Check,
} from './phase2-check-command'

loadDotenvChain()

async function main(): Promise<void> {
  const report = await runPhase2Check({ args: process.argv.slice(2), env: process.env })
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
  if (!report.ready) process.exitCode = 2
}

main().catch((error) => {
  const message = error instanceof Phase2CheckArgumentError
    ? error.message
    : 'readiness could not be evaluated'
  process.stderr.write(`[feed-v3-phase2-check] ${message}\n`)
  process.exitCode = 1
})
