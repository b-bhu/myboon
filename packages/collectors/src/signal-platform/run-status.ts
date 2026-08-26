import { existsSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'

import { loadDotenvChain } from '../pipeline-store/cli-env'
import { SignalPlatformControlPlane } from './control-plane'
import { formatControlPlaneStatusJson } from './control-plane-format'
import type { ExecutionAggregateQuery, ExecutionAggregateStatus } from './execution-ledger'
import { readFeedV3RuntimeStatusAvailability } from './runtime-status'
import { SqliteExecutionLedger } from './sqlite-execution-ledger'
import { SqliteSignalPlatformStore } from './sqlite-platform-store'

loadDotenvChain()

const PACKAGE_DIR = resolve(__dirname, '..', '..')

function databasePath(value: string | undefined, fallback: string): string {
  const configured = value?.trim() || fallback
  return isAbsolute(configured) ? configured : resolve(PACKAGE_DIR, configured)
}

async function main(): Promise<void> {
  const newsPath = databasePath(process.env.NEWS_SQLITE_PATH, '.data/news.sqlite')
  const pipelinePath = databasePath(process.env.PIPELINE_SQLITE_PATH, '.data/pipeline.sqlite')
  const runtimeStatusPath = databasePath(
    process.env.FEED_V3_RESEARCH_RUNTIME_STATUS_PATH,
    '.data/feed-v3-research-runtime-status.json',
  )
  const runtimeStaleAfterMs = positiveInteger(
    process.env.FEED_V3_RESEARCH_RUNTIME_STATUS_STALE_MS,
    60_000,
    'FEED_V3_RESEARCH_RUNTIME_STATUS_STALE_MS',
  )
  const entityRuntimeStatusPath = databasePath(
    process.env.FEED_V3_ENTITY_RUNTIME_STATUS_PATH,
    '.data/feed-v3-entity-runtime-status.json',
  )
  const entityRuntimeStaleAfterMs = positiveInteger(
    process.env.FEED_V3_ENTITY_RUNTIME_STATUS_STALE_MS,
    60_000,
    'FEED_V3_ENTITY_RUNTIME_STATUS_STALE_MS',
  )
  for (const [name, path] of [['news', newsPath], ['pipeline', pipelinePath]] as const) {
    if (!existsSync(path)) throw new Error(`${name} SQLite database does not exist at configured path`)
  }

  const stores = [
    new SqliteSignalPlatformStore(newsPath, 'news', { readOnly: true }),
    new SqliteSignalPlatformStore(pipelinePath, 'polymarket', { readOnly: true }),
    new SqliteSignalPlatformStore(pipelinePath, 'market_calendar', { readOnly: true }),
    new SqliteSignalPlatformStore(pipelinePath, 'x', { readOnly: true }),
  ]
  const newsEvents = new SqliteExecutionLedger(newsPath, { readOnly: true })
  const pipelineEvents = new SqliteExecutionLedger(pipelinePath, { readOnly: true })
  try {
    const executionReader = {
      readAggregateStatus(query?: ExecutionAggregateQuery): ExecutionAggregateStatus {
        const reports = [newsEvents.readAggregateStatus(query), pipelineEvents.readAggregateStatus(query)]
        return {
          totalEvents: reports.reduce((sum, report) => sum + report.totalEvents, 0),
          activeEvents: reports.reduce((sum, report) => sum + report.activeEvents, 0),
          rows: reports.flatMap((report) => report.rows),
        }
      },
    }
    const status = await new SignalPlatformControlPlane({
      stores,
      workReaders: stores,
      executionReader,
    }).readStatus({ now: new Date().toISOString() })
    const { researchRuntime, entityRuntime } = await readFeedV3RuntimeStatusAvailability({
      researchPath: runtimeStatusPath,
      researchStaleAfterMs: runtimeStaleAfterMs,
      entityPath: entityRuntimeStatusPath,
      entityStaleAfterMs: entityRuntimeStaleAfterMs,
    })
    process.stdout.write(`${formatControlPlaneStatusJson({ ...status, researchRuntime, entityRuntime })}\n`)
  } finally {
    newsEvents.close()
    pipelineEvents.close()
    for (const store of stores) store.close()
  }
}

function positiveInteger(raw: string | undefined, fallback: number, name: string): number {
  if (raw === undefined) return fallback
  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`)
  return value
}

main().catch((error) => {
  process.stderr.write(`[feed-v3-status] ${error instanceof Error ? error.message : 'unknown failure'}\n`)
  process.exitCode = 1
})
