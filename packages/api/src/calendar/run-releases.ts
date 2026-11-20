/**
 * #702 CLI entry: the calendar releases job for atlas.event_releases (PM2 cron
 * `0 21 * * *`, one run per day, then exit). Two modes:
 *   tsx src/calendar/run-releases.ts             daily: the 14 days ending today (UTC). Runs
 *                                                only when CALENDAR_RELEASES_ENABLED === 'true'
 *                                                (otherwise one skipped line and exit 0, before
 *                                                any pool, fetch or database I/O).
 *   tsx src/calendar/run-releases.ts --backfill  one-off: the 183 days ending today (UTC); the
 *                                                gate is ignored so it can be run by hand.
 * CALENDAR_RELEASES_DATABASE_URL connects as the calendar_worker role (#701)
 * and comes from packages/api/.env; its value is never logged.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import 'dotenv/config'
import pg from 'pg'
import { runReleases } from './releases.js'

// Same trust split as packages/entity-manager/src/worker.ts: clear host ->
// verify, localhost -> no TLS (CreatePool-style, #701's calendar_worker role).
const CA_PATH = fileURLToPath(new URL('../../supabase-prod-ca-2021.crt', import.meta.url))
const LOCAL_HOSTS = new Set(['', 'localhost', '127.0.0.1', '::1'])

export function createPool(databaseUrl: string): pg.Pool {
  const url = new URL(databaseUrl)
  for (const key of [...url.searchParams.keys()].filter((key) => /^ssl/i.test(key))) {
    url.searchParams.delete(key)
  }
  const ssl = LOCAL_HOSTS.has(url.hostname)
    ? false
    : {
        rejectUnauthorized: true as const,
        ca: readFileSync(process.env.CALENDAR_RELEASES_DATABASE_CA_FILE?.trim() || CA_PATH, 'utf8'),
      }
  // calendar_worker allows 2 connections; one strictly sequential job needs less.
  return new pg.Pool({ connectionString: url.toString(), ssl, max: 1 })
}

async function main(): Promise<number> {
  const mode = process.argv.includes('--backfill') ? 'backfill' as const : 'daily' as const
  // --backfill ignores the gate, so it can be run once by hand.
  const enabled = mode === 'backfill' || process.env.CALENDAR_RELEASES_ENABLED === 'true'
  const databaseUrl = process.env.CALENDAR_RELEASES_DATABASE_URL?.trim()
  if (enabled && !databaseUrl) {
    throw new Error('CALENDAR_RELEASES_DATABASE_URL is not set')
  }
  const pool = enabled && databaseUrl ? createPool(databaseUrl) : null
  try {
    const result = await runReleases({
      mode,
      enabled,
      query: pool ? (text: string, values: readonly unknown[]) => pool.query(text, values as unknown[]) : undefined,
      log: (line) => { console.log(JSON.stringify(line)) },
    })
    return result.ok ? 0 : 1
  } finally {
    // Always release the single pool connection before PM2's next cron start.
    await pool?.end()
  }
}

main()
  .then((code) => { if (code !== 0) process.exitCode = code })
  .catch((error: unknown) => {
    // The message only: the database URL and its values are never logged.
    console.error(`calendar releases: run failed: ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  })
