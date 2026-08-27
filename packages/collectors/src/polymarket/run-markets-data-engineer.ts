import { loadDotenvChain, requiredEnv } from '../pipeline-store/cli-env'
import { resolve } from 'node:path'

loadDotenvChain()

import { createClient } from '@supabase/supabase-js'
import { withPipelineRun, PipelineStoreLedgerStore } from '../pipeline-ledger'
import { startIntervalRunner } from '../pipeline-store/interval-runner'
import { SqlitePipelineStore } from '../pipeline-store/sqlite-store'
import { feedV3ModeForSource, loadFeedV3RuntimeConfig } from '../signal-platform/runtime-config'
import { CanonicalSourceSignalIntake } from '../signal-platform/source-intake'
import { SqliteSignalPlatformStore } from '../signal-platform/sqlite-platform-store'
import { createActiveSourceTriageIntake } from '../signal-platform/active-triage'
import { SqliteLocalCapacitySnapshot } from '../signal-platform/local-capacity'
import {
  previewPolymarketMarketsDataEngineer,
  runPolymarketMarketsDataEngineer,
} from './markets-data-engineer'

const DEFAULT_RUN_INTERVAL_MS = 2 * 60 * 60 * 1000

async function runOnce(): Promise<void> {
  if (process.env.POLYMARKET_MARKETS_PREVIEW_ONLY === '1') {
    const result = await previewPolymarketMarketsDataEngineer()
    console.log(JSON.stringify(result, null, 2))
    return
  }

  const pipelinePath = process.env.PIPELINE_SQLITE_PATH ?? resolve(__dirname, '..', '..', '.data', 'pipeline.sqlite')
  const runtime = loadFeedV3RuntimeConfig()
  const intakeMode = feedV3ModeForSource(runtime, 'intake', 'polymarket')
  const supabase = createClient(
    requiredEnv('SUPABASE_URL'),
    requiredEnv('SUPABASE_SERVICE_ROLE_KEY')
  )

  // Local pipeline state (candidates, research, watchlist, etc.) now lives in
  // SQLite; only published_narratives reads still go through Supabase, done
  // inside runPolymarketMarketsDataEngineer itself.
  const store = new SqlitePipelineStore(pipelinePath)
  const canonicalStore = intakeMode !== 'off'
    ? new SqliteSignalPlatformStore(pipelinePath, 'polymarket')
    : null
  try {
    const signalIntake = canonicalStore
      ? intakeMode === 'active'
        ? createActiveSourceTriageIntake({
          store: canonicalStore,
          capacity: new SqliteLocalCapacitySnapshot(canonicalStore),
          providerHealth: runtime.triageProviderHealth,
          classifierEnabled: runtime.triageClassifierEnabled,
          allowedDepths: [...runtime.triageAllowedDepths],
        })
        : new CanonicalSourceSignalIntake({ mode: 'observe', store: canonicalStore })
      : undefined
    const result = await withPipelineRun(
      new PipelineStoreLedgerStore(store),
      {
        source: 'polymarket',
        sourceArea: 'markets',
        stage: 'polymarket.data_engineer',
      },
      () => runPolymarketMarketsDataEngineer(
        store,
        supabase,
        {},
        signalIntake,
      )
    )
    console.log(JSON.stringify(result, null, 2))
  } finally {
    canonicalStore?.close()
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
