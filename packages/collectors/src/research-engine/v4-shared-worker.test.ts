import { validateLegacyResearchPacket } from '../signal-platform/validation'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import { SharedResearchWorker, researchGateSignal, type SharedResearchWorkPort, type SharedResearchV4Options } from './shared-worker'
import { SqliteSignalPlatformStore } from '../signal-platform/sqlite-platform-store'
import { DeterministicRetriever } from './deterministic-retrieval'
import { durableResearchClassification } from './durable-classification'
import { durablePrimarySynthesis } from './durable-synthesis'
import { durableArticleEntityProposal } from './durable-article-proposal'
import { researchRootAssignmentId, ResearchFollowupHold, runBoundedFollowup } from './bounded-followup'
import { InferenceGatewayError, RESEARCH_NOVELTY_VERSION, RESEARCH_NOVELTY_WORKLOAD, type ClassificationGateway, type InferenceTelemetry } from '../inference-gateway'
import { resolveKnownObservation, assertKnownObservationResolution, type KnownObservationResolution } from './known-observation'
import { createResolvedWithoutNewItemReadiness } from '../signal-platform/research-readiness'
import type { GateDecision } from '../research-gate/types'
import { seedV4, V4_POLICY, V4_FOLLOWUP_POLICY, V4_NOW, V4_SOURCE_URL, V4_FOLLOWUP_URL, v4Signal, v4Work, v4Clock, v4Classifier,
  v4ContextReader, v4Database, v4Evidence, v4Packet, V4Synthesizer, v4ClassificationResult } from './v4-test-fixtures'

function worker(store: SharedResearchWorkPort, synth: V4Synthesizer, v4: SharedResearchV4Options = V4_POLICY, instant = V4_NOW,
  onFetch: () => void = () => undefined) {
  return new SharedResearchWorker({ workerId: 'offline-v4-worker', stores: [store], stages: ['synthesis'],
    mode: 'active', ownership: 'shared', legacyClaimersActive: false, clock: v4Clock(instant),
    synthesizer: synth, retriever: new DeterministicRetriever({ now: () => new Date(instant),
      fetchDocument: async (url) => { onFetch(); return { body: Buffer.from('The regulator records Monday as the launch date.'),
        finalUrl: url, contentType: 'text/plain', status: 200, visitedHosts: [] } } }), v4 })
}

function receivedSynthesisTelemetry(work: ReturnType<typeof v4Work>, failureCategory: 'budget_exceeded' | 'invalid_structured_output'): InferenceTelemetry {
  return {
    workload: 'research.synthesis', purpose: 'research.structured-synthesis', mode: 'generateStructured',
    promptVersion: 'offline-test.prompt.v1', policyVersion: work.policyVersion,
    configuredPrimaryProvider: 'hermes', configuredPrimaryModel: 'model-1', actualProvider: 'hermes', actualModel: 'model-1',
    fallbackInvoked: false, fallbackReason: null, schemaValid: failureCategory === 'invalid_structured_output' ? false : null,
    providerCalls: 1, repairCalls: 0, inputTokens: 500, outputTokens: 4_001, toolCalls: 0,
    costUsdMicros: null, durationMs: 25, budgetExceeded: failureCategory === 'budget_exceeded', failureCategory,
    calls: [{ mode: 'generateStructured', provider: 'hermes', model: 'model-1', durationMs: 25,
      status: 'succeeded', failureCategory: null, schemaValid: failureCategory === 'invalid_structured_output',
      inputTokens: 500, outputTokens: 4_001, costUsdMicros: null }],
  }
}

/** Simulate a crash after the rejection receipt is durable but before settlement. */
function failNextSettlement(store: SqliteSignalPlatformStore, allowanceId?: string): void {
  const factory = store.researchBudgetStore.bind(store)
  let failed = false
  store.researchBudgetStore = () => {
    const port = factory()
    const update = port.update.bind(port)
    port.update = async (...args) => {
      if (!failed && args[2].state === 'settled' && (!allowanceId || args[0].allowanceId === allowanceId)) {
        failed = true
        return null
      }
      return update(...args)
    }
    return port
  }
}

