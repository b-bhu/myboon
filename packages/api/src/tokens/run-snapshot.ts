// CLI entrypoint for the token identity snapshot job.
// Usage: pnpm --filter @myboon/api run tokens:snapshot
//
// Env:
//   TOKENS_SNAPSHOT_RUN_ONCE      'true' to run once and exit (default: loop)
//   TOKENS_SNAPSHOT_INTERVAL_MS   loop interval, default 24h
//   TOKENS_API_KEY                optional; seed-mode-only run without it
//   SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY  required, same as the API server

import 'dotenv/config'
import { loadApiConfig } from '../bootstrap/config.js'
import { SupabaseTokenIdentityStore } from './identity-store.js'
import { runTokenSnapshot } from './snapshot-job.js'

const DEFAULT_INTERVAL_MS = 24 * 60 * 60 * 1000 // 24h

function parseIntervalMs(value: string | undefined): number {
  const parsed = value ? Number.parseInt(value, 10) : NaN
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_INTERVAL_MS
}

async function runOnce(store: SupabaseTokenIdentityStore): Promise<void> {
  const apiKey = process.env.TOKENS_API_KEY || null
  const startedAt = Date.now()
  try {
    const result = await runTokenSnapshot({ apiKey, store })
    const elapsedMs = Date.now() - startedAt
    console.log(
      `[tokens:snapshot] seed=${result.seedRowsUpserted} tokens=${result.tokensRowsUpserted} `
      + `failedCalls=${result.tokensCallsFailed} elapsedMs=${elapsedMs}`,
    )
  } catch (err) {
    console.error('[tokens:snapshot] run failed:', err instanceof Error ? err.message : err)
  }
}

async function main(): Promise<void> {
  const config = loadApiConfig()
  const store = new SupabaseTokenIdentityStore(config.supabaseUrl, config.supabaseServiceRoleKey)

  const runOnceFlag = process.env.TOKENS_SNAPSHOT_RUN_ONCE === 'true' || process.env.TOKENS_SNAPSHOT_RUN_ONCE === '1'

  if (runOnceFlag) {
    await runOnce(store)
    return
  }

  const intervalMs = parseIntervalMs(process.env.TOKENS_SNAPSHOT_INTERVAL_MS)
  console.log(`[tokens:snapshot] looping every ${Math.round(intervalMs / 3600_000)}h`)

  // Run immediately, then on the interval. This process is expected to be
  // run under a process manager / cron wrapper that keeps it alive.
  await runOnce(store)
  setInterval(() => {
    void runOnce(store)
  }, intervalMs)
}

main().catch((err) => {
  console.error('[tokens:snapshot] fatal:', err instanceof Error ? err.message : err)
  process.exit(1)
})
