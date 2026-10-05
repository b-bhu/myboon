import { validateLegacyResearchReadiness } from './research-readiness'
import assert from 'node:assert/strict'
import test from 'node:test'
import {
  RESEARCH_PACKET_SCHEMA_VERSION,
  RESEARCH_WORK_SCHEMA_VERSION,
  RETRIEVED_EVIDENCE_SCHEMA_VERSION,
  SIGNAL_SCHEMA_VERSION,
  type ResearchPacketV1,
  type ResearchWorkItem,
  type RetrievedEvidence,
  type Signal,
} from './contracts'
import {
  NO_RESEARCH_ENTITY_ACTION,
  RESEARCH_READINESS_POLICY_VERSION,
  RESEARCH_READINESS_SCHEMA_VERSION,
  assessResearchReadiness,
  createBlockedReadiness,
  createReadinessUnknownReadiness,
  createResolvedWithoutNewItemReadiness,
  isNonClaimableReadiness,
  owesResearchEntityAction,
  researchEntityActionId,
  researchHandoffEntityClaim,
  researchHandoffTerminalStatus,
  researchHandoffWorkStatus,
  researchReadinessId,
  validateResearchReadiness,
  validateResearchReadinessLinkage,
} from './research-readiness'
import { ContractValidationError } from './validation'

const NOW = '2026-08-26T12:00:00.000Z'
const ASSESSED_AT = '2026-08-26T12:00:05.000Z'

function signal(): Signal {
  return {
    schemaVersion: SIGNAL_SCHEMA_VERSION, signalId: 'signal-1', sourceType: 'news',
    sourceId: 'news:source:1', contentKind: 'article',
    content: { schemaVersion: 'myboon.signal_content.article.v1' },
    observedAt: '2026-08-26T11:00:00.000Z', publishedAt: '2026-08-26T10:55:00.000Z',
    canonicalUrl: 'https://example.com/ethena', title: 'Ethena Looks Beyond Crypto to Support USDe',
    visibleSummary: 'Source summary.', media: { imageUrl: null, attribution: 'Example' },
    sourceHints: { entities: ['Ethena'], assets: ['USDe'], eventId: null, deadline: null },
    provenance: { provider: 'fixture', upstreamSource: 'Example', rawPayloadRef: 'raw-1' },
    idempotencyKey: 'news:key:1',
  } as Signal
}

function work(overrides: Partial<ResearchWorkItem> = {}): ResearchWorkItem {
  return {
    schemaVersion: RESEARCH_WORK_SCHEMA_VERSION, workId: 'work-1', signalId: 'signal-1',
    sourceType: 'news', researchDepth: 'standard', deepReason: null,
    priorityClass: 'P1', priorityScore: 0.5, freshnessDeadline: '2026-08-26T18:00:00.000Z',
    policyVersion: 'policy.v1', researchContractVersion: RESEARCH_PACKET_SCHEMA_VERSION,
    retrievalPlan: { sourceUrl: 'https://example.com/ethena', allowedDomains: ['example.com'], maxExternalSources: 2 },
    budget: { maxProviderCalls: 2, maxRepairCalls: 1, maxToolCalls: 0, maxWallTimeMs: 30_000 },
    status: 'synthesis_leased', attemptCount: 1, nextAttemptAt: null,
    leaseOwner: 'worker-1', leaseId: 'lease-1', leaseExpiresAt: '2026-08-26T12:05:00.000Z',
    failureCategory: null, failureDetail: null, traceId: 'trace-1',
    createdAt: '2026-08-26T11:30:00.000Z', updatedAt: '2026-08-26T11:59:00.000Z',
    ...overrides,
  }
}

function evidence(id = 'evidence-1'): RetrievedEvidence {
  return {
    schemaVersion: RETRIEVED_EVIDENCE_SCHEMA_VERSION, evidenceId: id, workId: 'work-1',
    requestedUrl: 'https://example.com/ethena', finalUrl: 'https://example.com/ethena',
    authority: 'source_url', authorityId: 'signal-1', contentHash: 'hash-1',
    contentType: 'text/html', httpStatus: 200, retrievalMethod: 'safe_http',
    retrievedAt: NOW, text: 'Article body', truncated: false, byteLength: 100,
  }
}

