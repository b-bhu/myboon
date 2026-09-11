import assert from 'node:assert/strict'
import test from 'node:test'
import type { ResearchPacketV1 } from '../signal-platform/contracts'
import {
  ENTITY_ADMISSION_KNOWLEDGE_SCHEMA_VERSION,
  EntityAdmissionKnowledgeValidationError,
  StaticEntityAdmissionKnowledgeProvider,
  legacyEntityTypeToKindV1,
  validateEntityAdmissionKnowledge,
  type EntityAdmissionKnowledgeContextV1,
  type EntityKnowledgeClassificationV1,
  type EntityKnowledgeRelationshipV1,
  type EntityKindV1,
} from './entity-knowledge-context'
import type { EntityRecord } from './types'

const REVIEW_REFERENCE = 'docs/modules/entity-manager/PRDs/2026_09_11_entity_knowledge_model_PRD.md#worked-knowledge-map'

const IDS = {
  solana: 'entity-solana-network',
  sol: 'entity-sol-asset',
  jupiter: 'entity-jupiter-protocol',
  jup: 'entity-jup-asset',
  jupiterMobile: 'entity-jupiter-mobile',
  polymarket: 'entity-polymarket-product',
} as const

function classification(
  scheme: EntityKnowledgeClassificationV1['scheme'],
  slug: string,
  name: string,
  path: string[] = [slug],
): EntityKnowledgeClassificationV1 {
  return {
    conceptId: `${scheme}:${slug}`,
    scheme,
    slug,
    name,
    path,
    verificationStatus: 'reviewed',
    provenance: { kind: 'reviewed_record', reference: REVIEW_REFERENCE },
  }
}

function relationship(
  predicate: EntityKnowledgeRelationshipV1['predicate'],
  id: string,
  slug: string,
  name: string,
  kind: EntityKindV1,
): EntityKnowledgeRelationshipV1 {
  return {
    predicate,
    direction: 'outgoing',
    relatedEntity: { id, slug, name, kind },
    verificationStatus: 'reviewed',
    provenance: { kind: 'reviewed_record', reference: REVIEW_REFERENCE },
  }
}

function context(
  entityId: string,
  kind: EntityKindV1,
  classifications: EntityKnowledgeClassificationV1[],
  relationships: EntityKnowledgeRelationshipV1[] = [],
): EntityAdmissionKnowledgeContextV1 {
  return {
    schemaVersion: ENTITY_ADMISSION_KNOWLEDGE_SCHEMA_VERSION,
    entityId,
    kind,
    classifications,
    relationships,
  }
}

const SCOPED_EXAMPLES: EntityAdmissionKnowledgeContextV1[] = [
  context(IDS.solana, 'network', [
    classification('domain', 'crypto', 'Crypto'),
    classification('ecosystem', 'solana', 'Solana ecosystem'),
    classification('function', 'layer-1-network', 'Layer-1 network'),
  ], [
    relationship('has_native_asset', IDS.sol, 'sol', 'SOL', 'asset'),
  ]),
  context(IDS.sol, 'asset', [
    classification('domain', 'crypto', 'Crypto'),
    classification('asset_class', 'native-token', 'Native token', ['crypto-asset', 'native-token']),
  ], [
    relationship('native_asset_of', IDS.solana, 'solana', 'Solana', 'network'),
  ]),
  context(IDS.jupiter, 'protocol', [
    classification('domain', 'crypto', 'Crypto'),
    classification('ecosystem', 'solana', 'Solana ecosystem'),
    classification('sector', 'defi', 'DeFi', ['financial-markets', 'defi']),
    classification('function', 'dex-aggregation', 'DEX aggregation', ['trading-product', 'dex-aggregation']),
  ], [
    relationship('operates_on', IDS.solana, 'solana', 'Solana', 'network'),
    relationship('has_token', IDS.jup, 'jup', 'JUP', 'asset'),
    relationship('has_product', IDS.jupiterMobile, 'jupiter-mobile', 'Jupiter Mobile', 'product'),
  ]),
  context(IDS.jup, 'asset', [
    classification('domain', 'crypto', 'Crypto'),
    classification('asset_class', 'governance-token', 'Governance token', ['crypto-asset', 'governance-token']),
  ], [
    relationship('token_of', IDS.jupiter, 'jupiter', 'Jupiter', 'protocol'),
    relationship('issued_on', IDS.solana, 'solana', 'Solana', 'network'),
  ]),
  context(IDS.jupiterMobile, 'product', [
    classification('domain', 'crypto', 'Crypto'),
    classification('ecosystem', 'solana', 'Solana ecosystem'),
    classification('function', 'wallet', 'Wallet'),
    classification('function', 'mobile-trading', 'Mobile trading', ['trading-product', 'mobile-trading']),
  ], [
    relationship('product_of', IDS.jupiter, 'jupiter', 'Jupiter', 'protocol'),
    relationship('operates_on', IDS.solana, 'solana', 'Solana', 'network'),
  ]),
  context(IDS.polymarket, 'product', [
    classification('domain', 'crypto', 'Crypto'),
    classification('sector', 'prediction-markets', 'Prediction markets', ['financial-markets', 'prediction-markets']),
    classification('function', 'trading-venue', 'Trading venue', ['trading-product', 'trading-venue']),
  ]),
]

function entity(id: string, slug: string, name: string, type = 'topic'): EntityRecord {
  return {
    id,
    slug,
    name,
    type,
    aliases: [name],
    summary: null,
    status: 'active',
    show_in_carousel: false,
    metadata: {},
  }
}

