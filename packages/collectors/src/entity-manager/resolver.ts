import {
  isBannedEntitySlug,
  isNearDuplicate,
  nearestEntities,
  normalizeEntityType,
  shortlistForPacket,
  toCanonEntity,
  type CanonEntity,
  type RecentEntityMemory,
} from './canon'
import { normalizeSlug } from './normalization'
import type {
  EntityInput,
  EntityMemoryInput,
  EntityMemoryRecord,
  EntityMemoryStore,
  ExtractionProvider,
  EntityMemoryCandidate,
  PrimaryEntityCandidate,
  ResearchPacket,
  ResolvedEntity,
  StoryReconciliationCandidate,
  WriteExtractionResult,
} from './types'

/**
 * Polymarket runs many simultaneous strike-price/threshold markets on the
 * same underlying asset (e.g. a WTI crude oil "options chain" of $60/$80/$90
 * markets). Each one resolves to the same durable entity, and — left
 * unchecked — each odds wiggle on each strike becomes its own permanent
 * `market_signal` memory, so one volatile day produces dozens of
 * near-identical "something happened" rows on one entity (confirmed against
 * production data: 35+ rows on `crude-oil-wti` in a 1000-row sample).
 *
 * This window controls how long a `market_signal` memory for a Polymarket
 * entity "absorbs" further same-day signals by updating in place, rather than
 * every research packet inserting a new row. Naturally noisier categories get
 * a shorter window so genuinely fast-moving stories aren't over-suppressed;
 * everything else defaults to the wider window. Tag comes from the market's
 * own Gamma API tag (`packet.context.candidate.tag_slug`), already threaded
 * through by `polymarketResearchToPacket` — not a separate per-entity config.
 */
const POLYMARKET_CONSOLIDATION_WINDOW_HOURS: Record<string, number> = {
  crypto: 12,
  commodities: 12,
  geopolitics: 12,
}
const POLYMARKET_DEFAULT_CONSOLIDATION_WINDOW_HOURS = 24
const NEWS_STORY_RECONCILIATION_WINDOW_HOURS = 48
const NEWS_STORY_RECONCILIATION_LIMIT = 30
const NEWS_STORY_RECONCILIATION_MIN_CONFIDENCE = 0.8

function polymarketConsolidationWindowHours(packet: ResearchPacket): number {
  const context = packet.context as { candidate?: { tag_slug?: string | null } } | undefined
  const tagSlug = context?.candidate?.tag_slug
  if (typeof tagSlug === 'string' && tagSlug in POLYMARKET_CONSOLIDATION_WINDOW_HOURS) {
    return POLYMARKET_CONSOLIDATION_WINDOW_HOURS[tagSlug]
  }
  return POLYMARKET_DEFAULT_CONSOLIDATION_WINDOW_HOURS
}

function mergeUnique(existing: unknown[], incoming: unknown[]): unknown[] {
  const seen = new Set(existing.map((item) => JSON.stringify(item)))
  const merged = [...existing]
  for (const item of incoming) {
    const key = JSON.stringify(item)
    if (seen.has(key)) continue
    seen.add(key)
    merged.push(item)
  }
  return merged
}

/**
 * Fold a new market_signal memory into an existing recent one for the same
 * entity instead of inserting a new row: bump freshness, merge evidence and
 * mentions, and keep a running count of absorbed observations in context so
 * the "one live row" isn't indistinguishable from a single one-off signal.
 */
function consolidatedMemoryPatch(previous: EntityMemoryRecord, incoming: EntityMemoryInput) {
  const previousObservationCount = typeof previous.context?.consolidated_observation_count === 'number'
    ? previous.context.consolidated_observation_count
    : 1
  return {
    observed_at: incoming.observed_at,
    event_at: incoming.event_at ?? previous.event_at,
    summary: incoming.summary,
    body: incoming.body ?? previous.body,
    confidence: incoming.confidence ?? previous.confidence,
    evidence: mergeUnique(previous.evidence, incoming.evidence),
    mentions: mergeUnique(previous.mentions, incoming.mentions).filter((item): item is string => typeof item === 'string'),
    metrics: { ...previous.metrics, ...incoming.metrics },
    context: {
      ...previous.context,
      ...incoming.context,
      consolidated_observation_count: previousObservationCount + 1,
      consolidated_source_research_ids: mergeUnique(
        Array.isArray(previous.context?.consolidated_source_research_ids)
          ? previous.context.consolidated_source_research_ids
          : [previous.source_research_id],
        [incoming.source_research_id],
      ),
      last_consolidated_at: incoming.observed_at,
    },
  }
}

