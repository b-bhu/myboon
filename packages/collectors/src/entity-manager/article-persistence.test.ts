import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import { RESEARCH_PACKET_SCHEMA_VERSION, type ArticleChoiceDecision, type ArticleEntityProposal, type ArticleResearchPacketV1, type ArticleResearchPacketV2, type ArticleV2EntityProposal } from '../signal-platform/contracts'
import { canonicalJson } from '../signal-platform/canonical-json'
import { validateResearchPacket } from '../signal-platform/validation'
import { ArticlePersistenceProcessor, retainPrimaryDuplicateTarget } from './article-persistence'
import { deriveProgressionOperationId } from './progression-processor'

const ITEM_PRIMARY = 'managed-primary'
const ITEM_RELATED = 'managed-related'

function decision(choice: string): ArticleChoiceDecision {
  return { choice, probabilities: { [choice]: 1 }, confidence: 1, decisionId: `fixture:${choice}`, decisionVersion: 'fixture.v1' }
}

function proposal(role: 'primary' | 'related', entityId: string, itemId: string): ArticleEntityProposal {
  return {
    entityId,
    placementDisposition: 'selected',
    role,
    name: role === 'primary' ? 'Primary Entity' : 'Related Entity',
    type: 'organization', aliases: [], summary: null, scope: {},
    creationProposal: null, creationDecision: null, placement: decision(role === 'primary' ? entityId : 'related'),
    relationship: 'duplicate', relationshipDecision: decision('duplicate'),
    priorItemDecision: decision(itemId), priorItemId: itemId, priorItemSource: 'managed',
    duplicateTarget: { itemId, source: 'managed', entityId },
  }
}

function packet(memberships: ArticleEntityProposal[]): ArticleResearchPacketV1 {
  return {
    schemaVersion: 'myboon.research_packet.article.v1', packetKind: 'article', packetId: 'packet-1',
    workId: 'work-1', signalId: 'signal-1', sourceType: 'news', observedAt: '2026-10-06T00:00:00.000Z',
    sourceSignal: {
      sourceId: 'source-1', title: 'A source-backed development', canonicalUrl: 'https://example.com/article',
      publishedAt: null, provenance: { provider: 'fixture', upstreamSource: 'fixture', rawPayloadRef: 'fixture' },
    },
    article: {
      title: 'A source-backed development', timelineSummary: 'The source-backed development.', body: 'Captured body.',
      eventAt: null, sourceUrl: 'https://example.com/article', capturedText: 'Captured body.',
      capturedAt: '2026-10-06T00:00:00.000Z', contentHash: 'hash', truncated: false,
    },
    memberships, novelty: decision('already_known'), limitations: [], openQuestions: [], completion: 'complete',
    budgetUsed: { providerCalls: 0, repairCalls: 0, inputTokens: 0, outputTokens: 0, toolCalls: 0, wallTimeMs: 0, budgetExceeded: false },
    execution: { provider: 'fixture', model: 'fixture', fallbackProvider: null, fallbackModel: null, fallbackUsed: false, promptVersion: 'fixture', policyVersion: 'fixture', traceId: 'trace-1', attempt: 1 },
    researchContractVersion: RESEARCH_PACKET_SCHEMA_VERSION, createdAt: '2026-10-06T00:00:00.000Z',
  }
}

function v2Decision(provider: 'jev' | 'hermes', choice: string, fallbackReason?: string): ArticleV2EntityProposal['placement'] {
  return provider === 'jev'
    ? { provider, choice, probabilities: { [choice]: 1 }, confidence: 1, decisionId: `fixture:${choice}`, decisionVersion: 'fixture.v2', model: 'fixture-jev-model' }
    : { provider, choice, decisionId: `fixture:${choice}`, decisionVersion: 'fixture.v2', model: 'fixture-hermes-model', fallbackReason: fallbackReason ?? 'provider_billing' }
}

