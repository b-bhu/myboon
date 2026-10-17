import assert from 'node:assert/strict'
import test from 'node:test'
import {
  ARTICLE_RESEARCH_PACKET_SCHEMA_VERSION, ARTICLE_RESEARCH_PACKET_V2_SCHEMA_VERSION, RESEARCH_PACKET_SCHEMA_VERSION,
  type ArticleChoiceDecision, type ArticleDecisionV2, type ArticleEntityProposal, type ArticleResearchPacketV1,
  type ArticleResearchPacketV2, type ArticleV2EntityProposal,
} from '../signal-platform/contracts'
import {
  ENTITY_SUMMARY_MAX_CHARS, decideEntitySummaryUpdates, logEntitySummaryDecisions, type EntitySummaryDecision,
} from './entity-summary-update'
import type { ManagedEntityBinding } from './postgres-knowledge-writer'

const WORK_ID = 'work-1'
const APPLIED_SUMMARY = 'Primary Entity now faces a fresh regulatory review.'

function decision(choice: string, confidence = 0.9): ArticleChoiceDecision {
  return { choice, probabilities: { [choice]: 1 }, confidence, decisionId: `fixture:${choice}`, decisionVersion: 'fixture.v1' }
}

function v2Jev(choice: string, confidence = 0.9): Extract<ArticleDecisionV2, { provider: 'jev' }> {
  return { provider: 'jev', choice, probabilities: { [choice]: 1 }, confidence, decisionId: `fixture:${choice}`, decisionVersion: 'fixture.v2', model: 'fixture-jev-model' }
}

function v2Hermes(choice: string): Extract<ArticleDecisionV2, { provider: 'hermes' }> {
  return { provider: 'hermes', choice, decisionId: `fixture:${choice}`, decisionVersion: 'fixture.v2', model: 'fixture-hermes-model', fallbackReason: 'provider_billing' }
}

function membership(overrides: Partial<ArticleEntityProposal> = {}): ArticleEntityProposal {
  return {
    entityId: 'entity-primary',
    placementDisposition: 'selected',
    role: 'primary',
    name: 'Primary Entity',
    type: 'organization', aliases: [], summary: null, scope: {},
    creationProposal: null, creationDecision: null,
    placement: decision('entity-primary'),
    relationship: 'direct_continuation', relationshipDecision: decision('direct_continuation'),
    priorItemDecision: decision('managed-primary'), priorItemId: 'managed-primary', priorItemSource: 'managed',
    duplicateTarget: null,
    itemSummary: 'Primary Entity filed new paperwork.',
    updatedEntitySummary: APPLIED_SUMMARY,
    ...overrides,
  }
}

function v2Membership(overrides: Partial<ArticleV2EntityProposal> = {}): ArticleV2EntityProposal {
  return {
    entityId: 'entity-primary',
    placementDisposition: 'selected',
    role: 'primary',
    name: 'Primary Entity',
    type: 'organization', aliases: [], summary: null, scope: {},
    creationProposal: null, creationDecision: null,
    placement: v2Jev('entity-primary'),
    relationship: 'direct_continuation', relationshipDecision: v2Jev('direct_continuation'),
    priorItemDecision: v2Jev('managed-primary'), priorItemId: 'managed-primary', priorItemSource: 'managed',
    duplicateTarget: null,
    itemSummary: 'Primary Entity filed new paperwork.',
    updatedEntitySummary: APPLIED_SUMMARY,
    ...overrides,
  }
}