function maximumConfidence(left: number | null, right: number | null): number | null {
  if (left === null) return right
  if (right === null) return left
  return Math.max(left, right)
}

function storySource(
  memory: EntityMemoryRecord | EntityMemoryInput,
  action: 'original' | 'update_existing_story' | 'duplicate_source',
): Record<string, unknown> {
  const sourceTitle = typeof memory.context.source_title === 'string'
    ? memory.context.source_title
    : memory.title
  const sourceUrl = typeof memory.context.source_url === 'string'
    ? memory.context.source_url
    : null
  const imageUrl = typeof memory.context.image_url === 'string'
    ? memory.context.image_url
    : null
  return {
    source: memory.source,
    source_area: memory.source_area,
    source_type: memory.source_type,
    source_ref_id: memory.source_ref_id,
    source_research_id: memory.source_research_id,
    title: sourceTitle,
    url: sourceUrl,
    image_url: imageUrl,
    observed_at: memory.observed_at,
    reconciliation_action: action,
  }
}

function storyImageContext(
  previous: Record<string, unknown>,
  incoming: Record<string, unknown>,
  preferIncoming: boolean,
): Record<string, unknown> {
  const previousUrl = typeof previous.image_url === 'string' && previous.image_url
    ? previous.image_url
    : null
  const incomingUrl = typeof incoming.image_url === 'string' && incoming.image_url
    ? incoming.image_url
    : null
  const shouldUseIncoming = Boolean(incomingUrl && (
    preferIncoming
    || !previousUrl
    || (previous.image_kind === 'source_avatar' && incoming.image_kind === 'content')
  ))
  const selected = shouldUseIncoming ? incoming : previous
  const selectedUrl = shouldUseIncoming ? incomingUrl : previousUrl
  if (!selectedUrl) return { image_url: null }
  const output: Record<string, unknown> = { image_url: selectedUrl }
  for (const key of ['image_kind', 'image_origin', 'image_attribution']) {
    if (selected[key] !== undefined) output[key] = selected[key]
  }
  return output
}

function storyReconciliationPatch(
  previous: EntityMemoryRecord,
  incoming: EntityMemoryInput,
  reconciliation: StoryReconciliationCandidate,
) {
  const action = reconciliation.action === 'update_existing_story'
    ? 'update_existing_story'
    : 'duplicate_source'
  const previousSources = Array.isArray(previous.context.story_sources)
    ? previous.context.story_sources
    : [storySource(previous, 'original')]
  const sources = mergeUnique(previousSources, [storySource(incoming, action)]).slice(-50)
  const previousHistory = Array.isArray(previous.context.reconciliation_history)
    ? previous.context.reconciliation_history
    : []
  const history = mergeUnique(previousHistory, [{
    action,
    source_research_id: incoming.source_research_id,
    observed_at: incoming.observed_at,
    confidence: reconciliation.confidence ?? null,
    reason: reconciliation.reason?.trim() || null,
  }]).slice(-50)
  const isUpdate = action === 'update_existing_story'

  return {
    observed_at: incoming.observed_at,
    event_at: isUpdate ? incoming.event_at ?? previous.event_at : previous.event_at,
    summary: isUpdate ? incoming.summary : previous.summary,
    body: isUpdate ? incoming.body ?? previous.body : previous.body,
    confidence: maximumConfidence(previous.confidence, incoming.confidence),
    evidence: mergeUnique(previous.evidence, incoming.evidence),
    mentions: mergeUnique(previous.mentions, incoming.mentions).filter((item): item is string => typeof item === 'string'),
    metrics: { ...previous.metrics, ...incoming.metrics },
    context: {
      ...previous.context,
      ...(isUpdate ? incoming.context : {}),
      // A later source with no image must not erase a usable earlier image.
      // Updates may promote a new image; duplicates only promote one when the
      // existing story has none (or only an avatar and the new source has
      // content media). Every source image is still retained in story_sources.
      ...storyImageContext(previous.context, incoming.context, isUpdate),
      story_sources: sources,
      story_source_count: sources.length,
      story_source_research_ids: mergeUnique(
        Array.isArray(previous.context.story_source_research_ids)
          ? previous.context.story_source_research_ids
          : [previous.source_research_id],
        [incoming.source_research_id],
      ).slice(-50),
      last_story_reconciliation: action,
      last_story_update_at: incoming.observed_at,
      reconciliation_history: history,
    },
  }
}

