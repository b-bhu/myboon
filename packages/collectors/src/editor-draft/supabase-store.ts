import type { SupabaseClient } from '@supabase/supabase-js'
import { buildEntityDraftBundles } from './input-builder'
import type { EntityMemoryRecord, EntityRecord } from '../entity-manager/types'
import type { PipelineDraftUpsertInput, PipelineStore } from '../pipeline-store/store'
import type {
  EntityDraftBundle,
  EditorDraftAction,
  EditorDraftInput,
  EditorDraftRecord,
  EditorDraftStatus,
  EditorDraftStore,
  EvidenceQuality,
  FetchEditorDraftBundlesOptions,
  PriorEditorDraft,
  PublishedHistoryItem,
} from './types'

const ENTITY_SELECT = 'id, slug, name, type, aliases, summary, status, show_in_carousel, metadata, created_at, updated_at'
const MEMORY_SELECT = 'id, entity_id, source, source_area, source_type, source_ref_id, source_research_id, memory_type, title, summary, body, event_at, observed_at, confidence, evidence, mentions, metrics, context, created_at, updated_at'
const ENTITY_PUBLISHED_HISTORY_TABLE = 'entity_published_history'

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((item): item is string => typeof item === 'string')
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function normalizeEntity(row: unknown): EntityRecord {
  const record = row as Record<string, unknown>
  return {
    id: String(record.id),
    slug: String(record.slug),
    name: String(record.name),
    type: String(record.type),
    aliases: asStringArray(record.aliases),
    summary: typeof record.summary === 'string' ? record.summary : null,
    status: typeof record.status === 'string' ? record.status : 'active',
    show_in_carousel: typeof record.show_in_carousel === 'boolean' ? record.show_in_carousel : false,
    metadata: asRecord(record.metadata),
    created_at: typeof record.created_at === 'string' ? record.created_at : undefined,
    updated_at: typeof record.updated_at === 'string' ? record.updated_at : undefined,
  }
}

function normalizeMemory(row: unknown): EntityMemoryRecord {
  const record = row as Record<string, unknown>
  return {
    id: String(record.id),
    entity_id: typeof record.entity_id === 'string' ? record.entity_id : null,
    source: String(record.source),
    source_area: String(record.source_area),
    source_type: String(record.source_type),
    source_ref_id: String(record.source_ref_id),
    source_research_id: String(record.source_research_id),
    memory_type: record.memory_type as EntityMemoryRecord['memory_type'],
    title: String(record.title),
    summary: String(record.summary),
    body: typeof record.body === 'string' ? record.body : null,
    event_at: typeof record.event_at === 'string' ? record.event_at : null,
    observed_at: String(record.observed_at),
    confidence: typeof record.confidence === 'number' ? record.confidence : null,
    evidence: Array.isArray(record.evidence) ? record.evidence : [],
    mentions: asStringArray(record.mentions),
    metrics: asRecord(record.metrics),
    context: asRecord(record.context),
    created_at: typeof record.created_at === 'string' ? record.created_at : undefined,
    updated_at: typeof record.updated_at === 'string' ? record.updated_at : undefined,
  }
}

function normalizePublishedHistory(row: unknown): PublishedHistoryItem {
  const record = row as Record<string, unknown>
  return {
    id: String(record.id),
    entity_id: String(record.entity_id),
    title: typeof record.title === 'string' ? record.title : null,
    angle: typeof record.angle === 'string' ? record.angle : null,
    summary: typeof record.summary === 'string' ? record.summary : null,
    content: typeof record.content === 'string' ? record.content : null,
    source: typeof record.source === 'string' ? record.source : null,
    source_area: typeof record.source_area === 'string' ? record.source_area : null,
    published_at: String(record.published_at ?? record.created_at),
  }
}

function isMissingPublishedHistoryTable(error: { code?: string, message?: string } | null): boolean {
  if (!error) return false
  const text = `${error.code ?? ''} ${error.message ?? ''}`.toLowerCase()
  return text.includes('42p01')
    || text.includes('42703')
    || text.includes('pgrst')
    || text.includes('could not find')
    || text.includes('does not exist')
}

async function fetchRecentMemories(
  db: SupabaseClient,
  limit: number
): Promise<EntityMemoryRecord[]> {
  const { data, error } = await db
    .from('entity_memories')
    .select(MEMORY_SELECT)
    .not('entity_id', 'is', null)
    .neq('memory_type', 'source_marker')
    .order('created_at', { ascending: false })
    .limit(limit)
  if (error) throw new Error(`editor draft memory fetch failed: ${error.message}`)
  return (data ?? []).map(normalizeMemory)
}

