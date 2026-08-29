import { packageScriptArgs } from '../cli-args'
import { runRuntimeControlCommand } from './runtime-control-command'

function main(): void {
  const result = runRuntimeControlCommand(packageScriptArgs(process.argv.slice(2)))
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
}

try {
  main()
} catch (error) {
  process.stderr.write(`[feed-v3-runtime-control] ${error instanceof Error ? error.message : 'unknown failure'}\n`)
  process.exitCode = 1
}
