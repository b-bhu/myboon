import { packageScriptArgs } from '../cli-args'
import { loadDotenvChain } from '../pipeline-store/cli-env'
import { resolveLaneSqlitePathFromEnv } from './paths'
import { seedActiveWatchlist } from './seed-watchlist'

loadDotenvChain()

interface SeedWatchlistArgs {
  fromPath: string
  toPath?: string
  dryRun: boolean
}

export function parseSeedWatchlistArgs(args: string[]): SeedWatchlistArgs {
  const values = new Map<string, string>()
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index]
    if (flag === '--dry-run') {
      if (values.get('--dry-run')) throw new Error('Duplicate --dry-run flag')
      values.set('--dry-run', '1')
      continue
    }
    if (flag !== '--from' && flag !== '--to') throw new Error(`Unknown argument: ${flag ?? '<end>'}`)
    const value = args[index + 1]
    if (!value || value.startsWith('--')) throw new Error(`${flag} requires a path`)
    if (values.has(flag)) throw new Error(`Duplicate ${flag} flag`)
    values.set(flag, value)
    index += 1
  }
  const fromPath = values.get('--from')
  if (!fromPath) throw new Error('--from <path to old pipeline.sqlite> is required')
  return {
    fromPath,
    ...(values.get('--to') ? { toPath: values.get('--to') } : {}),
    dryRun: values.get('--dry-run') === '1',
  }
}

async function main(): Promise<void> {
  const args = parseSeedWatchlistArgs(packageScriptArgs(process.argv.slice(2)))
  const result = seedActiveWatchlist({
    fromPath: args.fromPath,
    toPath: args.toPath ?? resolveLaneSqlitePathFromEnv('polymarket', process.env),
    dryRun: args.dryRun,
  })
  process.stdout.write(`${JSON.stringify(result)}\n`)
}

main().catch((error) => {
  process.stderr.write(`[lane-store:seed-watchlist] ${error instanceof Error ? error.message : 'unknown failure'}\n`)
  process.exitCode = 1
})