function unique(values: string[]): string[] {
  const seen = new Set<string>()
  const output: string[] = []
  for (const value of values) {
    const text = value.trim()
    const key = text.toLowerCase()
    if (!text || seen.has(key)) continue
    seen.add(key)
    output.push(text)
  }
  return output
}

function entitySlug(candidate: PrimaryEntityCandidate): string {
  return normalizeSlug(candidate.slug, candidate.name)
}

function aliasesFor(candidate: PrimaryEntityCandidate): string[] {
  return unique([candidate.name, ...(candidate.aliases ?? [])])
}

function entityInput(candidate: PrimaryEntityCandidate): EntityInput {
  return {
    slug: entitySlug(candidate),
    name: candidate.name.trim(),
    // Fixed vocabulary at creation time (see canon.ts): the historical
    // free-formed type zoo (`nation` next to `country`, one-off `index`,
    // `legislation`, ...) stops growing here.
    type: normalizeEntityType(candidate.type),
    aliases: aliasesFor(candidate),
    summary: candidate.summary?.trim() || null,
    status: 'active',
    metadata: {
      ...(candidate.metadata ?? {}),
      create_reason: candidate.createReason || undefined,
    },
  }
}

function httpImageUrl(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null
  try {
    const parsed = new URL(value.trim())
    return parsed.protocol === 'http:' || parsed.protocol === 'https:'
      ? parsed.toString()
      : null
  } catch {
    return null
  }
}

function packetImageContext(packet: ResearchPacket): Record<string, unknown> {
  // Images are source facts, not extraction output. For news packets, copy the
  // upstream URL into every entity-bound memory after extraction so Hermes
  // cannot accidentally drop or replace it. The existing JSONB context keeps
  // this durable without changing the entity_memories schema.
  if (packet.source !== 'news') return {}

  const imageUrl = httpImageUrl(packet.context.image_url)
  if (!imageUrl) return { image_url: null }

  const parsed = new URL(imageUrl)
  const imageKind = parsed.pathname.includes('/profile_images/')
    ? 'source_avatar'
    : 'content'
  const attribution = typeof packet.context.upstream_source_name === 'string'
    && packet.context.upstream_source_name.trim()
    ? packet.context.upstream_source_name.trim()
    : null

  return {
    image_url: imageUrl,
    image_kind: imageKind,
    image_origin: typeof packet.context.provider_id === 'string' && packet.context.provider_id.trim()
      ? packet.context.provider_id.trim()
      : packet.sourceArea,
    image_attribution: attribution,
  }
}

function recentMemoryForPrompt(
  memory: EntityMemoryRecord,
  entity: CanonEntity,
): RecentEntityMemory {
  return {
    id: memory.id,
    entityId: entity.id,
    entitySlug: entity.slug,
    entityName: entity.name,
    memoryType: memory.memory_type,
    title: memory.title.slice(0, 240),
    summary: memory.summary.slice(0, 700),
    eventAt: memory.event_at,
    observedAt: memory.observed_at,
    source: memory.source,
    sourceUrl: typeof memory.context.source_url === 'string'
      ? memory.context.source_url.slice(0, 1_000)
      : null,
  }
}

async function loadRecentNewsMemories(
  store: EntityMemoryStore,
  packet: ResearchPacket,
  shortlist: CanonEntity[],
): Promise<EntityMemoryRecord[]> {
  if (packet.source !== 'news' || shortlist.length === 0) return []
  const until = Date.parse(packet.observedAt)
  if (!Number.isFinite(until)) return []
  const sinceIso = new Date(until - NEWS_STORY_RECONCILIATION_WINDOW_HOURS * 3_600_000).toISOString()
  try {
    return await store.listRecentMemories(
      shortlist.map((entity) => entity.id),
      sinceIso,
      new Date(until).toISOString(),
      NEWS_STORY_RECONCILIATION_LIMIT,
      'news',
    )
  } catch {
    // Recent memory improves filing, but a read failure must not block the
    // existing news pipeline. Invalid/absent context simply means new_story.
    return []
  }
}

