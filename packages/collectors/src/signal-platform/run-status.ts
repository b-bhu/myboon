import { existsSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'

import { loadDotenvChain } from '../pipeline-store/cli-env'
import { SignalPlatformControlPlane } from './control-plane'
import { formatControlPlaneStatusJson } from './control-plane-format'
import type { ExecutionAggregateQuery, ExecutionAggregateStatus } from './execution-ledger'
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
  for (const [name, path] of [['news', newsPath], ['pipeline', pipelinePath]] as const) {
    if (!existsSync(path)) throw new Error(`${name} SQLite database does not exist at configured path`)
  }

  const news = new SqliteSignalPlatformStore(newsPath, 'news', { readOnly: true })
  const polymarket = new SqliteSignalPlatformStore(pipelinePath, 'polymarket', { readOnly: true })
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
      stores: [news, polymarket],
      workReaders: [news, polymarket],
      executionReader,
    }).readStatus({ now: new Date().toISOString() })
    process.stdout.write(`${formatControlPlaneStatusJson(status)}\n`)
  } finally {
    newsEvents.close()
    pipelineEvents.close()
    news.close()
    polymarket.close()
  }
}

main().catch((error) => {
  process.stderr.write(`[feed-v3-status] ${error instanceof Error ? error.message : 'unknown failure'}\n`)
  process.exitCode = 1
})
