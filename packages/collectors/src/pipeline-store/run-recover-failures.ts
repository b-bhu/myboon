import { loadDotenvChain } from './cli-env'
import { packageScriptArgs } from '../cli-args'

loadDotenvChain()

import {
  MAX_RECOVERY_LIMIT,
  recoverFailedBacklog,
  type FailureCategoryFilter,
  type FailureRecoveryAction,
  type FailureRecoverySource,
  type FailureRecoveryStage,
} from './failure-recovery'

interface ParsedArgs {
  stage?: FailureRecoveryStage
  source?: FailureRecoverySource
  since?: string
  until?: string
  failureCategory?: FailureCategoryFilter
  candidateId?: string
  limit?: number
  apply: boolean
  action: FailureRecoveryAction
  help: boolean
}

const CATEGORY_FILTERS = new Set<FailureCategoryFilter>([
  'authentication',
  'rate_limit',
  'timeout',
  'connection',
  'provider',
  'malformed_output',
  'source_data',
  'unknown',
  'other',
  'provider_outage',
])

function valueAfter(args: string[], index: number, flag: string): string {
  const value = args[index + 1]
  if (!value || value.startsWith('--')) throw new Error(`${flag} requires a value`)
  return value
}

export function parseRecoveryArgs(args: string[]): ParsedArgs {
  const parsed: ParsedArgs = { apply: false, action: 'requeue', help: false }
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]
    if (arg === '--') {
      continue
    } else if (arg === '--help' || arg === '-h') {
      parsed.help = true
    } else if (arg === '--apply') {
      parsed.apply = true
    } else if (arg === '--mark-dead-letter') {
      parsed.action = 'dead-letter'
    } else if (arg === '--stage') {
      const value = valueAfter(args, i, arg)
      if (value !== 'research' && value !== 'entity-manager') throw new Error('--stage must be research or entity-manager')
      parsed.stage = value
      i += 1
    } else if (arg === '--source') {
      const value = valueAfter(args, i, arg)
      if (value !== 'news' && value !== 'polymarket') throw new Error('--source must be news or polymarket')
      parsed.source = value
      i += 1
    } else if (arg === '--since') {
      parsed.since = valueAfter(args, i, arg)
      i += 1
    } else if (arg === '--until') {
      parsed.until = valueAfter(args, i, arg)
      i += 1
    } else if (arg === '--failure-category' || arg === '--category') {
      const value = valueAfter(args, i, arg) as FailureCategoryFilter
      if (!CATEGORY_FILTERS.has(value)) throw new Error(`Unknown failure category: ${value}`)
      parsed.failureCategory = value
      i += 1
    } else if (arg === '--candidate-id') {
      parsed.candidateId = valueAfter(args, i, arg)
      i += 1
    } else if (arg === '--limit') {
      parsed.limit = Number(valueAfter(args, i, arg))
      i += 1
    } else {
      throw new Error(`Unknown argument: ${arg}`)
    }
  }
  return parsed
}

function usage(): string {
  return `Usage:
  pnpm pipeline-store:recover-research -- --source <news|polymarket> [filters] [--apply]
  pnpm pipeline-store:recover-entity-manager -- --source <news|polymarket> [filters] [--apply]

Dry-run is the default. A write requires --apply and either --since or --candidate-id.

Filters:
  --since <ISO timestamp>       Failure/update time at or after this timestamp
  --until <ISO timestamp>       Failure/update time at or before this timestamp
  --failure-category <value>   authentication, rate_limit, timeout, connection,
                               provider, provider_outage, malformed_output,
                               source_data, unknown, or other
  --candidate-id <id>           Exact candidate observation id
  --limit <1-${MAX_RECOVERY_LIMIT}>             Bounded rows inspected per invocation (default 100)

Actions:
  --apply                       Back up and verify both SQLite DBs, then write
  --mark-dead-letter            Mark selected failures dead_letter instead of requeueing
`
}

async function main(): Promise<void> {
  const args = parseRecoveryArgs(packageScriptArgs(process.argv.slice(2)))
  if (args.help) {
    console.log(usage())
    return
  }
  if (!args.stage) throw new Error('Missing --stage (use the stage-specific package script)')
  if (!args.source) throw new Error('Missing required --source news|polymarket')

  const report = await recoverFailedBacklog({
    stage: args.stage,
    source: args.source,
    since: args.since,
    until: args.until,
    failureCategory: args.failureCategory,
    candidateId: args.candidateId,
    limit: args.limit,
    apply: args.apply,
    action: args.action,
    pipelineSqlitePath: process.env.PIPELINE_SQLITE_PATH,
    newsSqlitePath: process.env.NEWS_SQLITE_PATH,
    backupDir: process.env.PIPELINE_BACKUP_DIR,
  })
  console.log(JSON.stringify(report, null, 2))
}

if (process.argv[1]?.endsWith('run-recover-failures.ts')) {
  main().catch((error) => {
    console.error('[pipeline-failure-recovery] fatal:', error instanceof Error ? error.message : String(error))
    process.exit(1)
  })
}
