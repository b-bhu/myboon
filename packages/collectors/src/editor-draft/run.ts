import { loadDotenvChain } from '../pipeline-store/cli-env'
import { appendErrorLog, installProcessErrorLogging } from '../pipeline-store/error-log'

loadDotenvChain()
installProcessErrorLogging('editor-draft')

import { createSupabaseClient, createSupabaseHealthProbe, requireSupabaseEnv } from '@myboon/shared/supabase-client'
import type { SupabaseClient } from '@supabase/supabase-js'
import { SupabasePipelineLedgerStore, withPipelineRun } from '../pipeline-ledger'
import { SupabaseHealthGate, waitForSupabaseRunOnce } from '../pipeline-store/health-gate'
import { runFirstThenInterval } from '../pipeline-store/interval-runner'
import { SqlitePipelineStore } from '../pipeline-store/sqlite-store'
import type { PipelineStore } from '../pipeline-store/store'
import { resolveLaneSqlitePathFromEnv } from '../lane-store/paths'
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
    }),
    undefined,
    { app: 'editor-draft' }
  )
  console.log(JSON.stringify(result, null, 2))
}

async function main(): Promise<void> {
  const { supabaseUrl, supabaseKey } = requireSupabaseEnv()
  const config = editorDraftCliConfig()
  const supabase = createSupabaseClient(supabaseUrl, supabaseKey)
  const pipelineStore = new SqlitePipelineStore(resolveLaneSqlitePathFromEnv('polymarket', process.env))
  const probe = createSupabaseHealthProbe(supabaseUrl, supabaseKey)

  try {
    await runFirstThenInterval({
      label: 'editor-draft',
      intervalMs: config.intervalMs,
      runOnce: config.runOnce,
      run: () => runOnce(supabase, pipelineStore),
      healthGate: new SupabaseHealthGate({ app: 'editor-draft', probe }),
      runOnceHealthCheck: () => waitForSupabaseRunOnce({ app: 'editor-draft', probe }),
    })
  } finally {
    if (config.runOnce) pipelineStore.close()
  }
}

main().catch((err) => {
  appendErrorLog({ app: 'editor-draft', kind: 'run_failed', error: err })
  console.error('[editor-draft] fatal:', err)
  process.exit(1)
})