async function fetchEntities(db: SupabaseClient, entityIds: string[]): Promise<EntityRecord[]> {
  if (entityIds.length === 0) return []
  const { data, error } = await db
    .from('entities')
    .select(ENTITY_SELECT)
    .in('id', entityIds)
  if (error) throw new Error(`editor draft entity fetch failed: ${error.message}`)
  return (data ?? []).map(normalizeEntity)
}

async function fetchMemoriesForEntities(
  db: SupabaseClient,
  entityIds: string[],
  limit: number
): Promise<EntityMemoryRecord[]> {
  const rows = await Promise.all(entityIds.map(async (entityId) => {
    const { data, error } = await db
      .from('entity_memories')
      .select(MEMORY_SELECT)
      .eq('entity_id', entityId)
      .neq('memory_type', 'source_marker')
      .order('created_at', { ascending: false })
      .limit(limit)
    if (error) throw new Error(`editor draft lane fetch failed: ${error.message}`)
    return (data ?? []).map(normalizeMemory)
  }))
  return rows.flat()
}

async function fetchPublishedHistory(
  db: SupabaseClient,
  entityIds: string[],
  limit: number
): Promise<PublishedHistoryItem[]> {
  if (entityIds.length === 0 || limit <= 0) return []

  const rows: PublishedHistoryItem[] = []
  for (const entityId of entityIds) {
    const { data, error } = await db
      .from(ENTITY_PUBLISHED_HISTORY_TABLE)
      .select('id, entity_id, title, angle, summary, content, source, source_area, published_at, created_at')
      .eq('entity_id', entityId)
      .order('published_at', { ascending: false })
      .limit(limit)

    if (error) {
      // V1 only loads published history from an entity-addressable table. The
      // current feed table is not entity-addressable, so missing table/column
      // errors intentionally produce an empty history. This error-tolerance
      // is load-bearing - preserve it.
      if (isMissingPublishedHistoryTable(error)) return []
      throw new Error(`editor draft published history fetch failed: ${error.message}`)
    }
    rows.push(...(data ?? []).map(normalizePublishedHistory))
  }
  return rows
}

function unique(values: string[]): string[] {
  return [...new Set(values)]
}

// ---------------------------------------------------------------------------
// Local-store (PipelineStore) <-> editor-draft type mapping.
//
// editor_drafts moved off Supabase into PipelineStore's `pipeline_editor_drafts`
// table. Everything else fetchBundles reads (entities, entity_memories,
// entity_published_history) is durable product data and stays on Supabase.
// ---------------------------------------------------------------------------

function toPriorEditorDraft(row: {
  id: string
  entityId: string
  sourceMemoryIds: string[]
  sourceMemoryHash: string
  action: string
  status: string
  title: string | null
  angle: string | null
  summary: string | null
  reasoning: string
  reasonCodes: unknown
  createdAt: string
}): PriorEditorDraft {
  return {
    id: row.id,
    entity_id: row.entityId,
    source_memory_ids: row.sourceMemoryIds,
    source_memory_hash: row.sourceMemoryHash,
    action: row.action as PriorEditorDraft['action'],
    status: row.status as PriorEditorDraft['status'],
    title: row.title,
    angle: row.angle,
    summary: row.summary,
    reasoning: row.reasoning,
    reason_codes: asStringArray(row.reasonCodes),
    created_at: row.createdAt,
  }
}

