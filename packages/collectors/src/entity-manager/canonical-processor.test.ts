import assert from 'node:assert/strict'
import test from 'node:test'
import type { ResearchPacketV1, ResearchWorkItem } from '../signal-platform/contracts'
import { PlatformFailure } from '../signal-platform/failures'
import { adaptCanonicalResearchPacket } from './canonical-packet-adapter'
import {
  CANONICAL_ENTITY_PLAN_SCHEMA_VERSION,
  EntityServiceCanonicalPacketProcessor,
  type CanonicalEntityMemoryDraft,
  type CanonicalEntityPlan,
  type CanonicalEntityPlanningPort,
  type EntityCanonLookup,
} from './canonical-processor'
import type {
  EntityInput,
  EntityIdentityLookupInput,
  EntityIdentityLookupResult,
  EntityMemoryConsolidationPatch,
  EntityMemoryInput,
  EntityMemoryRecord,
  EntityMemoryStore,
  EntityMemoryType,
  EntityRecord,
  ManualCommandLogInput,
  ManualCommandLogRecord,
  MemoryLookupKey,
} from './types'

const NOW = '2026-08-26T12:00:00.000Z'

function work(overrides: Partial<ResearchWorkItem> = {}): ResearchWorkItem {
  return {
    schemaVersion: 'myboon.research_work.v1',
    workId: 'work-1',
    signalId: 'signal-1',
    sourceType: 'news',
    researchDepth: 'standard',
    deepReason: null,
    priorityClass: 'P1',
    priorityScore: 0.8,
    freshnessDeadline: '2026-08-26T13:00:00.000Z',
    policyVersion: 'research-policy-v1',
    researchContractVersion: 'myboon.research_packet.v1',
    retrievalPlan: { sourceUrl: null, allowedDomains: [], maxExternalSources: 1 },
    budget: {
      maxProviderCalls: 1,
      maxRepairCalls: 1,
      maxInputTokens: 100,
      maxOutputTokens: 100,
      maxToolCalls: 0,
      maxWallTimeMs: 1_000,
    },
    status: 'entity_leased',
    attemptCount: 0,
    nextAttemptAt: null,
    leaseOwner: 'worker',
    leaseId: 'lease',
    leaseExpiresAt: '2026-08-26T12:01:00.000Z',
    failureCategory: null,
    failureDetail: null,
    traceId: 'trace-1',
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  }
}

function packet(overrides: Partial<ResearchPacketV1> = {}): ResearchPacketV1 {
  return {
    schemaVersion: 'myboon.research_packet.v1',
    packetId: 'packet-1',
    workId: 'work-1',
    signalId: 'signal-1',
    sourceType: 'news',
    observedAt: NOW,
    sourceSignal: {
      title: 'Federal Reserve changes its guidance',
      canonicalUrl: 'https://example.com/story',
      publishedAt: NOW,
      provenance: { provider: 'fixture', upstreamSource: 'Example News', rawPayloadRef: 'raw-1' },
      contentKind: 'article',
      content: { text: 'The Federal Reserve changed its guidance.' },
      media: { imageUrl: 'https://example.com/image.jpg', attribution: 'Example News' },
      sourceHints: { entities: ['Federal Reserve'], assets: [], eventId: null, deadline: null },
    },
    claims: [{
      claimId: 'claim-1',
      claim: 'The Federal Reserve changed its guidance.',
      attributedTo: 'Federal Reserve',
      evidenceRefs: ['evidence-1'],
    }],
    verifiedFacts: [{ fact: 'An official statement exists.', evidenceRefs: ['evidence-1'] }],
    unresolvedClaims: [],
    evidence: [{
      evidenceId: 'evidence-1',
      title: 'Official statement',
      url: 'https://example.com/statement',
      sourceType: 'official',
      observedAt: NOW,
      note: 'The statement changes forward guidance.',
    }],
    entityHints: [{
      name: 'Federal Reserve',
      type: 'organization',
      role: 'subject',
      aliases: ['Fed'],
      source: 'research',
      claimRefs: ['claim-1'],
      evidenceRefs: ['evidence-1'],
    }],
    limitations: [],
    openQuestions: [],
    completion: 'complete',
    budgetUsed: {
      providerCalls: 1,
      repairCalls: 0,
      inputTokens: 100,
      outputTokens: 50,
      toolCalls: 0,
      wallTimeMs: 500,
      budgetExceeded: false,
    },
    execution: {
      provider: 'test',
      model: 'test-model',
      fallbackProvider: null,
      fallbackModel: null,
      fallbackUsed: false,
      promptVersion: 'prompt-v1',
      policyVersion: 'research-policy-v1',
      traceId: 'trace-1',
      attempt: 1,
    },
    researchContractVersion: 'myboon.research_packet.v1',
    createdAt: NOW,
    ...overrides,
  }
}