for (const source of ['news', 'polymarket'] as const) {
  test(`actual ${source} shared worker composes novelty, bounded follow-up and canonical readiness`, async () => {
    const fx = v4Database(source)
    try {
      const seeded = seedV4(fx.store)
      const synth = new V4Synthesizer()
      const classifier = v4Classifier((request) => request.workload === RESEARCH_NOVELTY_WORKLOAD
        ? { verdict: 'new_information', reason: 'A new covered fact.' } : { direction: 'not_worthwhile', reason: 'No useful extra question.' })
      const v4 = { ...V4_POLICY, novelty: { classification: classifier.port, reader: () => v4ContextReader() },
        followup: { classification: classifier.port, policy: V4_FOLLOWUP_POLICY } }
      const outcome = await worker(fx.store, synth, v4).runOnce()
      assert.equal(outcome.kind, 'succeeded')
      assert.equal(fx.store.getResearchWork(seeded.work.workId)?.status, 'entity_pending')
      assert.equal(fx.store.getResearchReadinessByWork(seeded.work.workId)?.outcome, 'ready_for_entity')
      const packet = fx.store.listResearchPacketsByWork(seeded.work.workId, 10)[0]
      assert.equal(packet.completion, 'partial')
      assert.equal(validateLegacyResearchPacket(packet).claims[0].attributedTo, 'Atlas')
      assert.deepEqual(packet.verifiedFacts, [])
      assert.equal(synth.inputs.length, 1)
      assert.equal(fx.store.getResearchV4Record<{ verdict: string }>('novelty', seeded.work.workId, 'decision')?.verdict, 'new_information')
      assert.equal(classifier.requests.length, 2)
      assert.ok(classifier.requests.every((request) => request.maxProviderCalls === 1 && request.holdOnUnknownOutcome === true))
      assert.equal(synth.inputs[0].holdOnUnknownOutcome, true)
      assert.equal(synth.inputs[0].workItem.budget.maxInputTokens, V4_POLICY.synthesisPolicy.maxInputTokens)
      assert.equal(synth.inputs[0].workItem.budget.maxOutputTokens, V4_POLICY.synthesisPolicy.maxOutputTokens)
      assert.equal(fx.store.listResearchReservations(100).length, 3)
      assert.ok(fx.store.listResearchReservations(100).every((record) => record.state === 'settled'))
    } finally { fx.close() }
  })
}

test('saved baseline and classifiers survive a failed handoff and database reopen without re-spending', async () => {
  const fx = v4Database()
  let reopened: SqliteSignalPlatformStore | undefined
  try {
    const { work } = seedV4(fx.store)
    const synth = new V4Synthesizer()
    const classifier = v4Classifier({ direction: 'uncertain', reason: 'Insufficient expected value.' })
    const v4 = { ...V4_POLICY, followup: { classification: classifier.port, policy: V4_FOLLOWUP_POLICY } }
    const faulted = new Proxy(fx.store, { get(target, key) {
      if (key === 'commitResearchHandoff') return () => { throw new Error('Temporary handoff storage fault') }
      const value = Reflect.get(target, key)
      return typeof value === 'function' ? value.bind(target) : value
    } })
    assert.equal((await worker(faulted, synth, v4).runOnce()).kind, 'handoff_pending')
    assert.equal(synth.inputs.length, 1)
    assert.equal(classifier.requests.length, 1)
    assert.ok(fx.store.getResearchV4Record('baseline', work.workId, 'packet'))
    fx.store.close()
    reopened = new SqliteSignalPlatformStore(fx.path, 'news')
    await reopened.recoverExpiredLeases({ now: '2026-10-03T08:02:00.000Z', limit: 10 })
    assert.equal((await worker(reopened, synth, v4, '2026-10-03T08:02:00.000Z').runOnce()).kind, 'succeeded')
    assert.equal(synth.inputs.length, 1)
    assert.equal(classifier.requests.length, 1)
    assert.equal(reopened.getResearchReadinessByWork(work.workId)?.outcome, 'ready_for_entity')
  } finally { reopened?.close(); fx.close() }
})

for (const source of ['news', 'polymarket'] as const) {
  test(`${source} fully covered known observation avoids synthesis/follow-up and retains captured evidence without claims`, async () => {
    const fx = v4Database(source)
    try {
      const { signal, work, evidence } = seedV4(fx.store)
      const synth = new V4Synthesizer(() => { throw new Error('Covered known observations must not buy synthesis') })
      const classifier = v4Classifier({ verdict: 'already_known', reason: 'Complete bounded current timeline already covers the source.' })
      const v4 = { ...V4_POLICY, novelty: { classification: classifier.port, reader: () => v4ContextReader() },
        followup: { classification: classifier.port, policy: V4_FOLLOWUP_POLICY } }
      assert.equal((await worker(fx.store, synth, v4).runOnce()).kind, 'succeeded')
      assert.equal(synth.inputs.length, 0)
      assert.equal(classifier.requests.length, 1)
      assert.equal(fx.store.getResearchWork(work.workId)?.status, 'complete')
      assert.equal(fx.store.getResearchReadinessByWork(work.workId)?.entityAction.kind, 'none')
      assert.deepEqual(fx.store.getSignal(signal.signalId), signal)
      assert.deepEqual(fx.store.getEvidence(evidence.evidenceId), evidence)
      const packet = fx.store.listResearchPacketsByWork(work.workId, 10)[0]
      assert.deepEqual([packet.claims, packet.verifiedFacts, packet.entityHints, packet.unresolvedClaims], [[], [], [], []])
      assert.equal(validateLegacyResearchPacket(packet).evidence[0].evidenceId, evidence.evidenceId)
      assert.equal(packet.budgetUsed.providerCalls, 1, 'One novelty classifier call is counted, no synthesis call')
      assert.ok(packet.knownObservationResolution)
      assert.equal(fx.store.listResearchReservations(100).length, 1)
    } finally { fx.close() }
  })
}