function aliasesIntersect(left: string[], right: string[]): boolean {
  const rightSet = new Set(right.map((item) => item.toLowerCase()))
  return left.some((item) => rightSet.has(item.toLowerCase()))
}

function findMatchingEntity(
  candidate: PrimaryEntityCandidate,
  existing: Awaited<ReturnType<EntityMemoryStore['findEntities']>>[number][]
): Awaited<ReturnType<EntityMemoryStore['findEntities']>>[number] | null {
  const slug = entitySlug(candidate)
  const aliases = aliasesFor(candidate)
  return existing.find((entity) => entity.slug === slug || aliasesIntersect(entity.aliases ?? [], aliases)) ?? null
}

async function resolvePrimaryEntities(
  store: EntityMemoryStore,
  candidates: PrimaryEntityCandidate[],
  catalog: CanonEntity[] = []
): Promise<ResolvedEntity[]> {
  const deduped = new Map<string, PrimaryEntityCandidate>()
  for (const candidate of candidates.slice(0, 3)) {
    if (!candidate.name.trim()) continue
    // Source objects (the platforms we collect FROM) are never entities -
    // the extraction prompt forbids it and production data shows it happened
    // anyway ('polymarket' accumulated 8 memories). Hard-dropped here.
    if (isBannedEntitySlug(entitySlug(candidate))) continue
    deduped.set(entitySlug(candidate), candidate)
  }
  const inputs = [...deduped.values()]
  if (inputs.length === 0) return []

  const slugs = inputs.map(entitySlug)
  const aliases = inputs.flatMap(aliasesFor)
  const existing = await store.findEntities(slugs, aliases)
  const resolved: ResolvedEntity[] = []
  const toCreate: EntityInput[] = []
  const createCandidates: PrimaryEntityCandidate[] = []

  const resolveAsMatch = async (candidate: PrimaryEntityCandidate, match: Awaited<ReturnType<EntityMemoryStore['findEntities']>>[number]) => {
    const mergedAliases = unique([...(match.aliases ?? []), ...aliasesFor(candidate)])
    const nextMetadata = { ...(match.metadata ?? {}), ...(candidate.metadata ?? {}) }
    const needsUpdate = mergedAliases.length !== (match.aliases ?? []).length
      || (!match.summary && candidate.summary)
      || JSON.stringify(nextMetadata) !== JSON.stringify(match.metadata ?? {})
    const entity = needsUpdate
      ? await store.updateEntity({
        ...match,
        aliases: mergedAliases,
        summary: match.summary || candidate.summary || null,
        metadata: nextMetadata,
      })
      : match
    resolved.push({ candidate, entity, created: false })
  }

  for (const candidate of inputs) {
    const match = findMatchingEntity(candidate, existing)
    if (match) {
      await resolveAsMatch(candidate, match)
      continue
    }
    if (candidate.createIfMissing === false) continue

    // Deterministic near-duplicate guardrail (see canon.ts): a proposed NEW
    // entity that is a granular variant of an existing entity gets snapped
    // onto it instead of created - the mechanical backstop behind the
    // registrar reflection, and the direct kill for a fifth
    // 'china-taiwan-*' or an 'nvidia-h100' next to 'nvidia'. The top FIVE
    // nearest are checked, not just rank one: Jaccard ranks by overall
    // token overlap, so a high-overlap NON-duplicate can outrank the true
    // duplicate sitting at rank two (PR review finding) - the same width
    // the registrar reflection already looks at.
    const candidateShape = { slug: entitySlug(candidate), name: candidate.name, aliases: candidate.aliases }
    const nearDup = nearestEntities(catalog, candidateShape, 5)
      .find((nearest) => isNearDuplicate(candidateShape, nearest))
    if (nearDup) {
      const [snapTarget] = await store.findEntities([nearDup.slug], [nearDup.name])
      if (snapTarget) {
        await resolveAsMatch(candidate, snapTarget)
        continue
      }
    }

    toCreate.push(entityInput(candidate))
    createCandidates.push(candidate)
  }

  const created = await store.createEntities(toCreate)
  for (let index = 0; index < created.length; index += 1) {
    resolved.push({ candidate: createCandidates[index], entity: created[index], created: true })
  }
  return resolved
}