function packet(memberships: ArticleEntityProposal[], novelty: ArticleChoiceDecision = decision('new_information')): ArticleResearchPacketV1 {
  return {
    schemaVersion: ARTICLE_RESEARCH_PACKET_SCHEMA_VERSION, packetKind: 'article', packetId: 'packet-1',
    workId: WORK_ID, signalId: 'signal-1', sourceType: 'news', observedAt: '2026-10-06T00:00:00.000Z',
    sourceSignal: {
      sourceId: 'source-1', title: 'A source-backed development', canonicalUrl: 'https://example.com/article',
      publishedAt: null, provenance: { provider: 'fixture', upstreamSource: 'fixture', rawPayloadRef: 'fixture' },
    },
    article: {
      title: 'A source-backed development', timelineSummary: 'The source-backed development.', body: 'Captured body.',
      eventAt: null, sourceUrl: 'https://example.com/article', capturedText: 'Captured body.',
      capturedAt: '2026-10-06T00:00:00.000Z', contentHash: 'hash', truncated: false,
    },
    memberships, novelty, completion: 'complete',
    budgetUsed: { providerCalls: 0, repairCalls: 0, inputTokens: 0, outputTokens: 0, toolCalls: 0, wallTimeMs: 0, budgetExceeded: false },
    researchContractVersion: RESEARCH_PACKET_SCHEMA_VERSION, createdAt: '2026-10-06T00:00:00.000Z',
  }
}

function packetV2(memberships: ArticleV2EntityProposal[], novelty: ArticleDecisionV2 = v2Jev('new_information')): ArticleResearchPacketV2 {
  return {
    schemaVersion: ARTICLE_RESEARCH_PACKET_V2_SCHEMA_VERSION, packetKind: 'article', packetId: 'packet-2',
    workId: WORK_ID, signalId: 'signal-2', sourceType: 'news', observedAt: '2026-10-06T00:00:00.000Z',
    sourceSignal: {
      sourceId: 'source-2', title: 'A source-backed development', canonicalUrl: 'https://example.com/article',
      publishedAt: null, provenance: { provider: 'fixture', upstreamSource: 'fixture', rawPayloadRef: 'fixture' },
    },
    article: {
      title: 'A source-backed development', timelineSummary: 'The source-backed development.', body: 'Captured body.',
      eventAt: null, sourceUrl: 'https://example.com/article', capturedText: 'Captured body.',
      capturedAt: '2026-10-06T00:00:00.000Z', contentHash: 'hash', truncated: false,
    },
    memberships, novelty, completion: 'complete',
    budgetUsed: { providerCalls: 0, repairCalls: 0, inputTokens: 0, outputTokens: 0, toolCalls: 0, wallTimeMs: 0, budgetExceeded: false },
    researchContractVersion: RESEARCH_PACKET_SCHEMA_VERSION, createdAt: '2026-10-06T00:00:00.000Z',
  }
}

function binding(overrides: Partial<ManagedEntityBinding> = {}): ManagedEntityBinding {
  return {
    id: 'entity-primary', slug: 'primary-entity', name: 'Primary Entity', type: 'organization', aliases: [],
    summary: 'Primary Entity is a long-standing market participant.',
    status: 'active', show_in_carousel: false, metadata: {}, revision: 'entity-revision-1',
    catalogEntityId: null, identityKey: 'catalog:primary-entity',
    ...overrides,
  }
}

function decide(input: ArticleResearchPacketV1 | ArticleResearchPacketV2, entities: readonly ManagedEntityBinding[], placementFloor = 0.6, duplicateTarget: { itemId: string, source: 'legacy' | 'managed', entityId: string } | null = null) {
  return decideEntitySummaryUpdates({ packet: input, entities, duplicateTarget, placementFloor })
}

function updateDecision(outcome: EntitySummaryDecision['outcome'], reason: string, proposedSummary: string | null, overrides: Partial<EntitySummaryDecision> = {}): EntitySummaryDecision {
  return { entityId: 'entity-primary', name: 'Primary Entity', role: 'primary', outcome, reason, proposedSummary, ...overrides }
}

