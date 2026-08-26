import assert from 'node:assert/strict'
import test from 'node:test'
import type { ResearchPacketV1, Signal } from '../signal-platform/contracts'
import {
  CanonicalPacketAdapterError,
  adaptCanonicalResearchPacket,
} from './canonical-packet-adapter'

const SOURCE_EXPECTATIONS: Record<Signal['sourceType'], { area: string, legacyType: string, contentKind: string }> = {
  news: { area: 'feed', legacyType: 'article', contentKind: 'article' },
  polymarket: { area: 'markets', legacyType: 'market_event', contentKind: 'market_event' },
  market_calendar: { area: 'events', legacyType: 'calendar_event', contentKind: 'calendar_event' },
  x: { area: 'social', legacyType: 'social_thread', contentKind: 'social_thread' },
}

function packet(
  sourceType: Signal['sourceType'] = 'news',
  overrides: Partial<ResearchPacketV1> = {},
): ResearchPacketV1 {
  const expected = SOURCE_EXPECTATIONS[sourceType]
  const contentSchema = `myboon.signal_content.${expected.contentKind}.v1`
  return {
    schemaVersion: 'myboon.research_packet.v1',
    packetId: 'packet-stable-1',
    workId: 'work-stable-1',
    signalId: 'signal-stable-1',
    sourceType,
    observedAt: '2026-08-26T10:00:00.000Z',
    sourceSignal: {
      signalId: 'signal-stable-1',
      workId: 'work-stable-1',
      sourceType,
      sourceId: `${sourceType}:source-item-1`,
      title: 'Canonical source title',
      canonicalUrl: 'https://example.com/source-item',
      publishedAt: '2026-08-26T09:55:00.000Z',
      provenance: {
        provider: 'fixture-provider',
        upstreamSource: 'Fixture Source',
        rawPayloadRef: 'raw-payload-1',
      },
      visibleSummary: 'Source supplied summary.',
      contentKind: expected.contentKind,
      content: {
        schemaVersion: contentSchema,
        sourceSpecificValue: `${sourceType}-detail`,
        ...(sourceType === 'market_calendar' ? { startAt: '2026-08-27T15:00:00.000Z' } : {}),
      },
      media: { imageUrl: 'https://example.com/image.jpg', attribution: 'Fixture Source' },
      sourceHints: { entities: ['Bitcoin'], assets: ['BTC'], eventId: 'event-1', deadline: null },
    },
    claims: [{
      claimId: 'claim-1',
      claim: 'A material event occurred.',
      attributedTo: 'Fixture Source',
      evidenceRefs: ['evidence-1'],
    }],
    verifiedFacts: [{ fact: 'The source document exists.', evidenceRefs: ['evidence-1'] }],
    unresolvedClaims: [{ claim: 'The effect is uncertain.', reason: 'Future outcome', evidenceRefs: ['evidence-1'] }],
    evidence: [{
      evidenceId: 'evidence-1',
      title: 'Primary evidence',
      url: 'https://example.com/evidence',
      sourceType: 'official',
      observedAt: '2026-08-26T09:55:00.000Z',
      note: 'Primary source',
    }],
    entityHints: [{
      name: 'Bitcoin',
      type: 'asset',
      role: 'subject',
      aliases: ['BTC'],
      source: 'synthesis',
      claimRefs: ['claim-1'],
      evidenceRefs: ['evidence-1'],
    }],
    limitations: ['Outcome is not yet known.'],
    openQuestions: ['What happens next?'],
    completion: 'complete',
    budgetUsed: {
      providerCalls: 1,
      repairCalls: 0,
      inputTokens: 120,
      outputTokens: 60,
      toolCalls: 0,
      wallTimeMs: 400,
      budgetExceeded: false,
    },
    execution: {
      provider: 'openai',
      model: 'fixture-model',
      fallbackProvider: null,
      fallbackModel: null,
      fallbackUsed: false,
      promptVersion: 'packet-prompt-v1',
      policyVersion: 'research-policy-v1',
      traceId: 'trace-1',
      attempt: 1,
    },
    researchContractVersion: 'myboon.research_packet.v1',
    createdAt: '2026-08-26T10:01:00.000Z',
    ...overrides,
  }
}

for (const sourceType of ['news', 'polymarket', 'market_calendar', 'x'] as const) {
  test(`registered ${sourceType} policy adapts canonical identity and source semantics`, () => {
    const canonical = packet(sourceType)
    const adapted = adaptCanonicalResearchPacket(canonical)
    const expected = SOURCE_EXPECTATIONS[sourceType]

    assert.equal(adapted.source, sourceType)
    assert.equal(adapted.sourceArea, expected.area)
    assert.equal(adapted.sourceType, expected.legacyType)
    assert.equal(adapted.sourceResearchId, canonical.packetId)
    assert.equal(adapted.sourceRefId, canonical.signalId)
    assert.equal(adapted.id, `canonical-packet:${canonical.packetId}`)
    assert.equal(adapted.context.content_kind, expected.contentKind)
    assert.deepEqual(adapted.context.content, canonical.sourceSignal.content)
  })
}