test('saved known observation survives failed handoff and rechecks current context on restart without extra spend', async () => {
  const fx = v4Database()
  try {
    const { work } = seedV4(fx.store)
    const classifier = v4Classifier({ verdict: 'already_known', reason: 'Complete source already covered.' })
    const synth = new V4Synthesizer()
    const v4 = { ...V4_POLICY, novelty: { classification: classifier.port, reader: () => v4ContextReader() } }
    const faulted = new Proxy(fx.store, { get(target, key) {
      if (key === 'commitResearchHandoff') return () => { throw new Error('Temporary no-item handoff failure') }
      const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value
    } })
    assert.equal((await worker(faulted, synth, v4).runOnce()).kind, 'handoff_pending')
    await fx.store.recoverExpiredLeases({ now: '2026-10-03T08:02:00.000Z', limit: 10 })
    assert.equal((await worker(fx.store, synth, v4, '2026-10-03T08:02:00.000Z').runOnce()).kind, 'succeeded')
    assert.equal(classifier.requests.length, 1)
    assert.equal(synth.inputs.length, 0)
    assert.equal(fx.store.getResearchReadinessByWork(work.workId)?.outcome, 'resolved_without_new_item')
  } finally { fx.close() }
})

test('changed current context and explicitly owed action keep accepted known comparisons on the ordinary Research path', async () => {
  for (const variant of ['changed_context', 'owed_action', 'lookup_truncated', 'lookup_failed', 'empty_refs'] as const) {
    const fx = v4Database()
    try {
      seedV4(fx.store, undefined, variant === 'owed_action' ? { retrievalPlan: { sourceUrl: 'https://issuer.example/release',
        allowedDomains: ['issuer.example'], maxExternalSources: 1, requiredEntityAction: { kind: 'evidence_attachment', targetId: 'explicit-target' } } } : {})
      let lookups = 0
      const reader = () => {
        const base = v4ContextReader(variant === 'changed_context' && lookups++ > 0 ? 'updated-after-decision' : 'knowledge-digest-v1')
        if (variant === 'lookup_truncated') base.noveltyEvidence = async () => ({ digest: 'knowledge-digest-v1', itemRefs: ['item'], failures: [], truncated: true })
        if (variant === 'lookup_failed') base.noveltyEvidence = async () => ({ digest: 'knowledge-digest-v1', itemRefs: ['item'], failures: ['Context unavailable'], truncated: false })
        if (variant === 'empty_refs') base.noveltyEvidence = async () => ({ digest: 'knowledge-digest-v1', itemRefs: [], failures: [], truncated: false })
        return base
      }
      const classifier = v4Classifier({ verdict: 'already_known', reason: 'Synthetic accepted known classification.' })
      const synth = new V4Synthesizer()
      assert.equal((await worker(fx.store, synth, { ...V4_POLICY, novelty: { classification: classifier.port, reader } }).runOnce()).kind, 'succeeded', variant)
      assert.equal(synth.inputs.length, 1, variant)
    } finally { fx.close() }
  }
})

test('forged no-item packet markers cannot reach atomic handoff without code-owned complete comparison proof', async () => {
  const fx = v4Database()
  try {
    const { signal, work, evidence } = seedV4(fx.store)
    const forged = { ...v4Packet({ signal, workItem: work, evidence: [evidence] }),
      claims: [], knownObservationResolution: { policyVersion: 'forged', owedAction: 'none' } }
    const readiness = createResolvedWithoutNewItemReadiness({ work, signal, packet: forged, persistedEvidence: [evidence],
      assessedAt: V4_NOW, reason: 'Forged provider marker' })
    assert.throws(() => assertKnownObservationResolution({ store: fx.store, packet: forged, signal, work, evidence: [evidence] }), /persisted complete comparison/)
    const synth = new V4Synthesizer(() => forged)
    assert.equal((await worker(fx.store, synth).runOnce()).kind, 'dead_letter')
    assert.equal(fx.store.getResearchReadinessByWork(work.workId), null)
    assert.equal(readiness.outcome, 'resolved_without_new_item')
    const other = seedV4(fx.store, { ...signal, signalId: 'signal-forged-atomic', idempotencyKey: 'forged-atomic' })
    const atomicPacket = { ...forged, packetId: 'packet-forged-atomic', workId: other.work.workId, signalId: other.signal.signalId,
      evidence: [{ ...forged.evidence[0], evidenceId: other.evidence.evidenceId }] }
    const atomicReadiness = createResolvedWithoutNewItemReadiness({ work: other.work, signal: other.signal, packet: atomicPacket,
      persistedEvidence: [other.evidence], assessedAt: V4_NOW, reason: 'Forged atomic marker' })
    const lease = await fx.store.claimWithLease({ workId: other.work.workId, expectedStatus: 'synthesis_pending',
      leaseOwner: 'atomic-operator', leaseId: 'atomic-lease', now: V4_NOW, leaseExpiresAt: '2026-10-03T08:01:00.000Z' })
    assert.ok(lease)
    assert.throws(() => fx.store.commitResearchHandoff({ packet: atomicPacket, readiness: atomicReadiness,
      fence: { workId: other.work.workId, leaseOwner: 'atomic-operator', leaseId: 'atomic-lease' }, now: V4_NOW }), /persisted complete comparison/)
    assert.equal(fx.store.getResearchReadinessByWork(other.work.workId), null)
  } finally { fx.close() }
})

