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

const WORK_ID = 'work-mc-342'
const OWNER = 'mc-save-source-owner'
const OPERATION_ID = deriveProgressionOperationId(WORK_ID)

function sourcePacket(): ResearchPacketV1 {
  return {
    schemaVersion: 'myboon.research_packet.v1',
    packetId: 'packet-mc-342',
    workId: WORK_ID,
    signalId: 'signal-mc-342',
    sourceType: 'news',
    observedAt: '2026-10-20T00:00:00.000Z',
    sourceSignal: {
      title: 'A source-backed managed finding with a legacy hint',
      canonicalUrl: 'https://example.com/managed-342',
      publishedAt: '2026-10-20T00:00:00.000Z',
      provenance: { provider: 'fixture', upstreamSource: 'Fixture', rawPayloadRef: 'fixture-mc-342' },
    },
    claims: [
      { claimId: 'claim-mc-342-a', claim: 'First supported managed claim.', attributedTo: null, evidenceRefs: ['evidence-mc-342-a'] },
    ],
    verifiedFacts: [],
    unresolvedClaims: [],
    evidence: [
      { evidenceId: 'evidence-mc-342-a', title: 'Source A', url: 'https://example.com/source-a', sourceType: 'news', observedAt: null, note: null },
    ],
    entityHints: [
      {
        name: 'Fixture Data Provider',
        // Legacy free-text type as research packs store it — not an already
        // mapped value such as 'organization'. Entity code must forward it raw.
        type: 'data provider',
        role: null,
        aliases: [],
        source: null,
        claimRefs: ['claim-mc-342-a'],
        evidenceRefs: ['evidence-mc-342-a'],
      },
    ],
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
      traceId: 'trace-mc-342', attempt: 1,
    },
    researchContractVersion: 'myboon.research_packet.v1',
    createdAt: '2026-10-20T00:00:00.000Z',
  }
}

/**
 * A minimal PostgresKnowledgeOperationWriter stand-in that records what the
 * processor hands to saveResearchSource. The fake mirrors managed_knowledge_private
 * behavior the scenario touches only: the entity worker converts the durable
 * held receipt (nothing can ground) into a retryable PlatformFailure that never
 * consumes an attempt, which ends process() after the source save.
 */
function fakeManager() {
  const savedSources: Array<{ packet: ResearchPacketV1; handoff: unknown }> = []
  const holds: KnowledgeOperationHoldInput[] = []
  const expiresAt = () => new Date(Date.now() + 60_000).toISOString()
  const context: ManagedResearchContext = { entities: [], items: [], digest: 'context-digest-1', watermark: 'watermark-mc-342', truncated: false }
  const writer = {
    async findPlanningDispatch() { return null },
    async saveResearchSource(packet: ResearchPacketV1, handoff: unknown) {
      savedSources.push({ packet, handoff })
    },
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
  return { writer: writer as unknown as PostgresKnowledgeOperationWriter, holds, savedSources }
}

test('the managed non-article path forwards the raw input packet to saveResearchSource, legacy hint type included', async () => {
  // #342 follow-up: on the non-article path ManagedCanonicalPacketProcessor
  // must pass the input packet to writer.saveResearchSource UNCHANGED — the
  // same reference and deep-equal content, entityHints types included, even
  // when a hint carries the legacy free-text type 'data provider'. No TS-side
  // type mapping may be added: the fill trigger entity_fill_columns_v1
  // (20261019230000) maps the stored column, and mapping in TS would break
  // writer_v1 digest/grounding equality on retry, so do not add it back.
  const packet = sourcePacket()
  // Pristine copy taken before processing: any TS-side mapping or mutation of
  // the packet during process() shows up as a against-clone mismatch here.
  const packetClone = structuredClone(packet)
  const readiness = {
    schemaVersion: 'myboon.research_readiness.v1',
    outcome: 'ready_for_entity',
    entityAction: { kind: 'entity_item', actionId: 'action-mc-342', targetId: null },
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
  const { writer, holds, savedSources } = fakeManager()
  const processor = new ManagedCanonicalPacketProcessor({
    writer,
    ports: [port],
    // Nothing grounds here, so planning asserts availability and returns before
    // any entity is created: a paid gateway must never be built for this scenario.
    gatewayFactory() { throw new Error('no paid gateway may be constructed for an ungrounded identity') },
    policyVersion: 'fixture-policy',
    owner: OWNER,
    assertOwnership() {},
    executeOwned: (_source, action) => action(),
  })

  // The hint cannot ground (no prior identities, and a source-side data
  // provider is not a membership role), so process() rejects with the durable
  // held failure — after the source save it must survive the raw forwarding.
  await assert.rejects(processor.process(input), (error: unknown) => {
    assert.ok(error instanceof PlatformFailure)
    assert.equal(error.category, 'storage_transient')
    assert.equal(error.retryable, true)
    assert.equal(error.incrementsAttempt, false)
    assert.match(error.message, /^entity_identity_grounding: No explicitly evidenced entity identity/)
    return true
  })
  assert.equal(holds.length, 1)
  assert.equal(holds[0]?.missingDependency, 'entity_identity_grounding')

  // The save happened exactly once, before the hold, with the pristine packet.
  assert.equal(savedSources.length, 1)
  const saved = savedSources[0]!
  assert.equal(saved.packet, input.canonicalPacket)
  assert.deepStrictEqual(saved.packet, packetClone)
  assert.equal(saved.packet.entityHints[0]?.type, 'data provider')
})