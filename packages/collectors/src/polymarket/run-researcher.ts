import { config as loadEnv } from 'dotenv'

loadEnv({ path: '.env' })
loadEnv({ path: '../../.env' })
loadEnv()

import { createClient } from '@supabase/supabase-js'
import { withPipelineRun, PipelineStoreLedgerStore } from '../pipeline-ledger'
import { SqlitePipelineStore } from '../pipeline-store/sqlite-store'
import { runPolymarketResearcher } from './researcher'

const RESEARCHER_INTERVAL_MS = 5 * 60 * 1000

function requiredEnv(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`Missing required env var: ${name}`)
  return value
}

async function runOnce(): Promise<void> {
  const supabase = createClient(
    requiredEnv('SUPABASE_URL'),
    requiredEnv('SUPABASE_SERVICE_ROLE_KEY')
  )

  // Local pipeline state now lives in SQLite; the researcher no longer reads
  // or writes any Supabase table directly, but still takes the client for
  // signature parity with the data-engineer stage and any future need.
  const store = new SqlitePipelineStore()
  try {
    const result = await withPipelineRun(
      new PipelineStoreLedgerStore(store),
      {
        source: 'polymarket',
        sourceArea: 'markets',
        stage: 'polymarket.researcher',
      },
      () => runPolymarketResearcher(store, supabase)
    )
    console.log(JSON.stringify(result, null, 2))
  } finally {
    store.close()
  }
}

async function main(): Promise<void> {
  await runOnce()

  setInterval(() => {
    runOnce().catch((err) => {
      console.error('[polymarket-researcher] run failed:', err)
    })
  }, RESEARCHER_INTERVAL_MS)
}

main().catch((err) => {
  console.error('[polymarket-researcher] fatal:', err)
  process.exit(1)
})
