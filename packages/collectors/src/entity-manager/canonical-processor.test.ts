import assert from 'node:assert/strict'
import test from 'node:test'
import type { InferenceTelemetry } from '../inference-gateway/types'
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
import {
  ENTITY_ADMISSION_KNOWLEDGE_SCHEMA_VERSION,
  StaticEntityAdmissionKnowledgeProvider,
  type EntityAdmissionKnowledgeContextV1,
  type EntityAdmissionKnowledgePort,
} from './entity-knowledge-context'
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
      sourceId: 'news-item-1',
      title: 'Federal Reserve changes its guidance',
      canonicalUrl: 'https://example.com/story',
      publishedAt: NOW,
      provenance: { provider: 'fixture', upstreamSource: 'Example News', rawPayloadRef: 'raw-1' },
      contentKind: 'article',
      content: {
        text: 'The Federal Reserve changed its guidance.',
        contentHash: 'content-hash-1',
      },
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

function storedMemory(overrides: Partial<EntityMemoryRecord> = {}): EntityMemoryRecord {
  return {
    id: 'memory-existing',
    memory_identity_key: 'myboon.memory_identity.v1:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    entity_id: 'entity-fed',
    source: 'news',
    source_area: 'feed',
    source_type: 'article',
    source_ref_id: 'signal-old',
    source_research_id: 'packet-old',
    memory_type: 'news_event',
    title: 'Earlier Fed guidance',
    summary: 'The earlier guidance.',
    body: 'Earlier body.',
    event_at: '2026-08-26T09:00:00.000Z',
    observed_at: '2026-08-26T10:00:00.000Z',
    confidence: 0.9,
    evidence: [],
    mentions: ['Federal Reserve'],
    metrics: {},
    context: {
      canonical_source_item_id: 'news-item-old',
      canonical_source_content_hash: 'content-hash-old',
      source_url: 'https://example.com/old-story',
    },
    created_at: '2026-08-26T10:00:00.000Z',
    updated_at: '2026-08-26T10:00:00.000Z',
    ...overrides,
  }
}

function plan(
  decision: CanonicalEntityPlan['decision'],
  memories: CanonicalEntityMemoryDraft[] = [memoryDraft()],
): CanonicalEntityPlan {
  assert.equal(memories.length, 1, 'canonical plans retain exactly one memory')
  const supportedDecision = decision.action === 'select_existing'
    && decision.supportingClaimIds === undefined
    && decision.supportingEvidenceIds === undefined
    ? { ...decision, supportingEvidenceIds: ['evidence-1'] }
    : decision
  return {
    schemaVersion: CANONICAL_ENTITY_PLAN_SCHEMA_VERSION,
    decision: supportedDecision,
    memory: { action: 'keep', memory: memories[0] },
  }
}