test('changed source/capture snapshots cannot reuse known proof, and changed knowledge holds saved no-item handoff', async () => {
  const fx = v4Database()
  try {
    const seeded = seedV4(fx.store)
    const classifier = v4Classifier({ verdict: 'already_known', reason: 'Complete source covered.' })
    const synth = new V4Synthesizer()
    const v4 = { ...V4_POLICY, novelty: { classification: classifier.port, reader: () => v4ContextReader() } }
    const faulted = new Proxy(fx.store, { get(target, key) {
      if (key === 'commitResearchHandoff') return () => { throw new Error('Retryable handoff fault') }
      const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value
    } })
    assert.equal((await worker(faulted, synth, v4).runOnce()).kind, 'handoff_pending')
    const decision = fx.store.getResearchV4Record<GateDecision>('novelty', seeded.work.workId, 'decision')!
    const input = { store: fx.store, ...seeded, evidence: [seeded.evidence], decision,
      gateSignal: researchGateSignal(seeded.signal, [seeded.evidence]), reader: v4ContextReader(), policyVersion: V4_POLICY.policyVersion,
      stillOwnsLease: async () => true, now: () => V4_NOW }
    assert.equal(await resolveKnownObservation({ ...input, signal: { ...seeded.signal, visibleSummary: 'New fact added.' } }), null)
    assert.equal(await resolveKnownObservation({ ...input, evidence: [{ ...seeded.evidence, text: 'New body added.', contentHash: 'new-body' }] }), null)
    await fx.store.recoverExpiredLeases({ now: '2026-10-03T08:02:00.000Z', limit: 10 })
    assert.equal((await worker(fx.store, synth, { ...v4, novelty: { ...v4.novelty,
      reader: () => v4ContextReader('updated-after-handoff-failure') } }, '2026-10-03T08:02:00.000Z').runOnce()).kind, 'dead_letter')
    assert.equal(fx.store.getResearchReadinessByWork(seeded.work.workId), null)
    assert.equal(synth.inputs.length, 0)
    assert.equal(classifier.requests.length, 1)
  } finally { fx.close() }
})

test('unknown primary outcome becomes a durable hold and never dispatches a replacement', async () => {
  const fx = v4Database()
  try {
    const { work } = seedV4(fx.store)
    const synth = new V4Synthesizer(async () => { throw new Error('Transport timed out after dispatch') })
    assert.equal((await worker(fx.store, synth).runOnce()).kind, 'dead_letter')
    assert.equal(synth.inputs.length, 1)
    assert.equal(fx.store.getResearchReadinessByWork(work.workId), null)
    assert.equal(fx.store.listResearchPacketsByWork(work.workId, 10).length, 0)
    assert.equal(fx.store.listResearchReservations(100)[0].state, 'execution_outcome_unknown')
    const unknown = fx.store.getResearchV4Record<{ providerCalls: number | null }>('baseline', work.workId, 'unknown_outcome')!
    assert.equal(unknown.providerCalls, null)
    let replacement = 0
    await assert.rejects(durablePrimarySynthesis({ store: fx.store, work, saved: null, requestMaterial: {},
      policy: V4_POLICY.synthesisPolicy, assignmentPolicy: V4_POLICY.assignmentPolicy,
      generate: async () => { replacement++; throw new Error('Must not reach provider') }, transform: (packet) => packet,
      stillOwnsLease: async () => true, now: () => V4_NOW }), ResearchFollowupHold)
    assert.equal(replacement, 0)
  } finally { fx.close() }
})