function toEditorDraftRecord(row: {
  id: string
  entityId: string
  entitySlug: string
  entityName: string
  entityType: string
  bundleKey: string
  sourceMemoryIds: string[]
  sourceMemoryHash: string
  source: string | null
  sourceArea: string | null
  action: string
  status: string
  title: string | null
  angle: string | null
  summary: string | null
  body: string | null
  reasoning: string
  reasonCodes: unknown
  evidenceQuality: string | null
  priority: number | null
  confidence: number | null
  mergeTargetDraftId: string | null
  relatedDraftIds: unknown
  followUpQuestions: unknown
  researchInstructions: string | null
  backend: string
  model: string | null
  createdAt: string
  updatedAt: string
}): EditorDraftRecord {
  return {
    id: row.id,
    entity_id: row.entityId,
    entity_slug: row.entitySlug,
    entity_name: row.entityName,
    entity_type: row.entityType,
    bundle_key: row.bundleKey,
    source_memory_ids: row.sourceMemoryIds,
    source_memory_hash: row.sourceMemoryHash,
    source: row.source,
    source_area: row.sourceArea,
    action: row.action as EditorDraftAction,
    status: row.status as EditorDraftStatus,
    title: row.title,
    angle: row.angle,
    summary: row.summary,
    body: row.body,
    reasoning: row.reasoning,
    reason_codes: asStringArray(row.reasonCodes),
    evidence_quality: row.evidenceQuality as EvidenceQuality | null,
    priority: row.priority,
    confidence: row.confidence,
    merge_target_draft_id: row.mergeTargetDraftId,
    related_draft_ids: asStringArray(row.relatedDraftIds),
    follow_up_questions: asStringArray(row.followUpQuestions),
    research_instructions: row.researchInstructions,
    backend: row.backend,
    model: row.model,
    created_at: row.createdAt,
    updated_at: row.updatedAt,
  }
}

function toDraftUpsertInput(draft: EditorDraftInput): PipelineDraftUpsertInput {
  return {
    entityId: draft.entity_id,
    entitySlug: draft.entity_slug,
    entityName: draft.entity_name,
    entityType: draft.entity_type,
    bundleKey: draft.bundle_key,
    sourceMemoryIds: draft.source_memory_ids,
    sourceMemoryHash: draft.source_memory_hash,
    source: draft.source,
    sourceArea: draft.source_area,
    action: draft.action,
    status: draft.status,
    title: draft.title,
    angle: draft.angle,
    summary: draft.summary,
    body: draft.body,
    reasoning: draft.reasoning,
    reasonCodes: draft.reason_codes,
    evidenceQuality: draft.evidence_quality,
    priority: draft.priority,
    confidence: draft.confidence,
    mergeTargetDraftId: draft.merge_target_draft_id,
    relatedDraftIds: draft.related_draft_ids,
    followUpQuestions: draft.follow_up_questions,
    researchInstructions: draft.research_instructions,
    backend: draft.backend,
    model: draft.model,
  }
}

export class SupabaseEditorDraftStore implements EditorDraftStore {
  constructor(private readonly db: SupabaseClient, private readonly store: PipelineStore) {}

  async fetchBundles(options: FetchEditorDraftBundlesOptions): Promise<EntityDraftBundle[]> {
    const recentFetchLimit = Math.max(options.batchSize * options.recentMemoryLimit * 10, options.batchSize)
    const recentMemories = await fetchRecentMemories(this.db, recentFetchLimit)
    const recentReviewed = await this.store.findReviewedMemoryIds(recentMemories.map((memory) => memory.id))
    const eligibleEntityIds = unique(
      recentMemories
        .filter((memory) => memory.entity_id && !recentReviewed.has(memory.id))
        .map((memory) => memory.entity_id as string)
    ).slice(0, options.batchSize)

    if (eligibleEntityIds.length === 0) return []

    const [entities, laneMemories, priorDraftsByEntity, publishedHistory] = await Promise.all([
      fetchEntities(this.db, eligibleEntityIds),
      fetchMemoriesForEntities(this.db, eligibleEntityIds, options.laneMemoryLimit),
      this.store.fetchPriorDraftsByEntity(eligibleEntityIds, options.priorDraftLimit),
      fetchPublishedHistory(this.db, eligibleEntityIds, options.publishedHistoryLimit),
    ])
    const priorDrafts = eligibleEntityIds.flatMap((entityId) => priorDraftsByEntity.get(entityId) ?? [])
      .map(toPriorEditorDraft)
    const laneReviewed = await this.store.findReviewedMemoryIds(laneMemories.map((memory) => memory.id))

    return buildEntityDraftBundles(
      entities,
      laneMemories,
      priorDrafts,
      publishedHistory,
      {
        recentMemoryLimit: options.recentMemoryLimit,
        laneMemoryLimit: options.laneMemoryLimit,
        reviewedMemoryIds: laneReviewed,
      }
    ).slice(0, options.batchSize)
  }

  async upsertDrafts(drafts: EditorDraftInput[]): Promise<EditorDraftRecord[]> {
    if (drafts.length === 0) return []
    const rows = await this.store.upsertDraftsByBundleKey(drafts.map(toDraftUpsertInput))
    return rows.map(toEditorDraftRecord)
  }
}

export const __testing = {
  ENTITY_SELECT,
  normalizeEntity,
}