function entity(overrides: Partial<EntityRecord> = {}): EntityRecord {
  return {
    id: 'entity-fed',
    slug: 'federal-reserve',
    name: 'Federal Reserve',
    type: 'organization',
    aliases: ['Federal Reserve', 'Fed'],
    summary: 'The US central bank.',
    status: 'active',
    show_in_carousel: false,
    metadata: {},
    created_at: NOW,
    updated_at: NOW,
    ...overrides,
  }
}

function memoryDraft(title = 'Fed changes forward guidance'): CanonicalEntityMemoryDraft {
  return {
    memoryType: 'news_event',
    memoryRole: 'primary_event',
    representedClaimIds: ['claim-1'],
    representedEvidenceIds: ['evidence-1'],
    title,
    summary: 'The Federal Reserve changed its forward guidance.',
    body: 'The official statement supplies the change.',
    eventAt: NOW,
    confidence: 0.95,
    mentions: ['Federal Reserve', 'Fed'],
  }
}

function plan(
  decision: CanonicalEntityPlan['decision'],
  memories: CanonicalEntityMemoryDraft[] = [memoryDraft()],
): CanonicalEntityPlan {
  return { schemaVersion: CANONICAL_ENTITY_PLAN_SCHEMA_VERSION, decision, memories }
}

function input(canonical = packet(), item = work()) {
  const validAdapted = adaptCanonicalResearchPacket(packet())
  return {
    work: item,
    canonicalPacket: canonical,
    packet: canonical.schemaVersion === 'myboon.research_packet.v1' && canonical.completion === 'complete'
      ? adaptCanonicalResearchPacket(canonical)
      : validAdapted,
    signal: new AbortController().signal,
  }
}

class FakeStore implements EntityMemoryStore {
  readonly entities: EntityRecord[]
  readonly memories: EntityMemoryRecord[] = []
  entityWrites = 0
  memoryWrites = 0
  catalogReads = 0
  listError: unknown = null
  private nextEntity = 1
  private nextMemory = 1

  constructor(entities: EntityRecord[] = []) {
    this.entities = [...entities]
  }

  async listEntities(limit = 1_000): Promise<EntityRecord[]> {
    this.catalogReads += 1
    if (this.listError) throw this.listError
    return this.entities.slice(0, limit)
  }

  async findEntities(slugs: string[], aliases: string[]): Promise<EntityRecord[]> {
    this.catalogReads += 1
    if (this.listError) throw this.listError
    const slugSet = new Set(slugs)
    const aliasSet = new Set(aliases.map((alias) => alias.toLowerCase()))
    return this.entities.filter((item) => slugSet.has(item.slug) || item.aliases.some((alias) => aliasSet.has(alias.toLowerCase())))
  }

  async findEntitiesByIdentity(input: EntityIdentityLookupInput): Promise<EntityIdentityLookupResult> {
    this.catalogReads += 1
    if (this.listError) throw this.listError
    const labels = new Set([...input.names, ...input.aliases].map((label) => label.toLowerCase()))
    return {
      complete: true,
      entities: this.entities.filter((item) => (
        input.slugs.includes(item.slug)
        || labels.has(item.name.toLowerCase())
        || item.aliases.some((alias) => labels.has(alias.toLowerCase()))
      )),
    }
  }

  async createEntities(inputs: EntityInput[]): Promise<EntityRecord[]> {
    this.entityWrites += inputs.length
    return inputs.map((value) => {
      const existing = this.entities.find((item) => item.slug === value.slug)
      if (existing) return existing
      const created: EntityRecord = {
        ...value,
        id: `created-${this.nextEntity++}`,
        show_in_carousel: value.show_in_carousel ?? false,
        created_at: NOW,
        updated_at: NOW,
      }
      this.entities.push(created)
      return created
    })
  }

  async updateEntity(value: EntityRecord): Promise<EntityRecord> {
    this.entityWrites += 1
    const index = this.entities.findIndex((item) => item.id === value.id)
    if (index >= 0) this.entities[index] = value
    return value
  }

