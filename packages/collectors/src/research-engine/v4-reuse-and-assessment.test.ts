import assert from 'node:assert/strict'
import test from 'node:test'
import { reuseCompatibleResearchResult, type ResearchReuseContract } from './research-result-reuse'
import { reusePlannedSourceEvidence } from './cross-source-evidence-reuse'
import { assessRetainedPartialResearch } from './retained-partial-assessment'
import { runRetainedPartialAssessment } from './run-retained-partial-assessment'
import { runReconcileResearchReservation } from './run-reconcile-research-reservation'
import { claimReservation, recordDispatchIntent, recordUnknownOutcome } from './assignment-budget'
import { researchRootAssignmentId } from './bounded-followup'
import { operationsFixture, withIsolatedV4Environment } from '../signal-platform/v4-operations.test-support'
import { v4Database, seedV4, v4Signal, v4Packet, V4_NOW, V4_SOURCE_URL, V4_POLICY } from './v4-test-fixtures'
import type { RetrievedEvidence, ResearchPacketV1 } from '../signal-platform/contracts'

const CONTRACT: ResearchReuseContract = { question: 'Which date does Atlas claim for launch?', scope: 'One Atlas release, source assertions only',
  applicability: 'Atlas product launch event', correctionSignature: 'corrections-v1', sourceMaterialDigest: 'same-complete-source-material' }
const POLICY = { policyVersion: 'reuse.approved.test.v1', maxEvidenceAgeMs: 3_600_000, maxResearchAgeMs: 3_600_000 }

function reuseFixture() {
  const owner = v4Database('news'), consumer = v4Database('polymarket')
  const producer = seedV4(owner.store, undefined, { retrievalPlan: { sourceUrl: V4_SOURCE_URL,
    allowedDomains: ['issuer.example'], maxExternalSources: 1, researchReuseContract: CONTRACT } })
  const current = seedV4(consumer.store, undefined, { retrievalPlan: { sourceUrl: V4_SOURCE_URL,
    allowedDomains: ['issuer.example'], maxExternalSources: 1, researchReuseContract: CONTRACT } })
  const packet = v4Packet({ signal: producer.signal, workItem: producer.work, evidence: [producer.evidence] },
    { reuseSnapshot: { policyVersion: POLICY.policyVersion, knowledgeDigest: 'current-knowledge-v1', assignmentContract: CONTRACT } })
  owner.store.appendResearchPacket(packet)
  const input = { owners: [owner.store], consumer: consumer.store, signal: current.signal, work: current.work,
    evidence: [current.evidence], policy: POLICY, now: V4_NOW, currentKnowledgeDigest: 'current-knowledge-v1', assignmentContract: CONTRACT }
  return { owner, consumer, producer, current, packet, input, close() { owner.close(); consumer.close() } }
}

test('whole cross-source result reuse remaps exact immutable evidence IDs and preserves attribution, partial completion and limitations', () => {
  const fx = reuseFixture()
  try {
    const original = fx.owner.store.getResearchPacket(fx.packet.packetId)
    const reused = reuseCompatibleResearchResult(fx.input)!
    assert.ok(reused)
    assert.equal(reused.workId, fx.current.work.workId)
    assert.equal(reused.sourceType, 'polymarket')
    assert.equal(reused.claims[0].attributedTo, 'Atlas')
    assert.deepEqual(reused.claims[0].evidenceRefs, [fx.current.evidence.evidenceId])
    assert.equal(reused.completion, 'partial')
    assert.deepEqual(reused.verifiedFacts, [])
    assert.ok(reused.limitations.includes(fx.packet.limitations[0]))
    assert.equal(reused.budgetUsed.providerCalls, 0)
    assert.ok(reused.execution.reusedResult)
    assert.deepEqual(fx.owner.store.getResearchPacket(fx.packet.packetId), original)
    assert.equal(fx.consumer.store.listResearchV4Records<{ decision: string }>('research_reuse', fx.current.work.workId, 10)[0].decision, 'reuse_result')
  } finally { fx.close() }
})

for (const dimension of ['question', 'scope', 'applicability', 'correctionSignature', 'sourceMaterialDigest'] as const) {
  test(`whole result reuse rejects changed ${dimension}`, () => {
    const fx = reuseFixture()
    try {
      assert.equal(reuseCompatibleResearchResult({ ...fx.input, assignmentContract: { ...CONTRACT, [dimension]: 'changed' } }), null)
      const record = fx.consumer.store.listResearchV4Records<{ decision: string, reason: string }>('research_reuse', fx.current.work.workId, 10)[0]
      assert.equal(record.decision, 'rejected')
      assert.equal(record.reason, 'incompatible_question_scope_applicability_or_correction')
    } finally { fx.close() }
  })
}

