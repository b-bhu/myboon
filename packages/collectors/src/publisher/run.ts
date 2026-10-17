import { loadDotenvChain, requiredEnv } from '../pipeline-store/cli-env'
import { appendErrorLog, installProcessErrorLogging } from '../pipeline-store/error-log'

loadDotenvChain()
installProcessErrorLogging('publisher')

import { createSupabaseClient, requireSupabaseEnv } from '@myboon/shared/supabase-client'
import { SupabasePipelineLedgerStore, withPipelineRun } from '../pipeline-ledger'
import { runFirstThenInterval } from '../pipeline-store/interval-runner'
import { SqlitePipelineStore } from '../pipeline-store/sqlite-store'
import { publisherCliConfig, runPublisher } from './runner'
import { SupabasePublisherStore } from './supabase-store'
import { SupabaseEntityKnowledgeReader } from '../entity-manager/supabase-entity-knowledge-reader'

function previewOnly(env: NodeJS.ProcessEnv): boolean {
  return env.PUBLISHER_PREVIEW_ONLY === '1' || env.PUBLISHER_DRY_RUN === '1'
}

async function runOnce(): Promise<void> {
  const config = publisherCliConfig()
  const supabase = createSupabaseClient(
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
        store: new SupabasePublisherStore(
          supabase,
          pipelineStore,
          new SupabaseEntityKnowledgeReader(supabase),
        ),
        batchSize: config.batchSize,
        dryRun: previewOnly(process.env),
      }),
      undefined,
      { app: 'publisher' }
    )
    console.log(JSON.stringify(result, null, 2))
  } finally {
    pipelineStore.close()
  }
}

async function main(): Promise<void> {
  requireSupabaseEnv()
  const config = publisherCliConfig()
  await runFirstThenInterval({
    label: 'publisher',
    intervalMs: config.intervalMs,
    runOnce: config.runOnce,
    run: runOnce,
  })
}

main().catch((err) => {
  appendErrorLog({ app: 'publisher', kind: 'run_failed', error: err })
  console.error('[publisher] fatal:', err)
  process.exit(1)
})
