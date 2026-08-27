import { isAbsolute, resolve } from 'node:path'

import { loadDotenvChain } from '../pipeline-store/cli-env'
import { formatControlPlaneStatusJson } from './control-plane-format'
import { parseControlPlaneAlertPolicy } from './control-plane'
import { readFeedV3RuntimeStatusAvailability } from './runtime-status'
import { evaluateOperationalAlerts, parseOperationalAlertPolicy } from './runtime-alerts'
import { readSqliteControlPlaneStatus } from './status-sqlite-composition'

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
  const now = new Date().toISOString()
  const alertPolicy = process.env.FEED_V3_STATUS_ALERT_POLICY_JSON?.trim()
    ? parseControlPlaneAlertPolicy(JSON.parse(process.env.FEED_V3_STATUS_ALERT_POLICY_JSON))
    : null
  const activityWindowMs = positiveInteger(
    process.env.FEED_V3_STATUS_ACTIVITY_WINDOW_MS, 30 * 60_000, 'FEED_V3_STATUS_ACTIVITY_WINDOW_MS',
  )
  const status = await readSqliteControlPlaneStatus({
    newsPath, pipelinePath, now, alertPolicy, activityWindowMs,
  })
  const { researchRuntime, entityRuntime } = await readFeedV3RuntimeStatusAvailability({
    researchPath: runtimeStatusPath,
    researchStaleAfterMs: runtimeStaleAfterMs,
    entityPath: entityRuntimeStatusPath,
    entityStaleAfterMs: entityRuntimeStaleAfterMs,
  })
  const operationalAlertPolicy = process.env.FEED_V3_OPERATIONAL_ALERT_POLICY_JSON?.trim()
    ? parseOperationalAlertPolicy(JSON.parse(process.env.FEED_V3_OPERATIONAL_ALERT_POLICY_JSON))
    : null
  const runtime = { researchRuntime, entityRuntime }
  const operationalAlerts = evaluateOperationalAlerts({ status, runtime, policy: operationalAlertPolicy })
  process.stdout.write(`${formatControlPlaneStatusJson({ ...status, ...runtime, operationalAlerts })}\n`)
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
