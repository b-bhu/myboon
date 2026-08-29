import { packageScriptArgs } from '../cli-args'
import { loadDotenvChain } from './cli-env'
import { parsePruneCommandArgs, runPruneCommand } from './prune-command'

loadDotenvChain()

runPruneCommand(parsePruneCommandArgs(packageScriptArgs(process.argv.slice(2)))).then(
  (audit) => process.stdout.write(`${JSON.stringify(audit, null, 2)}\n`),
  (error) => {
    process.stderr.write(`[pipeline-backup-prune] ${error instanceof Error ? error.message : 'unknown failure'}\n`)
    process.exitCode = 1
  },
)
