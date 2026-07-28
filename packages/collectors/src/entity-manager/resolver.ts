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
    type: candidate.type.trim() || 'unknown',
    aliases: aliasesFor(candidate),
    summary: candidate.summary?.trim() || null,
    status: 'active',
    metadata: {
      ...(candidate.metadata ?? {}),
      create_reason: candidate.createReason || undefined,
    },
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

async function resolvePrimaryEntities(store: EntityMemoryStore, candidates: PrimaryEntityCandidate[]): Promise<ResolvedEntity[]> {
  const deduped = new Map<string, PrimaryEntityCandidate>()
  for (const candidate of candidates.slice(0, 3)) {
    if (!candidate.name.trim()) continue
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

  for (const candidate of inputs) {
    const match = findMatchingEntity(candidate, existing)
    if (match) {
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
    } else if (candidate.createIfMissing !== false) {
      toCreate.push(entityInput(candidate))
      createCandidates.push(candidate)
    }
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
      source_title: packet.title,
      source_url: packet.url ?? null,
      ...(memory.context ?? {}),
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

export async function writeExtraction(
  store: EntityMemoryStore,
  packet: ResearchPacket,
  extractionProvider: ExtractionProvider
): Promise<WriteExtractionResult> {
  const extraction = await extractionProvider.extract(packet)
  const resolvedEntities = await resolvePrimaryEntities(store, extraction.primaryEntities)
  const bySlug = new Map(resolvedEntities.map((resolved) => [entitySlug(resolved.candidate), resolved.entity.id]))
  const memoryInputs = extraction.memories.flatMap((memory) => {
    const entityId = bySlug.get(memory.entitySlug)
    return entityId ? [memoryInput(packet, memory, entityId)] : []
  })
  // No longer writes a `source_marker` "processed" marker into entity_memories:
  // that table now forbids memory_type = 'source_marker' entirely (a Supabase
  // migration drops the CHECK constraint that used to permit it). Callers that
  // need a processed/failed cursor must track it themselves - see
  // entity-manager/run-polymarket.ts's fetchUnprocessedPolymarketPackets for
  // the Polymarket lane, and entity-manager/run-news.ts for news (which still
  // reads for this marker defensively; see the comment there).

  const { remaining, consolidated } = await consolidatePolymarketMarketSignals(store, packet, memoryInputs)

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
  resolvePrimaryEntities,
}
