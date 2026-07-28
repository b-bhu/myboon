import { loadDotenvChain, requiredEnv } from '../pipeline-store/cli-env'

loadDotenvChain()

import { createClient } from '@supabase/supabase-js'
import { previewHyperliquidCollector, runHyperliquidCollector } from './collector'
import { runHyperliquidCollectorToSqlite } from './sqlite-store'

const DEFAULT_EVALUATION_INTERVAL_HOURS = 4
const DEFAULT_EVALUATION_DELAY_MS = 2 * 60 * 1000
const MAX_TIMEOUT_MS = 2_147_483_647

function envNumber(name: string, fallback: number): number {
  const parsed = Number(process.env[name])
  return Number.isFinite(parsed) ? parsed : fallback
}

async function runOnce(): Promise<void> {
  if (process.env.HYPERLIQUID_PREVIEW_ONLY === '1') {
    const result = await previewHyperliquidCollector()
    console.log(JSON.stringify(result, null, 2))
    return
  }

  if (process.env.HYPERLIQUID_STORAGE === 'sqlite') {
    const result = await runHyperliquidCollectorToSqlite({
      path: process.env.HYPERLIQUID_SQLITE_PATH,
    })
    console.log(JSON.stringify(result, null, 2))
    return
  }

  const supabase = createClient(
    requiredEnv('SUPABASE_URL'),
    requiredEnv('SUPABASE_SERVICE_ROLE_KEY')
  )

  const result = await runHyperliquidCollector(supabase)
  console.log(JSON.stringify(result, null, 2))
}

function nextUtcEvaluationAt(
  now = new Date(),
  intervalHours = envNumber('HYPERLIQUID_EVALUATION_INTERVAL_HOURS', DEFAULT_EVALUATION_INTERVAL_HOURS),
  delayMs = envNumber('HYPERLIQUID_EVALUATION_DELAY_MS', DEFAULT_EVALUATION_DELAY_MS)
): Date {
  const intervalMs = Math.max(1, intervalHours) * 60 * 60 * 1000
  const currentMs = now.getTime()
  const nextBoundaryMs = Math.floor(currentMs / intervalMs) * intervalMs + intervalMs
  return new Date(nextBoundaryMs + Math.max(0, delayMs))
}

function scheduleNextRun(): void {
  const nextRunAt = nextUtcEvaluationAt()
  const waitMs = Math.min(Math.max(0, nextRunAt.getTime() - Date.now()), MAX_TIMEOUT_MS)
  console.log(JSON.stringify({
    service: 'hyperliquid-collector',
    nextRunAt: nextRunAt.toISOString(),
    waitMs,
    evaluationIntervalHours: envNumber('HYPERLIQUID_EVALUATION_INTERVAL_HOURS', DEFAULT_EVALUATION_INTERVAL_HOURS),
  }))

  setTimeout(() => {
    runOnce()
      .catch((err) => {
        console.error('[hyperliquid-collector] run failed:', err)
      })
      .finally(scheduleNextRun)
  }, waitMs)
}

async function main(): Promise<void> {
  if (process.env.HYPERLIQUID_RUN_ONCE === '1') {
    await runOnce()
    return
  }

  scheduleNextRun()
}

main().catch((err) => {
  console.error('[hyperliquid-collector] fatal:', err)
  process.exit(1)
})

export const __testing = {
  nextUtcEvaluationAt,
}
