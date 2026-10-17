import { loadDotenvChain, requiredEnv } from '../pipeline-store/cli-env'

loadDotenvChain()

import { createSupabaseClient, requireSupabaseEnv } from '@myboon/shared/supabase-client'
import type { SupabaseClient } from '@supabase/supabase-js'
import { SupabasePipelineLedgerStore, withPipelineRun } from '../pipeline-ledger'
import { runFirstThenInterval } from '../pipeline-store/interval-runner'
import { SqlitePipelineStore } from '../pipeline-store/sqlite-store'
import type { PipelineStore } from '../pipeline-store/store'
import { HermesEditorDraftProvider } from './hermes-editor'
import { editorDraftCliConfig, runEditorDraft } from './runner'

async function runOnce(supabase: SupabaseClient, pipelineStore: PipelineStore): Promise<void> {
  const config = editorDraftCliConfig()
  const result = await withPipelineRun(
    new SupabasePipelineLedgerStore(supabase),
    {
      source: 'feed',
      sourceArea: 'entity_memory',
      stage: 'editor_draft',
      metadata: {
        batchSize: config.batchSize,
      },
    },
    () => runEditorDraft(supabase, pipelineStore, {
      batchSize: config.batchSize,
      recentMemoryLimit: config.recentMemoryLimit,
      laneMemoryLimit: config.laneMemoryLimit,
      priorDraftLimit: config.priorDraftLimit,
      publishedHistoryLimit: config.publishedHistoryLimit,
      provider: new HermesEditorDraftProvider({ timeoutMs: config.hermesTimeoutMs }),
    })
  )
  console.log(JSON.stringify(result, null, 2))
}

async function main(): Promise<void> {
  requireSupabaseEnv()
  const config = editorDraftCliConfig()
  const supabase = createSupabaseClient(
    requiredEnv('SUPABASE_URL'),
    requiredEnv('SUPABASE_SERVICE_ROLE_KEY')
  )
  const pipelineStore = new SqlitePipelineStore()

  try {
    await runFirstThenInterval({
      label: 'editor-draft',
      intervalMs: config.intervalMs,
      runOnce: config.runOnce,
      run: () => runOnce(supabase, pipelineStore),
    })
  } finally {
    if (config.runOnce) pipelineStore.close()
  }
}

main().catch((err) => {
  console.error('[editor-draft] fatal:', err)
  process.exit(1)
})