for (const change of ['knowledge', 'evidence', 'research_policy', 'expiry', 'missing_context', 'truncated'] as const) {
  test(`whole result reuse safely misses ${change} changes`, () => {
    const fx = reuseFixture()
    try {
      const input = { ...fx.input }
      if (change === 'knowledge') input.currentKnowledgeDigest = 'corrected-or-retracted-knowledge'
      if (change === 'evidence') input.evidence = [{ ...fx.current.evidence, contentHash: 'new-body-hash' }]
      if (change === 'research_policy') input.work = { ...fx.current.work, policyVersion: 'different-policy' }
      if (change === 'expiry') input.now = '2026-10-03T10:00:00.000Z'
      if (change === 'missing_context') input.currentKnowledgeDigest = null as unknown as string
      if (change === 'truncated') input.evidence = [{ ...fx.current.evidence, truncated: true }]
      assert.equal(reuseCompatibleResearchResult(input), null)
    } finally { fx.close() }
  })
}

test('missing referenced capture is recorded as a reuse rejection rather than falsely accepted usage', () => {
  const fx = reuseFixture()
  try {
    const owner = { artifactStoreId: () => fx.owner.store.artifactStoreId(), getResearchWork: (id: string) => fx.owner.store.getResearchWork(id),
      getResearchPacket: (id: string) => fx.owner.store.getResearchPacket(id), listEvidenceByWork: () => [fx.producer.evidence],
      listRecentResearchPackets: () => [{ ...fx.packet, claims: [{ ...fx.packet.claims[0], evidenceRefs: ['missing-producer-capture'] }] }] }
    assert.equal(reuseCompatibleResearchResult({ ...fx.input, owners: [owner] }), null)
    const record = fx.consumer.store.listResearchV4Records<{ decision: string, reason: string }>('research_reuse', fx.current.work.workId, 10)[0]
    assert.equal(record.decision, 'rejected')
    assert.equal(record.reason, 'unavailable_referenced_capture')
  } finally { fx.close() }
})

test('planned cross-source capture reuse pins producer bytes, preserves original work and capture time, and records consumer origin', () => {
  const fx = reuseFixture()
  try {
    const original = fx.owner.store.getEvidence(fx.producer.evidence.evidenceId)
    const captures = reusePlannedSourceEvidence({ owners: [fx.owner.store], consumer: fx.consumer.store, signal: fx.current.signal,
      work: fx.current.work, urls: [V4_SOURCE_URL], policy: POLICY, maxBytesPerSource: 1_000, maxTotalBytes: 1_000, now: V4_NOW })
    assert.equal(captures.length, 1)
    const copied = captures[0]
    assert.equal(copied.workId, fx.current.work.workId)
    assert.notEqual(copied.evidenceId, fx.producer.evidence.evidenceId)
    assert.equal(copied.retrievedAt, fx.producer.evidence.retrievedAt)
    const origin = copied.reuseApproval as { pinId: string, ref: { ownerStoreId: string, artifactId: string } }
    assert.equal(origin.ref.ownerStoreId, fx.owner.store.artifactStoreId())
    assert.equal(origin.ref.artifactId, fx.producer.evidence.evidenceId)
    const pin = fx.owner.store.getArtifactPin(origin.pinId)!
    assert.deepEqual(fx.owner.store.resolvePinnedArtifact(pin), original)
    assert.deepEqual(fx.owner.store.getEvidence(fx.producer.evidence.evidenceId), original)
    assert.equal(fx.consumer.store.listResearchV4Records('evidence_reuse', fx.current.work.workId, 10).length, 1)
  } finally { fx.close() }
})

for (const reason of ['missing_pin', 'correction', 'new_body', 'unapproved_material', 'oversize'] as const) {
  test(`planned evidence reuse safely misses ${reason}`, () => {
    const fx = reuseFixture()
    try {
      const owner = reason === 'missing_pin' ? new Proxy(fx.owner.store, { get(target, property) {
        if (property === 'resolvePinnedArtifact') return () => null
        const value = Reflect.get(target, property); return typeof value === 'function' ? value.bind(target) : value
      } }) : fx.owner.store
      const work = { ...fx.current.work, retrievalPlan: { ...fx.current.work.retrievalPlan } }
      if (reason === 'correction') work.retrievalPlan.researchReuseContract = { ...CONTRACT, correctionSignature: 'changed' }
      if (reason === 'new_body') work.retrievalPlan.evidenceReuseState = { contentHashByRequestedUrl: { [V4_SOURCE_URL]: 'updated-content' } }
      if (reason === 'unapproved_material') delete work.retrievalPlan.researchReuseContract
      assert.deepEqual(reusePlannedSourceEvidence({ owners: [owner], consumer: fx.consumer.store, signal: fx.current.signal,
        work, urls: [V4_SOURCE_URL], policy: POLICY, maxBytesPerSource: reason === 'oversize' ? 1 : 1_000, maxTotalBytes: 1_000, now: V4_NOW }), [])
    } finally { fx.close() }
  })
}

