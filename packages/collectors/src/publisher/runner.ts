import { envFlag, positiveInteger } from '../pipeline-store/cli-env'
import { deriveActionsFromMemories } from './actions'
import type {
  PublishedNarrativeInput,
  PublisherDraftRecord,
  PublisherEntityRecord,
  PublisherMemoryRecord,
  PublisherStore,
} from './types'

const DEFAULT_BATCH_SIZE = 10
const DEFAULT_INTERVAL_MS = 5 * 60 * 1000

export interface PublisherCliConfig {
  batchSize: number
  intervalMs: number
  runOnce: boolean
}

export interface RunPublisherOptions {
  now?: string
  batchSize?: number
  store: PublisherStore
  dryRun?: boolean
}

export interface PublisherRunResult {
  observedAt: string
  dryRun: boolean
  draftsFetched: number
  publicationsWritten: number
  publicationsExisting: number
  skipped: number
  publications: Array<{
    id: string | null
    editorDraftId: string
    entitySlug: string
    title: string
    actionCount: number
    existing: boolean
  }>
  skips: Array<{ editorDraftId: string, reason: string }>
}

function directString(record: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return null
}

export function publisherCliConfig(env: NodeJS.ProcessEnv = process.env): PublisherCliConfig {
  return {
    batchSize: positiveInteger(env.PUBLISHER_BATCH_SIZE, DEFAULT_BATCH_SIZE),
    intervalMs: positiveInteger(env.PUBLISHER_INTERVAL_MS, DEFAULT_INTERVAL_MS),
    runOnce: envFlag(env.PUBLISHER_RUN_ONCE),
  }
}

export function isEligibleDraft(draft: PublisherDraftRecord): boolean {
  return draft.action === 'draft_post'
    && draft.status === 'drafted'
    && Boolean(draft.title?.trim())
    && Boolean(draft.body?.trim())
}

export function entityCategory(entity: PublisherEntityRecord | null, draft: PublisherDraftRecord): string | null {
  const metadataCategory = entity
    ? directString(entity.metadata, ['category', 'entity_category', 'primary_category'])
    : null
  return metadataCategory ?? (draft.entity_type.trim() || null)
}

export function tagsForEntity(entity: PublisherEntityRecord | null): string[] {
  if (!entity) return []
  const metadataCategory = directString(entity.metadata, ['category', 'entity_category', 'primary_category'])
  return metadataCategory ? [metadataCategory] : []
}

export function buildPublication(
  draft: PublisherDraftRecord,
  entity: PublisherEntityRecord | null,
  memories: PublisherMemoryRecord[],
  observedAt: string
): PublishedNarrativeInput {
  if (!isEligibleDraft(draft)) {
    throw new Error(`draft ${draft.id} is not eligible for publishing`)
  }

  return {
    editor_draft_id: draft.id,
    title: draft.title?.trim() ?? '',
    content_small: draft.summary?.trim() ?? '',
    content_full: draft.body?.trim() ?? '',
    // Production's long-lived public feed column is integer-valued even
    // though newer draft storage accepts numeric scores. Normalize at the
    // publication boundary so a legacy fractional draft cannot crash-loop
    // the publisher.
    priority: Math.round(draft.priority ?? 0),
    actions: deriveActionsFromMemories(memories),
    tags: tagsForEntity(entity),
    status: 'published',
    published_at: observedAt,
    entity_id: draft.entity_id,
    entity_slug: draft.entity_slug,
    entity_name: draft.entity_name,
    entity_type: draft.entity_type,
    entity_category: entityCategory(entity, draft),
    source_memory_ids: draft.source_memory_ids,
    source_memory_hash: draft.source_memory_hash,
    source: draft.source,
    source_area: draft.source_area,
    angle: draft.angle,
    reasoning: draft.reasoning,
    evidence_quality: draft.evidence_quality,
    confidence: draft.confidence,
  }
}

export async function runPublisher(options: RunPublisherOptions): Promise<PublisherRunResult> {
  const observedAt = options.now ?? new Date().toISOString()
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE
  const dryRun = options.dryRun ?? false
  const drafts = await options.store.fetchEligibleDrafts(batchSize)
  const publications: PublisherRunResult['publications'] = []
  const skips: PublisherRunResult['skips'] = []

  for (const draft of drafts) {
    if (!isEligibleDraft(draft)) {
      skips.push({ editorDraftId: draft.id, reason: 'not_eligible' })
      continue
    }

    const [entity, memories] = await Promise.all([
      options.store.fetchEntity(draft.entity_id),
      options.store.fetchMemories(draft.source_memory_ids),
    ])
    const publication = buildPublication(draft, entity, memories, observedAt)

    if (dryRun) {
      publications.push({
        id: null,
        editorDraftId: draft.id,
        entitySlug: draft.entity_slug,
        title: publication.title,
        actionCount: publication.actions.length,
        existing: false,
      })
      continue
    }

    const written = await options.store.publishDraft(publication)
    publications.push({
      id: written.narrative.id,
      editorDraftId: draft.id,
      entitySlug: draft.entity_slug,
      title: publication.title,
      actionCount: publication.actions.length,
      existing: written.existing,
    })
  }

  return {
    observedAt,
    dryRun,
    draftsFetched: drafts.length,
    publicationsWritten: publications.filter((item) => item.id && !item.existing).length,
    publicationsExisting: publications.filter((item) => item.id && item.existing).length,
    skipped: skips.length,
    publications,
    skips,
  }
}
