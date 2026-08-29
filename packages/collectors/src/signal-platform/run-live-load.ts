import { packageScriptArgs } from '../cli-args'
import { formatLiveLoadResult, parseLiveLoadArgs, runLiveLoadCommand } from './live-load-command'

async function main(): Promise<void> {
  const command = parseLiveLoadArgs(packageScriptArgs(process.argv.slice(2)))
  // Deliberately no production collector is wired here. The checked-in CLI is
  // a read-only planner; --execute fails closed at the collector boundary.
  const result = await runLiveLoadCommand({ command })
  process.stdout.write(`${formatLiveLoadResult(result.plan)}\n`)
}

main().catch((error) => {
  process.stderr.write(`[feed-v3-live-load] ${error instanceof Error ? error.message : 'unknown failure'}\n`)
  process.exitCode = 1
})
