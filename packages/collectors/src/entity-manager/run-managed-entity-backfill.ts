/**
 * #337 PR-B CLI entrypoint (thin — all logic lives in ./managed-entity-backfill):
 *   pnpm run entity-v4:backfill-337 -- --report out.json [--write --cursor c.json] ...
 * The database URL comes only from MYBOON_ENTITY_BACKFILL_DATABASE_URL (no
 * dotenv loading), it is never logged, and SIGINT/SIGTERM stop the run after
 * the current batch with the cursor saved, report status 'interrupted' and
 * exit code 130.
 */

import { packageScriptArgs } from '../cli-args'
import { createBackfillPool, parseBackfillArgs, runBackfill } from './managed-entity-backfill'

async function main(): Promise<void> {
  const args = parseBackfillArgs(packageScriptArgs(process.argv.slice(2)))
  const connectionString = process.env.MYBOON_ENTITY_BACKFILL_DATABASE_URL?.trim()
  if (!connectionString) {
    throw new Error('MYBOON_ENTITY_BACKFILL_DATABASE_URL is required (no dotenv file is loaded; set the variable explicitly)')
  }
  const stop = { stopped: false }
  const onSignal = (): void => {
    stop.stopped = true
  }
  process.on('SIGINT', onSignal)
  process.on('SIGTERM', onSignal)
  const pool = createBackfillPool(connectionString)
  try {
    const report = await runBackfill({
      pool,
      write: args.write,
      reportPath: args.reportPath,
      cursorPath: args.cursorPath,
      batchSize: args.batchSize,
      pauseMs: args.pauseMs,
      maxBatches: args.maxBatches ?? undefined,
      signal: stop,
    })
    process.stdout.write(`${JSON.stringify({
      mode: report.mode, status: report.status, counts: report.counts, cursor: report.cursor?.phase ?? null, report: args.reportPath,
    }, null, 2)}\n`)
    if (report.status === 'interrupted') {
      process.exitCode = 130
      return
    }
    if (report.status === 'failed') {
      process.stderr.write(`[entity-v4-backfill-337] ${report.error ?? 'the backfill failed'}\n`)
      process.exitCode = 1
    }
  } finally {
    process.off('SIGINT', onSignal)
    process.off('SIGTERM', onSignal)
    await pool.end().catch(() => {})
  }
}

if (require.main === module) {
  main().catch((error: unknown) => {
    process.stderr.write(`[entity-v4-backfill-337] ${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  })
}