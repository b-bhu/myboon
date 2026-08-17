import type {
  EntityMemoryCandidate,
  EntityMemoryExtraction,
  EntityMemoryType,
  PrimaryEntityCandidate,
  ResearchPacket,
  StoryReconciliationAction,
  StoryReconciliationCandidate,
} from './types'

const ALLOWED_MEMORY_TYPES = new Set<EntityMemoryType>([
  'research_note',
  'market_signal',
  'news_event',
  'social_signal',
  'timeline_event',
  'metric_change',
  'source_marker',
])

export function slugify(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/['"]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return slug || 'unknown'
}

export function normalizeSlug(value: unknown, fallback: string): string {
  return slugify(typeof value === 'string' && value.trim() ? value : fallback)
}

export function compactString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : fallback
}

function uniqueStrings(values: unknown[]): string[] {
  const seen = new Set<string>()
  const output: string[] = []
  for (const value of values) {
    const text = compactString(value)
    const key = text.toLowerCase()
    if (!text || seen.has(key)) continue
    seen.add(key)
    output.push(text)
  }
  return output
}

function recordOrEmpty(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function arrayOrEmpty(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function booleanOrDefault(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback
}

function numberOrNull(value: unknown): number | null {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN
  return Number.isFinite(parsed) ? Math.max(0, Math.min(1, parsed)) : null
}

function normalizePrimaryEntity(value: unknown): PrimaryEntityCandidate | null {
  const record = recordOrEmpty(value)
  const name = compactString(record.name)
  if (!name) return null
  const aliases = uniqueStrings([...(Array.isArray(record.aliases) ? record.aliases : []), name])
  return {
    name,
    type: compactString(record.type, 'unknown'),
    slug: normalizeSlug(record.slug, name),
    aliases,
    summary: compactString(record.summary),
    createIfMissing: booleanOrDefault(record.createIfMissing ?? record.create_if_missing, true),
    createReason: compactString(record.createReason ?? record.create_reason),
    metadata: recordOrEmpty(record.metadata),
  }
}

function normalizeMemoryType(value: unknown, packet: ResearchPacket): EntityMemoryType {
  // A social source must stay a social signal even if extraction returns an
  // allowed but semantically wrong news_event value.
  if (packet.sourceType === 'social_post') return 'social_signal'
  const text = compactString(value)
  if (ALLOWED_MEMORY_TYPES.has(text as EntityMemoryType)) return text as EntityMemoryType
  if (packet.sourceType === 'market_signal') return 'market_signal'
  if (packet.sourceType === 'article') return 'news_event'
  return 'research_note'
}

const STORY_RECONCILIATION_ACTIONS = new Set<StoryReconciliationAction>([
  'new_story',
  'update_existing_story',
  'duplicate_source',
])

function normalizeReconciliation(value: unknown): StoryReconciliationCandidate {
  const record = recordOrEmpty(value)
  const requestedAction = compactString(record.action)
  const action = STORY_RECONCILIATION_ACTIONS.has(requestedAction as StoryReconciliationAction)
    ? requestedAction as StoryReconciliationAction
    : 'new_story'
  return {
    action,
    existingMemoryId: action === 'new_story'
      ? null
      : compactString(record.existingMemoryId ?? record.existing_memory_id) || null,
    confidence: numberOrNull(record.confidence) ?? undefined,
    reason: compactString(record.reason),
  }
}

function normalizeMemory(value: unknown, packet: ResearchPacket): EntityMemoryCandidate | null {
  const record = recordOrEmpty(value)
  const entitySlug = normalizeSlug(record.entitySlug ?? record.entity_slug, '')
  const title = compactString(record.title)
  const summary = compactString(record.summary)
  if (!entitySlug || !title || !summary) return null
  return {
    entitySlug,
    memoryType: normalizeMemoryType(record.memoryType ?? record.memory_type ?? record.itemType ?? record.item_type, packet),
    title,
    summary,
    body: compactString(record.body),
    eventAt: compactString(record.eventAt ?? record.event_at) || packet.eventAt || packet.observedAt,
    observedAt: compactString(record.observedAt ?? record.observed_at, packet.observedAt),
    confidence: numberOrNull(record.confidence) ?? undefined,
    evidence: arrayOrEmpty(record.evidence),
    mentions: uniqueStrings(arrayOrEmpty(record.mentions ?? record.related_mentions)),
    metrics: recordOrEmpty(record.metrics),
    context: recordOrEmpty(record.context),
    reconciliation: normalizeReconciliation(record.reconciliation),
  }
}

export function normalizeExtraction(value: unknown, packet: ResearchPacket): EntityMemoryExtraction {
  const record = recordOrEmpty(value)
  const rawEntities = record.primaryEntities ?? record.primary_entities ?? record.entities
  const primaryEntities = arrayOrEmpty(rawEntities)
    .map(normalizePrimaryEntity)
    .filter((entity): entity is PrimaryEntityCandidate => Boolean(entity))
    .slice(0, 3)
  const validEntitySlugs = new Set(primaryEntities.map((entity) => normalizeSlug(entity.slug, entity.name)))
  const rawMemories = record.memories ?? record.memoryItems ?? record.memory_items
  const memories = arrayOrEmpty(rawMemories)
    .map((item) => normalizeMemory(item, packet))
    .filter((item): item is EntityMemoryCandidate => Boolean(item))
    .filter((item) => validEntitySlugs.has(item.entitySlug))

  return { primaryEntities, memories }
}
