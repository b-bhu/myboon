import assert from 'node:assert/strict'
import test from 'node:test'
import type { ResearchPacketV1 } from '../signal-platform/contracts'
import {
  ENTITY_ADMISSION_MAX_SHORTLIST_SIZE,
  EntityAdmissionValidationError,
  EntityCanonUnavailableError,
  buildEntityAdmissionInput,
  validateEntityAdmissionDecision,
  type BuildEntityAdmissionInput,
  type CanonicalEntityRef,
} from './admission'

function packet(overrides: Partial<ResearchPacketV1> = {}): ResearchPacketV1 {
  return {
    schemaVersion: 'myboon.research_packet.v1',
    packetId: 'packet-1',
    workId: 'work-1',
    signalId: 'signal-1',
    sourceType: 'news',
    observedAt: '2026-08-26T10:00:00.000Z',
    sourceSignal: {
      title: 'Federal Reserve signals a policy change',
      canonicalUrl: 'https://example.com/story',
      publishedAt: '2026-08-26T09:55:00.000Z',
      provenance: { provider: 'example', upstreamSource: 'Example News', rawPayloadRef: 'raw-1' },
    },
    claims: [{
      claimId: 'claim-1',
      claim: 'The Federal Reserve changed its guidance.',
      attributedTo: 'Federal Reserve',
      evidenceRefs: ['evidence-1'],
    }],
    verifiedFacts: [{ fact: 'A statement was published.', evidenceRefs: ['evidence-1'] }],
    unresolvedClaims: [],
    evidence: [{
      evidenceId: 'evidence-1',
      title: 'Official statement',
      url: 'https://example.com/statement',
      sourceType: 'official',
      observedAt: '2026-08-26T09:55:00.000Z',
      note: null,
    }],
    entityHints: [{
      name: 'Federal Reserve',
      type: 'organization',
      role: 'subject',
      aliases: ['Fed', 'Federal Reserve', 'Fed'],
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
      policyVersion: 'research-v1',
      traceId: 'trace-1',
      attempt: 1,
    },
    researchContractVersion: 'myboon.research_packet.v1',
    createdAt: '2026-08-26T10:01:00.000Z',
    ...overrides,
  }
}

function entity(entityId: string, rank: number): CanonicalEntityRef {
  return {
    entityId,
    slug: entityId,
    name: entityId,
    type: 'organization',
    aliases: ['Zed', 'Alpha', 'Zed'],
    summary: null,
    rank,
  }
}

function buildInput(overrides: Partial<BuildEntityAdmissionInput> = {}): BuildEntityAdmissionInput {
  return {
    packet: packet(),
    canonicalEntityShortlist: [entity('entity-2', 1), entity('entity-1', 0)],
    evidenceSpans: [{
      spanId: 'span-1',
      evidenceId: 'evidence-1',
      claimRefs: ['claim-1'],
      text: 'The Federal Reserve changed its guidance.',
    }],
    shortlistPolicyVersion: 'entity-shortlist-v1',
    canonAvailability: { state: 'loaded', complete: true },
    ...overrides,
  }
}

test('builder creates a versioned deterministic bounded admission input from canonical packet data', () => {
  const input = buildInput()
  const admission = buildEntityAdmissionInput(input)

  assert.equal(admission.schemaVersion, 'myboon.entity_admission.v1')
  assert.equal(admission.packet, input.packet)
  assert.deepEqual(admission.canonicalEntityShortlist.map((item) => item.entityId), ['entity-1', 'entity-2'])
  assert.deepEqual(admission.canonicalEntityShortlist[0].aliases, ['Alpha', 'Zed'])
  assert.deepEqual(admission.entityHints[0].aliases, ['Fed', 'Federal Reserve'])
  assert.deepEqual(admission.entityHints[0].claimRefs, ['claim-1'])
  assert.notEqual(admission.entityHints, admission.packet.entityHints)
})

test('builder rejects unversioned policy, oversize shortlist, and duplicate entity IDs', () => {
  assert.throws(
    () => buildEntityAdmissionInput(buildInput({ shortlistPolicyVersion: 'latest' })),
    EntityAdmissionValidationError,
  )
  assert.throws(
    () => buildEntityAdmissionInput(buildInput({
      canonicalEntityShortlist: Array.from(
        { length: ENTITY_ADMISSION_MAX_SHORTLIST_SIZE + 1 },
        (_, index) => entity(`entity-${index}`, index),
      ),
    })),
    EntityAdmissionValidationError,
  )
  assert.throws(
    () => buildEntityAdmissionInput(buildInput({ canonicalEntityShortlist: [entity('duplicate', 0), entity('duplicate', 1)] })),
    EntityAdmissionValidationError,
  )
})

test('builder rejects packet, hint, and span references outside canonical claims and evidence', () => {
  const badPacketClaim = packet({
    claims: [{ claimId: 'claim-1', claim: 'Claim', attributedTo: null, evidenceRefs: ['missing-evidence'] }],
  })
  assert.throws(() => buildEntityAdmissionInput(buildInput({ packet: badPacketClaim })), /unknown ID: missing-evidence/)

  const badHint = packet({
    entityHints: [{
      name: 'Federal Reserve', type: null, role: null, aliases: [], source: null,
      claimRefs: ['missing-claim'], evidenceRefs: [],
    }],
  })
  assert.throws(() => buildEntityAdmissionInput(buildInput({ packet: badHint })), /unknown ID: missing-claim/)

  assert.throws(() => buildEntityAdmissionInput(buildInput({
    evidenceSpans: [{ spanId: 'span-1', evidenceId: 'missing-evidence', claimRefs: [], text: 'Unsupported' }],
  })), /unknown ID: missing-evidence/)
})

test('every entity hint must be explicitly traceable', () => {
  const untraceable = packet({
    entityHints: [{
      name: 'Federal Reserve', type: null, role: null, aliases: [], source: null,
      claimRefs: [], evidenceRefs: [],
    }],
  })
  assert.throws(
    () => buildEntityAdmissionInput(buildInput({ packet: untraceable })),
    /must reference a packet claim or evidence item/,
  )
})

test('decision can select only a canonical entity supplied in the shortlist', () => {
  const admission = buildEntityAdmissionInput(buildInput())
  const selected = validateEntityAdmissionDecision(admission, {
    action: 'select_existing',
    entityId: 'entity-1',
    supportingClaimIds: ['claim-1'],
  })
  assert.equal(selected.action, 'select_existing')
  assert.throws(
    () => validateEntityAdmissionDecision(admission, { action: 'select_existing', entityId: 'entity-unknown' }),
    /Unknown canonical entity ID/,
  )
})

test('create_new requires evidence and a complete loaded canon', () => {
  const admission = buildEntityAdmissionInput(buildInput())
  const created = validateEntityAdmissionDecision(admission, {
    action: 'create_new',
    proposal: { slug: 'federal-reserve-policy', name: 'Federal Reserve Policy', type: 'topic' },
    supportingClaimIds: ['claim-1'],
  })
  assert.equal(created.action, 'create_new')
  assert.deepEqual(created.supportingClaimIds, ['claim-1'])

  assert.throws(
    () => validateEntityAdmissionDecision(admission, {
      action: 'create_new',
      proposal: { slug: 'unsupported', name: 'Unsupported', type: 'topic' },
    }),
    /requires supporting packet evidence/,
  )

  for (const canonAvailability of [
    { state: 'unavailable', complete: false } as const,
    { state: 'loaded', complete: false } as const,
  ]) {
    const withoutCanon = buildEntityAdmissionInput(buildInput({ canonAvailability }))
    assert.throws(
      () => validateEntityAdmissionDecision(withoutCanon, {
        action: 'create_new',
        proposal: { slug: 'new-entity', name: 'New Entity', type: 'topic' },
        supportingEvidenceIds: ['evidence-1'],
      }),
      (error: unknown) => error instanceof EntityCanonUnavailableError
        && error.category === 'storage_transient'
        && error.retryable,
    )
  }
})