function v2Proposal(
  role: 'primary' | 'related',
  entityId: string,
  itemId: string,
  provider: 'jev' | 'hermes',
): ArticleV2EntityProposal {
  return {
    entityId,
    placementDisposition: 'selected',
    role,
    name: role === 'primary' ? 'Primary Entity' : 'Related Entity',
    type: 'organization', aliases: [], summary: null, scope: {},
    creationProposal: null, creationDecision: null,
    placement: v2Decision(provider, role === 'primary' ? entityId : 'related'),
    relationship: 'duplicate',
    relationshipDecision: v2Decision(provider, 'duplicate'),
    priorItemDecision: v2Decision(provider, itemId),
    priorItemId: itemId, priorItemSource: 'managed',
    // v2 packets are saved in the normalized shape: exactly one primary
    // durable reuse target, with related duplicate judgment retained only as
    // contextual history — the shape retainPrimaryDuplicateTarget produces.
    duplicateTarget: role === 'primary' ? { itemId, source: 'managed', entityId } : null,
    contextualDuplicateTarget: role === 'primary' ? null : { itemId, source: 'managed', entityId },
  }
}

function packetV2(memberships: ArticleV2EntityProposal[]): ArticleResearchPacketV2 {
  return {
    schemaVersion: 'myboon.research_packet.article.v2', packetKind: 'article', packetId: 'packet-1',
    workId: 'work-1', signalId: 'signal-1', sourceType: 'news', observedAt: '2026-10-06T00:00:00.000Z',
    sourceSignal: {
      sourceId: 'source-1', title: 'A source-backed development', canonicalUrl: 'https://example.com/article',
      publishedAt: null, provenance: { provider: 'fixture', upstreamSource: 'fixture', rawPayloadRef: 'fixture' },
    },
    article: {
      title: 'A source-backed development', timelineSummary: 'The source-backed development.', body: 'Captured body.',
      eventAt: null, sourceUrl: 'https://example.com/article', capturedText: 'Captured body.',
      capturedAt: '2026-10-06T00:00:00.000Z', contentHash: 'hash', truncated: false,
    },
    memberships,
    novelty: v2Decision('jev', 'already_known'), limitations: [], openQuestions: [], completion: 'complete',
    budgetUsed: { providerCalls: 0, repairCalls: 0, inputTokens: 0, outputTokens: 0, toolCalls: 0, wallTimeMs: 0, budgetExceeded: false },
    execution: { provider: 'fixture', model: 'fixture', fallbackProvider: null, fallbackModel: null, fallbackUsed: false, promptVersion: 'fixture', policyVersion: 'fixture', traceId: 'trace-1', attempt: 1 },
    researchContractVersion: RESEARCH_PACKET_SCHEMA_VERSION, createdAt: '2026-10-06T00:00:00.000Z',
  }
}

test('primary exact duplicate is the sole durable reuse target while related history remains in the packet', () => {
  const primary = proposal('primary', 'entity-primary', ITEM_PRIMARY)
  const related = proposal('related', 'entity-related', ITEM_RELATED)
  const input = packet([primary, related])
  const reduced = retainPrimaryDuplicateTarget(input)

  assert.equal(reduced.memberships[0]!.duplicateTarget?.itemId, ITEM_PRIMARY)
  assert.equal(reduced.memberships[1]!.duplicateTarget, null)
  assert.deepEqual(reduced.memberships[1]!.contextualDuplicateTarget, { itemId: ITEM_RELATED, source: 'managed', entityId: 'entity-related' })
  assert.equal(reduced.memberships[1]!.priorItemId, ITEM_RELATED)
  assert.equal(reduced.memberships[1]!.priorItemSource, 'managed')
  assert.equal(reduced.memberships[1]!.relationshipDecision?.choice, 'duplicate')
  assert.deepEqual(reduced.memberships.map(({ entityId, role }) => ({ entityId, role })), [
    { entityId: 'entity-primary', role: 'primary' },
    { entityId: 'entity-related', role: 'related' },
  ])
  assert.equal(input.memberships[1]!.duplicateTarget?.itemId, ITEM_RELATED)
  assert.doesNotThrow(() => validateResearchPacket(reduced))
})

