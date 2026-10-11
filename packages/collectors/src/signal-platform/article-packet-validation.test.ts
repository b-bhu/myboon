import assert from 'node:assert/strict'
import test from 'node:test'
import { validateResearchPacket, validateLegacyResearchPacket, ContractValidationError } from './validation'

const V1 = 'myboon.research_packet.article.v1'
const V2 = 'myboon.research_packet.article.v2'
const ITEM_PRIMARY = 'managed-primary'
const ITEM_RELATED = 'managed-related'

type Decision = Record<string, unknown>
type Membership = Record<string, unknown>
type PacketFixture = Record<string, unknown>

/** v1 raw Jev Choice decision; validated by the unchanged v1 path. */
function v1Decision(choice: string): Decision {
  return { choice, probabilities: { [choice]: 1 }, confidence: 1, decisionId: `fixture:${choice}`, decisionVersion: 'fixture.v1' }
}

function v1Membership(role: 'primary' | 'related', entityId: string, itemId: string): Membership {
  return {
    entityId,
    placementDisposition: 'selected',
    role,
    name: role === 'primary' ? 'Primary Entity' : 'Related Entity',
    type: 'organization',
    aliases: [],
    summary: null,
    scope: {},
    creationProposal: null,
    creationDecision: null,
    placement: v1Decision(role === 'primary' ? entityId : 'related'),
    relationship: 'duplicate',
    relationshipDecision: v1Decision('duplicate'),
    priorItemDecision: v1Decision(itemId),
    priorItemId: itemId,
    priorItemSource: 'managed',
    duplicateTarget: { itemId, source: 'managed', entityId },
  }
}

/** Provider-aware v2 decision as it travels on the wire. */
function v2Decision(options: {
  provider: 'jev' | 'hermes'
  choice: string
  model?: string
  fallbackReason?: string
}): Decision {
  const { provider, choice } = options
  const decision: Decision = {
    provider,
    choice,
    decisionId: `fixture:${choice}`,
    decisionVersion: 'fixture.v2',
    model: options.model ?? 'fixture-model',
  }
  if (provider === 'jev') {
    decision.probabilities = { [choice]: 1 }
    decision.confidence = 1
  }
  if (options.fallbackReason !== undefined) decision.fallbackReason = options.fallbackReason
  return decision
}

/** Placement/relationship/prior-item choices mirror what a real packet retains. */
function v2Membership(options: {
  role: 'primary' | 'related'
  entityId: string
  itemId: string
  provider: 'jev' | 'hermes'
  model?: string
  fallbackReason?: string
}): Membership {
  const placementChoice = options.role === 'primary' ? options.entityId : 'related'
  return {
    entityId: options.entityId,
    placementDisposition: 'selected',
    role: options.role,
    name: options.role === 'primary' ? 'Primary Entity' : 'Related Entity',
    type: 'organization',
    aliases: [],
    summary: null,
    scope: {},
    creationProposal: null,
    creationDecision: null,
    placement: v2Decision({ provider: options.provider, choice: placementChoice, model: options.model, fallbackReason: options.fallbackReason }),
    relationship: 'duplicate',
    relationshipDecision: v2Decision({ provider: options.provider, choice: 'duplicate', model: options.model, fallbackReason: options.fallbackReason }),
    priorItemDecision: v2Decision({ provider: options.provider, choice: options.itemId, model: options.model, fallbackReason: options.fallbackReason }),
    priorItemId: options.itemId,
    priorItemSource: 'managed',
    duplicateTarget: { itemId: options.itemId, source: 'managed', entityId: options.entityId },
  }
}

function packet(schemaVersion: string, memberships: Membership[], novelty: Decision): PacketFixture {
  return {
    schemaVersion,
    packetKind: 'article',
    packetId: 'packet-1',
    workId: 'work-1',
    signalId: 'signal-1',
    sourceType: 'news',
    observedAt: '2026-10-06T00:00:00.000Z',
    sourceSignal: {
      sourceId: 'source-1',
      title: 'A source-backed development',
      canonicalUrl: 'https://example.com/article',
      publishedAt: null,
      provenance: { provider: 'fixture', upstreamSource: 'fixture', rawPayloadRef: 'fixture' },
    },
    article: {
      title: 'A source-backed development',
      timelineSummary: 'The source-backed development.',
      body: 'Captured body.',
      eventAt: null,
      sourceUrl: 'https://example.com/article',
      capturedText: 'Captured body.',
      capturedAt: '2026-10-06T00:00:00.000Z',
      contentHash: 'hash',
      truncated: false,
    },
    memberships,
    novelty,
    limitations: [],
    openQuestions: [],
    completion: 'complete',
    budgetUsed: { providerCalls: 0, repairCalls: 0, inputTokens: 0, outputTokens: 0, toolCalls: 0, wallTimeMs: 0, budgetExceeded: false },
    execution: {
      provider: 'fixture', model: 'fixture', fallbackProvider: null, fallbackModel: null,
      fallbackUsed: false, promptVersion: 'fixture', policyVersion: 'fixture', traceId: 'trace-1', attempt: 1,
    },
    researchContractVersion: 'myboon.research_packet.v1',
    createdAt: '2026-10-06T00:00:00.000Z',
  }
}