function packet(): ResearchPacketV1 {
  return {
    schemaVersion: 'myboon.research_packet.v1',
    packetId: 'packet-scoped-knowledge',
    workId: 'work-scoped-knowledge',
    signalId: 'signal-scoped-knowledge',
    sourceType: 'news',
    observedAt: '2026-09-11T00:00:00.000Z',
    sourceSignal: {
      title: 'Jupiter expands its product surface',
      canonicalUrl: 'https://example.com/jupiter',
      publishedAt: '2026-09-11T00:00:00.000Z',
      provenance: { provider: 'fixture', upstreamSource: 'Fixture', rawPayloadRef: 'fixture-1' },
    },
    claims: [],
    verifiedFacts: [],
    unresolvedClaims: [],
    evidence: [],
    entityHints: [],
    limitations: [],
    openQuestions: [],
    completion: 'complete',
    budgetUsed: {
      providerCalls: 0, repairCalls: 0, inputTokens: 0, outputTokens: 0,
      toolCalls: 0, wallTimeMs: 0, budgetExceeded: false,
    },
    execution: {
      provider: 'fixture', model: 'fixture', fallbackProvider: null, fallbackModel: null,
      fallbackUsed: false, promptVersion: 'fixture-v1', policyVersion: 'fixture-v1',
      traceId: 'trace-scoped-knowledge', attempt: 1,
    },
    researchContractVersion: 'myboon.research_packet.v1',
    createdAt: '2026-09-11T00:00:00.000Z',
  }
}

test('scoped Solana, Jupiter, and Polymarket examples form bounded reviewed admission context', () => {
  const contexts = validateEntityAdmissionKnowledge(SCOPED_EXAMPLES, new Set(Object.values(IDS)))

  assert.equal(contexts.length, 6)
  const jupiter = contexts.find((item) => item.entityId === IDS.jupiter)
  assert.equal(jupiter?.kind, 'protocol')
  assert.deepEqual(jupiter?.classifications.map((item) => item.conceptId), [
    'domain:crypto',
    'ecosystem:solana',
    'function:dex-aggregation',
    'sector:defi',
  ])
  assert.deepEqual(jupiter?.relationships.map((item) => item.predicate), [
    'has_product',
    'has_token',
    'operates_on',
  ])

  const polymarket = contexts.find((item) => item.entityId === IDS.polymarket)
  assert.equal(polymarket?.kind, 'product')
  assert.ok(polymarket?.classifications.some((item) => item.conceptId === 'sector:prediction-markets'))
})

test('legacy type projection is explicit and leaves ambiguous project/platform values unclassified', () => {
  assert.equal(legacyEntityTypeToKindV1('company'), 'organization')
  assert.equal(legacyEntityTypeToKindV1('protocol'), 'protocol')
  assert.equal(legacyEntityTypeToKindV1('commodity'), 'asset')
  assert.equal(legacyEntityTypeToKindV1('nation'), 'place')
  assert.equal(legacyEntityTypeToKindV1('project'), 'unclassified')
  assert.equal(legacyEntityTypeToKindV1('platform'), 'unclassified')
  assert.equal(legacyEntityTypeToKindV1('made-up-value'), 'unclassified')
})

test('static provider returns only requested reviewed profiles and defensive copies', async () => {
  const provider = new StaticEntityAdmissionKnowledgeProvider(SCOPED_EXAMPLES)
  const entities = [
    entity(IDS.jupiter, 'jupiter', 'Jupiter', 'project'),
    entity(IDS.jupiterMobile, 'jupiter-mobile', 'Jupiter Mobile', 'topic'),
  ]
  const first = await provider.getEntityAdmissionKnowledge({
    entities,
    packet: packet(),
    signal: new AbortController().signal,
  })
  assert.deepEqual(first.map((item) => item.entityId), [IDS.jupiterMobile, IDS.jupiter])

  first[0]!.classifications[0]!.path.push('mutation')
  const second = await provider.getEntityAdmissionKnowledge({
    entities,
    packet: packet(),
    signal: new AbortController().signal,
  })
  assert.equal(second[0]!.classifications[0]!.path.includes('mutation'), false)
})

test('validation rejects free-form kinds, concepts, predicates, duplicates, and unrequested entities', () => {
  const base = SCOPED_EXAMPLES[0]!
  assert.throws(
    () => validateEntityAdmissionKnowledge([{ ...base, kind: 'blockchain' }], new Set([base.entityId])),
    EntityAdmissionKnowledgeValidationError,
  )
  assert.throws(
    () => validateEntityAdmissionKnowledge([{
      ...base,
      classifications: [{ ...base.classifications[0]!, conceptId: 'domain:cryptocurrency' }],
    }], new Set([base.entityId])),
    /conceptId must equal/,
  )
  assert.throws(
    () => validateEntityAdmissionKnowledge([{
      ...base,
      relationships: [{ ...base.relationships[0]!, predicate: 'related_to' }],
    }], new Set([base.entityId])),
    EntityAdmissionKnowledgeValidationError,
  )
  assert.throws(
    () => validateEntityAdmissionKnowledge([base, base], new Set([base.entityId])),
    EntityAdmissionKnowledgeValidationError,
  )
  assert.throws(
    () => validateEntityAdmissionKnowledge([base], new Set(['some-other-entity'])),
    /unrequested Entity/,
  )
})
