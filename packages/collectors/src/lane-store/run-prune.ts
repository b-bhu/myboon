import { packageScriptArgs } from '../cli-args'
import { appendErrorLog } from '../pipeline-store/error-log'
import { loadDotenvChain } from '../pipeline-store/cli-env'
import { parseLaneStorePruneArgs, runLaneStorePruneCommand } from './prune-command'

loadDotenvChain()

runLaneStorePruneCommand(parseLaneStorePruneArgs(packageScriptArgs(process.argv.slice(2)))).then(
  (audit) => process.stdout.write(`${JSON.stringify(audit, null, 2)}\n`),
  (error) => {
    appendErrorLog({ app: 'lane-store-prune', kind: 'run_failed', error })
    process.stderr.write(`[lane-store:prune] ${error instanceof Error ? error.message : 'unknown failure'}\n`)
    process.exitCode = 1
  },
)