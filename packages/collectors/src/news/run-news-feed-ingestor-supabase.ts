import { createClient } from '@supabase/supabase-js'
import { envFlag, loadDotenvChain, requiredEnv } from '../pipeline-store/cli-env'
import { SupabasePipelineLedgerStore, withPipelineRun } from '../pipeline-ledger'
import { startIntervalRunner } from '../pipeline-store/interval-runner'
import {
  DEFAULT_NEWS_FEED_INTERVAL_MS,
  positiveInteger,
} from './runtime-config'
import { SupabaseNewsStore } from './supabase-store'
import { runNewsFeedIngestionOnce } from './news-feed-ingestor'

async function runOnce(): Promise<void> {
  const supabase = createClient(
    requiredEnv('SUPABASE_URL'),
    requiredEnv('SUPABASE_SERVICE_ROLE_KEY'),
  )
  const result = await withPipelineRun(
    new SupabasePipelineLedgerStore(supabase),
    {
      source: 'news',
      sourceArea: 'curated_news',
      stage: 'news.collector',
      metadata: {
        provider: 'structured_news_feed',
        storage: 'supabase',
      },
    },
    () => runNewsFeedIngestionOnce({
      store: new SupabaseNewsStore(supabase),
    }),
  )
  console.log(JSON.stringify(result, null, 2))
}

async function main(): Promise<void> {
  loadDotenvChain()
  await runOnce()
  if (envFlag(process.env.NEWS_FEED_RUN_ONCE)) return

  startIntervalRunner({
    label: 'news-feed-ingestor-supabase',
    intervalMs: positiveInteger(
      process.env.NEWS_FEED_INTERVAL_MS,
      DEFAULT_NEWS_FEED_INTERVAL_MS,
    ),
    run: runOnce,
  })
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
})
