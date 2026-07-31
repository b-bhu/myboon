import { loadDotenvChain, requiredEnv } from '../pipeline-store/cli-env'

loadDotenvChain()

import { createClient } from '@supabase/supabase-js'
import { startIntervalRunner } from '../pipeline-store/interval-runner'
import { SqlitePipelineStore } from '../pipeline-store/sqlite-store'
import { runPolymarketPublisher } from './publisher'

const DEFAULT_INTERVAL_MS = 60 * 60 * 1000

function envNumber(name: string, fallback: number): number {
  const parsed = Number(process.env[name])
  return Number.isFinite(parsed) ? parsed : fallback
}

async function runOnce(): Promise<void> {
  const supabase = createClient(
    requiredEnv('SUPABASE_URL'),
    requiredEnv('SUPABASE_SERVICE_ROLE_KEY')
  )
  const store = new SqlitePipelineStore()

  try {
    const result = await runPolymarketPublisher(store, supabase)
    console.log(JSON.stringify(result, null, 2))
  } finally {
    store.close()
  }
}

async function main(): Promise<void> {
  // LEGACY LANE GUARD (PR review finding): see run-editor.ts - this
  // research-row publisher writes published_narratives via a different
  // column set than the production entity-draft lane. Never run by accident.
  if (process.env.POLYMARKET_LEGACY_RESEARCH_LANE !== 'I_UNDERSTAND') {
    console.error(
      '[polymarket-publisher] REFUSING TO START: legacy research-row publisher lane. '
      + 'Production uses the entity-draft lane (editor-draft/ + publisher/). '
      + 'Set POLYMARKET_LEGACY_RESEARCH_LANE=I_UNDERSTAND to run it anyway.'
    )
    process.exit(1)
  }

  await runOnce()

  if (process.env.POLYMARKET_PUBLISHER_RUN_ONCE === '1') return

  startIntervalRunner({
    label: 'polymarket-publisher',
    intervalMs: envNumber('POLYMARKET_PUBLISHER_INTERVAL_MS', DEFAULT_INTERVAL_MS),
    run: runOnce,
  })
}

main().catch((err) => {
  console.error('[polymarket-publisher] fatal:', err)
  process.exit(1)
})