test('adapter preserves the complete rich canonical packet without data loss', () => {
  const canonical = packet('news')
  const adapted = adaptCanonicalResearchPacket(canonical)

  assert.deepEqual(adapted.context.canonical_packet, canonical)
  assert.deepEqual(adapted.context.claims, canonical.claims)
  assert.deepEqual(adapted.context.verified_facts, canonical.verifiedFacts)
  assert.deepEqual(adapted.context.unresolved_claims, canonical.unresolvedClaims)
  assert.deepEqual(adapted.context.evidence, canonical.evidence)
  assert.deepEqual(adapted.context.entity_hints, canonical.entityHints)
  assert.deepEqual(adapted.context.limitations, canonical.limitations)
  assert.deepEqual(adapted.context.open_questions, canonical.openQuestions)
  assert.deepEqual(adapted.context.source_signal, canonical.sourceSignal)
  assert.deepEqual(adapted.context.execution, canonical.execution)
  assert.deepEqual(adapted.context.budget_used, canonical.budgetUsed)
  assert.equal(adapted.context.trace_id, canonical.execution.traceId)
  assert.equal(adapted.context.policy_version, canonical.execution.policyVersion)
  assert.equal(adapted.context.research_contract_version, canonical.researchContractVersion)
})

test('repeat adaptation is deterministic and generated title changes do not affect replay identity', () => {
  const canonical = packet('news')
  assert.deepEqual(adaptCanonicalResearchPacket(canonical), adaptCanonicalResearchPacket(canonical))

  const renamed = packet('news', {
    sourceSignal: { ...canonical.sourceSignal, title: 'Different generated presentation title' },
  })
  const first = adaptCanonicalResearchPacket(canonical)
  const second = adaptCanonicalResearchPacket(renamed)
  assert.equal(second.sourceResearchId, first.sourceResearchId)
  assert.equal(second.sourceRefId, first.sourceRefId)
  assert.equal(second.id, first.id)
  assert.notEqual(second.title, first.title)
})

test('stable packet and signal identity are source-neutral across policies', () => {
  const news = adaptCanonicalResearchPacket(packet('news'))
  const market = adaptCanonicalResearchPacket(packet('polymarket'))

  assert.equal(news.sourceResearchId, market.sourceResearchId)
  assert.equal(news.sourceRefId, market.sourceRefId)
  assert.equal(news.id, market.id)
})

test('unknown source, wrong schema, and wrong linkage hard-fail', () => {
  assert.throws(
    () => adaptCanonicalResearchPacket({ ...packet(), sourceType: 'unknown_source' }),
    /sourceType/,
  )
  assert.throws(
    () => adaptCanonicalResearchPacket({ ...packet(), schemaVersion: 'myboon.research_packet.v2' }),
    (error: unknown) => error instanceof CanonicalPacketAdapterError
      && error.category === 'schema_version_mismatch',
  )
  assert.throws(
    () => adaptCanonicalResearchPacket({
      ...packet(),
      sourceSignal: { ...packet().sourceSignal, signalId: 'different-signal' },
    }),
    /does not match sourceSignal.signalId/,
  )
})

test('failed packets and policy-disallowed partial packets are rejected', () => {
  assert.throws(() => adaptCanonicalResearchPacket(packet('news', { completion: 'failed' })), /Failed Research Packet/)
  assert.throws(
    () => adaptCanonicalResearchPacket(packet('news', { completion: 'partial' })),
    /Partial Research Packet is disallowed/,
  )

  const calendar = adaptCanonicalResearchPacket(packet('market_calendar', { completion: 'partial' }))
  assert.equal(calendar.context.completion, 'partial')
  assert.equal(calendar.eventAt, '2026-08-27T15:00:00.000Z')
})

test('missing or dangling evidence linkage is rejected before Entity Manager', () => {
  const canonical = packet()
  assert.throws(
    () => adaptCanonicalResearchPacket(packet('news', {
      claims: [{ ...canonical.claims[0], evidenceRefs: ['missing-evidence'] }],
    })),
    /contains unknown ID: missing-evidence/,
  )
  assert.throws(
    () => adaptCanonicalResearchPacket(packet('news', {
      entityHints: [{ ...canonical.entityHints[0], claimRefs: [], evidenceRefs: [] }],
    })),
    /has no claim\/evidence linkage/,
  )
})