test('a confident new_information direct continuation applies the trimmed updated summary', () => {
  assert.equal(ENTITY_SUMMARY_MAX_CHARS, 1200)
  const input = packet([membership({ updatedEntitySummary: `  Primary Entity   now faces a fresh regulatory review.  ` })])
  const result = decide(input, [binding()])
  assert.deepEqual(result.updates, [{ entityId: 'entity-primary', summary: APPLIED_SUMMARY }])
  assert.deepEqual(result.decisions, [updateDecision('update', 'conditions_met', APPLIED_SUMMARY)])
})

test('a confident related_story_branch membership applies the updated summary', () => {
  const input = packet([membership({
    role: 'related', name: 'Related Entity', entityId: 'entity-related',
    placement: decision('related'), relationship: 'related_story_branch', relationshipDecision: decision('related_story_branch'),
    updatedEntitySummary: 'Related Entity now publishes weekly position updates.',
  })])
  const related = binding({ id: 'entity-related', slug: 'related-entity', name: 'Related Entity', identityKey: 'catalog:related-entity', summary: 'Related Entity holds its earlier position.' })
  const result = decide(input, [related])
  assert.deepEqual(result.updates, [{ entityId: 'entity-related', summary: 'Related Entity now publishes weekly position updates.' }])
  assert.deepEqual(result.decisions, [updateDecision('update', 'conditions_met', 'Related Entity now publishes weekly position updates.', { entityId: 'entity-related', name: 'Related Entity', role: 'related' })])
})

test('a same_topic_only related membership is kept while the primary still updates', () => {
  const related = membership({
    role: 'related', name: 'Related Entity', entityId: 'entity-related',
    placement: decision('related'), relationship: 'same_topic_only', relationshipDecision: decision('same_topic_only'),
  })
  const result = decide(packet([membership(), related]), [
    binding(),
    binding({ id: 'entity-related', slug: 'related-entity', name: 'Related Entity', identityKey: 'catalog:related-entity' }),
  ])
  assert.deepEqual(result.updates, [{ entityId: 'entity-primary', summary: APPLIED_SUMMARY }])
  assert.deepEqual(result.decisions, [
    updateDecision('update', 'conditions_met', APPLIED_SUMMARY),
    updateDecision('kept', 'relationship_same_topic_only', null, { entityId: 'entity-related', name: 'Related Entity', role: 'related' }),
  ])
})

test('already_known novelty keeps the summary, and an exact duplicate target keeps it as duplicate', () => {
  const known = packet([membership()], decision('already_known'))
  const noTarget = decide(known, [binding()])
  assert.deepEqual(noTarget.updates, [])
  assert.deepEqual(noTarget.decisions, [updateDecision('kept', 'novelty_already_known', null)])

  const articleDuplicate = decide(known, [binding()], 0.6, { itemId: 'managed-duplicate', source: 'managed', entityId: 'entity-primary' })
  assert.deepEqual(articleDuplicate.updates, [])
  assert.deepEqual(articleDuplicate.decisions, [updateDecision('kept', 'duplicate', null)])

  const membershipDuplicate = decide(packet([membership({ relationship: 'duplicate', relationshipDecision: decision('duplicate'), duplicateTarget: { itemId: 'managed-duplicate', source: 'managed', entityId: 'entity-primary' } })]), [binding()])
  assert.deepEqual(membershipDuplicate.updates, [])
  assert.deepEqual(membershipDuplicate.decisions, [updateDecision('kept', 'duplicate', null)])
})

test('uncertain novelty keeps the summary without updates', () => {
  const result = decide(packet([membership()], decision('uncertain')), [binding()])
  assert.deepEqual(result.updates, [])
  assert.deepEqual(result.decisions, [updateDecision('kept', 'novelty_uncertain', null)])
})

test('contradicts_prior novelty holds the proposed summary for review without applying it', () => {
  const result = decide(packet([membership()], decision('contradicts_prior')), [binding()])
  assert.deepEqual(result.updates, [])
  assert.deepEqual(result.decisions, [updateDecision('held_for_review', 'novelty_contradicts_prior', APPLIED_SUMMARY)])
})