  async findMemories(keys: MemoryLookupKey[]): Promise<EntityMemoryRecord[]> {
    const identities = new Set(keys.map((key) => key.memoryIdentityKey))
    return this.memories.filter((memory) => identities.has(memory.memory_identity_key))
  }

  async upsertMemories(inputs: EntityMemoryInput[]): Promise<EntityMemoryRecord[]> {
    this.memoryWrites += inputs.length
    return inputs.map((value) => {
      assert.match(value.memory_identity_key ?? '', /^myboon\.memory_identity\.v1:[0-9a-f]{64}$/)
      const existing = this.memories.find((memory) => memory.memory_identity_key === value.memory_identity_key)
      if (existing) {
        Object.assign(existing, value, { updated_at: NOW })
        return existing
      }
      const created: EntityMemoryRecord = {
        ...value,
        id: `memory-${this.nextMemory++}`,
        created_at: NOW,
        updated_at: NOW,
      }
      this.memories.push(created)
      return created
    })
  }

  async listRecentMemories(): Promise<EntityMemoryRecord[]> { return [] }
  async findLatestMemorySince(_entityId: string, _memoryType: EntityMemoryType, _sinceIso: string): Promise<EntityMemoryRecord | null> {
    return null
  }
  async updateMemory(id: string, patch: EntityMemoryConsolidationPatch): Promise<EntityMemoryRecord> {
    const existing = this.memories.find((memory) => memory.id === id)
    if (!existing) throw new Error('missing memory')
    Object.assign(existing, patch)
    return existing
  }
  async findManualCommand(): Promise<ManualCommandLogRecord | null> { return null }
  async recordManualCommand(_input: ManualCommandLogInput): Promise<ManualCommandLogRecord> {
    throw new Error('not used')
  }
}

function processor(store: FakeStore, planner: CanonicalEntityPlanningPort, canonLookup?: EntityCanonLookup) {
  return new EntityServiceCanonicalPacketProcessor({ store, planner, canonLookup })
}

test('selects only an admitted existing Entity and preserves canonical traceability', async () => {
  const store = new FakeStore([entity()])
  let sawShortlist = false
  const subject = processor(store, {
    async plan({ admission }) {
      sawShortlist = admission.canonicalEntityShortlist.some((item) => item.entityId === 'entity-fed')
      return plan({
        action: 'select_existing',
        entityId: 'entity-fed',
        supportingClaimIds: ['claim-1'],
        supportingEvidenceIds: ['evidence-1'],
      })
    },
  })

  await subject.process(input())

  assert.equal(sawShortlist, true)
  assert.equal(store.entityWrites, 0)
  assert.equal(store.memories.length, 1)
  assert.equal(store.memories[0].entity_id, 'entity-fed')
  assert.equal(store.memories[0].source_research_id, 'packet-1')
  assert.equal(store.memories[0].source_ref_id, 'signal-1')
  assert.deepEqual(store.memories[0].context.canonical_claim_ids, ['claim-1'])
  assert.deepEqual(store.memories[0].context.canonical_evidence_ids, ['evidence-1'])
  assert.equal(store.memories[0].context.image_url, 'https://example.com/image.jpg')
  assert.equal(store.memories[0].context.image_attribution, 'Example News')
  assert.equal(store.memories[0].context.canonical_trace_id, 'trace-1')
  assert.equal(store.memories[0].context.priority_class, 'P1')
  assert.equal(store.memories[0].context.research_depth, 'standard')
  assert.equal(store.memories[0].context.freshness_deadline, '2026-08-26T13:00:00.000Z')
  assert.deepEqual(store.memories[0].evidence, packet().evidence)
})