function memoryInput(packet: ResearchPacket, memory: EntityMemoryCandidate, entityId: string): EntityMemoryInput {
  return {
    entity_id: entityId,
    source: packet.source,
    source_area: packet.sourceArea,
    source_type: packet.sourceType,
    source_ref_id: packet.sourceRefId,
    source_research_id: packet.sourceResearchId,
    memory_type: memory.memoryType,
    title: memory.title.trim(),
    summary: memory.summary.trim(),
    body: memory.body?.trim() || null,
    event_at: memory.eventAt || packet.eventAt || packet.observedAt,
    observed_at: memory.observedAt || packet.observedAt,
    confidence: memory.confidence ?? null,
    evidence: memory.evidence ?? packet.evidence,
    mentions: unique(memory.mentions ?? []),
    metrics: { ...packet.metrics, ...(memory.metrics ?? {}) },
    context: {
      ...(memory.context ?? {}),
      source_title: packet.title,
      source_url: packet.url ?? null,
      ...packetImageContext(packet),
    },
  }
}

/**
 * For Polymarket market_signal memories only: fold a new observation into a
 * recent existing memory for the same entity (per
 * POLYMARKET_CONSOLIDATION_WINDOW_HOURS) instead of always inserting a new
 * row. Returns the memories that still need the normal insert path, plus a
 * count of how many were absorbed in place.
 */
async function consolidatePolymarketMarketSignals(
  store: EntityMemoryStore,
  packet: ResearchPacket,
  memoryInputs: EntityMemoryInput[],
): Promise<{ remaining: EntityMemoryInput[]; consolidated: number }> {
  if (packet.source !== 'polymarket') return { remaining: memoryInputs, consolidated: 0 }

  const windowHours = polymarketConsolidationWindowHours(packet)
  const sinceIso = new Date(Date.parse(packet.observedAt) - windowHours * 3_600_000).toISOString()
  const remaining: EntityMemoryInput[] = []
  let consolidated = 0

  for (const memory of memoryInputs) {
    if (memory.memory_type !== 'market_signal' || !memory.entity_id) {
      remaining.push(memory)
      continue
    }
    const previous = await store.findLatestMemorySince(memory.entity_id, 'market_signal', sinceIso)
    if (previous) {
      await store.updateMemory(previous.id, consolidatedMemoryPatch(previous, memory))
      consolidated += 1
      continue
    }
    remaining.push(memory)
  }

  return { remaining, consolidated }
}

interface PreparedMemory {
  input: EntityMemoryInput
  reconciliation?: StoryReconciliationCandidate
}

async function reconcileNewsStoryMemories(
  store: EntityMemoryStore,
  packet: ResearchPacket,
  memories: PreparedMemory[],
  recentMemories: EntityMemoryRecord[],
): Promise<{ remaining: EntityMemoryInput[]; consolidated: number }> {
  if (packet.source !== 'news' || recentMemories.length === 0) {
    return { remaining: memories.map((memory) => memory.input), consolidated: 0 }
  }

  const recentById = new Map(recentMemories.map((memory) => [memory.id, memory]))
  const remaining: EntityMemoryInput[] = []
  let consolidated = 0

  for (const memory of memories) {
    const reconciliation = memory.reconciliation
    const targetId = reconciliation?.existingMemoryId
    const target = typeof targetId === 'string' ? recentById.get(targetId) : undefined
    const actionCanMerge = reconciliation?.action === 'duplicate_source'
      || reconciliation?.action === 'update_existing_story'
    const isConfident = (reconciliation?.confidence ?? 0) >= NEWS_STORY_RECONCILIATION_MIN_CONFIDENCE
    const isSameEntity = Boolean(target && target.entity_id === memory.input.entity_id)
    const isSamePacket = Boolean(target
      && target.source === memory.input.source
      && target.source_area === memory.input.source_area
      && target.source_research_id === memory.input.source_research_id)

    if (!actionCanMerge || !isConfident || !isSameEntity || isSamePacket || !target || !reconciliation) {
      remaining.push(memory.input)
      continue
    }

    const updated = await store.updateMemory(
      target.id,
      storyReconciliationPatch(target, memory.input, reconciliation),
    )
    recentById.set(updated.id, updated)
    consolidated += 1
  }

  return { remaining, consolidated }
}

