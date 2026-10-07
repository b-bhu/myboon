import assert from 'node:assert/strict'
import test from 'node:test'
import { RESEARCH_PACKET_SCHEMA_VERSION, type ArticleChoiceDecision, type ArticleEntityProposal, type ArticleResearchPacketV1 } from '../signal-platform/contracts'
import { validateResearchPacket } from '../signal-platform/validation'
import { ArticlePersistenceProcessor, retainPrimaryDuplicateTarget } from './article-persistence'

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