test('without a primary exact duplicate, conflicting targets remain unchanged for the ambiguity hold', () => {
  const related = proposal('related', 'entity-related', ITEM_RELATED)
  const input = packet([related])
  const reduced = retainPrimaryDuplicateTarget(input)

  assert.strictEqual(reduced, input)
  assert.equal(reduced.memberships[0]!.duplicateTarget?.itemId, ITEM_RELATED)
})

test('validation rejects contextual related history when already_known has no primary exact duplicate', () => {
  const relatedOnly = packet([proposal('related', 'entity-related', ITEM_RELATED)])
  relatedOnly.memberships[0]!.duplicateTarget = null
  relatedOnly.memberships[0]!.contextualDuplicateTarget = { itemId: ITEM_RELATED, source: 'managed', entityId: 'entity-related' }

  assert.throws(() => validateResearchPacket(relatedOnly), /primary exact duplicate/i)
})

test('persistence holds a related-only already_known packet before writer commit', async () => {
  const primaryWithoutDuplicate = proposal('primary', 'entity-primary', ITEM_PRIMARY)
  primaryWithoutDuplicate.relationship = 'same_topic_only'
  primaryWithoutDuplicate.relationshipDecision = decision('same_topic_only')
  primaryWithoutDuplicate.priorItemDecision = decision('same_topic_only')
  primaryWithoutDuplicate.priorItemId = null
  primaryWithoutDuplicate.priorItemSource = null
  primaryWithoutDuplicate.duplicateTarget = null
  const relatedOnly = packet([primaryWithoutDuplicate, proposal('related', 'entity-related', ITEM_RELATED)])
  let committed = false
  const hold: { missingDependency?: string } = {}
  const writer = {
    findReceipt: async () => null,
    articleContext: async () => ({
      entities: [
        { id: 'entity-primary', slug: 'primary', name: 'Primary Entity', type: 'organization', aliases: [], summary: null,
          status: 'active', show_in_carousel: false, metadata: {}, revision: 'entity-revision-primary', catalogEntityId: null, identityKey: 'catalog:primary' },
        { id: 'entity-related', slug: 'related', name: 'Related Entity', type: 'organization', aliases: [], summary: null,
          status: 'active', show_in_carousel: false, metadata: {}, revision: 'entity-revision-related', catalogEntityId: null, identityKey: 'catalog:related' },
      ],
      items: [], digest: 'context-digest', watermark: 'watermark', truncated: false,
      articleItems: [{ itemId: ITEM_RELATED, entityId: 'entity-related', origin: 'managed', title: 'Prior', summary: 'Prior',
        publishedAt: null, eventAt: null, observedAt: '2026-10-05T00:00:00.000Z', catalogEntityId: null, aliases: [], metadata: {}, revision: 'item-revision' }],
    }),
    savePlanningContext: async () => {},
    acquireLease: async () => ({ owner: 'fixture-owner', epoch: 1 }),
    releaseLease: async () => true,
    commitArticle: async () => { committed = true; throw new Error('must not commit') },
    commitArticleHold: async (input: { missingDependency?: string }) => { Object.assign(hold, input); return {} },
  } as any

  await assert.rejects(new ArticlePersistenceProcessor(writer).persist({
    packet: relatedOnly, source: 'news', owner: 'fixture-owner', signal: new AbortController().signal,
  }), /duplicate_target_resolution/)
  assert.equal(committed, false)
  assert.equal(hold.missingDependency, 'duplicate_target_resolution')
})

