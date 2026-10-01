import assert from 'node:assert/strict'
import test from 'node:test'
import type { ResearchPacketV1, ResearchWorkItem, RetrievedEvidence, Signal } from '../signal-platform/contracts'
import {
  CanonicalPacketAdapterError,
  adaptCanonicalResearchPacket,
} from './canonical-packet-adapter'
import type { ResearchReadinessV1 } from '../signal-platform/research-readiness'
import {
  NO_RESEARCH_ENTITY_ACTION,
  assessResearchReadiness,
  createResolvedWithoutNewItemReadiness,
} from '../signal-platform/research-readiness'
import {
  operatorEvidence,
  operatorPacket,
  operatorSignal,
  operatorWork,
} from '../signal-platform/operator-fixtures.test-support'

const HANDOFF_ID = 'handoff-1'

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

  assert.throws(
    () => adaptCanonicalResearchPacket(packet('market_calendar', { completion: 'partial' })),
    /Partial Research Packet is disallowed by market_calendar policy/,
  )
})

/**
 * A Research readiness decision plus the stored records it describes, all
 * produced by the real assessor so the test exercises the shipped contract.
 */
function readinessHandoff(overrides: {
  completion?: ResearchPacketV1['completion']
  readinessOverrides?: Record<string, unknown>
  persistedEvidence?: RetrievedEvidence[]
  workOverrides?: Partial<ResearchWorkItem>
} = {}) {
  const canonical = operatorPacket('news', HANDOFF_ID, {
    completion: overrides.completion ?? 'partial',
    claims: [{
      claimId: 'claim-handoff', claim: 'Ethena expanded USDe backing beyond crypto.',
      attributedTo: 'Ethena', evidenceRefs: [`evidence-${HANDOFF_ID}`],
    }],
    limitations: ['No independent verification of the backing claim.'],
    openQuestions: ['Which US enterprise payments partner is named?'],
  })
  const workItem = operatorWork('news', HANDOFF_ID, {
    status: 'entity_pending', ...overrides.workOverrides,
  })
  const persisted = overrides.persistedEvidence ?? [operatorEvidence(HANDOFF_ID)]
  const readiness = assessResearchReadiness({
    work: workItem,
    signal: operatorSignal('news', HANDOFF_ID),
    packet: canonical,
    persistedEvidence: persisted,
    assessedAt: '2026-08-26T10:46:00.000Z',
  })
  return {
    canonical,
    context: {
      work: workItem,
      signal: operatorSignal('news', HANDOFF_ID),
      persistedEvidence: persisted,
      readiness: { ...readiness, ...overrides.readinessOverrides } as ResearchReadinessV1,
    },
  }
}

test('a ready decision admits an attributed partial packet without a second sufficiency judgment', () => {
  const { canonical, context } = readinessHandoff()
  assert.equal(context.readiness.outcome, 'ready_for_entity')
  const adapted = adaptCanonicalResearchPacket(canonical, undefined, context)

  // The partial packet is preserved whole, including its limitations.
  assert.deepEqual(adapted.context.canonical_packet, canonical)
  assert.deepEqual(adapted.context.limitations, canonical.limitations)
  assert.deepEqual(adapted.context.open_questions, canonical.openQuestions)
  assert.equal(adapted.context.completion, 'partial')
  // The consumed decision travels with the packet.
  assert.equal((adapted.context.research_readiness as ResearchReadinessV1).outcome, 'ready_for_entity')
  assert.equal(adapted.context.adapter_version, 'myboon.entity_packet_adapter.v2')
})

test('a recorded non-ready outcome is refused as a Research decision, not reassessed', () => {
  for (const [outcome, category] of [
    ['blocked', 'retrieval_blocked'],
    ['failed', 'invalid_structured_output'],
    ['readiness_unknown', 'schema_version_mismatch'],
  ] as const) {
    // The packet is complete and admissible under the v1 rule, so a refusal here
    // can only come from consuming the decision.
    const { canonical, context } = readinessHandoff({
      completion: 'complete',
      readinessOverrides: { outcome, entityAction: NO_RESEARCH_ENTITY_ACTION, failureCategory: category },
    })
    assert.doesNotThrow(() => adaptCanonicalResearchPacket(canonical))
    assert.throws(
      () => adaptCanonicalResearchPacket(canonical, undefined, context),
      (error: unknown) => error instanceof CanonicalPacketAdapterError
        && new RegExp(`is ${outcome}`).test(error.message),
      outcome,
    )
  }
})