test('received synthesis output overrun settles its paid attempt with a durable rejection receipt', async () => {
  const fx = v4Database()
  try {
    const { work } = seedV4(fx.store)
    const telemetry = receivedSynthesisTelemetry(work, 'budget_exceeded')
    let calls = 0
    failNextSettlement(fx.store, 'research_primary_synthesis.v1')
    await assert.rejects(durablePrimarySynthesis({ store: fx.store, work, saved: null, requestMaterial: {},
      policy: V4_POLICY.synthesisPolicy, assignmentPolicy: V4_POLICY.assignmentPolicy,
      generate: async () => { calls += 1; throw new InferenceGatewayError('Provider exceeded output-token budget', {
        category: 'budget_exceeded', retryable: false, telemetry,
      }) }, transform: (packet) => packet, stillOwnsLease: async () => true, now: () => V4_NOW }), ResearchFollowupHold)
    const reservation = fx.store.listResearchReservations(100).find((row) => row.allowanceId === 'research_primary_synthesis.v1')
    assert.equal(reservation?.state, 'dispatch_intent')
    assert.equal(fx.store.getResearchV4Record('baseline', work.workId, 'unknown_outcome'), null)
    assert.equal(fx.store.getResearchV4Record<{ status: string }>('baseline', work.workId, 'rejected_response')?.status, 'received_response_rejected')
    await assert.rejects(durablePrimarySynthesis({ store: fx.store, work, saved: null, requestMaterial: {},
      policy: V4_POLICY.synthesisPolicy, assignmentPolicy: V4_POLICY.assignmentPolicy,
      generate: async () => { calls += 1; throw new Error('Must not reach provider') }, transform: (packet) => packet,
      stillOwnsLease: async () => true, now: () => V4_NOW }), /terminal and will not be redispatched/)
    assert.equal(calls, 1)
    assert.equal(fx.store.listResearchReservations(100).find((row) => row.allowanceId === 'research_primary_synthesis.v1')?.state, 'settled')
  } finally { fx.close() }
})

test('a received packet rejected by the local contract is settled without an unknown paid hold', async () => {
  const fx = v4Database()
  try {
    const { work } = seedV4(fx.store)
    const packet = v4Packet({ signal: v4Signal(), workItem: work, evidence: [v4Evidence(work)], holdOnUnknownOutcome: true } as never)
    await assert.rejects(durablePrimarySynthesis({ store: fx.store, work, saved: null, requestMaterial: {},
      policy: V4_POLICY.synthesisPolicy, assignmentPolicy: V4_POLICY.assignmentPolicy,
      generate: async () => packet, transform: () => { throw new Error('packet contract invalid') },
      stillOwnsLease: async () => true, now: () => V4_NOW }), ResearchFollowupHold)
    const reservation = fx.store.listResearchReservations(100).find((row) => row.allowanceId === 'research_primary_synthesis.v1')
    assert.equal(reservation?.state, 'settled')
    assert.equal(fx.store.getResearchV4Record('baseline', work.workId, 'unknown_outcome'), null)
    assert.equal(fx.store.getResearchV4Record<{ status: string }>('baseline', work.workId, 'rejected_response')?.status, 'received_response_rejected')
  } finally { fx.close() }
})

test('received article proposal output settles with a rejection receipt instead of an unknown hold', async () => {
  const fx = v4Database()
  try {
    const { work } = seedV4(fx.store)
    const telemetry = receivedSynthesisTelemetry(work, 'invalid_structured_output')
    let calls = 0
    let generationBudget: { maxInputTokens: number, maxOutputTokens: number } | null = null
    failNextSettlement(fx.store, 'research_article_entity_proposal.v1')
    await assert.rejects(durableArticleEntityProposal({ store: fx.store, work,
      assignmentPolicy: V4_POLICY.assignmentPolicy, requestMaterial: { article: 'fixture' },
      stillOwnsLease: async () => true, now: () => V4_NOW,
      generate: async (budget) => { generationBudget = budget; calls += 1; throw new InferenceGatewayError('Proposal validation failed', {
        category: 'invalid_structured_output', retryable: false, telemetry,
      }) },
    }), ResearchFollowupHold)
    assert.deepEqual(generationBudget, { maxInputTokens: 16_000, maxOutputTokens: 4_000 })
    const reservation = fx.store.listResearchReservations(100).find((row) => row.allowanceId === 'research_article_entity_proposal.v1')
    assert.equal(reservation?.state, 'dispatch_intent')
    assert.deepEqual(reservation?.approvedLimits, {
      maxProviderCalls: 1, maxInputTokens: 16_000, maxOutputTokens: 4_000, maxIncrementalCostUsdMicros: null,
    })
    assert.equal(fx.store.getResearchV4Record<{ status: string }>('rejected_response', work.workId, reservation!.attemptId)?.status, 'received_response_rejected')
    await assert.rejects(durableArticleEntityProposal({ store: fx.store, work,
      assignmentPolicy: V4_POLICY.assignmentPolicy, requestMaterial: { article: 'fixture' },
      stillOwnsLease: async () => true, now: () => V4_NOW,
      generate: async () => { calls += 1; throw new Error('Must not reach provider') },
    }), /terminal and will not be redispatched/)
    assert.equal(calls, 1)
    assert.equal(fx.store.listResearchReservations(100).find((row) => row.allowanceId === 'research_article_entity_proposal.v1')?.state, 'settled')
  } finally { fx.close() }
})