test('a missing or empty updatedEntitySummary is kept without updates', () => {
  const missing = decide(packet([membership({ updatedEntitySummary: null })]), [binding()])
  assert.deepEqual(missing.updates, [])
  assert.deepEqual(missing.decisions, [updateDecision('kept', 'summary_missing', null)])

  const empty = decide(packet([membership({ updatedEntitySummary: '   ' })]), [binding()])
  assert.deepEqual(empty.updates, [])
  assert.deepEqual(empty.decisions, [updateDecision('kept', 'summary_empty', null)])
})

test('a summary beyond the 1200-character ceiling is kept without updates', () => {
  const result = decide(packet([membership({ updatedEntitySummary: `Primary Entity ${'x'.repeat(1186)}` })]), [binding()])
  assert.deepEqual(result.updates, [])
  assert.deepEqual(result.decisions, [updateDecision('kept', 'summary_too_long', null)])
})

test('a summary that does not name the entity is kept without updates', () => {
  const result = decide(packet([membership({ updatedEntitySummary: 'Completely unrelated market chatter appears here.' })]), [binding()])
  assert.deepEqual(result.updates, [])
  assert.deepEqual(result.decisions, [updateDecision('kept', 'summary_not_about_entity', null)])
})

test('a summary identical to the current one, including modulo whitespace, is kept without updates', () => {
  const identical = decide(packet([membership({ updatedEntitySummary: 'Primary Entity is a long-standing market participant.' })]), [binding()])
  assert.deepEqual(identical.decisions, [updateDecision('kept', 'summary_unchanged', null)])

  const whitespaceOnly = decide(packet([membership({ updatedEntitySummary: '  Primary   Entity is a long-standing market participant. ' })]), [binding()])
  assert.deepEqual(whitespaceOnly.decisions, [updateDecision('kept', 'summary_unchanged', null)])
  assert.deepEqual(identical.updates, [])
  assert.deepEqual(whitespaceOnly.updates, [])
})

test('a summary naming no resolvable entity binding is kept without updates', () => {
  const result = decide(packet([membership({ entityId: 'entity-ghost' })]), [])
  assert.deepEqual(result.updates, [])
  assert.deepEqual(result.decisions, [updateDecision('kept', 'entity_binding_missing', null, { entityId: 'entity-ghost' })])
})

test('an alias match counts as naming the entity', () => {
  const fed = binding({ id: 'entity-fed', slug: 'federal-reserve', name: 'Federal Reserve', aliases: ['Fed'], summary: 'The Federal Reserve sets policy rates.', identityKey: 'catalog:federal-reserve' })
  const result = decide(packet([membership({
    entityId: 'entity-fed', name: 'FOMC Watch',
    updatedEntitySummary: 'The Fed held rates steady this week.',
  })]), [fed])
  assert.deepEqual(result.updates, [{ entityId: 'entity-fed', summary: 'The Fed held rates steady this week.' }])
  assert.deepEqual(result.decisions, [updateDecision('update', 'conditions_met', 'The Fed held rates steady this week.', { entityId: 'entity-fed', name: 'FOMC Watch' })])
})

test('placement uncertainty, floor failures and unscored decisions keep the summary', () => {
  const uncertain = decide(packet([membership({ placementUncertain: true, placementConfidence: 0.9 })]), [binding()])
  assert.deepEqual(uncertain.decisions, [updateDecision('kept', 'placement_uncertain', null)])

  const belowFloor = decide(packet([membership({ placementUncertain: false, placementConfidence: 0.5 })]), [binding()])
  assert.deepEqual(belowFloor.decisions, [updateDecision('kept', 'placement_below_floor', null)])

  const atFloor = decide(packet([membership({ placementUncertain: false, placementConfidence: 0.6 })]), [binding()])
  assert.deepEqual(atFloor.decisions, [updateDecision('update', 'conditions_met', APPLIED_SUMMARY)])

  assert.deepEqual(uncertain.updates, [])
  assert.deepEqual(belowFloor.updates, [])
})