test('v1 article packet still validates on its unchanged path and stays refused by legacy consumers', () => {
  const input = packet(V1, [
    v1Membership('primary', 'entity-primary', ITEM_PRIMARY),
    v1Membership('related', 'entity-related', ITEM_RELATED),
  ], v1Decision('already_known'))
  const validated = validateResearchPacket(input)
  assert.equal(validated, input)
  assert.throws(() => validateLegacyResearchPacket(input), ContractValidationError)
})

test('v2 packet with jev decisions validates and retains truthful raw Choice data', () => {
  const input = packet(V2, [
    v2Membership({ role: 'primary', entityId: 'entity-primary', itemId: ITEM_PRIMARY, provider: 'jev' }),
    v2Membership({ role: 'related', entityId: 'entity-related', itemId: ITEM_RELATED, provider: 'jev' }),
  ], v2Decision({ provider: 'jev', choice: 'already_known', model: 'jev-model-1' }))
  const validated = validateResearchPacket(input)
  assert.equal(validated, input)
  const novelty = input.novelty as Decision
  assert.equal(novelty.provider, 'jev')
  assert.deepEqual(novelty.probabilities, { already_known: 1 })
  assert.equal(novelty.confidence, 1)
  assert.equal(novelty.model, 'jev-model-1')
})

test('v2 packet with hermes fallback decisions validates without probabilities or confidence', () => {
  const input = packet(V2, [
    v2Membership({ role: 'primary', entityId: 'entity-primary', itemId: ITEM_PRIMARY, provider: 'hermes', fallbackReason: 'provider_billing' }),
    v2Membership({ role: 'related', entityId: 'entity-related', itemId: ITEM_RELATED, provider: 'hermes', fallbackReason: 'provider_unavailable' }),
  ], v2Decision({ provider: 'hermes', choice: 'already_known', fallbackReason: 'provider_timeout' }))
  const validated = validateResearchPacket(input)
  assert.equal(validated, input)
  const placement = (input.memberships as Membership[])[0]!.placement as Decision
  assert.equal(placement.provider, 'hermes')
  assert.equal(placement.probabilities, undefined)
  assert.equal(placement.confidence, undefined)
  assert.equal(placement.fallbackReason, 'provider_billing')
  const novelty = input.novelty as Decision
  assert.equal(novelty.provider, 'hermes')
  assert.equal(novelty.fallbackReason, 'provider_timeout')
})

test('v2 hermes decision carrying probabilities is rejected', () => {
  const decision = v2Decision({ provider: 'hermes', choice: 'entity-primary', fallbackReason: 'provider_billing' })
  decision.probabilities = { 'entity-primary': 1 }
  const primary = v2Membership({ role: 'primary', entityId: 'entity-primary', itemId: ITEM_PRIMARY, provider: 'hermes', fallbackReason: 'provider_billing' })
  primary.placement = decision
  const input = packet(V2, [
    primary,
    v2Membership({ role: 'related', entityId: 'entity-related', itemId: ITEM_RELATED, provider: 'hermes', fallbackReason: 'provider_unavailable' }),
  ], v2Decision({ provider: 'hermes', choice: 'already_known', fallbackReason: 'provider_timeout' }))
  assert.throws(() => validateResearchPacket(input), /hermes decisions must not carry probabilities/)
})

test('v2 hermes decision carrying confidence is rejected', () => {
  const decision = v2Decision({ provider: 'hermes', choice: 'entity-primary', fallbackReason: 'provider_billing' })
  decision.confidence = 0.9
  const primary = v2Membership({ role: 'primary', entityId: 'entity-primary', itemId: ITEM_PRIMARY, provider: 'hermes', fallbackReason: 'provider_billing' })
  primary.placement = decision
  const input = packet(V2, [
    primary,
    v2Membership({ role: 'related', entityId: 'entity-related', itemId: ITEM_RELATED, provider: 'hermes', fallbackReason: 'provider_unavailable' }),
  ], v2Decision({ provider: 'hermes', choice: 'already_known', fallbackReason: 'provider_timeout' }))
  assert.throws(() => validateResearchPacket(input), /hermes decisions must not carry confidence/)
})

