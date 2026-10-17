import assert from 'node:assert/strict'
import test from 'node:test'
import type { ResearchPacketV1, ResearchWorkItem } from '../signal-platform/contracts'
import { PlatformFailure } from '../signal-platform/failures'
import type { ResearchReadiness } from '../signal-platform/research-readiness'
import {
  type KnowledgeOperationCommitResult,
  type KnowledgeOperationHoldInput,
  type KnowledgeOperationReceipt,
  type SaveProgressionPlanInput,
} from './knowledge-operation-store'
import { ManagedCanonicalPacketProcessor } from './managed-canonical-processor'
import type {
  ManagedResearchContext,
  PostgresKnowledgeOperationWriter,
} from './postgres-knowledge-writer'
import { deriveProgressionOperationId } from './progression-processor'
import type { CanonicalPacketProcessorInput, EntityPacketWorkPort } from './shared-worker'

const WORK_ID = 'work-mc-337'
const OWNER = 'mc-held-owner'
const OPERATION_ID = deriveProgressionOperationId(WORK_ID)

function sourcePacket(): ResearchPacketV1 {
  return {
    schemaVersion: 'myboon.research_packet.v1',
    packetId: 'packet-mc-1',
    workId: WORK_ID,
    signalId: 'signal-mc-1',
    sourceType: 'news',
    observedAt: '2026-10-17T00:00:00.000Z',
    sourceSignal: {
      title: 'A source-backed managed finding',
      canonicalUrl: 'https://example.com/managed',
      publishedAt: '2026-10-17T00:00:00.000Z',
      provenance: { provider: 'fixture', upstreamSource: 'Fixture', rawPayloadRef: 'fixture-mc-1' },
    },
    claims: [
      { claimId: 'claim-mc-a', claim: 'First supported managed claim.', attributedTo: null, evidenceRefs: ['evidence-mc-a'] },
    ],
    verifiedFacts: [],
    unresolvedClaims: [],
    evidence: [
      { evidenceId: 'evidence-mc-a', title: 'Source A', url: 'https://example.com/source-a', sourceType: 'news', observedAt: null, note: null },
    ],
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
      traceId: 'trace-mc-1', attempt: 1,
    },
    researchContractVersion: 'myboon.research_packet.v1',
    createdAt: '2026-10-17T00:00:00.000Z',
  }
}

/**
 * A minimal PostgresKnowledgeOperationWriter stand-in. Reaching a held receipt
 * through the real writer needs live PostgreSQL (see
 * postgres-knowledge-writer.integration.test.ts), so this unit test binds
 * exactly the calls the scenario makes. The recorded `holds` mirror
 * managed_knowledge_private.holds: the entity worker converts a durable held
 * receipt into a retryable PlatformFailure that never consumes an attempt.
 */
function fakeManager() {
  const holds: KnowledgeOperationHoldInput[] = []
  const expiresAt = () => new Date(Date.now() + 60_000).toISOString()
  const context: ManagedResearchContext = { entities: [], items: [], digest: 'context-digest-1', watermark: 'watermark-mc-1', truncated: false }
  const writer = {
    async findPlanningDispatch() { return null },
    async saveResearchSource() {},
    async researchContext() { return context },
    async savePlanningContext() {},
    async findReceipt() { return null },
    async acquireLease() {
      return { operationId: OPERATION_ID, owner: OWNER, epoch: 1, expiresAt: expiresAt() }
    },
    async renewLease() {
      return { operationId: OPERATION_ID, owner: OWNER, epoch: 1, expiresAt: expiresAt() }
    },
    async releaseLease() { return true },
    async findSavedPlan() { return null },
    async saveValidatedPlan(input: SaveProgressionPlanInput) {
      return {
        revision: 1, attemptDigest: input.attemptDigest, plan: input.plan,
        planDigest: input.planDigest, savedAt: new Date().toISOString(), owner: input.owner, ownerEpoch: input.epoch,
      }
    },
    async targetsCurrent() { return true },
    async commitHold(input: KnowledgeOperationHoldInput): Promise<KnowledgeOperationCommitResult> {
      holds.push(input)
      const receipt = {
        schemaVersion: 'myboon.knowledge_operation_receipt.v2', status: 'held',
        operationId: input.operationId, workId: input.workId,
        attemptDigest: input.attemptDigest, planRevision: input.planRevision,
        planDigest: input.planDigest, owner: input.owner, ownerEpoch: input.epoch,
        contentDigest: input.contentDigest, committedAt: new Date().toISOString(),
        reason: input.reason, missingDependency: input.missingDependency,
        retainedGroups: input.retainedGroups, retainedPayload: input.retainedPayload,
      } as KnowledgeOperationReceipt
      return { receipt, alreadyAccepted: false }
    },
  }
  return { writer: writer as unknown as PostgresKnowledgeOperationWriter, holds }
}

test('a durable held receipt surfaces as a retryable platform failure without consuming the attempt', async () => {
  // #337 PR-A: a held receipt (here: no explicitly evidenced entity identity
  // can be grounded) must map to a PlatformFailure that is retryable and does
  // not increment the attempt, so the re-planned attempt can retry the work.
  const packet = sourcePacket()
  const readiness = {
    schemaVersion: 'myboon.research_readiness.v1',
    outcome: 'ready_for_entity',
    entityAction: { kind: 'entity_item', actionId: 'action-mc-1', targetId: null },
  } as ResearchReadiness
  const work = { workId: WORK_ID, sourceType: 'news' } as ResearchWorkItem
  const port = {
    sourceType: 'news',
    async peekSchedulable() { return null },
    async claimWithLease() { return null },
    async heartbeatLease() { return true },
    async transitionLeased() { return null },
    async releaseLease() { return true },
    readResearchPacket: async () => packet,
    readHandoffContext: async () => ({ work, signal: null, persistedEvidence: [], readiness }),
  } as unknown as EntityPacketWorkPort
  const input = {
    work,
    canonicalPacket: packet,
    packet: packet,
    signal: new AbortController().signal,
    handoffContext: { work, signal: null, persistedEvidence: [], readiness },
  } as unknown as CanonicalPacketProcessorInput
  const { writer, holds } = fakeManager()
  const processor = new ManagedCanonicalPacketProcessor({
    writer,
    ports: [port],
    // assertPlanningAvailable returns before construction when no entity is
    // grounded, so a paid gateway must never be built for this scenario.
    gatewayFactory() { throw new Error('no paid gateway may be constructed for an ungrounded identity') },
    policyVersion: 'fixture-policy',
    owner: OWNER,
    assertOwnership() {},
    executeOwned: (_source, action) => action(),
  })

  await assert.rejects(processor.process(input), (error: unknown) => {
    assert.ok(error instanceof PlatformFailure)
    assert.equal(error.category, 'storage_transient')
    assert.equal(error.retryable, true)
    assert.equal(error.incrementsAttempt, false)
    assert.equal(error.retryAfterMs, 300_000)
    assert.match(error.message, /^entity_identity_grounding: No explicitly evidenced entity identity/)
    return true
  })

  // The failure came from a durable held receipt: plan revision 1 with the
  // outcome retained, ready for the re-planned attempt.
  assert.equal(holds.length, 1)
  assert.equal(holds[0]?.planRevision, 1)
  assert.equal(holds[0]?.missingDependency, 'entity_identity_grounding')
  assert.equal(holds[0]?.owner, OWNER)
})