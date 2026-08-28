import { isAbsolute, resolve } from 'node:path'
import { packageScriptArgs } from '../cli-args'
import { loadDotenvChain } from '../pipeline-store/cli-env'
import {
  formatLoadSoakArtifact,
  parseLoadSoakArgs,
  runLoadSoakCommand,
} from './load-soak-command'

loadDotenvChain()

const PACKAGE_DIR = resolve(__dirname, '..', '..')

async function main(): Promise<void> {
  const command = parseLoadSoakArgs(packageScriptArgs(process.argv.slice(2)))
  const protectedDatabasePaths = [
    databasePath(process.env.NEWS_SQLITE_PATH, '.data/news.sqlite'),
    databasePath(process.env.PIPELINE_SQLITE_PATH, '.data/pipeline.sqlite'),
  ]
  const result = await runLoadSoakCommand({ command, protectedDatabasePaths })
  process.stdout.write(`${formatLoadSoakArtifact(result.artifact)}\n`)
  if (command.execute && !result.artifact.passed) process.exitCode = 2
}

function databasePath(value: string | undefined, fallback: string): string {
  const configured = value?.trim() || fallback
  return isAbsolute(configured) ? resolve(configured) : resolve(PACKAGE_DIR, configured)
}

main().catch((error) => {
  process.stderr.write(`[feed-v3-load-soak] ${error instanceof Error ? error.message : 'unknown failure'}\n`)
  process.exitCode = 1
})