test('explicit retained-partial assessment records useful readiness without canonical promotion, queue replay or paid execution', () => {
  const fx = v4Database()
  try {
    const seeded = seedV4(fx.store)
    const packet = v4Packet({ signal: seeded.signal, workItem: seeded.work, evidence: [seeded.evidence] })
    fx.store.appendResearchPacket(packet)
    const assessment = assessRetainedPartialResearch({ store: fx.store, packetIds: [packet.packetId], admissionId: 'explicit-admission',
      operatorId: 'offline-operator', limit: 1, now: V4_NOW })
    assert.equal(assessment[0].disposition, 'retained_for_review')
    assert.equal(assessment[0].decision.outcome, 'ready_for_entity')
    assert.equal(fx.store.getResearchReadinessByPacket(packet.packetId), null)
    assert.equal(fx.store.getResearchWork(seeded.work.workId)?.status, 'synthesis_pending')
    assert.equal(fx.store.listResearchReservations(10).length, 0)
    assert.throws(() => assessRetainedPartialResearch({ store: fx.store, packetIds: [packet.packetId, 'missing'], admissionId: 'separate-admission',
      operatorId: 'operator', limit: 2, now: V4_NOW }), /not a retained partial/)
    assert.equal(fx.store.listResearchV4Records('retained_partial_assessment', seeded.work.workId, 10).length, 1)
  } finally { fx.close() }
})

test('D1 single-item operator requires durable pause and records explicit authority without replay', () => {
  const restore = withIsolatedV4Environment(), fx = operationsFixture()
  try {
    const seeded = seedV4(fx.store)
    const packet = v4Packet({ signal: seeded.signal, workItem: seeded.work, evidence: [seeded.evidence] })
    fx.store.appendResearchPacket(packet)
    const args = ['--source', 'news', '--database', fx.path, '--packet', packet.packetId, '--admission', 'offline-admission', '--operator', 'offline-operator']
    assert.throws(() => runRetainedPartialAssessment(args), /paused/)
    fx.run(fx.receipt('initialize'))
    const result = runRetainedPartialAssessment(args) as Array<{ operatorId: string, disposition: string }>
    assert.equal(result[0].operatorId, 'offline-operator')
    assert.equal(result[0].disposition, 'retained_for_review')
    assert.equal(fx.store.getResearchReadinessByPacket(packet.packetId), null)
    assert.equal(fx.store.getResearchWork(seeded.work.workId)?.status, 'synthesis_pending')
  } finally { fx.dispose(); restore() }
})

test('D2 operator inspect does not mutate; unknown payment cannot release without supported proof', async () => {
  const restore = withIsolatedV4Environment(), fx = operationsFixture()
  try {
    const { work } = seedV4(fx.store)
    fx.run(fx.receipt('initialize'))
    const key = { rootAssignmentId: researchRootAssignmentId(work), allowanceId: 'research_primary_synthesis.v1', attemptId: 'offline-attempt' }
    const budget = fx.store.researchBudgetStore()
    assert.equal((await claimReservation(budget, { ...key, requestDigest: 'request', providerRoute: 'offline',
      approvedLimits: { ...V4_POLICY.synthesisPolicy, maxProviderCalls: 2 }, assignmentLimits: V4_POLICY.assignmentPolicy, nowMs: 1 })).ok, true)
    await recordDispatchIntent(budget, key, { ownedEpoch: 1, nowMs: 2 }); await recordUnknownOutcome(budget, key, { ownedEpoch: 1, nowMs: 3 })
    const args = ['--source', 'news', '--database', fx.path, '--work', work.workId, '--root', key.rootAssignmentId,
      '--allowance', key.allowanceId, '--attempt', key.attemptId, '--admission', 'offline-reconciliation', '--operator', 'offline-operator']
    const result = await runReconcileResearchReservation([...args, '--action', 'inspect']) as { disposition: string }
    assert.equal(result.disposition, 'retained_hold_no_mutation')
    assert.equal(fx.store.listResearchV4Records('reservation_reconciliation', work.workId, 10).length, 0)
    await assert.rejects(runReconcileResearchReservation([...args, '--action', 'release-before-dispatch']), /never-dispatched/)
    await assert.rejects(runReconcileResearchReservation([...args, '--action', 'settle-saved-response']), /No matching code-owned/)
    assert.equal((await budget.get(key))?.state, 'execution_outcome_unknown')
    assert.equal(fx.store.getResearchWork(work.workId)?.status, 'synthesis_pending')
  } finally { fx.dispose(); restore() }
})
