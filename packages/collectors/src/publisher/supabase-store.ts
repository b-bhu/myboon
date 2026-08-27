import type { SupabaseClient } from '@supabase/supabase-js'
import type { PipelineStore } from '../pipeline-store/store'
import {
  ENTITY_KNOWLEDGE_MAX_PAGE_SIZE,
} from '../entity-manager/entity-knowledge-reader'
import type {
  EntityKnowledgeMemoryV1,
  EntityKnowledgeReader,
} from '../entity-manager/entity-knowledge-reader'
import type {
  PublishedNarrativeInput,
  PublishedNarrativeRecord,
  PublisherDraftRecord,
  PublisherEntityRecord,
  PublisherMemoryRecord,
  PublisherStore,
  PublisherWriteResult,
} from './types'

const ENTITY_SELECT = 'id, slug, name, type, metadata'
const NARRATIVE_SELECT = 'id, editor_draft_id, created_at, published_at'
const MAX_MEMORY_HYDRATION_REQUESTS = 10

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function nullableString(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

function nullableNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string') {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

function normalizeMemory(memory: EntityKnowledgeMemoryV1): PublisherMemoryRecord {
  return {
    id: memory.id,
    source: memory.provenance.provider,
    source_area: memory.provenance.sourceArea,
    source_type: memory.provenance.sourceType,
    source_ref_id: memory.provenance.sourceRefId,
    source_research_id: memory.provenance.researchPacketId,
    title: memory.title,
    summary: memory.summary,
    evidence: memory.evidence,
    context: memory.context,
  }
}

function normalizeEntity(row: unknown): PublisherEntityRecord {
  const record = row as Record<string, unknown>
  return {
    id: String(record.id),
    slug: String(record.slug),
    name: String(record.name),
    type: String(record.type),
    metadata: asRecord(record.metadata),
  }
}

function normalizeNarrative(row: unknown): PublishedNarrativeRecord {
  const record = row as Record<string, unknown>
  return {
    id: String(record.id),
    editor_draft_id: nullableString(record.editor_draft_id),
    created_at: nullableString(record.created_at) ?? undefined,
    published_at: nullableString(record.published_at) ?? undefined,
  }
}

function isUniqueViolation(error: { code?: string, message?: string } | null): boolean {
  if (!error) return false
  return error.code === '23505' || /duplicate key|unique/i.test(error.message ?? '')
}

/**
 * `PublisherStore` implementation for the post-migration split:
 * `published_narratives` and `entity_published_history` stay on Supabase
 * (durable product data); `editor_drafts` now lives in the local
 * `PipelineStore` (pipeline scratch state).
 *
 * `publishDraft` therefore writes across two systems with no shared
 * transaction. See the reconciliation contract on `publishDraft` below for
 * how that inconsistency window is bounded and recovered from.
 */
export class SupabasePublisherStore implements PublisherStore {
  constructor(
    private readonly db: SupabaseClient,
    private readonly store: PipelineStore,
    private readonly knowledgeReader: Pick<EntityKnowledgeReader, 'getEntityMemoriesByIds'>,
  ) {}

  async fetchEligibleDrafts(batchSize: number): Promise<PublisherDraftRecord[]> {
    const rows = await this.store.fetchEligibleDrafts({
      action: 'draft_post',
      status: 'drafted',
      limit: batchSize,
    })
    return rows
      .filter((row) => Boolean(row.title) && Boolean(row.body))
      .map((row) => ({
        id: row.id,
        entity_id: row.entityId,
        entity_slug: row.entitySlug,
        entity_name: row.entityName,
        entity_type: row.entityType,
        source_memory_ids: row.sourceMemoryIds,
        source_memory_hash: row.sourceMemoryHash,
        source: row.source,
        source_area: row.sourceArea,
        action: row.action,
        status: row.status as PublisherDraftRecord['status'],
        title: row.title,
        angle: row.angle,
        summary: row.summary,
        body: row.body,
        reasoning: row.reasoning,
        evidence_quality: row.evidenceQuality,
        priority: row.priority,
        confidence: row.confidence,
        created_at: row.createdAt,
        updated_at: row.updatedAt,
      }))
  }

  async fetchMemories(memoryIds: string[]): Promise<PublisherMemoryRecord[]> {
    if (memoryIds.length === 0) return []
    const uniqueIds = [...new Set(memoryIds)]
    if (Math.ceil(uniqueIds.length / ENTITY_KNOWLEDGE_MAX_PAGE_SIZE) > MAX_MEMORY_HYDRATION_REQUESTS) {
      throw new Error(`publisher memory fetch exceeds ${MAX_MEMORY_HYDRATION_REQUESTS} bounded knowledge requests`)
    }
    const hydrated: EntityKnowledgeMemoryV1[] = []
    try {
      for (let offset = 0; offset < uniqueIds.length; offset += ENTITY_KNOWLEDGE_MAX_PAGE_SIZE) {
        const chunk = uniqueIds.slice(offset, offset + ENTITY_KNOWLEDGE_MAX_PAGE_SIZE)
        hydrated.push(...await this.knowledgeReader.getEntityMemoriesByIds({
          memoryIds: chunk,
          limit: chunk.length,
        }))
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : 'unknown error'
      throw new Error(`publisher memory fetch failed: ${detail}`, { cause: error })
    }
    const byId = new Map(hydrated.map((memory) => [memory.id, memory]))
    return uniqueIds.flatMap((id) => {
      const memory = byId.get(id)
      return memory ? [normalizeMemory(memory)] : []
    })
  }

  async fetchEntity(entityId: string): Promise<PublisherEntityRecord | null> {
    const { data, error } = await this.db
      .from('entities')
      .select(ENTITY_SELECT)
      .eq('id', entityId)
      .maybeSingle()

    if (error) throw new Error(`publisher entity fetch failed: ${error.message}`)
    return data ? normalizeEntity(data) : null
  }

  /**
   * Publishes a draft: writes the public narrative to Supabase, then
   * reconciles the local draft's status.
   *
   * Supabase is the source of truth for "was this published" - the narrative
   * row is what the product actually reads. The local `editor_drafts.status`
   * flip is a SEPARATE, non-transactional write that only exists so this
   * stage does not re-offer an already-published draft to the publisher
   * agent next run. Order matters and is deliberate:
   *
   *   1. write the Supabase narrative (source of truth)
   *   2. write entity_published_history (Supabase, same durable side)
   *   3. mark the local draft published (bookkeeping only)
   *
   * If step 3 fails or the process dies between 1/2 and 3, the narrative
   * already exists and is not lost or duplicated - that is an acceptable,
   * recoverable state, not a bug. The recovery path is this method itself:
   * on the NEXT run, before doing any agent/publish work, it checks
   * `findPublishedNarrative(editor_draft_id)` FIRST. If a narrative already
   * exists, this method treats the draft as already published, skips writing
   * a duplicate narrative and duplicate history row, and only reconciles the
   * local draft status to 'published' - making the whole operation idempotent
   * across crashes and re-runs. The existing 23505 unique-violation catch
   * below is the same idea applied to a race between two concurrent
   * publisher runs instead of a crash-and-retry.
   */
  async publishDraft(publication: PublishedNarrativeInput): Promise<PublisherWriteResult> {
    const existing = await this.findPublishedNarrative(publication.editor_draft_id)
    if (existing) {
      await this.ensureHistory(existing.id, publication)
      await this.markDraftPublished(publication.editor_draft_id, publication.published_at)
      return { narrative: existing, existing: true }
    }

    const payload = {
      title: publication.title,
      content_small: publication.content_small,
      content_full: publication.content_full,
      tags: publication.tags,
      priority: publication.priority,
      actions: publication.actions,
      status: publication.status,
      published_at: publication.published_at,
      editor_draft_id: publication.editor_draft_id,
      entity_id: publication.entity_id,
      entity_slug: publication.entity_slug,
      entity_name: publication.entity_name,
      entity_type: publication.entity_type,
      entity_category: publication.entity_category,
      source_memory_ids: publication.source_memory_ids,
      source_memory_hash: publication.source_memory_hash,
      source: publication.source,
      area: publication.source_area,
      source_area: publication.source_area,
      angle: publication.angle,
      reasoning: publication.reasoning,
      evidence_quality: publication.evidence_quality,
      confidence: publication.confidence,
    }

    const { data, error } = await this.db
      .from('published_narratives')
      .insert(payload)
      .select(NARRATIVE_SELECT)
      .single()

    if (error) {
      if (isUniqueViolation(error)) {
        const racedExisting = await this.findPublishedNarrative(publication.editor_draft_id)
        if (racedExisting) {
          await this.ensureHistory(racedExisting.id, publication)
          await this.markDraftPublished(publication.editor_draft_id, publication.published_at)
          return { narrative: racedExisting, existing: true }
        }
      }
      throw new Error(`publisher narrative insert failed: ${error.message}`)
    }

    const narrative = normalizeNarrative(data)
    await this.ensureHistory(narrative.id, publication)
    await this.markDraftPublished(publication.editor_draft_id, publication.published_at)
    return { narrative, existing: false }
  }

  private async findPublishedNarrative(editorDraftId: string): Promise<PublishedNarrativeRecord | null> {
    const { data, error } = await this.db
      .from('published_narratives')
      .select(NARRATIVE_SELECT)
      .eq('editor_draft_id', editorDraftId)
      .maybeSingle()

    if (error) throw new Error(`publisher existing narrative lookup failed: ${error.message}`)
    return data ? normalizeNarrative(data) : null
  }

  private async ensureHistory(narrativeId: string, publication: PublishedNarrativeInput): Promise<void> {
    const { error } = await this.db
      .from('entity_published_history')
      .upsert({
        published_narrative_id: narrativeId,
        entity_id: publication.entity_id,
        entity_slug: publication.entity_slug,
        title: publication.title,
        angle: publication.angle,
        summary: publication.content_small,
        content: publication.content_full,
        source: publication.source,
        source_area: publication.source_area,
        published_at: publication.published_at,
      }, { onConflict: 'published_narrative_id' })

    if (error) throw new Error(`publisher history upsert failed: ${error.message}`)
  }

  /**
   * Idempotent local bookkeeping write: marks the local draft published.
   * Safe to call repeatedly (setDraftPublished is a plain status write, not
   * an insert) and safe to skip on failure - see the reconciliation contract
   * on publishDraft above.
   */
  private async markDraftPublished(editorDraftId: string, observedAt: string): Promise<void> {
    await this.store.setDraftPublished(editorDraftId, observedAt)
  }
}