test('persistence holds a contextual duplicate whose exact prior item is absent from captured context', async () => {
  const primary = proposal('primary', 'entity-primary', ITEM_PRIMARY)
  const related = proposal('related', 'entity-related', 'managed-missing')
  const input = packet([primary, related])
  const writer = {
    findReceipt: async () => null,
    articleContext: async () => ({
      entities: [
        { id: 'entity-primary', slug: 'primary', name: 'Primary Entity', type: 'organization', aliases: [], summary: null,
          status: 'active', show_in_carousel: false, metadata: {}, revision: 'entity-revision-primary', catalogEntityId: null, identityKey: 'catalog:primary' },
        { id: 'entity-related', slug: 'related', name: 'Related Entity', type: 'organization', aliases: [], summary: null,
          status: 'active', show_in_carousel: false, metadata: {}, revision: 'entity-revision-related', catalogEntityId: null, identityKey: 'catalog:related' },
      ],
      items: [], digest: 'context-digest', watermark: 'watermark', truncated: false,
      articleItems: [{ itemId: ITEM_PRIMARY, entityId: 'entity-primary', origin: 'managed', title: 'Prior', summary: 'Prior',
        publishedAt: null, eventAt: null, observedAt: '2026-10-05T00:00:00Z', catalogEntityId: null, aliases: [], metadata: {}, revision: 'item-revision' }],
    }),
    savePlanningContext: async () => {},
    acquireLease: async () => ({ owner: 'fixture-owner', epoch: 1 }),
    releaseLease: async () => true,
    commitArticle: async () => { throw new Error('must not commit') },
    commitArticleHold: async (hold: { missingDependency?: string; reason?: string }) => hold,
  } as any

  const normalized = retainPrimaryDuplicateTarget(input)
  assert.equal(normalized.memberships[0]!.duplicateTarget?.itemId, ITEM_PRIMARY)
  assert.equal(normalized.memberships[1]!.duplicateTarget, null)
  assert.equal(normalized.memberships[1]!.contextualDuplicateTarget?.itemId, 'managed-missing')
  await assert.rejects(new ArticlePersistenceProcessor(writer).persist({
    packet: normalized, source: 'news', owner: 'fixture-owner', signal: new AbortController().signal,
  }), /duplicate_target_resolution/)
})

test('persistence retains a valid legacy multi-target packet when its source checkpoint is already immutable', async () => {
  const input = packet([proposal('primary', 'entity-primary', ITEM_PRIMARY), proposal('related', 'entity-related', ITEM_RELATED)])
  let committed = false
  const hold: { missingDependency?: string } = {}
  const writer = {
    findReceipt: async () => null,
    articleContext: async () => ({
      entities: [
        { id: 'entity-primary', slug: 'primary', name: 'Primary Entity', type: 'organization', aliases: [], summary: null,
          status: 'active', show_in_carousel: false, metadata: {}, revision: 'entity-revision-primary', catalogEntityId: null, identityKey: 'catalog:primary' },
        { id: 'entity-related', slug: 'related', name: 'Related Entity', type: 'organization', aliases: [], summary: null,
          status: 'active', show_in_carousel: false, metadata: {}, revision: 'entity-revision-related', catalogEntityId: null, identityKey: 'catalog:related' },
      ],
      items: [], digest: 'context-digest', watermark: 'watermark', truncated: false,
      articleItems: [
        { itemId: ITEM_PRIMARY, entityId: 'entity-primary', origin: 'managed', title: 'Primary prior', summary: 'Primary prior',
          publishedAt: null, eventAt: null, observedAt: '2026-10-05T00:00:00Z', catalogEntityId: null, aliases: [], metadata: {}, revision: 'item-revision-primary' },
        { itemId: ITEM_RELATED, entityId: 'entity-related', origin: 'managed', title: 'Related prior', summary: 'Related prior',
          publishedAt: null, eventAt: null, observedAt: '2026-10-05T00:00:00Z', catalogEntityId: null, aliases: [], metadata: {}, revision: 'item-revision-related' },
      ],
    }),
    savePlanningContext: async () => {},
    acquireLease: async () => ({ owner: 'fixture-owner', epoch: 1 }),
    releaseLease: async () => true,
    commitArticle: async () => { committed = true; throw new Error('must not commit') },
    commitArticleHold: async (input: { missingDependency?: string }) => { Object.assign(hold, input); return {} },
  } as any

  await assert.rejects(new ArticlePersistenceProcessor(writer).persist({
    packet: input, source: 'news', owner: 'fixture-owner', signal: new AbortController().signal,
  }), /immutable_article_source_checkpoint/)
  assert.equal(committed, false)
  assert.equal(hold.missingDependency, 'immutable_article_source_checkpoint')
})