/** The Ethena shape: attributed claims, zero verified facts, open questions. */
function packet(overrides: Partial<ResearchPacketV1> = {}): ResearchPacketV1 {
  return {
    schemaVersion: RESEARCH_PACKET_SCHEMA_VERSION, packetId: 'packet-1', workId: 'work-1',
    signalId: 'signal-1', sourceType: 'news', observedAt: '2026-08-26T11:00:00.000Z',
    sourceSignal: {
      title: 'Ethena Looks Beyond Crypto to Support USDe',
      canonicalUrl: 'https://example.com/ethena',
      publishedAt: '2026-08-26T10:55:00.000Z',
      provenance: { provider: 'fixture', upstreamSource: 'Example', rawPayloadRef: 'raw-1' },
    },
    claims: [
      { claimId: 'claim-1', claim: 'Ethena says USDe backing extends beyond crypto.', attributedTo: 'Ethena', evidenceRefs: ['evidence-1'] },
      { claimId: 'claim-2', claim: 'The expansion targets US enterprise payments.', attributedTo: 'Ethena', evidenceRefs: ['evidence-1'] },
    ],
    verifiedFacts: [],
    unresolvedClaims: [],
    evidence: [{
      evidenceId: 'evidence-1', title: 'Ethena article', url: 'https://example.com/ethena',
      sourceType: 'source_url', observedAt: NOW, note: null,
    }],
    entityHints: [{
      name: 'Ethena', type: 'organization', role: 'subject', aliases: [], source: 'synthesis',
      claimRefs: ['claim-1'], evidenceRefs: ['evidence-1'],
    }],
    limitations: ['No independent verification of the USDe backing claim.'],
    openQuestions: ['Which US enterprise payments partner is named?'],
    completion: 'partial',
    budgetUsed: {
      providerCalls: 1, repairCalls: 0, inputTokens: 100, outputTokens: 50,
      toolCalls: 0, wallTimeMs: 900, budgetExceeded: false,
    },
    execution: {
      provider: 'fixture', model: 'fixture-model', fallbackProvider: null, fallbackModel: null,
      fallbackUsed: false, promptVersion: 'prompt.v1', policyVersion: 'policy.v1',
      traceId: 'trace-1', attempt: 1,
    },
    researchContractVersion: RESEARCH_PACKET_SCHEMA_VERSION,
    createdAt: NOW,
    ...overrides,
  }
}

function assess(overrides: {
  work?: ResearchWorkItem
  packet?: ResearchPacketV1
  evidence?: RetrievedEvidence[]
} = {}) {
  return assessResearchReadiness({
    work: overrides.work ?? work(),
    signal: signal(),
    packet: overrides.packet ?? packet(),
    persistedEvidence: overrides.evidence ?? [evidence()],
    assessedAt: ASSESSED_AT,
  })
}

test('an attributed partial packet with persisted evidence is ready for Entity', () => {
  const readiness = assess()
  assert.equal(readiness.schemaVersion, RESEARCH_READINESS_SCHEMA_VERSION)
  assert.equal(readiness.outcome, 'ready_for_entity')
  // A ready result always owes its normal Entity item action.
  assert.equal(readiness.entityAction.kind, 'entity_item')
  assert.equal(owesResearchEntityAction(readiness.entityAction), true)
  assert.equal(researchHandoffEntityClaim(readiness)?.kind, 'entity_item')
  assert.equal(readiness.packetCompletion, 'partial')
  assert.equal(readiness.failureCategory, null)
  assert.deepEqual(readiness.evidenceIds, ['evidence-1'])
  assert.equal(readiness.coverage.useful, true)
  assert.equal(readiness.coverage.attribution, 'attributed')
  assert.equal(readiness.coverage.attributedClaimCount, 2)
  assert.equal(readiness.coverage.verifiedFactCount, 0)
  // Limitations and open questions survive the handoff.
  assert.deepEqual(readiness.limitations, ['No independent verification of the USDe backing claim.'])
  assert.deepEqual(readiness.openQuestions, ['Which US enterprise payments partner is named?'])
  assert.equal(readiness.researchContractVersion, RESEARCH_PACKET_SCHEMA_VERSION)
  assert.equal(readiness.readinessPolicyVersion, RESEARCH_READINESS_POLICY_VERSION)
  assert.equal(readiness.assessedAt, ASSESSED_AT)
  assert.equal(readiness.readinessId, researchReadinessId('work-1', 'packet-1', RESEARCH_READINESS_POLICY_VERSION))
  // The owed action carries a stable idempotency identity for its own target.
  const action = readiness.entityAction as { kind: string, actionId: string }
  assert.equal(action.actionId, researchEntityActionId({
    workId: 'work-1', packetId: 'packet-1', readinessPolicyVersion: RESEARCH_READINESS_POLICY_VERSION,
    kind: 'entity_item', targetId: null,
  }))
})