test('admits evidence-backed creation only with a complete canon', async () => {
  const store = new FakeStore()
  const subject = processor(store, {
    async plan() {
      return plan({
        action: 'create_new',
        proposal: { slug: 'federal-reserve-guidance', name: 'Federal Reserve Guidance', type: 'topic' },
        supportingClaimIds: ['claim-1'],
      })
    },
  })

  await subject.process(input())
  assert.equal(store.entities.length, 1)
  assert.equal(store.memories[0].entity_id, store.entities[0].id)
  assert.equal(store.entities[0].metadata.canonical_packet_id, 'packet-1')

  const incomplete = new FakeStore()
  const blocked = processor(incomplete, {
    async plan() {
      return plan({
        action: 'create_new',
        proposal: { slug: 'brand-new-entity', name: 'Brand New Entity', type: 'topic' },
        supportingEvidenceIds: ['evidence-1'],
      })
    },
  }, {
    async lookup(query) {
      return {
        entities: [],
        complete: !query.slugs.includes('brand-new-entity'),
      }
    },
  })

  await assert.rejects(blocked.process(input()), (error: unknown) => error instanceof PlatformFailure
    && error.category === 'storage_transient'
    && error.retryable)
  assert.equal(incomplete.entityWrites, 0)
  assert.equal(incomplete.memoryWrites, 0)
})

test('unrelated catalogs above the former limit do not block targeted new Entity creation', async () => {
  const unrelated = Array.from({ length: 1_005 }, (_, index) => entity({
    id: `unrelated-${index}`,
    slug: `unrelated-${index}`,
    name: `Unrelated ${index}`,
    aliases: [`Unrelated ${index}`],
  }))
  const store = new FakeStore(unrelated)
  const subject = processor(store, {
    async plan() {
      return plan({
        action: 'create_new',
        proposal: { slug: 'novel-policy-topic', name: 'Novel Policy Topic', type: 'topic' },
        supportingEvidenceIds: ['evidence-1'],
      })
    },
  })

  await subject.process(input())

  assert.equal(store.entities.some((item) => item.slug === 'novel-policy-topic'), true)
  assert.equal(store.entityWrites, 1)
  assert.equal(store.memoryWrites, 1)
})

test('targeted collision lookup reuses exact slugs and rejects ambiguous alias collisions', async () => {
  const exact = entity({
    id: 'existing-proposal',
    slug: 'federal-reserve-guidance',
    name: 'Federal Reserve Guidance',
    aliases: ['Federal Reserve Guidance'],
  })
  const exactStore = new FakeStore([exact])
  const exactSubject = processor(exactStore, {
    async plan() {
      return plan({
        action: 'create_new',
        proposal: { slug: exact.slug, name: exact.name, type: exact.type },
        supportingEvidenceIds: ['evidence-1'],
      })
    },
  })

  await exactSubject.process(input())
  assert.equal(exactStore.entityWrites, 0)
  assert.equal(exactStore.memories[0].entity_id, exact.id)

  const ambiguousStore = new FakeStore([entity({
    id: 'alias-collision',
    slug: 'different-canonical-entity',
    name: 'Different Canonical Entity',
    aliases: ['Federal Reserve Guidance'],
  })])
  const ambiguous = processor(ambiguousStore, {
    async plan() {
      return plan({
        action: 'create_new',
        proposal: { slug: 'federal-reserve-guidance', name: 'Federal Reserve Guidance', type: 'topic' },
        supportingEvidenceIds: ['evidence-1'],
      })
    },
  })

  await assert.rejects(ambiguous.process(input()), (error: unknown) => error instanceof PlatformFailure
    && error.category === 'entity_resolution_failed'
    && !error.retryable)
  assert.equal(ambiguousStore.entityWrites, 0)
  assert.equal(ambiguousStore.memoryWrites, 0)

  const inactiveStore = new FakeStore([entity({
    id: 'inactive-proposal',
    slug: 'federal-reserve-guidance',
    name: 'Retired Federal Reserve Guidance',
    aliases: [],
    status: 'inactive',
  })])
  const inactive = processor(inactiveStore, {
    async plan() {
      return plan({
        action: 'create_new',
        proposal: { slug: 'federal-reserve-guidance', name: 'Federal Reserve Guidance', type: 'topic' },
        supportingEvidenceIds: ['evidence-1'],
      })
    },
  })
  await assert.rejects(inactive.process(input()), (error: unknown) => error instanceof PlatformFailure
    && error.category === 'entity_resolution_failed')
  assert.equal(inactiveStore.entityWrites, 0)
  assert.equal(inactiveStore.memoryWrites, 0)
})