test('v2 hermes decision missing fallbackReason is rejected', () => {
  const decision = v2Decision({ provider: 'hermes', choice: 'entity-primary' })
  delete decision.fallbackReason
  const primary = v2Membership({ role: 'primary', entityId: 'entity-primary', itemId: ITEM_PRIMARY, provider: 'hermes' })
  primary.placement = decision
  const input = packet(V2, [
    primary,
    v2Membership({ role: 'related', entityId: 'entity-related', itemId: ITEM_RELATED, provider: 'hermes', fallbackReason: 'provider_unavailable' }),
  ], v2Decision({ provider: 'hermes', choice: 'already_known', fallbackReason: 'provider_timeout' }))
  assert.throws(() => validateResearchPacket(input), /fallbackReason: must be a non-empty string/)
})

test('v2 jev decision without probabilities or confidence is rejected', () => {
  const decision = v2Decision({ provider: 'jev', choice: 'entity-primary' })
  delete decision.probabilities
  delete decision.confidence
  const primary = v2Membership({ role: 'primary', entityId: 'entity-primary', itemId: ITEM_PRIMARY, provider: 'jev' })
  primary.placement = decision
  const input = packet(V2, [
    primary,
    v2Membership({ role: 'related', entityId: 'entity-related', itemId: ITEM_RELATED, provider: 'jev' }),
  ], v2Decision({ provider: 'jev', choice: 'already_known' }))
  assert.throws(() => validateResearchPacket(input), /jev decision requires raw probabilities and confidence/)
})

test('v2 decision requires a non-empty model on both provider branches', () => {
  const jevModel = v2Decision({ provider: 'jev', choice: 'entity-primary' })
  jevModel.model = '   '
  const jevPrimary = v2Membership({ role: 'primary', entityId: 'entity-primary', itemId: ITEM_PRIMARY, provider: 'jev' })
  jevPrimary.placement = jevModel
  const jevInput = packet(V2, [
    jevPrimary,
    v2Membership({ role: 'related', entityId: 'entity-related', itemId: ITEM_RELATED, provider: 'jev' }),
  ], v2Decision({ provider: 'jev', choice: 'already_known' }))
  assert.throws(() => validateResearchPacket(jevInput), /model: must be a non-empty string/)

  const hermesModel = v2Decision({ provider: 'hermes', choice: 'entity-primary' })
  delete hermesModel.model
  const hermesPrimary = v2Membership({ role: 'primary', entityId: 'entity-primary', itemId: ITEM_PRIMARY, provider: 'hermes' })
  hermesPrimary.placement = hermesModel
  const hermesInput = packet(V2, [
    hermesPrimary,
    v2Membership({ role: 'related', entityId: 'entity-related', itemId: ITEM_RELATED, provider: 'hermes', fallbackReason: 'provider_unavailable' }),
  ], v2Decision({ provider: 'hermes', choice: 'already_known', fallbackReason: 'provider_timeout' }))
  assert.throws(() => validateResearchPacket(hermesInput), /model: must be a non-empty string/)
})

test('v2 packet keeps v1 packet rules: primary exact duplicate conflicts with new or contradictory novelty', () => {
  const input = packet(V2, [
    v2Membership({ role: 'primary', entityId: 'entity-primary', itemId: ITEM_PRIMARY, provider: 'jev' }),
    v2Membership({ role: 'related', entityId: 'entity-related', itemId: ITEM_RELATED, provider: 'jev' }),
  ], v2Decision({ provider: 'jev', choice: 'new_information' }))
  assert.throws(() => validateResearchPacket(input), /primary exact duplicate conflicts with new or contradictory novelty/)
})

test('v2 packet keeps v1 packet rules: related-only already_known is held, not persisted', () => {
  const relatedOnly = v2Membership({ role: 'related', entityId: 'entity-related', itemId: ITEM_RELATED, provider: 'jev' })
  relatedOnly.duplicateTarget = null
  relatedOnly.contextualDuplicateTarget = { itemId: ITEM_RELATED, source: 'managed', entityId: 'entity-related' }
  const input = packet(V2, [relatedOnly], v2Decision({ provider: 'jev', choice: 'already_known' }))
  assert.throws(() => validateResearchPacket(input), /primary exact duplicate/i)
})