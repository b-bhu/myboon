import { config as loadEnv } from 'dotenv'

loadEnv({ path: '.env' })
loadEnv({ path: '../../.env' })
loadEnv()

import { createClient } from '@supabase/supabase-js'
import { withPipelineRun, PipelineStoreLedgerStore } from '../pipeline-ledger'
import { startIntervalRunner } from '../pipeline-store/interval-runner'
import { SqlitePipelineStore } from '../pipeline-store/sqlite-store'
import {
  previewPolymarketMarketsDataEngineer,
  runPolymarketMarketsDataEngineer,
} from './markets-data-engineer'

const DEFAULT_RUN_INTERVAL_MS = 2 * 60 * 60 * 1000

function requiredEnv(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`Missing required env var: ${name}`)
  return value
}

async function runOnce(): Promise<void> {
  if (process.env.POLYMARKET_MARKETS_PREVIEW_ONLY === '1') {
    const result = await previewPolymarketMarketsDataEngineer()
    console.log(JSON.stringify(result, null, 2))
    return
  }

  const supabase = createClient(
    requiredEnv('SUPABASE_URL'),
    requiredEnv('SUPABASE_SERVICE_ROLE_KEY')
  )

  // Local pipeline state (candidates, research, watchlist, etc.) now lives in
  // SQLite; only published_narratives reads still go through Supabase, done
  // inside runPolymarketMarketsDataEngineer itself.
  const store = new SqlitePipelineStore()
  try {
    const result = await withPipelineRun(
      new PipelineStoreLedgerStore(store),
      {
        source: 'polymarket',
        sourceArea: 'markets',
        stage: 'polymarket.data_engineer',
      },
      () => runPolymarketMarketsDataEngineer(store, supabase)
    )
    console.log(JSON.stringify(result, null, 2))
  } finally {
    store.close()
  }
}

async function main(): Promise<void> {
  await runOnce()

  if (process.env.POLYMARKET_MARKETS_RUN_ONCE === '1') return

  const intervalMs = Number(process.env.POLYMARKET_MARKETS_RUN_INTERVAL_MS) || DEFAULT_RUN_INTERVAL_MS
  startIntervalRunner({
    label: 'polymarket-markets-data-engineer',
    intervalMs,
    run: runOnce,
  })
}

main().catch((err) => {
  console.error('[polymarket-markets-data-engineer] fatal:', err)
  process.exit(1)
})