test('unknown paid follow-up retains the original baseline and holds without replacement or canonical promotion', async () => {
  const fx = v4Database()
  try {
    const { work } = seedV4(fx.store)
    const classifier = v4Classifier({ direction: 'worthwhile', reason: 'An admitted regulator source answers the unresolved date.' })
    const synth = new V4Synthesizer((input) => {
      if (input.evidence.length > 1) throw new Error('Follow-up transport timed out')
      return v4Packet(input)
    })
    const v4 = { ...V4_POLICY, followup: { classification: classifier.port, policy: V4_FOLLOWUP_POLICY } }
    assert.equal((await worker(fx.store, synth, v4).runOnce()).kind, 'dead_letter')
    assert.equal(synth.inputs.length, 2)
    assert.equal(classifier.requests.length, 1)
    assert.ok(fx.store.getResearchV4Record('baseline', work.workId, 'packet'))
    assert.equal(fx.store.listResearchPacketsByWork(work.workId, 10).length, 0)
    assert.equal(fx.store.getResearchReadinessByWork(work.workId), null)
    assert.equal(fx.store.listResearchReservations(100).find((row) => row.allowanceId === 'research_followup_investigation.v1')?.state, 'execution_outcome_unknown')
    assert.equal((await worker(fx.store, synth, v4).runOnce()).kind, 'idle')
    assert.equal(synth.inputs.length, 2)
  } finally { fx.close() }
})

test('received follow-up output settles with a rejection receipt instead of an unknown hold', async () => {
  const fx = v4Database()
  try {
    const { work } = seedV4(fx.store)
    const classifier = v4Classifier({ direction: 'worthwhile', reason: 'An admitted regulator source answers the unresolved date.' })
    const telemetry = receivedSynthesisTelemetry(work, 'budget_exceeded')
    let calls = 0
    const synth = new V4Synthesizer((input) => {
      if (input.evidence.length > 1) { calls += 1; throw new InferenceGatewayError('Output-token budget exceeded', {
        category: 'budget_exceeded', retryable: false, telemetry,
      }) }
      return v4Packet(input)
    })
    const v4 = { ...V4_POLICY, followup: { classification: classifier.port, policy: V4_FOLLOWUP_POLICY } }
    failNextSettlement(fx.store, 'research_followup_investigation.v1')
    assert.equal((await worker(fx.store, synth, v4).runOnce()).kind, 'dead_letter')
    const reservation = fx.store.listResearchReservations(100).find((row) => row.allowanceId === 'research_followup_investigation.v1')
    assert.equal(reservation?.state, 'dispatch_intent')
    assert.equal(fx.store.getResearchV4Record<{ status: string }>('rejected_response', work.workId, reservation!.attemptId)?.status, 'received_response_rejected')
    const baseline = fx.store.getResearchV4Record<ReturnType<typeof v4Packet>>('baseline', work.workId, 'packet')!
    const signal = fx.store.getSignal(work.signalId)!
    const evidence = fx.store.listEvidenceByWork(work.workId, 1_000)
    await assert.rejects(runBoundedFollowup({
      store: fx.store, signal, work, baseline, gateSignal: researchGateSignal(signal, evidence), entityContext: null,
      classification: classifier.port, policy: V4_FOLLOWUP_POLICY,
      retriever: new DeterministicRetriever({ now: () => new Date(V4_NOW), fetchDocument: async (url) => ({
        body: Buffer.from('The regulator records Monday as the launch date.'), finalUrl: url,
        contentType: 'text/plain', status: 200, visitedHosts: [],
      }) }), synthesizer: synth, assignmentPolicy: V4_POLICY.assignmentPolicy,
      stillOwnsLease: async () => true, now: () => V4_NOW,
    }), /terminal and will not be redispatched/)
    assert.equal(calls, 1)
    assert.equal(fx.store.listResearchReservations(100).find((row) => row.allowanceId === 'research_followup_investigation.v1')?.state, 'settled')
  } finally { fx.close() }
})

for (const direction of ['uncertain', 'not_worthwhile'] as const) {
  test(`${direction} value decision preserves baseline and does not fetch or synthesize extra work`, async () => {
    const fx = v4Database()
    try {
      const { work } = seedV4(fx.store)
      const classifier = v4Classifier({ direction, reason: 'Synthetic labeled value decision.' })
      const synth = new V4Synthesizer()
      let fetches = 0
      assert.equal((await worker(fx.store, synth, { ...V4_POLICY,
        followup: { classification: classifier.port, policy: V4_FOLLOWUP_POLICY } }, V4_NOW, () => fetches++).runOnce()).kind, 'succeeded')
      assert.equal(fetches, 0)
      assert.equal(synth.inputs.length, 1)
      assert.equal(fx.store.listResearchReservations(100).length, 2)
      assert.equal(fx.store.getResearchReadinessByWork(work.workId)?.outcome, 'ready_for_entity')
    } finally { fx.close() }
  })
}

