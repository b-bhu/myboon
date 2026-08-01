import { loadDotenvChain, requiredEnv } from '../pipeline-store/cli-env'

loadDotenvChain()

import { createClient } from '@supabase/supabase-js'
import { SupabasePipelineLedgerStore, withPipelineRun } from '../pipeline-ledger'
import { startIntervalRunner } from '../pipeline-store/interval-runner'
import { SqlitePipelineStore } from '../pipeline-store/sqlite-store'
import { publisherCliConfig, runPublisher } from './runner'
import { SupabasePublisherStore } from './supabase-store'

function previewOnly(env: NodeJS.ProcessEnv): boolean {
  return env.PUBLISHER_PREVIEW_ONLY === '1' || env.PUBLISHER_DRY_RUN === '1'
}

async function runOnce(): Promise<void> {
  const config = publisherCliConfig()
  const supabase = createClient(
    requiredEnv('SUPABASE_URL'),
    requiredEnv('SUPABASE_SERVICE_ROLE_KEY')
  )
  const pipelineStore = new SqlitePipelineStore()
  try {
    const result = await withPipelineRun(
      new SupabasePipelineLedgerStore(supabase),
      {
        source: 'feed',
        sourceArea: 'published_narratives',
        stage: 'publisher',
        metadata: {
          batchSize: config.batchSize,
          dryRun: previewOnly(process.env),
        },
      },
      () => runPublisher({
        store: new SupabasePublisherStore(supabase, pipelineStore),
        batchSize: config.batchSize,
        dryRun: previewOnly(process.env),
      })
    )
    console.log(JSON.stringify(result, null, 2))
  } finally {
    pipelineStore.close()
  }
}

async function main(): Promise<void> {
  const config = publisherCliConfig()
  await runOnce()

  if (config.runOnce) return

  startIntervalRunner({
    label: 'publisher',
    intervalMs: config.intervalMs,
    run: runOnce,
  })
}

main().catch((err) => {
  console.error('[publisher] fatal:', err)
  process.exit(1)
})