test('a complete packet still needs a useful evidence-linked contribution', () => {
  const complete = packet({ completion: 'complete' })
  assert.equal(assess({ packet: complete }).outcome, 'ready_for_entity')

  const unsupportedComplete = packet({ completion: 'complete', claims: [] })
  const readiness = assess({ packet: unsupportedComplete })
  assert.equal(readiness.outcome, 'failed')
  assert.deepEqual(readiness.entityAction, NO_RESEARCH_ENTITY_ACTION)
  assert.equal(readiness.failureCategory, 'invalid_structured_output')
  assert.equal(readiness.packetCompletion, 'complete')
})

test('packet existence and a partial label are never sufficient on their own', () => {
  const noContribution = packet({ claims: [], verifiedFacts: [], unresolvedClaims: [], entityHints: [] })
  assert.equal(assess({ packet: noContribution }).outcome, 'failed')

  const ungrounded = packet({
    claims: [{ claimId: 'claim-1', claim: 'Unsupported.', attributedTo: null, evidenceRefs: ['evidence-absent'] }],
    evidence: [],
  })
  const readiness = assess({ packet: ungrounded })
  assert.equal(readiness.outcome, 'failed')
  assert.match(readiness.reason, /no attributable contribution|not persisted/)
})

test('a failed packet and unpersisted evidence are never promoted', () => {
  const failed = packet({ completion: 'failed' })
  const readiness = assess({ packet: failed })
  assert.equal(readiness.outcome, 'failed')
  assert.deepEqual(readiness.entityAction, NO_RESEARCH_ENTITY_ACTION)
  assert.equal(isNonClaimableReadiness(readiness.outcome), true)

  // Evidence referenced by the packet but never persisted cannot support a handoff.
  const stale = assess({ evidence: [] })
  assert.equal(stale.outcome, 'failed')
  assert.equal(stale.failureCategory, 'storage_permanent')
})

test('linkage mismatches fail closed instead of being assessed', () => {
  const wrongWork = assess({ work: work({ workId: 'work-other' }) })
  assert.equal(wrongWork.outcome, 'failed')
  assert.equal(wrongWork.failureCategory, 'schema_version_mismatch')
  assert.match(wrongWork.reason, /linkage/)

  const wrongContract = packet({ researchContractVersion: 'myboon.research_packet.v2' as never })
  assert.throws(() => assess({ packet: wrongContract }), ContractValidationError)
})

test('a deliberate no-item decision with no owed action completes locally', () => {
  const readiness = createResolvedWithoutNewItemReadiness({
    work: work(), signal: signal(), packet: packet(), persistedEvidence: [evidence()],
    assessedAt: ASSESSED_AT, reason: 'Contribution already accepted as a managed item.',
  })
  assert.equal(readiness.outcome, 'resolved_without_new_item')
  assert.deepEqual(readiness.entityAction, NO_RESEARCH_ENTITY_ACTION)
  assert.equal(owesResearchEntityAction(readiness.entityAction), false)
  // A true deliberate no-action result claims no Entity work.
  assert.equal(researchHandoffEntityClaim(readiness), null)
  assert.equal(researchHandoffWorkStatus(readiness), 'complete')
  assert.equal(readiness.failureCategory, null)
  assert.throws(() => createResolvedWithoutNewItemReadiness({
    work: work(), signal: signal(), packet: packet(), persistedEvidence: [evidence()],
    assessedAt: ASSESSED_AT, reason: '  ',
  }), ContractValidationError)
})