for (const followupUrls of [[], ['file:///private/source'], ['https://unadmitted.example/notice'],
  [`${V4_SOURCE_URL}#same-capture`], ['https://user:secret@issuer.example/notice']]) {
  test(`no newly admitted executable follow-up URL avoids buying a value decision: ${JSON.stringify(followupUrls)}`, async () => {
    const fx = v4Database()
    try {
      const signal = v4Signal()
      const { work } = seedV4(fx.store, signal, { retrievalPlan: { ...v4Work(signal).retrievalPlan, followupUrls } })
      const classifier = v4Classifier(() => { throw new Error('No route must mean no paid value judgment') })
      const synth = new V4Synthesizer()
      let fetches = 0
      assert.equal((await worker(fx.store, synth, { ...V4_POLICY,
        followup: { classification: classifier.port, policy: V4_FOLLOWUP_POLICY } }, V4_NOW, () => fetches++).runOnce()).kind, 'succeeded')
      assert.equal(classifier.requests.length, 0)
      assert.equal(fetches, 0)
      assert.equal(synth.inputs.length, 1)
      assert.equal(fx.store.listResearchReservations(100).length, 1)
      assert.equal(fx.store.getResearchReadinessByWork(work.workId)?.outcome, 'ready_for_entity')
      assert.equal(fx.store.getResearchV4Record<{ decisionSkipped: boolean }>('followup_decision', work.workId, 'admission')?.decisionSkipped, true)
    } finally { fx.close() }
  })
}

test('follow-up value state includes actual admitted source bounds and hashes exactly the transmitted material', async () => {
  const fx = v4Database()
  try {
    seedV4(fx.store)
    const classifier = v4Classifier({ direction: 'not_worthwhile', reason: 'No remaining contribution.' })
    assert.equal((await worker(fx.store, new V4Synthesizer(), { ...V4_POLICY,
      followup: { classification: classifier.port, policy: V4_FOLLOWUP_POLICY } }).runOnce()).kind, 'succeeded')
    const signal = (classifier.requests[0].state as { signal: { sourceMaterial: string; sourceMaterialDigest: string } }).signal
    const material = JSON.parse(signal.sourceMaterial)
    assert.deepEqual(material.followupAdmission.admittedUrls, [V4_FOLLOWUP_URL])
    assert.equal(material.followupAdmission.maxProviderCalls, 1)
    assert.equal(material.followupAdmission.maxSources, V4_FOLLOWUP_POLICY.maxSources)
    assert.equal(signal.sourceMaterialDigest, createHash('sha256').update(signal.sourceMaterial).digest('hex'))
  } finally { fx.close() }
})

for (const addsInformation of [false, true]) {
  test(`bounded paid follow-up ${addsInformation ? 'adds grounded regulator claim' : 'adds no information and preserves original readiness'}`, async () => {
    const fx = v4Database()
    try {
      const { work } = seedV4(fx.store)
      const classifier = v4Classifier({ direction: 'worthwhile', reason: 'Bounded source can resolve an open question.' })
      const synth = new V4Synthesizer((input) => {
        const packet = v4Packet(input)
        return input.evidence.length > 1 && addsInformation ? { ...packet, claims: [...packet.claims,
          { claimId: 'claim-regulator-date', claim: 'The regulator records Monday as the launch date.', attributedTo: 'Regulator',
            evidenceRefs: [input.evidence[1].evidenceId] }] } : packet
      })
      let fetches = 0
      assert.equal((await worker(fx.store, synth, { ...V4_POLICY,
        followup: { classification: classifier.port, policy: V4_FOLLOWUP_POLICY } }, V4_NOW, () => fetches++).runOnce()).kind, 'succeeded')
      assert.equal(fetches, 1)
      assert.equal(synth.inputs.length, 2)
      assert.equal(synth.inputs[1].workItem.budget.maxProviderCalls, 1)
      assert.equal(synth.inputs[1].workItem.budget.maxRepairCalls, 0)
      const packet = fx.store.listResearchPacketsByWork(work.workId, 10)[0]
      assert.equal((packet.followup as { addedInformation: boolean }).addedInformation, addsInformation)
      assert.equal(validateLegacyResearchPacket(packet).claims.length, addsInformation ? 2 : 1)
      assert.equal(validateLegacyResearchPacket(packet).claims[0].attributedTo, 'Atlas')
      assert.equal(packet.budgetUsed.providerCalls, 2)
      assert.equal(packet.budgetUsed.costUsdMicros, null)
      assert.equal(fx.store.getResearchReadinessByWork(work.workId)?.outcome, 'ready_for_entity')
    } finally { fx.close() }
  })
}

