import { createClient } from '@supabase/supabase-js'
import { envFlag, loadDotenvChain, requiredEnv } from '../pipeline-store/cli-env'
import { SupabasePipelineLedgerStore, withPipelineRun } from '../pipeline-ledger'
import { startIntervalRunner } from '../pipeline-store/interval-runner'
import { HermesWorkerClient } from './hermes-client'
import { runNewsResearchPipelineOnce } from './runner'
import {
  newsResearchBacklogWarnAgeMs,
  newsResearchBacklogWarnCount,
  newsResearchBatchSize,
  newsResearchConcurrency,
  positiveInteger,
} from './runtime-config'
import { SupabaseNewsStore } from './supabase-store'

const DEFAULT_INTERVAL_MS = 5 * 60 * 1000

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
  const concurrency = newsResearchConcurrency()
  const researchTimeoutMs = positiveInteger(process.env.NEWS_RESEARCH_TIMEOUT_MS, 10 * 60_000)
  const staleWorkCutoffMs = positiveInteger(process.env.NEWS_STALE_WORK_CUTOFF_MS, 30 * 60_000)
  const backlogWarnCount = newsResearchBacklogWarnCount()
  const backlogWarnAgeMs = newsResearchBacklogWarnAgeMs()

  const result = await withPipelineRun(
    new SupabasePipelineLedgerStore(supabase),
    {
      source: 'news',
      sourceArea: 'curated_news',
      stage: 'news.researcher',
      metadata: {
        batchSize,
        concurrency,
        storage: 'supabase',
      },
    },
    () => {
      const store = new SupabaseNewsStore(supabase)
      const hermes = new HermesWorkerClient()
      const options = {
        batchSize,
        concurrency,
        researchTimeoutMs,
        staleWorkCutoffMs,
        backlogWarnCount,
        backlogWarnAgeMs,
      }
      return runNewsResearchPipelineOnce({ store, hermes, options })
    }
  )

  if (result.backlog.warning) {
    console.warn('[news-researcher] backlog warning', JSON.stringify(result.backlog))
  }

  console.log(JSON.stringify(result, null, 2))
}

async function main(): Promise<void> {
  await runOnce()

  if (envFlag(process.env.NEWS_RESEARCHER_RUN_ONCE)) return

  const intervalMs = positiveInteger(process.env.NEWS_RESEARCHER_INTERVAL_MS, DEFAULT_INTERVAL_MS)
  startIntervalRunner({
    label: 'news-researcher',
    intervalMs,
    run: runOnce,
  })
}

// NOTE: no `require.main === module` guard here. PM2 fork mode wraps
// entrypoints in its ProcessContainer, so require.main is never this module
// under PM2 and a guarded main() would silently never run (restart loop).
main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
})
