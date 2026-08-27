export type EntityMemoryType =
  | 'research_note'
  | 'market_signal'
  | 'news_event'
  | 'social_signal'
  | 'timeline_event'
  | 'metric_change'
  | 'source_marker'

export type SourceProcessingStatus = 'processed' | 'failed'

export interface ResearchPacket {
  id: string
  source: string
  sourceArea: string
  sourceResearchId: string
  sourceType: string
  sourceRefId: string
  title: string
  summary: string
  body: string
  observedAt: string
  eventAt?: string | null
  url?: string | null
  evidence: unknown[]
  metrics: Record<string, unknown>
  context: Record<string, unknown>
}

export interface PrimaryEntityCandidate {
  name: string
  type: string
  slug?: string
  aliases?: string[]
  summary?: string
  createIfMissing?: boolean
  createReason?: string
  metadata?: Record<string, unknown>
}

export type StoryReconciliationAction = 'new_story' | 'update_existing_story' | 'duplicate_source'

export interface StoryReconciliationCandidate {
  /**
   * `new_story` writes a new row. The other actions may update only a recent
   * memory ID that Entity Manager supplied to the extraction prompt.
   */
  action: StoryReconciliationAction
  existingMemoryId?: string | null
  /** Confidence that the two memories describe the same underlying event. */
  confidence?: number
  reason?: string
}

export interface EntityMemoryCandidate {
  entitySlug: string
  memoryType: EntityMemoryType
  title: string
  summary: string
  body?: string
  eventAt?: string | null
  observedAt?: string
  confidence?: number
  evidence?: unknown[]
  mentions?: string[]
  metrics?: Record<string, unknown>
  context?: Record<string, unknown>
  reconciliation?: StoryReconciliationCandidate
}

export interface EntityMemoryExtraction {
  primaryEntities: PrimaryEntityCandidate[]
  memories: EntityMemoryCandidate[]
}

export interface ExtractionProvider {
  /**
   * `canon` (see canon.ts) carries the entity catalog awareness: a shortlist
   * of plausible existing homes for the prompt menu and the full catalog for
   * near-duplicate reflection. Optional so fakes and legacy callers that
   * extract without awareness keep working; when omitted the provider
   * behaves as before (menu-less filing).
   */
  extract(packet: ResearchPacket, canon?: import('./canon').ExtractionCanon): Promise<EntityMemoryExtraction>
}

export interface EntityRecord {
  id: string
  slug: string
  name: string
  type: string
  aliases: string[]
  summary: string | null
  status: string
  show_in_carousel: boolean
  metadata: Record<string, unknown>
  created_at?: string
  updated_at?: string
}

export interface EntityInput {
  slug: string
  name: string
  type: string
  aliases: string[]
  summary: string | null
  status: string
  show_in_carousel?: boolean
  metadata: Record<string, unknown>
}

/** Bounded exact identity labels used by canonical Entity admission. */
export interface EntityIdentityLookupInput {
  slugs: string[]
  names: string[]
  aliases: string[]
}

export interface EntityIdentityLookupResult {
  entities: EntityRecord[]
  /** False when the backing query hit its bounded result ceiling. */
  complete: boolean
}

export interface EntityTimelineItem {
  summary: string
  event_at: string
}

export interface EntityMemoryRecord {
  id: string
  /** Stable replay identity. Optional only for pre-migration test/legacy rows. */
  memory_identity_key?: string
  entity_id: string | null
  source: string
  source_area: string
  source_type: string
  source_ref_id: string
  source_research_id: string
  memory_type: EntityMemoryType
  title: string
  summary: string
  body: string | null
  event_at: string | null
  observed_at: string
  confidence: number | null
  evidence: unknown[]
  mentions: string[]
  metrics: Record<string, unknown>
  context: Record<string, unknown>
  created_at?: string
  updated_at?: string
}

export interface EntityMemoryInput {
  /**
   * Canonical Feed V3 callers provide a myboon.memory_identity.v1 SHA-256
   * key. Legacy callers may omit it; the Supabase store derives a deterministic
   * compatibility key matching the former unique tuple.
   */
  memory_identity_key?: string
  entity_id: string | null
  source: string
  source_area: string
  source_type: string
  source_ref_id: string
  source_research_id: string
  memory_type: EntityMemoryType
  title: string
  summary: string
  body: string | null
  event_at: string | null
  observed_at: string
  confidence: number | null
  evidence: unknown[]
  mentions: string[]
  metrics: Record<string, unknown>
  context: Record<string, unknown>
}

