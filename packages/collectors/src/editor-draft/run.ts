import { config as loadEnv } from 'dotenv'

loadEnv({ path: '.env' })
loadEnv({ path: '../../.env' })
loadEnv()

import { createClient } from '@supabase/supabase-js'
import type { SupabaseClient } from '@supabase/supabase-js'
import { SupabasePipelineLedgerStore, withPipelineRun } from '../pipeline-ledger'
import { SqlitePipelineStore } from '../pipeline-store/sqlite-store'
import type { PipelineStore } from '../pipeline-store/store'
import { HermesEditorDraftProvider } from './hermes-editor'
import { editorDraftCliConfig, runEditorDraft } from './runner'

function requiredEnv(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`Missing required env var: ${name}`)
  return value
}

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
  const config = editorDraftCliConfig()
  const supabase = createClient(
    requiredEnv('SUPABASE_URL'),
    requiredEnv('SUPABASE_SERVICE_ROLE_KEY')
  )
  const pipelineStore = new SqlitePipelineStore()

  try {
    await runOnce(supabase, pipelineStore)
    if (config.runOnce) return

    setInterval(() => {
      runOnce(supabase, pipelineStore).catch((err) => {
        console.error('[editor-draft] run failed:', err)
      })
    }, config.intervalMs)
  } finally {
    if (config.runOnce) pipelineStore.close()
  }
}

main().catch((err) => {
  console.error('[editor-draft] fatal:', err)
  process.exit(1)
})