export async function writeExtraction(
  store: EntityMemoryStore,
  packet: ResearchPacket,
  extractionProvider: ExtractionProvider
): Promise<WriteExtractionResult> {
  // Canon awareness (see canon.ts): load the catalog once, hand the
  // extraction a shortlist of plausible existing homes, and give the
  // resolver the full catalog for its near-duplicate guardrail. Catalog
  // load failures fail OPEN into menu-less extraction - awareness improves
  // filing, it must never block it.
  let catalog: CanonEntity[] = []
  try {
    catalog = (await store.listEntities()).map(toCanonEntity)
  } catch {
    catalog = []
  }
  const shortlist = shortlistForPacket(catalog, packet)
  const recentMemories = await loadRecentNewsMemories(store, packet, shortlist)
  const shortlistById = new Map(shortlist.map((entity) => [entity.id, entity]))
  const recentMemoriesForPrompt = recentMemories.flatMap((memory) => {
    const entity = memory.entity_id ? shortlistById.get(memory.entity_id) : undefined
    return entity ? [recentMemoryForPrompt(memory, entity)] : []
  })

  const extraction = await extractionProvider.extract(packet, {
    shortlist,
    catalog,
    recentMemories: recentMemoriesForPrompt,
  })
  const resolvedEntities = await resolvePrimaryEntities(store, extraction.primaryEntities, catalog)
  const bySlug = new Map(resolvedEntities.map((resolved) => [entitySlug(resolved.candidate), resolved.entity.id]))
  const preparedMemories = extraction.memories.flatMap((memory) => {
    const entityId = bySlug.get(memory.entitySlug)
    return entityId ? [{ input: memoryInput(packet, memory, entityId), reconciliation: memory.reconciliation }] : []
  })
  // No longer writes a `source_marker` "processed" marker into entity_memories:
  // that table now forbids memory_type = 'source_marker' entirely (a Supabase
  // migration drops the CHECK constraint that used to permit it). Callers that
  // need a processed/failed cursor must track it themselves - see
  // entity-manager/run-polymarket.ts's fetchUnprocessedPolymarketPackets for
  // the Polymarket lane, and entity-manager/run-news.ts for news (which still
  // reads for this marker defensively; see the comment there).

  const newsReconciliation = await reconcileNewsStoryMemories(
    store,
    packet,
    preparedMemories,
    recentMemories,
  )
  const polymarketConsolidation = await consolidatePolymarketMarketSignals(
    store,
    packet,
    newsReconciliation.remaining,
  )
  const remaining = polymarketConsolidation.remaining
  const consolidated = newsReconciliation.consolidated + polymarketConsolidation.consolidated

  const existing = await store.findMemories(remaining.map((memory) => ({
    source: memory.source,
    sourceArea: memory.source_area,
    sourceResearchId: memory.source_research_id,
    entityId: memory.entity_id,
    memoryType: memory.memory_type,
    title: memory.title,
  })))
  const existingKeys = new Set(existing.map((memory) => [
    memory.source,
    memory.source_area,
    memory.source_research_id,
    memory.entity_id ?? '',
    memory.memory_type,
    memory.title,
  ].join('|')))
  const newMemories = remaining.filter((memory) => !existingKeys.has([
    memory.source,
    memory.source_area,
    memory.source_research_id,
    memory.entity_id ?? '',
    memory.memory_type,
    memory.title,
  ].join('|')))
  const written = await store.upsertMemories(newMemories)

  return {
    sourceResearchId: packet.sourceResearchId,
    entitiesCreated: resolvedEntities.filter((resolved) => resolved.created).length,
    entitiesReused: resolvedEntities.filter((resolved) => !resolved.created).length,
    memoriesWritten: written.length + consolidated,
    memoriesConsolidated: consolidated,
    markerStatus: 'processed',
  }
}

export async function markExtractionFailed(
  store: EntityMemoryStore,
  packet: ResearchPacket,
  error: string
): Promise<WriteExtractionResult> {
  // No `source_marker` row written here either (see writeExtraction above) -
  // this now only reports the failure outcome; it does not persist a
  // durable "failed" marker into entity_memories. Callers that need to skip
  // re-attempting a permanently-failed packet must track that themselves.
  void error
  return {
    sourceResearchId: packet.sourceResearchId,
    entitiesCreated: 0,
    entitiesReused: 0,
    memoriesWritten: 0,
    memoriesConsolidated: 0,
    markerStatus: 'failed',
  }
}

export const __testing = {
  loadRecentNewsMemories,
  reconcileNewsStoryMemories,
  resolvePrimaryEntities,
  storyReconciliationPatch,
}