export interface EntityMemoryStore {
  findEntities(slugs: string[], aliases: string[]): Promise<EntityRecord[]>
  /**
   * Canonical Feed V3 exact-identity lookup. Unlike the legacy lookup this
   * covers slug, canonical name, and aliases with source-neutral semantics.
   */
  findEntitiesByIdentity?(input: EntityIdentityLookupInput): Promise<EntityIdentityLookupResult>
  /**
   * Atomically repeats the complete identity collision check and creates (or
   * reuses the exact slug) under a database-scoped lock. Production canonical
   * creation requires this capability; it is optional only for legacy stores.
   */
  createCanonicalEntity?(
    entity: EntityInput,
    identity: EntityIdentityLookupInput,
  ): Promise<EntityRecord>
  /**
   * The full entity catalog (bounded), for canon awareness: the extraction
   * shortlist and the resolver's near-duplicate guardrail both read it.
   * See canon.ts.
   */
  listEntities(limit?: number): Promise<EntityRecord[]>
  createEntities(entities: EntityInput[]): Promise<EntityRecord[]>
  updateEntity(entity: EntityRecord): Promise<EntityRecord>
  findMemories(keys: MemoryLookupKey[]): Promise<EntityMemoryRecord[]>
  upsertMemories(memories: EntityMemoryInput[]): Promise<EntityMemoryRecord[]>
  /**
   * Recent memories across the shortlisted entities, used by the existing
   * extraction call to distinguish a new story from a cross-source duplicate
   * or a material update. The result is bounded and newest-first.
   */
  listRecentMemories(
    entityIds: string[],
    sinceIso: string,
    untilIso: string,
    limit: number,
    source: string,
  ): Promise<EntityMemoryRecord[]>
  /**
   * Most recent memory of `memoryType` for `entityId` at or after `sinceIso`,
   * using the existing `entity_memories_entity_time_idx` (entity_id,
   * observed_at DESC) partial index — no schema change required.
   */
  findLatestMemorySince(entityId: string, memoryType: EntityMemoryType, sinceIso: string): Promise<EntityMemoryRecord | null>
  updateMemory(id: string, patch: EntityMemoryConsolidationPatch): Promise<EntityMemoryRecord>
  /**
   * Replay-idempotency log for manual Entity commands (dashboard/CLI/Codex),
   * backed by the dedicated `manual_command_log` table rather than an
   * `entity_memories` `source_marker` row — a command that creates an entity
   * has no entity_id to attach a memory to at write time, and entity_memories
   * forbids both a null entity_id and memory_type = 'source_marker' entirely
   * (see the entity_memories_drop_source_marker migration).
   */
  findManualCommand(requestId: string): Promise<ManualCommandLogRecord | null>
  recordManualCommand(input: ManualCommandLogInput): Promise<ManualCommandLogRecord>
}

export interface ManualCommandLogInput {
  requestId: string
  commandHash: string
  actor: ManualEntityActor
  entityId: string | null
}

export interface ManualCommandLogRecord {
  requestId: string
  commandHash: string
  actor: ManualEntityActor
  entityId: string | null
  appliedAt: string
}

export interface EntityMemoryConsolidationPatch {
  observed_at: string
  event_at: string | null
  summary: string
  body: string | null
  confidence: number | null
  evidence: unknown[]
  mentions: string[]
  metrics: Record<string, unknown>
  context: Record<string, unknown>
}

export interface MemoryLookupKey {
  memoryIdentityKey?: string
  source: string
  sourceArea: string
  sourceResearchId: string
  entityId: string | null
  memoryType: EntityMemoryType
  title: string
}

export interface ResolvedEntity {
  candidate: PrimaryEntityCandidate
  entity: EntityRecord
  created: boolean
}

export interface WriteExtractionResult {
  sourceResearchId: string
  entitiesCreated: number
  entitiesReused: number
  memoriesWritten: number
  /**
   * Memories folded into an existing recent memory instead of inserting a
   * new row. This includes Polymarket same-window signal consolidation and
   * Entity Manager news-story reconciliation. Included in memoriesWritten's
   * total for backward-compatible counters, but broken out separately so the
   * bloat-prevention rate remains visible.
   */
  memoriesConsolidated: number
  markerStatus: SourceProcessingStatus
}

export type ManualEntityActorKind = 'dashboard' | 'codex' | 'agent' | 'cli'

export interface ManualEntityActor {
  kind: ManualEntityActorKind
  name: string
}

export interface ManualEntityDefinition {
  name: string
  type: string
  slug?: string
  aliases?: string[]
  summary?: string | null
  status?: string
  showInCarousel?: boolean
  metadata?: Record<string, unknown>
}

export interface ManualEntityMemoryDefinition {
  memoryType: Exclude<EntityMemoryType, 'source_marker'>
  title: string
  summary: string
  body?: string | null
  eventAt: string
  observedAt?: string
  confidence?: number | null
  evidence?: unknown[]
  mentions?: string[]
  metrics?: Record<string, unknown>
  context?: Record<string, unknown>
  sourceLabel?: string
  sourceUrl?: string | null
  sourceRefId?: string
  sourceType?: string
}

export interface ManualEntityCommand {
  requestId: string
  actor: ManualEntityActor
  entity: ManualEntityDefinition
  memories: ManualEntityMemoryDefinition[]
}

export interface NormalizedManualEntityCommand {
  requestId: string
  actor: ManualEntityActor
  entity: {
    name: string
    type: string
    slug: string
    aliases: string[]
    summary?: string | null
    status?: string
    showInCarousel?: boolean
    metadata: Record<string, unknown>
  }
  memories: Array<{
    memoryType: Exclude<EntityMemoryType, 'source_marker'>
    title: string
    summary: string
    body: string | null
    eventAt: string
    observedAt: string
    confidence: number | null
    evidence: unknown[]
    mentions: string[]
    metrics: Record<string, unknown>
    context: Record<string, unknown>
    sourceLabel: string
    sourceUrl: string | null
    sourceRefId: string
    sourceType: string
  }>
}

export interface ManualEntityPreview {
  requestId: string
  command: NormalizedManualEntityCommand
  entity: {
    action: 'create' | 'update' | 'reuse'
    existingEntityId: string | null
    currentUpdatedAt: string | null
    slug: string
    name: string
    type: string
    aliases: string[]
    summary: string | null
    status: string
    showInCarousel: boolean
    metadata: Record<string, unknown>
    changes: string[]
  }
  memories: Array<{
    index: number
    action: 'create' | 'skip_duplicate'
    title: string
    summary: string
    eventAt: string
    memoryType: Exclude<EntityMemoryType, 'source_marker'>
  }>
  warnings: string[]
  planHash: string
}

export interface ManualEntityApplyResult {
  requestId: string
  entity: EntityRecord
  memoriesWritten: number
  duplicateMemoriesSkipped: number
  auditMarkerWritten: boolean
  replayed: boolean
}