const ARTICLE_CONTEXT = {
  entities: [
    { id: 'entity-primary', slug: 'primary', name: 'Primary Entity', type: 'organization', aliases: [], summary: null,
      status: 'active', show_in_carousel: false, metadata: {}, revision: 'entity-revision-primary', catalogEntityId: null, identityKey: 'catalog:primary' },
    { id: 'entity-related', slug: 'related', name: 'Related Entity', type: 'organization', aliases: [], summary: null,
      status: 'active', show_in_carousel: false, metadata: {}, revision: 'entity-revision-related', catalogEntityId: null, identityKey: 'catalog:related' },
  ],
  items: [], digest: 'context-digest', watermark: 'watermark', truncated: false,
  articleItems: [
    { itemId: ITEM_PRIMARY, entityId: 'entity-primary', origin: 'managed', title: 'Primary prior', summary: 'Primary prior',
      publishedAt: null, eventAt: null, observedAt: '2026-10-05T00:00:00Z', catalogEntityId: null, aliases: [], metadata: {}, revision: 'item-revision-primary' },
    { itemId: ITEM_RELATED, entityId: 'entity-related', origin: 'managed', title: 'Related prior', summary: 'Related prior',
      publishedAt: null, eventAt: null, observedAt: '2026-10-05T00:00:00Z', catalogEntityId: null, aliases: [], metadata: {}, revision: 'item-revision-related' },
  ],
}

function writerCapturingCommit(): { writer: any, committedPackets: unknown[], receipt: unknown } {
  const committedPackets: unknown[] = []
  const receipt = { status: 'accepted', operationId: deriveProgressionOperationId('work-1'), workId: 'work-1' }
  const writer = {
    findReceipt: async () => null,
    articleContext: async () => ARTICLE_CONTEXT,
    savePlanningContext: async () => {},
    acquireLease: async () => ({ owner: 'fixture-owner', epoch: 1 }),
    releaseLease: async () => true,
    commitArticle: async (input: { packet: unknown }) => {
      committedPackets.push(input.packet)
      return { receipt }
    },
    commitArticleHold: async () => ({}),
  } as any
  return { writer, committedPackets, receipt }
}

test('persistence accepts a v2 packet with jev decisions and commits it', async () => {
  const { writer, committedPackets } = writerCapturingCommit()
  const input = packetV2([v2Proposal('primary', 'entity-primary', ITEM_PRIMARY, 'jev'), v2Proposal('related', 'entity-related', ITEM_RELATED, 'jev')])
  assert.doesNotThrow(() => validateResearchPacket(input))
  const result = await new ArticlePersistenceProcessor(writer).persist({
    packet: input, source: 'news', owner: 'fixture-owner', signal: new AbortController().signal,
  })
  // A legacy multi-target packet is deliberately held before commit; this
  // single-target v2 packet must reach the commit boundary instead.
  assert.equal(committedPackets.length, 1)
  assert.equal(committedPackets[0], input)
  assert.equal(result, 'reused')
})