test('a no-new-item result that owes an attachment is admitted, and one that owes nothing is not', () => {
  const { canonical, context } = readinessHandoff()

  // No new note, but a required source attachment must still reach Entity, so the
  // decision is consumed and the partial packet is admitted as-is.
  const owed = createResolvedWithoutNewItemReadiness({
    work: context.work, signal: context.signal, packet: canonical,
    persistedEvidence: context.persistedEvidence, assessedAt: '2026-08-26T10:46:00.000Z',
    reason: 'Already covered, but the source must still be attached.',
    owedAttachment: { targetId: 'managed-item-42' },
  })
  assert.equal(owed.outcome, 'resolved_without_new_item')
  const adapted = adaptCanonicalResearchPacket(canonical, undefined, { ...context, readiness: owed })
  assert.equal(adapted.context.completion, 'partial')
  const carried = adapted.context.research_readiness as ResearchReadinessV1
  assert.equal(carried.outcome, 'resolved_without_new_item')
  assert.equal(carried.entityAction.kind, 'evidence_attachment')

  // A deliberate no-action result owes nothing, so there is no Entity work here.
  const none = createResolvedWithoutNewItemReadiness({
    work: context.work, signal: context.signal, packet: canonical,
    persistedEvidence: context.persistedEvidence, assessedAt: '2026-08-26T10:46:00.000Z',
    reason: 'Already represented by an accepted managed item.',
  })
  assert.throws(
    () => adaptCanonicalResearchPacket(canonical, undefined, { ...context, readiness: none }),
    /is resolved_without_new_item/,
  )
})

test('a decision whose linkage does not match the stored records is rejected', () => {
  const { canonical, context } = readinessHandoff()
  // A decision claiming readiness without a useful contribution is invalid on
  // its own terms, before linkage is even considered.
  assert.throws(
    () => adaptCanonicalResearchPacket(canonical, undefined, {
      ...context,
      readiness: { ...context.readiness, coverage: { ...context.readiness.coverage, useful: false } } as ResearchReadinessV1,
    }),
    /useful contribution/,
  )
  // Dropping the persisted evidence is a real linkage failure: the decision
  // cites evidence the store no longer holds for this work item.
  assert.throws(
    () => adaptCanonicalResearchPacket(canonical, undefined, { ...context, persistedEvidence: [] }),
    /not persisted for this work item/,
  )
  // Limitations that no longer match the packet are a linkage failure too.
  assert.throws(
    () => adaptCanonicalResearchPacket(canonical, undefined, {
      ...context, readiness: { ...context.readiness, limitations: [] } as ResearchReadinessV1,
    }),
    /limitations/,
  )
  // A decision whose identity does not cover its own work is forged.
  assert.throws(
    () => adaptCanonicalResearchPacket(canonical, undefined, {
      ...context, readiness: { ...context.readiness, workId: 'work-other' } as ResearchReadinessV1,
    }),
    /readinessId/,
  )
  // A signal that belongs to a different identity cannot validate the decision.
  assert.throws(
    () => adaptCanonicalResearchPacket(canonical, undefined, {
      ...context, signal: operatorSignal('news', 'other-signal'),
    }),
    /does not match its signal/,
  )
})

test('an old partial packet with no v2 decision is never auto-admitted', () => {
  // The validated-complete v1 path is preserved exactly.
  const legacy = adaptCanonicalResearchPacket(packet('news'))
  assert.equal(legacy.context.adapter_version, 'myboon.entity_packet_adapter.v1')
  assert.equal(legacy.context.research_readiness, null)
  // With no decision, a partial packet stays held rather than auto-admitted.
  const { canonical, context } = readinessHandoff()
  assert.equal(context.readiness.outcome, 'ready_for_entity')
  assert.throws(
    () => adaptCanonicalResearchPacket(canonical, undefined, { ...context, readiness: null }),
    /Partial Research Packet is disallowed/,
  )
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