test('a no-new-item result that owes an attachment stays claimable and keeps its target', () => {
  const readiness = createResolvedWithoutNewItemReadiness({
    work: work(), signal: signal(), packet: packet(), persistedEvidence: [evidence()],
    assessedAt: ASSESSED_AT,
    reason: 'Already covered by a managed item, but the source must still be attached.',
    owedAttachment: { targetId: 'managed-item-42' },
  })
  assert.equal(readiness.outcome, 'resolved_without_new_item')
  // The attachment is preserved as an explicit owed action, not discarded.
  assert.equal(readiness.entityAction.kind, 'evidence_attachment')
  assert.equal(researchHandoffEntityClaim(readiness)?.targetId, 'managed-item-42')
  const action = readiness.entityAction as { actionId: string }
  assert.equal(action.actionId, researchEntityActionId({
    workId: 'work-1', packetId: 'packet-1', readinessPolicyVersion: RESEARCH_READINESS_POLICY_VERSION,
    kind: 'evidence_attachment', targetId: 'managed-item-42',
  }))
  // It stays claimable so it reaches the validated Entity writer.
  assert.equal(researchHandoffWorkStatus(readiness), 'entity_pending')
  // The idempotency identity distinguishes targets, so a different target is a
  // genuinely different owed action rather than a collision.
  assert.notEqual(action.actionId, researchEntityActionId({
    workId: 'work-1', packetId: 'packet-1', readinessPolicyVersion: RESEARCH_READINESS_POLICY_VERSION,
    kind: 'evidence_attachment', targetId: 'managed-item-43',
  }))
  // An owed attachment with no target cannot be addressed, so it is refused.
  assert.throws(() => createResolvedWithoutNewItemReadiness({
    work: work(), signal: signal(), packet: packet(), persistedEvidence: [evidence()],
    assessedAt: ASSESSED_AT, reason: 'Attachment owed.', owedAttachment: { targetId: '  ' },
  }), ContractValidationError)
})

test('a blocked result records its cause and dependency without claiming an Entity action', () => {
  const readiness = createBlockedReadiness({
    work: work(), signal: signal(), packet: packet(), persistedEvidence: [evidence()],
    assessedAt: ASSESSED_AT, reason: 'A usable source was missing.', failureCategory: 'retrieval_blocked',
    blockedDependency: 'primary source host',
  })
  assert.equal(readiness.outcome, 'blocked')
  assert.equal(readiness.failureCategory, 'retrieval_blocked')
  assert.deepEqual(readiness.entityAction, NO_RESEARCH_ENTITY_ACTION)
  assert.equal(researchHandoffEntityClaim(readiness), null)
  // The named dependency survives for operator triage.
  assert.match(readiness.reason, /blocked on: primary source host/)
  assert.throws(() => createBlockedReadiness({
    work: work(), signal: signal(), packet: packet(), persistedEvidence: [evidence()],
    assessedAt: ASSESSED_AT, reason: '  ', failureCategory: 'retrieval_blocked',
  }), ContractValidationError)
})

test('an unassessed old packet is represented as readiness_unknown and stays non-claimable', () => {
  const readiness = createReadinessUnknownReadiness({
    work: work(), signal: signal(), packet: packet(), persistedEvidence: [evidence()],
    assessedAt: ASSESSED_AT, reason: 'No readiness assessment exists for this saved packet.',
  })
  assert.equal(readiness.outcome, 'readiness_unknown')
  assert.deepEqual(readiness.entityAction, NO_RESEARCH_ENTITY_ACTION)
  assert.equal(readiness.evidenceIds.length, 0)
  assert.equal(researchHandoffWorkStatus(readiness), 'dead_letter')
  // Limitations are still retained even when readiness is unknown.
  assert.deepEqual(readiness.limitations, ['No independent verification of the USDe backing claim.'])
})

