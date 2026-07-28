import { loadDotenvChain, requiredEnv } from '../pipeline-store/cli-env'

loadDotenvChain()

import { createClient } from '@supabase/supabase-js'
import { withPipelineRun, PipelineStoreLedgerStore } from '../pipeline-ledger'
import { startIntervalRunner } from '../pipeline-store/interval-runner'
import { SqlitePipelineStore } from '../pipeline-store/sqlite-store'
import { runPolymarketResearcher } from './researcher'

const RESEARCHER_INTERVAL_MS = 5 * 60 * 1000

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

  // Overlap guard: a single deep_web candidate can take ~11 minutes and a
  // batch can contain several, so a run can plausibly exceed this 5-minute
  // tick. Without this guard a slow tick would overlap the next one and
  // start a second concurrent researcher run against the same store.
  startIntervalRunner({
    label: 'polymarket-researcher',
    intervalMs: RESEARCHER_INTERVAL_MS,
    run: runOnce,
  })
}

main().catch((err) => {
  console.error('[polymarket-researcher] fatal:', err)
  process.exit(1)
})