test('persistence accepts a v2 packet with hermes fallback decisions and commits it', async () => {
  const { writer, committedPackets } = writerCapturingCommit()
  const input = packetV2([
    v2Proposal('primary', 'entity-primary', ITEM_PRIMARY, 'hermes'),
    v2Proposal('related', 'entity-related', ITEM_RELATED, 'hermes'),
  ])
  assert.doesNotThrow(() => validateResearchPacket(input))
  const result = await new ArticlePersistenceProcessor(writer).persist({
    packet: input, source: 'news', owner: 'fixture-owner', signal: new AbortController().signal,
  })
  assert.equal(committedPackets.length, 1)
  assert.equal(committedPackets[0], input)
  assert.equal(result, 'reused')
})

test('v1 packet survives the widened persistence helpers with its digest unchanged', () => {
  const input = packet([proposal('primary', 'entity-primary', ITEM_PRIMARY)])
  // Snapshot every retained v1 decision before the version-agnostic helpers run.
  const before = JSON.stringify(input)
  const reduced = retainPrimaryDuplicateTarget(input)
  // A single-target packet passes through by reference; content is untouched.
  assert.equal(reduced, input)
  assert.equal(JSON.stringify(reduced), before)
  assert.equal(reduced.novelty, input.novelty)
  assert.equal(reduced.memberships[0]!.placement, input.memberships[0]!.placement)
  assert.equal(reduced.memberships[0]!.relationshipDecision, input.memberships[0]!.relationshipDecision)
  assert.equal(reduced.memberships[0]!.priorItemDecision, input.memberships[0]!.priorItemDecision)
})

test('v2 packet flows through the same digest path with decisions intact', () => {
  const input = packetV2([v2Proposal('primary', 'entity-primary', ITEM_PRIMARY, 'jev')])
  const before = JSON.stringify(input)
  const reduced = retainPrimaryDuplicateTarget(input)
  assert.equal(reduced, input)
  assert.equal(JSON.stringify(reduced), before)
  // The same sha256-of-canonical-json digest used for v1 receipts applies to
  // v2 content without special-casing.
  const first = digestForTest(input)
  const second = digestForTest(input)
  assert.equal(first, second)
  assert.match(first, /^[0-9a-f]{64}$/)
})

function digestForTest(value: unknown): string {
  // Mirrors article-persistence.digest(): sha256 over canonical JSON.
  return createHash('sha256').update(canonicalJson(value)).digest('hex')
}

test('commitArticle stores contextualHistory and relationSummary in the item effect payload (#340)', async () => {
  const { PostgresKnowledgeOperationWriter } = await import('./postgres-knowledge-writer')
  const writer = new PostgresKnowledgeOperationWriter({ connectionString: 'postgresql://writer_fixture@localhost/fixture' })
  let captured: unknown
  ;(writer as unknown as { pool: unknown }).pool = {
    query: async (_sql: string, params: unknown[]) => { captured = params[1]; return { rows: [{ result: { ok: true } }] } },
    end: async () => {},
  }
  const input = { ...packet([{ ...proposal('primary', 'entity-primary', ITEM_PRIMARY), relationSummary: 'Follows the earlier item.' }]),
    contextualHistory: 'primary Primary Entity: duplicate; linked to managed item managed-primary.' }
  await writer.commitArticle({
    operationId: 'op-1', workId: 'work-1', owner: 'owner', epoch: 1, packet: input, contextDigest: 'digest',
    contextWatermark: 'wm', targetRevisions: {}, entities: [], itemId: 'item-1', duplicateTarget: null,
  })
  const sent = (typeof captured === 'string' ? JSON.parse(captured) : captured) as { plan: { effect: Record<string, unknown> }, effects: Array<Record<string, unknown>> }
  assert.equal(sent.plan.effect.contextualHistory, input.contextualHistory)
  assert.equal(sent.effects[0]!.contextualHistory, input.contextualHistory)
  assert.equal((sent.plan.effect.memberships as Array<Record<string, unknown>>)[0]!.relationSummary, 'Follows the earlier item.')
})
