import { resolve } from 'node:path'
import { packageScriptArgs } from '../cli-args'
import { loadDotenvChain } from '../pipeline-store/cli-env'
import {
  formatLoadSoakArtifact,
  parseLoadSoakArgs,
  runLoadSoakCommand,
} from './load-soak-command'
import { resolveLaneSqlitePathFromEnv } from '../lane-store/paths'

loadDotenvChain()

const PACKAGE_DIR = resolve(__dirname, '..', '..')

async function main(): Promise<void> {
  const command = parseLoadSoakArgs(packageScriptArgs(process.argv.slice(2)))
  const protectedDatabasePaths = [
    resolveLaneSqlitePathFromEnv('news', process.env, { baseDir: PACKAGE_DIR }),
    resolveLaneSqlitePathFromEnv('polymarket', process.env, { baseDir: PACKAGE_DIR }),
  ]
  const result = await runLoadSoakCommand({ command, protectedDatabasePaths })
  process.stdout.write(`${formatLoadSoakArtifact(result.artifact)}\n`)
  if (command.execute && !result.artifact.passed) process.exitCode = 2
}

main().catch((error) => {
  process.stderr.write(`[feed-v3-load-soak] ${error instanceof Error ? error.message : 'unknown failure'}\n`)
  process.exitCode = 1
})