test('saved classification response is reused after reopen with exact state and one transport call', async () => {
  const fx = v4Database()
  let reopened: SqliteSignalPlatformStore | undefined
  try {
    const { work } = seedV4(fx.store)
    const classifier = v4Classifier({ verdict: 'new_information', reason: 'Unseen fact.' })
    const request = { workload: RESEARCH_NOVELTY_WORKLOAD, decisionVersion: RESEARCH_NOVELTY_VERSION,
      state: { signal: {}, context: {} }, trace: { stableDecisionKey: 'decision-same-state' } }
    const make = (store: SqliteSignalPlatformStore) => durableResearchClassification({ gateway: classifier.port,
      store, work, assignmentPolicy: V4_POLICY.assignmentPolicy, now: () => V4_NOW })
    const first = await make(fx.store).classify(request)
    fx.store.close(); reopened = new SqliteSignalPlatformStore(fx.path, 'news')
    assert.deepEqual(await make(reopened).classify(request), first)
    assert.equal(classifier.requests.length, 1)
    await assert.rejects(make(reopened).classify({ ...request, state: { different: 'state' } }), ResearchFollowupHold)
    assert.equal(classifier.requests.length, 1)
  } finally { reopened?.close(); fx.close() }
})

test('unknown classification retains root exposure and cannot be replaced on same or continuing work', async () => {
  const fx = v4Database()
  try {
    const { work } = seedV4(fx.store)
    let calls = 0
    const gateway: Pick<ClassificationGateway, 'classify' | 'recordPolicyOutcome'> = {
      classify: async () => { calls++; throw new Error('Response lost after classification dispatch') }, recordPolicyOutcome: async () => {},
    }
    const request = { workload: RESEARCH_NOVELTY_WORKLOAD, decisionVersion: RESEARCH_NOVELTY_VERSION,
      state: { signal: {}, context: {} }, trace: { stableDecisionKey: 'same-root-stage' } }
    const make = (currentWork = work) => durableResearchClassification({ gateway, store: fx.store,
      work: currentWork, assignmentPolicy: V4_POLICY.assignmentPolicy, now: () => V4_NOW })
    await assert.rejects(make().classify(request), /Response lost/)
    await assert.rejects(make().classify(request), ResearchFollowupHold)
    await assert.rejects(make({ ...work, workId: 'work-continuation', retrievalPlan: { ...work.retrievalPlan,
      rootAssignmentId: researchRootAssignmentId(work) } }).classify(request), ResearchFollowupHold)
    assert.equal(calls, 1)
    assert.equal(fx.store.listResearchReservations(100)[0].state, 'execution_outcome_unknown')
  } finally { fx.close() }
})

test('received invalid classification output settles with a rejection receipt instead of an unknown hold', async () => {
  const fx = v4Database()
  try {
    const { work } = seedV4(fx.store)
    let calls = 0
    const gateway: Pick<ClassificationGateway, 'classify' | 'recordPolicyOutcome'> = {
      classify: async () => { calls += 1; throw new InferenceGatewayError('Provider output failed validation', {
        category: 'invalid_structured_output', retryable: false, provider: 'jev', model: 'model-1',
        providerResponseReceived: true,
      }) }, recordPolicyOutcome: async () => {},
    }
    const request = { workload: RESEARCH_NOVELTY_WORKLOAD, decisionVersion: RESEARCH_NOVELTY_VERSION,
      state: { signal: {}, context: {} }, trace: { stableDecisionKey: 'received-invalid-classification' } }
    failNextSettlement(fx.store)
    await assert.rejects(durableResearchClassification({ gateway, store: fx.store, work,
      assignmentPolicy: V4_POLICY.assignmentPolicy, now: () => V4_NOW }).classify(request), ResearchFollowupHold)
    const reservation = fx.store.listResearchReservations(100)[0]
    assert.equal(reservation?.state, 'dispatch_intent')
    assert.equal(fx.store.getResearchV4Record<{ status: string }>('rejected_response', work.workId, reservation.attemptId)?.status, 'received_response_rejected')
    await assert.rejects(durableResearchClassification({ gateway, store: fx.store, work,
      assignmentPolicy: V4_POLICY.assignmentPolicy, now: () => V4_NOW }).classify(request), /terminal and will not be redispatched/)
    assert.equal(calls, 1)
    assert.equal(fx.store.listResearchReservations(100)[0]?.state, 'settled')
  } finally { fx.close() }
})

test('durable classification preflight rejects local input before creating a paid reservation', async () => {
  const fx = v4Database()
  try {
    const { work } = seedV4(fx.store)
    let classifyCalls = 0
    const gateway = {
      preflight() { throw new Error('candidate state is invalid') },
      async classify() { classifyCalls += 1; throw new Error('must not dispatch') },
      async recordPolicyOutcome() {},
    } as unknown as Pick<ClassificationGateway, 'classify' | 'recordPolicyOutcome'> & {
      preflight(request: unknown): void
    }
    const port = durableResearchClassification({ gateway, store: fx.store, work,
      assignmentPolicy: V4_POLICY.assignmentPolicy, now: () => V4_NOW })
    await assert.rejects(port.classify({ workload: RESEARCH_NOVELTY_WORKLOAD, decisionVersion: RESEARCH_NOVELTY_VERSION,
      state: { invalid: true }, trace: { stableDecisionKey: 'invalid-local-state' } }), /candidate state is invalid/)
    assert.equal(classifyCalls, 0)
    assert.equal(fx.store.listResearchReservations(100).length, 0)
  } finally { fx.close() }
})