test('replay uses stable code identity and changed model title targets the same row', async () => {
  const store = new FakeStore([entity()])
  let title = 'First generated title'
  const subject = processor(store, {
    async plan() {
      return plan({ action: 'select_existing', entityId: 'entity-fed' }, [memoryDraft(title)])
    },
  })

  await subject.process(input())
  const firstId = store.memories[0].id
  const firstIdentity = store.memories[0].memory_identity_key
  title = 'Completely different generated title'
  await subject.process(input())

  assert.equal(store.memories.length, 1)
  assert.equal(store.memories[0].id, firstId)
  assert.equal(store.memories[0].memory_identity_key, firstIdentity)
  assert.equal(store.memories[0].title, title)
  assert.equal(store.memoryWrites, 2)
})

test('unknown Entity decisions and dangling memory references are rejected before any write', async () => {
  const unknownEntityStore = new FakeStore([entity()])
  const unknownEntity = processor(unknownEntityStore, {
    async plan() {
      return plan({ action: 'select_existing', entityId: 'not-in-the-shortlist' })
    },
  })
  await assert.rejects(unknownEntity.process(input()), (error: unknown) => error instanceof PlatformFailure
    && error.category === 'entity_resolution_failed'
    && !error.retryable)
  assert.equal(unknownEntityStore.entityWrites, 0)
  assert.equal(unknownEntityStore.memoryWrites, 0)

  const danglingStore = new FakeStore([entity()])
  const dangling = processor(danglingStore, {
    async plan() {
      return plan(
        { action: 'select_existing', entityId: 'entity-fed' },
        [{ ...memoryDraft(), representedEvidenceIds: ['not-packet-evidence'] }],
      )
    },
  })
  await assert.rejects(dangling.process(input()), (error: unknown) => error instanceof PlatformFailure
    && error.category === 'invalid_structured_output'
    && !error.retryable)
  assert.equal(danglingStore.entityWrites, 0)
  assert.equal(danglingStore.memoryWrites, 0)
})

test('partial, failed, missing-evidence, schema, and work-linkage rejection occur before writes', async () => {
  const invalidPackets: ResearchPacketV1[] = [
    packet({ completion: 'partial' }),
    packet({ completion: 'failed' }),
    packet({ claims: [], verifiedFacts: [], evidence: [], entityHints: [] }),
    { ...packet(), schemaVersion: 'myboon.research_packet.v2' as ResearchPacketV1['schemaVersion'] },
  ]
  for (const invalid of invalidPackets) {
    const store = new FakeStore([entity()])
    const subject = processor(store, { async plan() { throw new Error('must not plan') } })
    await assert.rejects(subject.process(input(invalid)), (error: unknown) => error instanceof PlatformFailure && !error.retryable)
    assert.equal(store.catalogReads, 0)
    assert.equal(store.entityWrites, 0)
    assert.equal(store.memoryWrites, 0)
  }

  const store = new FakeStore([entity()])
  const subject = processor(store, { async plan() { throw new Error('must not plan') } })
  await assert.rejects(
    subject.process(input(packet(), work({ workId: 'different-work' }))),
    (error: unknown) => error instanceof PlatformFailure && error.category === 'invalid_structured_output',
  )
  assert.equal(store.catalogReads, 0)
  assert.equal(store.entityWrites, 0)
  assert.equal(store.memoryWrites, 0)
})

test('provider, circuit, and storage outages retain structural failure categories', async () => {
  const circuit = new PlatformFailure({ category: 'circuit_open', message: 'open', incrementsAttempt: false })
  const preflightStore = new FakeStore([entity()])
  const preflight = processor(preflightStore, {
    async preflight() { throw circuit },
    async plan() { throw new Error('must not plan') },
  })
  await assert.rejects(preflight.preflight(input()), (error: unknown) => error === circuit)
  assert.equal(preflightStore.catalogReads, 0)

  const unavailable = new PlatformFailure({ category: 'provider_unavailable', message: 'offline' })
  const providerStore = new FakeStore([entity()])
  const provider = processor(providerStore, { async plan() { throw unavailable } })
  await assert.rejects(provider.process(input()), (error: unknown) => error === unavailable)
  assert.equal(providerStore.entityWrites, 0)
  assert.equal(providerStore.memoryWrites, 0)

  const storageStore = new FakeStore([entity()])
  storageStore.listError = new Error('database transport unavailable')
  const storage = processor(storageStore, { async plan() { throw new Error('must not plan') } })
  await assert.rejects(storage.process(input()), (error: unknown) => error instanceof PlatformFailure
    && error.category === 'storage_transient'
    && error.retryable)
  assert.equal(storageStore.entityWrites, 0)
  assert.equal(storageStore.memoryWrites, 0)
})