test('outcomes map to work statuses by what they owe, not by label alone', () => {
  assert.equal(researchHandoffWorkStatus(assess()), 'entity_pending')
  assert.equal(researchHandoffWorkStatus(createResolvedWithoutNewItemReadiness({
    work: work(), signal: signal(), packet: packet(), persistedEvidence: [evidence()],
    assessedAt: ASSESSED_AT, reason: 'No new note needed.',
  })), 'complete')
  assert.equal(researchHandoffWorkStatus(createResolvedWithoutNewItemReadiness({
    work: work(), signal: signal(), packet: packet(), persistedEvidence: [evidence()],
    assessedAt: ASSESSED_AT, reason: 'No new note, but a source must be attached.',
    owedAttachment: { targetId: 'managed-item-42' },
  })), 'entity_pending')

  for (const outcome of ['blocked', 'failed', 'readiness_unknown'] as const) {
    assert.equal(researchHandoffEntityClaim({ outcome, entityAction: NO_RESEARCH_ENTITY_ACTION } as never), null, outcome)
    assert.equal(isNonClaimableReadiness(outcome), true, outcome)
  }
})

test('blocked and failed outcomes use the existing bounded retry handling', () => {
  // A blocked result whose cause is classified retryable gets a bounded retry.
  const blocked = createBlockedReadiness({
    work: work(), signal: signal(), packet: packet(), persistedEvidence: [evidence()],
    assessedAt: ASSESSED_AT, reason: 'Missing usable source.', failureCategory: 'retrieval_timeout',
  })
  const retryable = { attemptCount: 1, maxAttempts: 3, expired: false, nextAttemptAt: ASSESSED_AT }
  // A blocked result is not successful completion: it waits for a bounded retry.
  assert.equal(researchHandoffTerminalStatus(blocked, retryable), 'retry_wait')
  // Once no bounded retry remains, it is an explicit non-claimable held row.
  assert.equal(
    researchHandoffTerminalStatus(blocked, { ...retryable, attemptCount: 3 }), 'dead_letter',
  )
  assert.equal(researchHandoffTerminalStatus(blocked, { ...retryable, nextAttemptAt: null }), 'dead_letter')
  // An elapsed freshness deadline ends the retry rather than extending it.
  assert.equal(researchHandoffTerminalStatus(blocked, { ...retryable, expired: true }), 'dead_letter')
  // A non-retryable blocked cause is held immediately, with no retry offered.
  const heldBlocked = createBlockedReadiness({
    work: work(), signal: signal(), packet: packet(), persistedEvidence: [evidence()],
    assessedAt: ASSESSED_AT, reason: 'Source refused.', failureCategory: 'retrieval_blocked',
  })
  assert.equal(researchHandoffTerminalStatus(heldBlocked, retryable), 'dead_letter')

  // A failed outcome respects its own classified retryability.
  const retryableFailed = assess({ packet: packet({ completion: 'failed' }) })
  assert.equal(retryableFailed.failureCategory, 'invalid_structured_output')
  assert.equal(researchHandoffTerminalStatus(retryableFailed, retryable), 'dead_letter')

  // readiness_unknown is always held: no retry and no automatic re-assessment.
  const unknown = createReadinessUnknownReadiness({
    work: work(), signal: signal(), packet: packet(), persistedEvidence: [evidence()],
    assessedAt: ASSESSED_AT, reason: 'Never assessed.',
  })
  assert.equal(researchHandoffTerminalStatus(unknown, { ...retryable, attemptCount: 0, nextAttemptAt: ASSESSED_AT }), 'dead_letter')
  assert.equal(researchHandoffTerminalStatus(unknown, { attemptCount: 0, maxAttempts: 3, expired: false, nextAttemptAt: ASSESSED_AT }), 'dead_letter')
})