function entityTelemetry(): InferenceTelemetry {
  return {
    workload: 'entity.extract', purpose: 'entity plan', mode: 'generateStructured',
    promptVersion: 'entity-prompt-v1', policyVersion: 'entity-policy-v1',
    configuredPrimaryProvider: 'primary', configuredPrimaryModel: 'primary-model',
    actualProvider: 'fallback', actualModel: 'fallback-model', fallbackInvoked: true,
    fallbackReason: 'provider_timeout', schemaValid: true, providerCalls: 2, repairCalls: 0,
    inputTokens: 10, outputTokens: 5, toolCalls: 0, costUsdMicros: 7,
    configuredReasoningEffort: 'high', actualReasoningEffort: 'medium',
    durationMs: 20, budgetExceeded: false, failureCategory: null, calls: [],
  }
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
  recentMemoryReads = 0
  listError: unknown = null
  recentMemoryError: unknown = null
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

  async findCanonicalPacketMemory(
    source: string,
    sourceArea: string,
    sourceResearchId: string,
    entityId: string,
    sourceItemId?: string,
  ): Promise<EntityMemoryRecord | null> {
    const scoped = this.memories.filter((memory) => (
      memory.source === source
      && memory.source_area === sourceArea
      && memory.entity_id === entityId
    ))
    if (source === 'news' && sourceItemId) {
      const article = scoped.find((memory) => memory.context.canonical_source_item_id === sourceItemId)
      if (article) return article
    }
    return scoped.find((memory) => memory.source_research_id === sourceResearchId) ?? null
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

  async listRecentMemories(
    entityIds: string[],
    sinceIso: string,
    untilIso: string,
    limit: number,
    source: string,
  ): Promise<EntityMemoryRecord[]> {
    this.recentMemoryReads += 1
    if (this.recentMemoryError) throw this.recentMemoryError
    const wanted = new Set(entityIds)
    const since = Date.parse(sinceIso)
    const until = Date.parse(untilIso)
    return this.memories.filter((memory) => (
      memory.entity_id !== null
      && wanted.has(memory.entity_id)
      && memory.source === source
      && Date.parse(memory.observed_at) >= since
      && Date.parse(memory.observed_at) <= until
    )).sort((left, right) => Date.parse(right.observed_at) - Date.parse(left.observed_at)).slice(0, limit)
  }
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

class AtomicRaceStore extends FakeStore {
  constructor(private readonly racedEntity: EntityRecord) {
    super()
  }

  async createCanonicalEntity(
    _input: EntityInput,
    _identity: EntityIdentityLookupInput,
  ): Promise<EntityRecord> {
    this.entityWrites += 1
    return this.racedEntity
  }
}

function processor(
  store: FakeStore,
  planner: CanonicalEntityPlanningPort,
  canonLookup?: EntityCanonLookup,
  admissionKnowledge?: EntityAdmissionKnowledgePort,
) {
  return new EntityServiceCanonicalPacketProcessor({ store, planner, canonLookup, admissionKnowledge })
}

test('selects only an admitted existing Entity and preserves canonical traceability', async () => {
  const store = new FakeStore([entity()])
  let sawShortlist = false
  const subject = processor(store, {
    async plan({ admission }) {
      sawShortlist = admission.canonicalEntityShortlist.some((item) => item.entityId === 'entity-fed')
      return { plan: plan({
        action: 'select_existing',
        entityId: 'entity-fed',
        supportingClaimIds: ['claim-1'],
        supportingEvidenceIds: ['evidence-1'],
      }), telemetry: entityTelemetry() }
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
  assert.equal(store.memories[0].context.canonical_source_item_id, 'news-item-1')
  assert.equal(store.memories[0].context.canonical_source_url, 'https://example.com/story')
  assert.equal(store.memories[0].context.canonical_source_content_hash, 'content-hash-1')
  assert.equal(store.memories[0].context.priority_class, 'P1')
  assert.equal(store.memories[0].context.research_depth, 'standard')
  assert.equal(store.memories[0].context.freshness_deadline, '2026-08-26T13:00:00.000Z')
  assert.equal(store.memories[0].context.entity_execution_attempt, 1)
  assert.equal(store.memories[0].context.entity_prompt_version, 'entity-prompt-v1')
  assert.equal(store.memories[0].context.entity_policy_version, 'entity-policy-v1')
  assert.equal(store.memories[0].context.entity_provider, 'fallback')
  assert.equal(store.memories[0].context.entity_model, 'fallback-model')
  assert.equal(store.memories[0].context.entity_fallback_used, true)
  assert.equal(store.memories[0].context.entity_cost_usd_micros, 7)
  assert.equal(store.memories[0].context.entity_configured_reasoning_effort, 'high')
  assert.equal(store.memories[0].context.entity_actual_reasoning_effort, 'medium')
  assert.deepEqual(store.memories[0].evidence, packet().evidence)
})

test('validated existing Entity selection cannot be remapped by another grounded Entity alias', async () => {
  const alpha = entity({
    id: 'entity-alpha', slug: 'alpha', name: 'Alpha', aliases: ['Alpha', 'Beta'],
  })
  const beta = entity({
    id: 'entity-beta', slug: 'beta', name: 'Beta', aliases: ['Beta'],
  })
  const store = new FakeStore([alpha, beta])
  const multiSubjectPacket = packet({
    sourceSignal: {
      ...packet().sourceSignal,
      title: 'Alpha and Beta publish separate updates',
      sourceHints: { entities: ['Alpha', 'Beta'], assets: [], eventId: null, deadline: null },
    },
    claims: [{
      claimId: 'claim-alpha', claim: 'Alpha published its update.',
      attributedTo: 'Alpha', evidenceRefs: ['evidence-1'],
    }, {
      claimId: 'claim-beta', claim: 'Beta published its update.',
      attributedTo: 'Beta', evidenceRefs: ['evidence-1'],
    }],
    entityHints: [{
      name: 'Alpha', type: 'organization', role: 'subject', aliases: [], source: 'research',
      claimRefs: [], evidenceRefs: ['evidence-1'],
    }, {
      name: 'Beta', type: 'organization', role: 'subject', aliases: [], source: 'research',
      claimRefs: [], evidenceRefs: ['evidence-1'],
    }],
  })
  const betaMemory: CanonicalEntityMemoryDraft = {
    ...memoryDraft('Beta publishes an update'),
    representedClaimIds: ['claim-beta'],
    summary: 'Beta published its update.',
    mentions: ['Beta'],
  }
  const subject = processor(store, {
    async plan() {
      return plan({
        action: 'select_existing',
        entityId: beta.id,
        supportingClaimIds: ['claim-beta'],
        supportingEvidenceIds: ['evidence-1'],
      }, [betaMemory])
    },
  })

  await subject.process(input(multiSubjectPacket))

  assert.equal(store.memories.length, 1)
  assert.equal(store.memories[0].entity_id, beta.id)
  assert.equal(store.entityWrites, 0)
})

test('polluted GPT aliases cannot displace the evidence-linked Solana canonical subject', async () => {
  const solana = entity({
    id: 'entity-solana', slug: 'solana', name: 'Solana', type: 'asset', aliases: ['Solana', 'SOL', '@Solana'],
  })
  const gpt = entity({
    id: 'entity-gpt', slug: 'openai-gpt-5-6', name: 'GPT-5.6', type: 'product',
    aliases: ['GPT 5.6', 'Sol', 'Solana', '@Solana'],
  })
  const store = new FakeStore([gpt, solana])
  const solanaPacket = packet({
    sourceSignal: { ...packet().sourceSignal, title: 'Solana holds above $100 as SOL demand rises' },
    claims: [{
      claimId: 'claim-1', claim: 'Solana held above $100.', attributedTo: null, evidenceRefs: ['evidence-1'],
    }],
    entityHints: [{
      name: 'Solana (SOL)', type: null, role: 'subject of report', aliases: ['SOL'], source: 'research',
      claimRefs: [], evidenceRefs: ['evidence-1'],
    }],
  })
  let shortlist: string[] = []
  const subject = processor(store, {
    async plan({ admission }) {
      shortlist = admission.canonicalEntityShortlist.map((item) => item.entityId)
      return plan({
        action: 'select_existing', entityId: solana.id, supportingEvidenceIds: ['evidence-1'],
      })
    },
  })

  await subject.process(input(solanaPacket))

  assert.deepEqual(shortlist, [solana.id])
  assert.equal(store.memories[0]?.entity_id, solana.id)
  assert.equal(store.memories.some((memory) => memory.entity_id === gpt.id), false)
})

test('derived canonical hint names participate in lookup even when the real Entity lacks the ticker alias', async () => {
  const solana = entity({
    id: 'entity-solana', slug: 'solana', name: 'Solana', type: 'asset', aliases: [],
  })
  const gpt = entity({
    id: 'entity-gpt', slug: 'openai-gpt-5-6', name: 'GPT-5.6', type: 'product', aliases: ['Solana'],
  })
  const store = new FakeStore([gpt, solana])
  const solanaPacket = packet({
    claims: [{
      claimId: 'claim-1', claim: 'Solana held above $100.',
      attributedTo: 'Solana', evidenceRefs: ['evidence-1'],
    }],
    entityHints: [{
      name: 'Solana (SOL)', type: null, role: 'subject of report', aliases: ['SOL'], source: 'research',
      claimRefs: [], evidenceRefs: ['evidence-1'],
    }],
  })
  let lookupIncludedDerivedBase = false
  const subject = processor(store, {
    async plan({ admission }) {
      assert.deepEqual(admission.canonicalEntityShortlist.map((item) => item.entityId), [solana.id])
      return plan({
        action: 'select_existing', entityId: solana.id, supportingEvidenceIds: ['evidence-1'],
      })
    },
  }, {
    async lookup(query) {
      lookupIncludedDerivedBase = query.slugs.includes('solana') && query.names.includes('Solana')
      return { entities: lookupIncludedDerivedBase ? [gpt, solana] : [gpt], complete: true }
    },
  })

  await subject.process(input(solanaPacket))

  assert.equal(lookupIncludedDerivedBase, true)
  assert.equal(store.memories[0]?.entity_id, solana.id)
})

test('aliases stay out of the bounded canonical-name lookup channel', async () => {
  const aliases = Array.from({ length: 20 }, (_, index) => `Example Alias ${index}`)
  const example = entity({ id: 'entity-example', slug: 'example', name: 'Example', aliases })
  const store = new FakeStore([example])
  const aliasHeavyPacket = packet({
    claims: [{
      claimId: 'claim-1', claim: 'Example announced an update.',
      attributedTo: 'Example', evidenceRefs: ['evidence-1'],
    }],
    entityHints: [{
      name: 'Example', type: 'organization', role: 'subject', aliases, source: 'research',
      claimRefs: ['claim-1'], evidenceRefs: ['evidence-1'],
    }],
  })
  let observedNameCount = -1
  let observedAliasCount = -1
  const subject = processor(store, {
    async plan() {
      return plan({
        action: 'select_existing', entityId: example.id, supportingClaimIds: ['claim-1'],
      })
    },
  }, {
    async lookup(query) {
      observedNameCount = query.names.length
      observedAliasCount = query.aliases.length
      return { entities: [example], complete: true }
    },
  })

  await subject.process(input(aliasHeavyPacket))

  assert.equal(observedNameCount, 1)
  assert.equal(observedAliasCount, 20)
  assert.equal(store.memories[0]?.entity_id, example.id)
})

test('create_new cannot alias-ground an unrelated canonical name and collide back onto GPT-5.6', async () => {
  const solana = entity({
    id: 'entity-solana', slug: 'solana', name: 'Solana', type: 'asset', aliases: ['Solana', 'SOL'],
  })
  const gpt = entity({
    id: 'entity-gpt', slug: 'openai-gpt-5-6', name: 'GPT-5.6', type: 'product', aliases: ['Solana'],
  })
  const store = new FakeStore([gpt, solana])
  const solanaPacket = packet({
    claims: [{
      claimId: 'claim-1', claim: 'Solana held above $100.',
      attributedTo: 'Solana', evidenceRefs: ['evidence-1'],
    }],
    entityHints: [{
      name: 'Solana (SOL)', type: null, role: 'subject of report', aliases: ['SOL'], source: 'research',
      claimRefs: [], evidenceRefs: ['evidence-1'],
    }],
  })
  const subject = processor(store, {
    async plan() {
      return plan({
        action: 'create_new',
        proposal: {
          slug: 'openai-gpt-5-6', name: 'GPT-5.6', type: 'product', aliases: ['Solana'],
        },
        supportingEvidenceIds: ['evidence-1'],
      })
    },
  })

  await assert.rejects(subject.process(input(solanaPacket)), (error: unknown) => (
    error instanceof PlatformFailure
    && error.category === 'invalid_structured_output'
    && /primary-subject hint|canonical name/.test(error.message)
  ))
  assert.equal(store.entityWrites, 0)
  assert.equal(store.memoryWrites, 0)
})

test('create_new cannot use a matching slug to disguise an unrelated canonical name', async () => {
  const store = new FakeStore()
  const novelPacket = packet({
    claims: [{
      claimId: 'claim-1', claim: 'Novel Protocol launched a new product.',
      attributedTo: 'Novel Protocol', evidenceRefs: ['evidence-1'],
    }],
    entityHints: [{
      name: 'Novel Protocol', type: 'product', role: 'subject', aliases: [], source: 'research',
      claimRefs: [], evidenceRefs: ['evidence-1'],
    }],
  })
  const subject = processor(store, {
    async plan() {
      return plan({
        action: 'create_new',
        proposal: { slug: 'novel-protocol', name: 'Unrelated Product', type: 'product', aliases: [] },
        supportingEvidenceIds: ['evidence-1'],
      })
    },
  })

  await assert.rejects(subject.process(input(novelPacket)), (error: unknown) => (
    error instanceof PlatformFailure
    && error.category === 'invalid_structured_output'
    && /canonical name/.test(error.message)
  ))
  assert.equal(store.entityWrites, 0)
  assert.equal(store.memoryWrites, 0)
})

test('retained memory evidence must concern the selected primary Entity', async () => {
  const store = new FakeStore([entity()])
  const multiTopicPacket = packet({
    claims: [
      ...packet().claims,
      {
        claimId: 'claim-2', claim: 'The SEC approved a tokenized-stock exemption.',
        attributedTo: 'SEC', evidenceRefs: ['evidence-1'],
      },
    ],
    entityHints: [{
      ...packet().entityHints[0],
      aliases: ['Fed', 'SEC'],
      claimRefs: [],
      evidenceRefs: ['evidence-1'],
    }],
  })
  const subject = processor(store, {
    async plan() {
      return plan(
        { action: 'select_existing', entityId: 'entity-fed', supportingEvidenceIds: ['evidence-1'] },
        [{
          ...memoryDraft('Unrelated tokenized-stock development'),
          representedClaimIds: ['claim-2'],
          representedEvidenceIds: ['evidence-1'],
        }],
      )
    },
  })

  await assert.rejects(subject.process(input(multiTopicPacket)), (error: unknown) => (
    error instanceof PlatformFailure
    && error.category === 'invalid_structured_output'
    && /claims must overlap the selected Entity/.test(error.message)
  ))
  assert.equal(store.entityWrites, 0)
  assert.equal(store.memoryWrites, 0)
})

test('no relevant subject completes with no Entity or memory write', async () => {
  const store = new FakeStore([entity()])
  const subject = processor(store, {
    async plan() {
      return {
        schemaVersion: CANONICAL_ENTITY_PLAN_SCHEMA_VERSION,
        decision: {
          action: 'no_relevant_subject', reasonCode: 'no_evidence_backed_subject',
          reason: 'The packet has no evidence-backed durable subject.',
        },
        memory: {
          action: 'drop', reasonCode: 'no_relevant_subject',
          reason: 'Nothing belongs in Entity memory.',
        },
      }
    },
  })

  const result = await subject.process(input())

  assert.equal(result.memoryOutcome, 'skipped')
  assert.equal(store.entityWrites, 0)
  assert.equal(store.memoryWrites, 0)
  assert.equal(store.memories.length, 0)
})

test('canonical news planning sees bounded recent memory and can update it at the established confidence boundary', async () => {
  const store = new FakeStore([entity()])
  store.memories.push(storedMemory())
  let recentIds: string[] = []
  let recentSourceIdentity: [string | null, string | null] | null = null
  const subject = processor(store, {
    async plan({ recentMemories }) {
      recentIds = recentMemories.map((memory) => memory.id)
      recentSourceIdentity = [
        recentMemories[0]?.sourceItemId ?? null,
        recentMemories[0]?.sourceContentHash ?? null,
      ]
      return {
        schemaVersion: CANONICAL_ENTITY_PLAN_SCHEMA_VERSION,
        decision: {
          action: 'select_existing', entityId: 'entity-fed', supportingEvidenceIds: ['evidence-1'],
        },
        memory: {
          action: 'update', subtype: 'material_update', existingMemoryId: 'memory-existing',
          confidence: 0.8, reason: 'The same policy story materially advanced.',
          memory: { ...memoryDraft(), summary: 'The Federal Reserve materially changed its guidance.' },
        },
      }
    },
  })

  const result = await subject.process(input())

  assert.deepEqual(recentIds, ['memory-existing'])
  assert.deepEqual(recentSourceIdentity, ['news-item-old', 'content-hash-old'])
  assert.equal(store.recentMemoryReads, 1, 'one fail-closed lookback is reused by the write boundary')
  assert.equal(store.memories.length, 1)
  assert.equal(store.memories[0].summary, 'The Federal Reserve materially changed its guidance.')
  assert.equal(store.memories[0].context.last_story_reconciliation, 'update_existing_story')
  assert.equal(result.memoryOutcome, 'written')
})

test('relevant Entity with no durable delta drops without mutating memory', async () => {
  const store = new FakeStore([entity()])
  store.memories.push(storedMemory())
  const before = structuredClone(store.memories)
  const subject = processor(store, {
    async plan() {
      return {
        schemaVersion: CANONICAL_ENTITY_PLAN_SCHEMA_VERSION,
        decision: {
          action: 'select_existing', entityId: 'entity-fed', supportingEvidenceIds: ['evidence-1'],
        },
        memory: {
          action: 'drop', reasonCode: 'no_material_change',
          reason: 'The recent timeline already contains the same durable fact.',
        },
      }
    },
  })

  const result = await subject.process(input())

  assert.equal(result.memoryOutcome, 'skipped')
  assert.deepEqual(store.memories, before)
  assert.equal(store.memoryWrites, 0)
})

test('required recent-memory lookback failure is retryable and prevents planner and writes', async () => {
  const store = new FakeStore([entity()])
  store.recentMemoryError = new Error('recent memory database unavailable')
  let plannerCalls = 0
  const subject = processor(store, {
    async plan() {
      plannerCalls += 1
      return plan({ action: 'select_existing', entityId: 'entity-fed' })
    },
  })

  await assert.rejects(subject.process(input()), (error: unknown) => (
    error instanceof PlatformFailure && error.category === 'storage_transient' && error.retryable
  ))
  assert.equal(plannerCalls, 0)
  assert.equal(store.entityWrites, 0)
  assert.equal(store.memoryWrites, 0)
})

test('reviewed scoped knowledge flows through the canonical admission path without adding writes', async () => {
  const jupiter = entity({
    id: 'entity-jupiter',
    slug: 'jupiter',
    name: 'Jupiter',
    type: 'project',
    aliases: ['Jupiter', 'Jupiter Exchange'],
    summary: 'A Solana trading protocol.',
  })
  const store = new FakeStore([jupiter])
  const provenance = {
    kind: 'reviewed_record' as const,
    reference: 'entity-knowledge-model-prd#worked-knowledge-map',
  }
  const knowledge: EntityAdmissionKnowledgeContextV1 = {
    schemaVersion: ENTITY_ADMISSION_KNOWLEDGE_SCHEMA_VERSION,
    entityId: jupiter.id,
    kind: 'protocol',
    classifications: [{
      conceptId: 'ecosystem:solana',
      scheme: 'ecosystem',
      slug: 'solana',
      name: 'Solana ecosystem',
      path: ['solana'],
      verificationStatus: 'reviewed',
      provenance,
    }, {
      conceptId: 'sector:defi',
      scheme: 'sector',
      slug: 'defi',
      name: 'DeFi',
      path: ['financial-markets', 'defi'],
      verificationStatus: 'reviewed',
      provenance,
    }],
    relationships: [{
      predicate: 'operates_on',
      direction: 'outgoing',
      relatedEntity: { id: 'entity-solana', slug: 'solana', name: 'Solana', kind: 'network' },
      verificationStatus: 'reviewed',
      provenance,
    }],
  }
  let observedKnowledge: EntityAdmissionKnowledgeContextV1 | undefined
  const subject = processor(store, {
    async plan({ admission }) {
      assert.equal(admission.schemaVersion, 'myboon.entity_admission.v2')
      observedKnowledge = admission.canonicalEntityShortlist[0]?.knowledge
      return plan({ action: 'select_existing', entityId: jupiter.id })
    },
  }, undefined, new StaticEntityAdmissionKnowledgeProvider([knowledge]))
  const jupiterPacket = packet({
    sourceSignal: {
      ...packet().sourceSignal,
      title: 'Jupiter expands its Solana product surface',
    },
    claims: [{
      claimId: 'claim-1', claim: 'Jupiter expanded its Solana product surface.',
      attributedTo: 'Jupiter', evidenceRefs: ['evidence-1'],
    }],
    entityHints: [{
      name: 'Jupiter', type: 'protocol', role: 'subject', aliases: ['Jupiter Exchange'], source: 'research',
      claimRefs: ['claim-1'], evidenceRefs: ['evidence-1'],
    }],
  })

  await subject.process(input(jupiterPacket))

  assert.equal(observedKnowledge?.kind, 'protocol')
  assert.deepEqual(observedKnowledge?.classifications.map((item) => item.conceptId), [
    'ecosystem:solana',
    'sector:defi',
  ])
  assert.equal(observedKnowledge?.relationships[0]?.relatedEntity.slug, 'solana')
  assert.equal(store.entityWrites, 0)
  assert.equal(store.memoryWrites, 1, 'the existing canonical memory write remains the only durable write')
})

test('configured knowledge failure or invalid output fails closed before planning and writes', async () => {
  for (const admissionKnowledge of [
    {
      async getEntityAdmissionKnowledge() { throw new Error('knowledge store offline') },
    },
    {
      async getEntityAdmissionKnowledge() {
        return [{
          schemaVersion: ENTITY_ADMISSION_KNOWLEDGE_SCHEMA_VERSION,
          entityId: 'unrequested-entity',
          kind: 'topic',
          classifications: [],
          relationships: [],
        }]
      },
    },
  ] satisfies EntityAdmissionKnowledgePort[]) {
    const store = new FakeStore([entity()])
    let plannerCalls = 0
    const subject = processor(store, {
      async plan() {
        plannerCalls += 1
        return plan({ action: 'select_existing', entityId: 'entity-fed' })
      },
    }, undefined, admissionKnowledge)

    await assert.rejects(subject.process(input()), (error: unknown) => (
      error instanceof PlatformFailure
      && (error.category === 'storage_transient' || error.category === 'storage_permanent')
    ))
    assert.equal(plannerCalls, 0)
    assert.equal(store.entityWrites, 0)
    assert.equal(store.memoryWrites, 0)
  }
})

test('Polymarket is admitted only when evidence-linked hints make it the subject, never from venue/source role alone', async () => {
  const polymarket = entity({
    id: 'entity-polymarket', slug: 'polymarket', name: 'Polymarket', type: 'platform', aliases: ['Polymarket'],
  })
  const solana = entity({
    id: 'entity-solana', slug: 'solana', name: 'Solana', type: 'asset', aliases: ['Solana', 'SOL'],
  })

  const aboutStore = new FakeStore([polymarket])
  let aboutShortlist: string[] = []
  const about = processor(aboutStore, {
    async plan({ admission }) {
      aboutShortlist = admission.canonicalEntityShortlist.map((item) => item.entityId)
      return plan({ action: 'select_existing', entityId: polymarket.id })
    },
  })
  const aboutPacket = packet({
    sourceSignal: { ...packet().sourceSignal, title: 'Polymarket launches a new product' },
    claims: [{
      claimId: 'claim-1', claim: 'Polymarket launched a new product.',
      attributedTo: 'Polymarket', evidenceRefs: ['evidence-1'],
    }],
    entityHints: [{
      name: 'Polymarket', type: 'product', role: 'primary_subject', aliases: [], source: 'research',
      claimRefs: ['claim-1'], evidenceRefs: ['evidence-1'],
    }],
  })
  await about.process(input(aboutPacket))
  assert.deepEqual(aboutShortlist, [polymarket.id])

  const venueStore = new FakeStore([polymarket, solana])
  let venueShortlist: string[] = []
  const venue = processor(venueStore, {
    async plan({ admission }) {
      venueShortlist = admission.canonicalEntityShortlist.map((item) => item.entityId)
      return plan({ action: 'select_existing', entityId: solana.id })
    },
  })
  const venuePacket = packet({
    sourceSignal: { ...packet().sourceSignal, title: 'Polymarket odds move on the price of Solana' },
    claims: [{
      claimId: 'claim-1', claim: 'Solana price odds moved on Polymarket.',
      attributedTo: 'Solana', evidenceRefs: ['evidence-1'],
    }],
    entityHints: [{
      name: 'Polymarket', type: 'product', role: 'venue', aliases: [], source: 'research',
      claimRefs: ['claim-1'], evidenceRefs: ['evidence-1'],
    }, {
      name: 'Solana', type: 'asset', role: 'subject', aliases: ['SOL'], source: 'research',
      claimRefs: ['claim-1'], evidenceRefs: ['evidence-1'],
    }],
  })
  await venue.process(input(venuePacket))
  assert.deepEqual(venueShortlist, [solana.id])
})

test('admits evidence-backed creation only with a complete canon', async () => {
  const store = new FakeStore()
  const subject = processor(store, {
    async plan() {
      return plan({
        action: 'create_new',
        proposal: { slug: 'federal-reserve', name: 'Federal Reserve', type: 'organization', aliases: [] },
        supportingClaimIds: ['claim-1'],
      })
    },
  })

  await subject.process(input())
  assert.equal(store.entities.length, 1)
  assert.equal(store.memories[0].entity_id, store.entities[0].id)
  assert.equal(store.entities[0].metadata.canonical_packet_id, 'packet-1')

  const incomplete = new FakeStore()
  const brandPacket = packet({
    sourceSignal: { ...packet().sourceSignal, title: 'Brand New Entity announces a durable launch' },
    claims: [{
      claimId: 'claim-1', claim: 'Brand New Entity announced a durable launch.',
      attributedTo: 'Brand New Entity', evidenceRefs: ['evidence-1'],
    }],
    entityHints: [{
      name: 'Brand New Entity', type: 'organization', role: 'subject', aliases: [], source: 'research',
      claimRefs: ['claim-1'], evidenceRefs: ['evidence-1'],
    }],
  })
  const blocked = processor(incomplete, {
    async plan() {
      return plan({
        action: 'create_new',
        proposal: { slug: 'brand-new-entity', name: 'Brand New Entity', type: 'organization' },
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

  await assert.rejects(blocked.process(input(brandPacket)), (error: unknown) => error instanceof PlatformFailure
    && error.category === 'storage_transient'
    && error.retryable)
  assert.equal(incomplete.entityWrites, 0)
  assert.equal(incomplete.memoryWrites, 0)
})

test('atomic create rejects an identity-mismatched concurrent exact-slug row', async () => {
  const raced = entity({
    id: 'entity-raced',
    slug: 'novel-protocol',
    name: 'GPT-5.6',
    type: 'product',
    aliases: ['GPT-5.6', 'Solana'],
  })
  const store = new AtomicRaceStore(raced)
  const novelPacket = packet({
    claims: [{
      claimId: 'claim-1', claim: 'Novel Protocol launched its network.',
      attributedTo: 'Novel Protocol', evidenceRefs: ['evidence-1'],
    }],
    entityHints: [{
      name: 'Novel Protocol', type: 'project', role: 'subject', aliases: [], source: 'research',
      claimRefs: [], evidenceRefs: ['evidence-1'],
    }],
  })
  const subject = processor(store, {
    async plan() {
      return plan({
        action: 'create_new',
        proposal: { slug: 'novel-protocol', name: 'Novel Protocol', type: 'project', aliases: [] },
        supportingClaimIds: ['claim-1'],
      }, [{
        ...memoryDraft('Novel Protocol launches'),
        representedClaimIds: ['claim-1'],
        summary: 'Novel Protocol launched its network.',
        mentions: ['Novel Protocol'],
      }])
    },
  })

  await assert.rejects(subject.process(input(novelPacket)), (error: unknown) => (
    error instanceof PlatformFailure
    && error.category === 'storage_transient'
    && error.retryable
    && /identity-mismatched/.test(error.message)
  ))
  assert.equal(store.entityWrites, 1)
  assert.equal(store.memoryWrites, 0)
})

test('atomic create accepts a concurrently created row with the exact grounded identity', async () => {
  const raced = entity({
    id: 'entity-raced',
    slug: 'novel-protocol',
    name: 'Novel Protocol',
    type: 'project',
    aliases: ['Novel Protocol'],
  })
  const store = new AtomicRaceStore(raced)
  const novelPacket = packet({
    claims: [{
      claimId: 'claim-1', claim: 'Novel Protocol launched its network.',
      attributedTo: 'Novel Protocol', evidenceRefs: ['evidence-1'],
    }],
    entityHints: [{
      name: 'Novel Protocol', type: 'project', role: 'subject', aliases: [], source: 'research',
      claimRefs: [], evidenceRefs: ['evidence-1'],
    }],
  })
  const subject = processor(store, {
    async plan() {
      return plan({
        action: 'create_new',
        proposal: { slug: 'novel-protocol', name: 'Novel Protocol', type: 'project', aliases: [] },
        supportingClaimIds: ['claim-1'],
      }, [{
        ...memoryDraft('Novel Protocol launches'),
        representedClaimIds: ['claim-1'],
        summary: 'Novel Protocol launched its network.',
        mentions: ['Novel Protocol'],
      }])
    },
  })

  await subject.process(input(novelPacket))

  assert.equal(store.entityWrites, 1)
  assert.equal(store.memories.length, 1)
  assert.equal(store.memories[0].entity_id, raced.id)
})

test('new Entity proposals cannot smuggle aliases that are absent from authoritative packet hints', async () => {
  const store = new FakeStore()
  const subject = processor(store, {
    async plan() {
      return plan({
        action: 'create_new',
        proposal: {
          slug: 'federal-reserve',
          name: 'Federal Reserve',
          type: 'organization',
          aliases: ['Fed', 'Solana'],
        },
        supportingEvidenceIds: ['evidence-1'],
      })
    },
  })

  await assert.rejects(subject.process(input()), (error: unknown) => (
    error instanceof PlatformFailure
    && error.category === 'invalid_structured_output'
    && /alias is not grounded/.test(error.message)
  ))
  assert.equal(store.entityWrites, 0)
  assert.equal(store.memoryWrites, 0)
})

test('new Entity proposals cannot mint an unrelated alias from a co-mention', async () => {
  const store = new FakeStore()
  const acmePacket = packet({
    claims: [{
      claimId: 'claim-1',
      claim: 'Acme partnered with Solitron.',
      attributedTo: 'Acme',
      evidenceRefs: ['evidence-1'],
    }],
    entityHints: [{
      name: 'Acme', type: 'organization', role: 'subject', aliases: ['Solitron'], source: 'research',
      claimRefs: [], evidenceRefs: ['evidence-1'],
    }],
  })
  const subject = processor(store, {
    async plan() {
      return plan({
        action: 'create_new',
        proposal: {
          slug: 'acme', name: 'Acme', type: 'organization', aliases: ['Solitron'],
        },
        supportingClaimIds: ['claim-1'],
      })
    },
  })

  await assert.rejects(subject.process(input(acmePacket)), (error: unknown) => (
    error instanceof PlatformFailure
    && error.category === 'invalid_structured_output'
    && /alias is not grounded/.test(error.message)
  ))
  assert.equal(store.entityWrites, 0)
  assert.equal(store.memoryWrites, 0)
})

test('partial canon results cannot make an alias appear uniquely authoritative', async () => {
  const federalReserve = entity()
  const store = new FakeStore([federalReserve])
  const fedPacket = packet({
    claims: [{
      claimId: 'claim-1', claim: 'Fed changed its guidance.',
      attributedTo: 'Fed', evidenceRefs: ['evidence-1'],
    }],
    entityHints: [{
      name: 'Fed', type: 'organization', role: 'subject', aliases: [], source: 'research',
      claimRefs: [], evidenceRefs: ['evidence-1'],
    }],
  })
  let shortlist: string[] = []
  const subject = processor(store, {
    async plan({ admission }) {
      shortlist = admission.canonicalEntityShortlist.map((item) => item.entityId)
      return plan({ action: 'select_existing', entityId: federalReserve.id })
    },
  }, {
    async lookup() {
      return { entities: [federalReserve], complete: false }
    },
  })

  await assert.rejects(subject.process(input(fedPacket)), (error: unknown) => (
    error instanceof PlatformFailure
    && error.category === 'entity_resolution_failed'
    && /Unknown canonical entity ID/.test(error.message)
  ))
  assert.deepEqual(shortlist, [])
  assert.equal(store.entityWrites, 0)
  assert.equal(store.memoryWrites, 0)
})

test('a planner cannot create an Entity when its article decision is drop', async () => {
  const store = new FakeStore()
  const subject = processor(store, {
    async plan() {
      return {
        schemaVersion: CANONICAL_ENTITY_PLAN_SCHEMA_VERSION,
        decision: {
          action: 'create_new',
          proposal: { slug: 'federal-reserve', name: 'Federal Reserve', type: 'organization', aliases: ['Fed'] },
          supportingEvidenceIds: ['evidence-1'],
        },
        memory: {
          action: 'drop', reasonCode: 'low_durable_value', reason: 'No durable observation should be stored.',
        },
      }
    },
  })

  await assert.rejects(subject.process(input()), (error: unknown) => (
    error instanceof PlatformFailure
    && error.category === 'invalid_structured_output'
    && /cannot create/.test(error.message)
  ))
  assert.equal(store.entityWrites, 0)
  assert.equal(store.memoryWrites, 0)
})

test('memory updates reject confidence below 0.8 and targets from the current packet', async () => {
  for (const invalid of [
    { confidence: 0.79, sourceResearchId: 'packet-old', message: /at least 0.8/ },
    { confidence: 0.8, sourceResearchId: 'packet-1', message: /same Research Packet/ },
  ]) {
    const store = new FakeStore([entity()])
    store.memories.push(storedMemory({ source_research_id: invalid.sourceResearchId }))
    const subject = processor(store, {
      async plan() {
        return {
          schemaVersion: CANONICAL_ENTITY_PLAN_SCHEMA_VERSION,
          decision: {
            action: 'select_existing', entityId: 'entity-fed', supportingEvidenceIds: ['evidence-1'],
          },
          memory: {
            action: 'update', subtype: 'material_update', existingMemoryId: 'memory-existing',
            confidence: invalid.confidence, reason: 'The same story appears to have changed.',
            memory: memoryDraft(),
          },
        }
      },
    })

    await assert.rejects(subject.process(input()), (error: unknown) => (
      error instanceof PlatformFailure
      && error.category === 'invalid_structured_output'
      && invalid.message.test(error.message)
    ))
    assert.equal(store.entityWrites, 0)
    assert.equal(store.memoryWrites, 0)
  }
})

test('unrelated catalogs above the former limit do not block targeted new Entity creation', async () => {
  const unrelated = Array.from({ length: 1_005 }, (_, index) => entity({
    id: `unrelated-${index}`,
    slug: `unrelated-${index}`,
    name: `Unrelated ${index}`,
    aliases: [`Unrelated ${index}`],
  }))
  const store = new FakeStore(unrelated)
  const novelPacket = packet({
    sourceSignal: { ...packet().sourceSignal, title: 'Novel Policy Topic becomes a durable regulatory subject' },
    claims: [{
      claimId: 'claim-1', claim: 'Novel Policy Topic became a durable regulatory subject.',
      attributedTo: 'Novel Policy Topic', evidenceRefs: ['evidence-1'],
    }],
    entityHints: [{
      name: 'Novel Policy Topic', type: 'topic', role: 'subject', aliases: [], source: 'research',
      claimRefs: ['claim-1'], evidenceRefs: ['evidence-1'],
    }],
  })
  const subject = processor(store, {
    async plan() {
      return plan({
        action: 'create_new',
        proposal: { slug: 'novel-policy-topic', name: 'Novel Policy Topic', type: 'topic' },
        supportingEvidenceIds: ['evidence-1'],
      })
    },
  })

  await subject.process(input(novelPacket))

  assert.equal(store.entities.some((item) => item.slug === 'novel-policy-topic'), true)
  assert.equal(store.entityWrites, 1)
  assert.equal(store.memoryWrites, 1)
})

test('targeted collision lookup reuses exact slugs and rejects ambiguous alias collisions', async () => {
  const guidancePacket = packet({
    sourceSignal: { ...packet().sourceSignal, title: 'Federal Reserve Guidance changes materially' },
    claims: [{
      claimId: 'claim-1', claim: 'Federal Reserve Guidance changed materially.',
      attributedTo: 'Federal Reserve Guidance', evidenceRefs: ['evidence-1'],
    }],
    entityHints: [{
      name: 'Federal Reserve Guidance', type: 'topic', role: 'subject', aliases: [], source: 'research',
      claimRefs: ['claim-1'], evidenceRefs: ['evidence-1'],
    }],
  })
  const exact = entity({
    id: 'existing-proposal',
    slug: 'federal-reserve-guidance',
    name: 'Federal Reserve Guidance',
    type: 'topic',
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

  await exactSubject.process(input(guidancePacket))
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

  await assert.rejects(ambiguous.process(input(guidancePacket)), (error: unknown) => error instanceof PlatformFailure
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
  await assert.rejects(inactive.process(input(guidancePacket)), (error: unknown) => error instanceof PlatformFailure
    && error.category === 'entity_resolution_failed')
  assert.equal(inactiveStore.entityWrites, 0)
  assert.equal(inactiveStore.memoryWrites, 0)
})

test('replay uses one article identity across changed model title, role, and claim selection', async () => {
  const store = new FakeStore([entity()])
  let title = 'First generated title'
  let secondPlan = false
  const replayPacket = packet({
    claims: [{
      claimId: 'claim-1', claim: 'The Federal Reserve changed its guidance.',
      attributedTo: 'Federal Reserve', evidenceRefs: ['evidence-1'],
    }, {
      claimId: 'claim-2', claim: 'The Federal Reserve also changed its forecast.',
      attributedTo: 'Federal Reserve', evidenceRefs: ['evidence-1'],
    }],
  })
  const subject = processor(store, {
    async plan() {
      return plan({ action: 'select_existing', entityId: 'entity-fed' }, [{
        ...memoryDraft(title),
        memoryRole: secondPlan ? 'material_follow_up' : 'primary_event',
        representedClaimIds: [secondPlan ? 'claim-2' : 'claim-1'],
      }])
    },
  })

  await subject.process(input(replayPacket))
  const firstId = store.memories[0].id
  const firstIdentity = store.memories[0].memory_identity_key
  title = 'Completely different generated title'
  secondPlan = true
  await subject.process(input(replayPacket))

  assert.equal(store.memories.length, 1)
  assert.equal(store.memories[0].id, firstId)
  assert.equal(store.memories[0].memory_identity_key, firstIdentity)
  assert.equal(store.memories[0].title, title)
  assert.equal(store.memoryWrites, 2)
})

test('replay reuses a canonical row written with the previous v1 identity algorithm', async () => {
  const store = new FakeStore([entity()])
  const previousIdentity = `myboon.memory_identity.v1:${'f'.repeat(64)}`
  store.memories.push(storedMemory({
    id: 'memory-previous-v1',
    memory_identity_key: previousIdentity,
    entity_id: 'entity-fed',
    source_research_id: 'packet-previous',
    title: 'Previous generated title',
    context: {
      ...storedMemory().context,
      canonical_source_item_id: 'news-item-1',
    },
  }))
  const subject = processor(store, {
    async plan() {
      return plan({ action: 'select_existing', entityId: 'entity-fed' }, [{
        ...memoryDraft('New generated title'),
        memoryRole: 'changed_model_role',
      }])
    },
  })

  await subject.process(input())

  assert.equal(store.memories.length, 1)
  assert.equal(store.memories[0].id, 'memory-previous-v1')
  assert.equal(store.memories[0].memory_identity_key, previousIdentity)
  assert.equal(store.memories[0].title, 'New generated title')
  assert.equal(store.memoryWrites, 1)
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

test('planner result rejects malformed telemetry before any Entity or memory write', async () => {
  const store = new FakeStore([entity()])
  const subject = processor(store, {
    async plan() {
      return {
        plan: plan({ action: 'select_existing', entityId: 'entity-fed' }),
        telemetry: { providerCalls: 1, secret: 'must-not-cross-boundary' },
      }
    },
  })

  await assert.rejects(subject.process(input()), (error: unknown) => (
    error instanceof PlatformFailure
    && error.category === 'invalid_structured_output'
    && /telemetry/.test(error.message)
  ))
  assert.equal(store.entityWrites, 0)
  assert.equal(store.memoryWrites, 0)
})
