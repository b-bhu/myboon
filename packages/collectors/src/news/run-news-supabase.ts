import { createClient } from '@supabase/supabase-js'
import { envFlag, loadDotenvChain, requiredEnv } from '../pipeline-store/cli-env'
import { SupabasePipelineLedgerStore, withPipelineRun } from '../pipeline-ledger'
import { startIntervalRunner } from '../pipeline-store/interval-runner'
import { HermesWorkerClient } from './hermes-client'
import { runNewsPipelineOnce } from './runner'
import {
  DEFAULT_NEWS_SCOUT_TIMEOUT_MS,
  newsResearchBatchSize,
  positiveInteger,
} from './runtime-config'
import { SupabaseNewsStore } from './supabase-store'

const DEFAULT_INTERVAL_MS = 60 * 60 * 1000

function createSupabase() {
  loadDotenvChain()
  const supabase = createClient(
    requiredEnv('SUPABASE_URL'),
    requiredEnv('SUPABASE_SERVICE_ROLE_KEY')
  )
  return supabase
}

async function runOnce(): Promise<void> {
  const supabase = createSupabase()
  const batchSize = newsResearchBatchSize()
  const scoutTimeoutMs = positiveInteger(process.env.NEWS_SCOUT_TIMEOUT_MS, DEFAULT_NEWS_SCOUT_TIMEOUT_MS)
  const researchTimeoutMs = positiveInteger(process.env.NEWS_RESEARCH_TIMEOUT_MS, 10 * 60_000)
  const staleWorkCutoffMs = positiveInteger(process.env.NEWS_STALE_WORK_CUTOFF_MS, 30 * 60_000)

  const result = await withPipelineRun(
    new SupabasePipelineLedgerStore(supabase),
    {
      source: 'news',
      sourceArea: 'curated_news',
      stage: 'news.collector',
      metadata: {
        batchSize,
        storage: 'supabase',
      },
    },
    () => runNewsPipelineOnce({
      store: new SupabaseNewsStore(supabase),
      hermes: new HermesWorkerClient(),
      options: {
        batchSize,
        scoutTimeoutMs,
        researchTimeoutMs,
        staleWorkCutoffMs,
      },
    })
  )

  console.log(JSON.stringify(result, null, 2))
}

async function main(): Promise<void> {
  await runOnce()

  if (envFlag(process.env.NEWS_RUNNER_RUN_ONCE)) return

  const intervalMs = positiveInteger(process.env.NEWS_RUNNER_INTERVAL_MS, DEFAULT_INTERVAL_MS)
  startIntervalRunner({
    label: 'news-runner',
    intervalMs,
    run: runOnce,
  })
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  })
}