test('a decision cannot claim readiness without a useful contribution or evidence', () => {
  const ready = assess()
  assert.throws(
    () => validateLegacyResearchReadiness({ ...ready, coverage: { ...ready.coverage, useful: false } }),
    /useful contribution/,
  )
  assert.throws(
    () => validateLegacyResearchReadiness({ ...ready, evidenceIds: [] }),
    /must reference persisted evidence/,
  )
  assert.throws(
    () => validateLegacyResearchReadiness({ ...ready, entityAction: NO_RESEARCH_ENTITY_ACTION }),
    /entityAction/,
  )
  assert.throws(
    () => validateLegacyResearchReadiness({ ...ready, readinessId: 'readiness_forged' }),
    /readinessId/,
  )
  // A non-claimable outcome must carry a typed category.
  const failed = assess({ packet: packet({ completion: 'failed' }) })
  assert.throws(
    () => validateLegacyResearchReadiness({ ...failed, failureCategory: null }),
    /failureCategory/,
  )
  assert.throws(
    () => validateLegacyResearchReadiness({ ...ready, outcome: 'not_an_outcome' }),
    /outcome/,
  )
  // A non-claimable outcome may never smuggle in an Entity action.
  for (const outcome of ['blocked', 'failed', 'readiness_unknown'] as const) {
    assert.throws(
      () => validateLegacyResearchReadiness({
        ...failed, outcome,
        entityAction: { kind: 'entity_item', actionId: 'action-1', targetId: null },
      }),
      /entityAction/,
      outcome,
    )
  }
  // A no-new-item result may not create a new item action.
  const noItem = createResolvedWithoutNewItemReadiness({
    work: work(), signal: signal(), packet: packet(), persistedEvidence: [evidence()],
    assessedAt: ASSESSED_AT, reason: 'No new note.',
  })
  assert.throws(
    () => validateLegacyResearchReadiness({
      ...noItem, entityAction: { kind: 'entity_item', actionId: 'action-1', targetId: null },
    }),
    /must not create an entity_item action/,
  )
  // A required action must be addressable: an attachment needs a target.
  assert.throws(
    () => validateLegacyResearchReadiness({
      ...noItem, entityAction: { kind: 'evidence_attachment', actionId: 'action-1', targetId: null },
    }),
    /targetId/,
  )
  // A required action needs a stable identity.
  assert.throws(
    () => validateLegacyResearchReadiness({
      ...noItem, entityAction: { kind: 'evidence_attachment', targetId: 'managed-item-42' },
    }),
    /actionId/,
  )
  // A none action carries no identity at all.
  assert.throws(
    () => validateLegacyResearchReadiness({
      ...noItem, entityAction: { kind: 'none', actionId: 'action-1' },
    }),
    /entityAction/,
  )
})

test('linkage validation rejects a decision that does not match its stored records', () => {
  const readiness = assess()
  const good = {
    readiness, work: work({ status: 'entity_pending', leaseOwner: null, leaseId: null, leaseExpiresAt: null }),
    signal: signal(), packet: packet(), persistedEvidence: [evidence()],
  }
  assert.equal(validateResearchReadinessLinkage(good), null)

  assert.match(
    validateResearchReadinessLinkage({ ...good, packet: packet({ workId: 'work-other' }) }) ?? '',
    /packet/,
  )
  assert.match(
    validateResearchReadinessLinkage({ ...good, persistedEvidence: [] }) ?? '',
    /not persisted/,
  )
  assert.match(
    validateResearchReadinessLinkage({ ...good, readiness: { ...readiness, limitations: [] } }) ?? '',
    /limitations/,
  )
  assert.match(
    validateResearchReadinessLinkage({ ...good, readiness: { ...readiness, packetCompletion: 'complete' } }) ?? '',
    /completion provenance/,
  )
  assert.match(
    validateResearchReadinessLinkage({ ...good, signal: { ...signal(), signalId: 'signal-other' } as Signal }) ?? '',
    /signal/,
  )
})

test('the decision identity is stable for one work, packet, and policy version', () => {
  const first = assess()
  const second = assess({ packet: packet({ completion: 'failed' }) })
  // Same work and packet, so the identity tuple is identical; only the policy
  // version could produce a second, independently named decision.
  assert.equal(first.workId, second.workId)
  assert.equal(first.packetId, second.packetId)
  assert.equal(first.readinessId, researchReadinessId('work-1', 'packet-1', RESEARCH_READINESS_POLICY_VERSION))
  assert.notEqual(
    first.readinessId,
    researchReadinessId('work-1', 'packet-1', 'myboon.research_readiness_policy.v2'),
  )
})