test('a v2 hermes placement decision is unscored while a v2 jev decision falls back to its own confidence', () => {
  const input = packetV2([
    v2Membership({ placement: v2Hermes('entity-primary') }),
    v2Membership({
      entityId: 'entity-related', role: 'related', name: 'Related Entity',
      placement: v2Jev('related'), relationship: 'related_story_branch', relationshipDecision: v2Jev('related_story_branch'),
      updatedEntitySummary: 'Related Entity now publishes weekly position updates.',
    }),
  ])
  const result = decide(input, [
    binding(),
    binding({ id: 'entity-related', slug: 'related-entity', name: 'Related Entity', identityKey: 'catalog:related-entity' }),
  ])
  assert.deepEqual(result.decisions, [
    updateDecision('kept', 'placement_unscored', null),
    updateDecision('update', 'conditions_met', 'Related Entity now publishes weekly position updates.', { entityId: 'entity-related', name: 'Related Entity', role: 'related' }),
  ])
  assert.deepEqual(result.updates, [{ entityId: 'entity-related', summary: 'Related Entity now publishes weekly position updates.' }])
})

test('a no_match membership keeps its creation summary', () => {
  const result = decide(packet([membership({
    entityId: null, placementDisposition: 'no_match', name: 'Nova Protocol',
    placement: decision('no_match'), relationship: null, relationshipDecision: null,
    priorItemDecision: null, priorItemId: null, priorItemSource: null,
    creationProposal: { name: 'Nova Protocol', type: 'protocol', aliases: [], summary: 'A source-grounded identity proposal.', scope: {} },
    creationDecision: decision('accept'),
  })]), [])
  assert.deepEqual(result.updates, [])
  assert.deepEqual(result.decisions, [updateDecision('kept', 'new_or_unresolved_entity', null, { entityId: null, name: 'Nova Protocol' })])
})

test('a second membership for the same entity is kept as a duplicate entity membership', () => {
  const result = decide(packet([membership(), membership({ priorItemId: 'managed-second' })]), [binding()])
  assert.deepEqual(result.updates, [{ entityId: 'entity-primary', summary: APPLIED_SUMMARY }])
  assert.deepEqual(result.decisions, [
    updateDecision('update', 'conditions_met', APPLIED_SUMMARY),
    updateDecision('kept', 'duplicate_entity_membership', null),
  ])
})

test('logEntitySummaryDecisions emits one JSON audit line per decision', () => {
  const decisions: EntitySummaryDecision[] = [
    updateDecision('update', 'conditions_met', APPLIED_SUMMARY),
    updateDecision('held_for_review', 'novelty_contradicts_prior', APPLIED_SUMMARY),
    updateDecision('kept', 'placement_below_floor', null, { role: 'related' }),
  ]
  const original = console.info
  const lines: string[] = []
  console.info = (...args: unknown[]) => { lines.push(String(args[0])) }
  try {
    logEntitySummaryDecisions(WORK_ID, decisions)
  } finally {
    console.info = original
  }
  assert.equal(lines.length, 3)
  const parsed = lines.map((line) => {
    assert.match(line, /^\[entity-manager:summary\] /)
    return JSON.parse(line.slice('[entity-manager:summary] '.length)) as Record<string, unknown>
  })
  assert.deepEqual(parsed, [
    { event: 'entity_summary_decision', workId: WORK_ID, entityId: 'entity-primary', name: 'Primary Entity', role: 'primary', outcome: 'update', reason: 'conditions_met' },
    { event: 'entity_summary_decision', workId: WORK_ID, entityId: 'entity-primary', name: 'Primary Entity', role: 'primary', outcome: 'held_for_review', reason: 'novelty_contradicts_prior' },
    { event: 'entity_summary_decision', workId: WORK_ID, entityId: 'entity-primary', name: 'Primary Entity', role: 'related', outcome: 'kept', reason: 'placement_below_floor' },
  ])
})