import { loadDotenvChain, requiredEnv } from '../pipeline-store/cli-env'

loadDotenvChain()

import { createClient } from '@supabase/supabase-js'
import { SqlitePipelineStore } from '../pipeline-store/sqlite-store'
import { HermesEditorDraftProvider } from './hermes-editor'
import { draftInputFromDecision, normalizeEditorDraftDecision } from './normalizer'
import { editorDraftCliConfig } from './runner'
import { SupabaseEditorDraftStore } from './supabase-store'

function shouldWrite(argv: string[], env: NodeJS.ProcessEnv): boolean {
  return argv.includes('--write') || env.EDITOR_DRAFT_PREVIEW_WRITE === '1'
}

async function main(): Promise<void> {
  const config = editorDraftCliConfig()
  const write = shouldWrite(process.argv.slice(2), process.env)
  const observedAt = new Date().toISOString()
  const supabase = createClient(
    requiredEnv('SUPABASE_URL'),
    requiredEnv('SUPABASE_SERVICE_ROLE_KEY')
  )
  const pipelineStore = new SqlitePipelineStore()
  try {
    const store = new SupabaseEditorDraftStore(supabase, pipelineStore)
    const provider = new HermesEditorDraftProvider({ timeoutMs: config.hermesTimeoutMs })
    const bundles = await store.fetchBundles({
      batchSize: config.batchSize,
      recentMemoryLimit: config.recentMemoryLimit,
      laneMemoryLimit: config.laneMemoryLimit,
      priorDraftLimit: config.priorDraftLimit,
      publishedHistoryLimit: config.publishedHistoryLimit,
    })

    const previews = []
    for (const bundle of bundles) {
      const agentDecision = await provider.decide(bundle)
      const normalized = normalizeEditorDraftDecision(agentDecision, bundle)
      const draftInput = draftInputFromDecision(bundle, normalized, observedAt, 'hermes_cli', null)
      const written = write ? await store.upsertDrafts([draftInput]) : []
      previews.push({
        mode: write ? 'write' : 'preview',
        entity: {
          id: bundle.entity.id,
          slug: bundle.entity.slug,
          name: bundle.entity.name,
          type: bundle.entity.type,
        },
        input: {
          new_memory_ids: bundle.newMemories.map((memory) => memory.id),
          memory_lane_count: bundle.memoryLane.length,
          prior_draft_count: bundle.priorDrafts.length,
          published_history_count: bundle.publishedHistory.length,
        },
        normalized_draft: draftInput,
        written,
      })
    }

    console.log(JSON.stringify({
      observedAt,
      write,
      bundlesFetched: bundles.length,
      previews,
    }, null, 2))
  } finally {
    pipelineStore.close()
  }
}

main().catch((err) => {
  console.error('[editor-draft:preview] fatal:', err)
  process.exit(1)
})
