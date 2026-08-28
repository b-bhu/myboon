import { packageScriptArgs } from '../cli-args'
import { loadDotenvChain } from './cli-env'
import { parseRestoreCommandArgs, runRestoreCommand } from './restore-command'

loadDotenvChain()

runRestoreCommand(parseRestoreCommandArgs(packageScriptArgs(process.argv.slice(2)))).then(
  (result) => {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
    if (result.mode === 'dry_run' && !result.verification.ok) process.exitCode = 1
  },
  (error) => {
    process.stderr.write(`[pipeline-restore] ${error instanceof Error ? error.message : 'unknown failure'}\n`)
    process.exitCode = 1
  },
)
