import type { SupabaseClient } from '@supabase/supabase-js'
import { envFlag, positiveInteger } from '../pipeline-store/cli-env'
import type { PipelineStore } from '../pipeline-store/store'
import { HermesEditorDraftProvider } from './hermes-editor'
import { draftInputFromDecision, normalizeEditorDraftDecision } from './normalizer'
import { SupabaseEditorDraftStore } from './supabase-store'
import type {
  EditorDraftProvider,
  EditorDraftRecord,
  EditorDraftStore,
  FetchEditorDraftBundlesOptions,
} from './types'

const DEFAULT_BATCH_SIZE = 10
const DEFAULT_RECENT_MEMORY_LIMIT = 5
const DEFAULT_LANE_MEMORY_LIMIT = 30
const DEFAULT_PRIOR_DRAFT_LIMIT = 20
const DEFAULT_PUBLISHED_HISTORY_LIMIT = 20

export interface RunEditorDraftOptions extends Partial<FetchEditorDraftBundlesOptions> {
  now?: string
  provider?: EditorDraftProvider
  store?: EditorDraftStore
  backend?: string
  model?: string | null
}

export interface EditorDraftCliConfig extends FetchEditorDraftBundlesOptions {
  intervalMs: number
  runOnce: boolean
  hermesTimeoutMs: number
}

export interface EditorDraftRunResult {
  observedAt: string
  bundlesFetched: number
  draftsWritten: number
  failed: number
  drafts: Array<{
    id: string
    entityId: string
    entitySlug: string
    action: string
    status: string
    sourceMemoryIds: string[]
  }>
  failures: Array<{ entityId: string, entitySlug: string, error: string }>
}

export function editorDraftCliConfig(env: NodeJS.ProcessEnv = process.env): EditorDraftCliConfig {
  return {
    batchSize: positiveInteger(env.EDITOR_DRAFT_BATCH_SIZE, DEFAULT_BATCH_SIZE),
    recentMemoryLimit: positiveInteger(env.EDITOR_DRAFT_RECENT_MEMORY_LIMIT, DEFAULT_RECENT_MEMORY_LIMIT),
    laneMemoryLimit: positiveInteger(env.EDITOR_DRAFT_LANE_MEMORY_LIMIT, DEFAULT_LANE_MEMORY_LIMIT),
    priorDraftLimit: positiveInteger(env.EDITOR_DRAFT_PRIOR_DRAFT_LIMIT, DEFAULT_PRIOR_DRAFT_LIMIT),
    publishedHistoryLimit: positiveInteger(env.EDITOR_DRAFT_PUBLISHED_HISTORY_LIMIT, DEFAULT_PUBLISHED_HISTORY_LIMIT),
    intervalMs: positiveInteger(env.EDITOR_DRAFT_INTERVAL_MS, 5 * 60 * 1000),
    runOnce: envFlag(env.EDITOR_DRAFT_RUN_ONCE),
    hermesTimeoutMs: positiveInteger(env.EDITOR_DRAFT_HERMES_TIMEOUT_MS, 10 * 60 * 1000),
  }
}

function sourceMemoryIds(record: EditorDraftRecord): string[] {
  return Array.isArray(record.source_memory_ids)
    ? record.source_memory_ids.filter((item): item is string => typeof item === 'string')
    : []
}

export async function runEditorDraft(
  db: SupabaseClient,
  pipelineStore: PipelineStore | null,
  options: RunEditorDraftOptions = {}
): Promise<EditorDraftRunResult> {
  const observedAt = options.now ?? new Date().toISOString()
  const fetchOptions: FetchEditorDraftBundlesOptions = {
    batchSize: options.batchSize ?? DEFAULT_BATCH_SIZE,
    recentMemoryLimit: options.recentMemoryLimit ?? DEFAULT_RECENT_MEMORY_LIMIT,
    laneMemoryLimit: options.laneMemoryLimit ?? DEFAULT_LANE_MEMORY_LIMIT,
    priorDraftLimit: options.priorDraftLimit ?? DEFAULT_PRIOR_DRAFT_LIMIT,
    publishedHistoryLimit: options.publishedHistoryLimit ?? DEFAULT_PUBLISHED_HISTORY_LIMIT,
  }
  let store = options.store
  if (!store) {
    if (!pipelineStore) throw new Error('runEditorDraft requires a PipelineStore when options.store is not provided')
    store = new SupabaseEditorDraftStore(db, pipelineStore)
  }
  const provider = options.provider ?? new HermesEditorDraftProvider()
  const backend = options.backend ?? 'hermes_cli'
  const model = options.model ?? null
  const bundles = await store.fetchBundles(fetchOptions)
  const drafts: EditorDraftRecord[] = []
  const failures: Array<{ entityId: string, entitySlug: string, error: string }> = []

  for (const bundle of bundles) {
    try {
      const agentDecision = await provider.decide(bundle)
      const decision = normalizeEditorDraftDecision(agentDecision, bundle)
      const input = draftInputFromDecision(bundle, decision, observedAt, backend, model)
      const written = await store.upsertDrafts([input])
      drafts.push(...written)
    } catch (error) {
      failures.push({
        entityId: bundle.entity.id,
        entitySlug: bundle.entity.slug,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  return {
    observedAt,
    bundlesFetched: bundles.length,
    draftsWritten: drafts.length,
    failed: failures.length,
    drafts: drafts.map((draft) => ({
      id: draft.id,
      entityId: draft.entity_id,
      entitySlug: draft.entity_slug,
      action: draft.action,
      status: draft.status,
      sourceMemoryIds: sourceMemoryIds(draft),
    })),
    failures,
  }
}
