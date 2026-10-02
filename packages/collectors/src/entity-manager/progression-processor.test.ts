import assert from 'node:assert/strict'
import test from 'node:test'
import {
  InMemoryKnowledgeOperationStore,
  type KnowledgeOperationEffect,
} from './knowledge-operation-store'
import type { ResearchPacketV1 } from '../signal-platform/contracts'
import {
  deriveManagedItemId,
  deriveProgressionAttemptDigest,
  deriveProgressionOperationId,
  ProgressionProcessor,
  type ProgressionPlanMetadata,
  type ProgressionProcessInput,
} from './progression-processor'
import { progressionPlanDigest } from './progression-plan'
import { progressionSourcePacketDigest } from './progression-source-packet-reader'

function sourcePacket(): ResearchPacketV1 {
  return {
    schemaVersion: 'myboon.research_packet.v1',
    packetId: 'packet-1',
    workId: 'work-1',
    signalId: 'signal-1',
    sourceType: 'news',
    observedAt: '2026-09-11T00:00:00.000Z',
    sourceSignal: {
      title: 'A source-backed finding',
      canonicalUrl: 'https://example.com/story',
      publishedAt: '2026-09-11T00:00:00.000Z',
      provenance: { provider: 'fixture', upstreamSource: 'Fixture', rawPayloadRef: 'fixture-1' },
    },
    claims: [
      { claimId: 'claim-a', claim: 'First supported claim.', attributedTo: null, evidenceRefs: ['evidence-a'] },
      { claimId: 'claim-b', claim: 'Second supported claim.', attributedTo: null, evidenceRefs: ['evidence-b'] },
    ],
    verifiedFacts: [],
    unresolvedClaims: [],
    evidence: [
      { evidenceId: 'evidence-a', title: 'Source A', url: 'https://example.com/source-a', sourceType: 'news', observedAt: null, note: null },
      { evidenceId: 'evidence-b', title: 'Source B', url: 'https://example.com/source-b', sourceType: 'news', observedAt: null, note: null },
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
      traceId: 'trace-1', attempt: 1,
    },
    researchContractVersion: 'myboon.research_packet.v1',
    createdAt: '2026-09-11T00:00:00.000Z',
  }
}

const metadata: ProgressionPlanMetadata = {
  packetDigest: progressionSourcePacketDigest(sourcePacket()),
  contextDigest: 'b'.repeat(64),
  contextWatermark: 'work-watermark-9',
  policyVersion: 'policy-v1',
  promptVersion: 'prompt-v1',
  decisionVersions: { entity: 'entity-decision-v3' },
  targetRevisions: {
    'resolved-candidate-entity-a': 'entity-revision-a',
    'resolved-candidate-entity-b': 'entity-revision-b',
    'existing-item-uuid': 'item-revision-8',
  },
}

const WORK_ID = 'work-1'
const SOURCE_EVIDENCE_REFS = [
  { claimId: 'claim-a', evidenceId: 'evidence-a', sourceRef: 'https://example.com/source-a' },
  { claimId: 'claim-b', evidenceId: 'evidence-b', sourceRef: 'https://example.com/source-b' },
]
const OPERATION_ID = deriveProgressionOperationId(WORK_ID)

function createProcessor(store: InMemoryKnowledgeOperationStore): ProgressionProcessor {
  return new ProgressionProcessor(store, {
    readResearchPacket: async () => sourcePacket(),
  })
}

function applyOutcome() {
  return {
    kind: 'apply',
    drafts: [
      {
        localKey: 'draft-a',
        candidateId: 'candidate-a',
        note: 'A bounded attributed finding.',
        entityLinks: [{
          candidateEntityRef: 'candidate-entity-a',
          resolvedEntityRef: 'model-must-not-control-entity-id',
          role: 'subject',
        }],
        continuityLinks: [{ toLocalKey: 'draft-b', kind: 'continues' }],
        evidenceRefs: [{ claimId: 'claim-a', evidenceId: 'evidence-a', sourceRef: 'https://example.com/source-a' }],
      },
      {
        localKey: 'draft-b',
        candidateId: null,
        note: 'A separate but connected finding.',
        entityLinks: [{ candidateEntityRef: 'candidate-entity-b', role: 'subject' }],
        continuityLinks: [],
        evidenceRefs: [{ claimId: 'claim-b', evidenceId: 'evidence-b', sourceRef: 'https://example.com/source-b' }],
      },
    ],
    operations: [{
      candidateItemRef: 'candidate-existing-item',
      itemId: 'model-must-not-control-existing-item-id',
      kind: 'annotate',
      payload: { note: 'Attach corroborating evidence.' },
    }],
  }
}

function processInput(overrides: Partial<ProgressionProcessInput> = {}): ProgressionProcessInput {
  const workId = overrides.workId ?? WORK_ID
  const selectedMetadata = overrides.metadata ?? metadata
  return {
    operationId: overrides.operationId ?? deriveProgressionOperationId(workId),
    workId,
    owner: 'worker-a',
    metadata: selectedMetadata,
    assertPlanningAvailable: async () => {},
    proposeOutcome: async () => applyOutcome(),
    resolveEntityIdentity: (candidateRef) => candidateRef ? `resolved-${candidateRef}` : null,
    resolveExistingItemIdentity: (candidateRef) => candidateRef ? 'existing-item-uuid' : null,

    checkPlanFreshness: async () => ({ current: true, reason: '', missingDependency: '' }),
    ...overrides,
  }
}

function createStore(leaseTtlMs = 60_000): InMemoryKnowledgeOperationStore {
  const store = new InMemoryKnowledgeOperationStore({ leaseTtlMs })
  for (const [targetId, revision] of Object.entries(metadata.targetRevisions)) {
    store.setTargetRevision(targetId, revision)
  }
  return store
}

class RenewalObservedStore extends InMemoryKnowledgeOperationStore {
  private signalFirstRenewal!: () => void
  readonly firstRenewal: Promise<void>

  constructor(leaseTtlMs = 500) {
    super({ leaseTtlMs })
    this.firstRenewal = new Promise<void>((resolve) => { this.signalFirstRenewal = resolve })
    for (const [targetId, revision] of Object.entries(metadata.targetRevisions)) this.setTargetRevision(targetId, revision)
  }

  override async renewLease(operationId: string, owner: string, epoch: number) {
    const renewed = await super.renewLease(operationId, owner, epoch)
    if (renewed) this.signalFirstRenewal()
    return renewed
  }
}

test('attempt metadata is normalized before its digest and plan checkpointing', async () => {
  const store = createStore()
  let packetReads = 0
  let proposalCalls = 0
  const processor = new ProgressionProcessor(store, {
    readResearchPacket: async () => { packetReads += 1; return sourcePacket() },
  })
  const nonNormalizedMetadata = { ...metadata, policyVersion: ' policy-v1 ' }

  const result = await processor.process(processInput({
    metadata: nonNormalizedMetadata,
    proposeOutcome: async () => { proposalCalls += 1; return applyOutcome() },
  }))
  assert.equal(result.kind, 'accepted')
  assert.equal(packetReads, 1)
  assert.equal(proposalCalls, 1)
  const saved = await store.findSavedPlan(OPERATION_ID, deriveProgressionAttemptDigest(OPERATION_ID, metadata))
  assert.equal(saved?.plan.policyVersion, 'policy-v1')
})

test('lease release failures do not mask durable results or the original processing error', async () => {
  class FailingReleaseStore extends InMemoryKnowledgeOperationStore {
    override async releaseLease(): Promise<boolean> {
      throw new Error('lease release outage')
    }
  }
  const createFailingReleaseStore = () => {
    const store = new FailingReleaseStore({ leaseTtlMs: 60_000 })
    for (const [targetId, revision] of Object.entries(metadata.targetRevisions)) store.setTargetRevision(targetId, revision)
    return store
  }

  const heldStore = createFailingReleaseStore()
  const heldProcessor = new ProgressionProcessor(heldStore, { readResearchPacket: async () => null })
  const held = await heldProcessor.process(processInput())
  assert.equal(held.kind, 'held')
  assert.equal((await heldStore.findHoldHistory(OPERATION_ID))[0]?.status, 'held')

  const failedStore = createFailingReleaseStore()
  const failedProcessor = createProcessor(failedStore)
  await assert.rejects(
    failedProcessor.process(processInput({ proposeOutcome: async () => { throw new Error('original proposal failure') } })),
    /original proposal failure/,
  )
})

test('applies a validated plan with code-owned UUIDs and all related effects', async () => {
  const store = createStore()
  const processor = createProcessor(store)
  const result = await processor.process(processInput())
  assert.equal(result.kind, 'accepted')
  if (result.kind !== 'accepted') assert.fail('expected accepted result')
  assert.equal(result.alreadyAccepted, false)
  assert.equal(result.receipt.status, 'accepted')

  const effects = store.committedEffects(OPERATION_ID) as KnowledgeOperationEffect[]
  assert.equal(effects.length, 3)
  const draftA = effects.find((effect) => effect.payload.localKey === 'draft-a')
  const draftB = effects.find((effect) => effect.payload.localKey === 'draft-b')
  const existing = effects.find((effect) => effect.kind === 'existing_item_operation')
  assert.equal(draftA?.itemId, deriveManagedItemId(OPERATION_ID, 'draft-a'))
  assert.equal(draftB?.itemId, deriveManagedItemId(OPERATION_ID, 'draft-b'))
  assert.deepEqual(draftA?.payload.entityLinks, [{
    entityId: 'resolved-candidate-entity-a',
    candidateEntityRef: 'candidate-entity-a',
    role: 'subject',
  }])
  assert.deepEqual(draftA?.payload.continuityLinks, [{
    itemId: deriveManagedItemId(OPERATION_ID, 'draft-b'),
    kind: 'continues',
  }])
  assert.equal(existing?.itemId, 'existing-item-uuid')
  assert.notEqual(existing?.itemId, 'model-must-not-control-existing-item-id')
})

test('receipt lookup happens before configuration, model, and freshness checks', async () => {
  const store = createStore()
  const processor = createProcessor(store)
  await processor.process(processInput())
  let configurationCalls = 0
  let modelCalls = 0
  let freshnessCalls = 0
  const replay = await processor.process(processInput({
    owner: 'worker-b',
    assertPlanningAvailable: async () => { configurationCalls += 1; throw new Error('must not run') },
    proposeOutcome: async () => { modelCalls += 1; throw new Error('must not run') },
    checkPlanFreshness: async () => { freshnessCalls += 1; throw new Error('must not run') },
  }))
  assert.equal(replay.kind, 'replayed')
  assert.deepEqual([configurationCalls, modelCalls, freshnessCalls], [0, 0, 0])
  assert.equal(store.committedEffects(OPERATION_ID).length, 3)
})

test('accepted receipts replay across prompt fingerprints but remain bound to the work ID', async () => {
  const store = createStore()
  const processor = createProcessor(store)
  const accepted = await processor.process(processInput())
  assert.equal(accepted.kind, 'accepted')

  await assert.rejects(
    processor.process(processInput({ operationId: OPERATION_ID, workId: 'different-work' })),
    /operationId does not match the code-owned logical work ID/,
  )
  let modelCalls = 0
  const changedFingerprint = await processor.process(processInput({
    metadata: { ...metadata, promptVersion: '' },
    proposeOutcome: async () => { modelCalls += 1; return applyOutcome() },
  }))
  assert.equal(changedFingerprint.kind, 'replayed')
  assert.equal(modelCalls, 0)
  assert.equal((await store.findReceipt(OPERATION_ID))?.workId, WORK_ID)
  assert.equal(store.committedEffects(OPERATION_ID).length, 3)
})

test('receipt result must be stored under the requested operation id', async () => {
  class MiskeyedReceiptStore extends InMemoryKnowledgeOperationStore {
    override async findReceipt(operationId: string) {
      const receipt = await super.findReceipt(operationId)
      return receipt ? { ...receipt, operationId: 'different-operation' } : null
    }
  }
  const store = new MiskeyedReceiptStore({ leaseTtlMs: 60_000 })
  for (const [targetId, revision] of Object.entries(metadata.targetRevisions)) store.setTargetRevision(targetId, revision)
  const processor = createProcessor(store)
  await processor.process(processInput())
  await assert.rejects(processor.process(processInput()), /receipt operationId or workId does not match/)
})

test('a checkpointed plan must match every current material input even with a valid digest', async () => {
  class MiskeyedSavedPlanStore extends InMemoryKnowledgeOperationStore {
    corruptSavedPlan = false
    override async findSavedPlan(operationId: string, attemptDigest: string) {
      const saved = await super.findSavedPlan(operationId, attemptDigest)
      if (!saved || !this.corruptSavedPlan) return saved
      const plan = { ...saved.plan, contextWatermark: 'different-watermark' }
      return { ...saved, plan, planDigest: progressionPlanDigest(plan) }
    }
  }
  const store = new MiskeyedSavedPlanStore({ leaseTtlMs: 60_000 })
  for (const [targetId, revision] of Object.entries(metadata.targetRevisions)) store.setTargetRevision(targetId, revision)
  const processor = createProcessor(store)
  store.setCommitInterceptor(() => { throw new Error('synthetic commit failure') })
  await assert.rejects(processor.process(processInput()), /synthetic commit failure/)
  store.setCommitInterceptor(() => {})
  store.corruptSavedPlan = true

  await assert.rejects(
    processor.process(processInput()),
    /saved progression plan does not match requested operation and material inputs/,
  )
})

test('over-cap proposals create a durable hold retaining the full proposal and zero effects', async () => {
  const store = createStore()
  const processor = createProcessor(store)
  const oversized = applyOutcome()
  oversized.drafts.push(...Array.from({ length: 3 }, (_, index) => ({
    ...oversized.drafts[0],
    localKey: `overflow-${index}`,
  })))
  const result = await processor.process(processInput({ proposeOutcome: async () => oversized }))
  assert.equal(result.kind, 'held')
  if (result.kind !== 'held') assert.fail('expected held result')
  assert.equal(result.alreadyAccepted, false)
  assert.equal(result.receipt.missingDependency, 'plan_validation')
  assert.equal(result.receipt.retainedGroups, 6)
  assert.deepEqual(result.receipt.retainedPayload, { outcome: oversized, metadata })
  assert.deepEqual(store.committedEffects(OPERATION_ID), [])
})

test('a checkpointed plan retries without another model call after a failed atomic commit', async () => {
  const store = createStore()
  const processor = createProcessor(store)
  let proposalCalls = 0
  store.setCommitInterceptor(() => { throw new Error('synthetic transaction failure') })
  await assert.rejects(
    processor.process(processInput({ proposeOutcome: async () => { proposalCalls += 1; return applyOutcome() } })),
    /synthetic transaction failure/,
  )
  assert.equal(await store.findReceipt(OPERATION_ID), null)
  assert.notEqual(
    await store.findSavedPlan(OPERATION_ID, deriveProgressionAttemptDigest(OPERATION_ID, metadata)),
    null,
  )
  assert.deepEqual(store.committedEffects(OPERATION_ID), [])

  store.setCommitInterceptor(() => {})
  const replay = await processor.process(processInput({
    owner: 'worker-a',
    proposeOutcome: async () => { proposalCalls += 1; throw new Error('saved plan should be used') },
  }))
  assert.equal(replay.kind, 'accepted')
  assert.equal(proposalCalls, 1)
  assert.equal(store.committedEffects(OPERATION_ID).length, 3)
})

test('a changed prompt appends a new immutable plan revision for unfinished work', async () => {
  const store = createStore()
  const processor = createProcessor(store)
  store.setCommitInterceptor(() => { throw new Error('synthetic transaction failure') })
  await assert.rejects(
    processor.process(processInput({ proposeOutcome: async () => applyOutcome() })),
    /synthetic transaction failure/,
  )

  store.setCommitInterceptor(() => {})
  let proposalCalls = 0
  const changedMetadata = { ...metadata, promptVersion: 'prompt-v2' }
  const retried = await processor.process(processInput({
    metadata: changedMetadata,
    proposeOutcome: async () => {
      proposalCalls += 1
      const outcome = applyOutcome()
      outcome.drafts[0]!.note = 'A new prompt produced this uncommitted revision.'
      return outcome
    },
  }))
  assert.equal(retried.kind, 'accepted')
  assert.equal(proposalCalls, 1)
  assert.equal(processInput({ metadata: changedMetadata }).operationId, OPERATION_ID)
  const history = await store.findSavedPlanHistory(OPERATION_ID)
  assert.equal(history.length, 2)
  assert.deepEqual(history.map((saved) => saved.plan.promptVersion), ['prompt-v1', 'prompt-v2'])
  assert.deepEqual(history.map((saved) => saved.revision), [1, 2])
  assert.equal(store.committedEffects(OPERATION_ID)[0]?.payload.note, 'A new prompt produced this uncommitted revision.')
})

test('a held attempt is preserved and a new prompt can retry the same logical work', async () => {
  const store = createStore()
  const processor = createProcessor(store)
  const first = await processor.process(processInput({
    proposeOutcome: async () => ({
      kind: 'hold', reason: 'Need a better prompt', missingDependency: 'prompt_revision',
    }),
  }))
  assert.equal(first.kind, 'held')
  assert.equal(await store.findReceipt(OPERATION_ID), null)
  assert.equal((await store.findHoldHistory(OPERATION_ID)).length, 1)

  const second = await processor.process(processInput({
    metadata: { ...metadata, promptVersion: 'prompt-v2' },
  }))
  assert.equal(second.kind, 'accepted')
  assert.equal((await store.findHoldHistory(OPERATION_ID)).length, 1)
  assert.equal((await store.findReceipt(OPERATION_ID))?.status, 'accepted')
  assert.equal((await store.findSavedPlanHistory(OPERATION_ID)).length, 2)
})

test('stale plan versions are held with the plan preserved and no writes', async () => {
  const store = createStore()
  const processor = createProcessor(store)
  const result = await processor.process(processInput({
    checkPlanFreshness: async () => ({
      current: false,
      reason: 'Entity target revision changed after planning',
      missingDependency: 'target_revalidation',
    }),
  }))
  assert.equal(result.kind, 'held')
  if (result.kind !== 'held') assert.fail('expected held result')
  assert.equal(result.receipt.missingDependency, 'target_revalidation')
  assert.equal(result.receipt.retainedGroups, 3)
  assert.deepEqual(store.committedEffects(OPERATION_ID), [])
  assert.ok(result.receipt.retainedPayload && typeof result.receipt.retainedPayload === 'object')
})

test('freshness callback receives a deeply frozen saved plan', async () => {
  const store = createStore()
  const processor = createProcessor(store)
  const result = await processor.process(processInput({
    checkPlanFreshness: async (plan) => {
      assert.ok(Object.isFrozen(plan))
      assert.ok(Object.isFrozen(plan.outcome))
      if (plan.outcome.kind !== 'apply') assert.fail('expected apply plan')
      const draft = plan.outcome.drafts[0]
      assert.ok(draft)
      assert.ok(Object.isFrozen(draft))
      assert.ok(Object.isFrozen(draft.evidenceRefs))
      assert.throws(() => { draft.note = 'mutated after digest' }, TypeError)
      return { current: true, reason: '', missingDependency: '' }
    },
  }))
  assert.equal(result.kind, 'accepted')
  const effects = store.committedEffects(OPERATION_ID)
  assert.equal(effects.find((effect) => effect.payload.localKey === 'draft-a')?.payload.note, 'A bounded attributed finding.')
})

test('a changed target revision at commit is converted to a preserved hold with zero writes', async () => {
  const store = createStore()
  const processor = createProcessor(store)
  const result = await processor.process(processInput({
    checkPlanFreshness: async () => {
      store.setTargetRevision('resolved-candidate-entity-a', 'entity-revision-new')
      return { current: true, reason: '', missingDependency: '' }
    },
  }))
  assert.equal(result.kind, 'held')
  if (result.kind !== 'held') assert.fail('expected held result')
  assert.equal(result.receipt.missingDependency, 'target_revalidation')
  assert.match(result.receipt.reason ?? '', /revision changed before commit/)
  assert.equal(result.receipt.retainedGroups, 3)
  assert.deepEqual(store.committedEffects(OPERATION_ID), [])
})

test('new managed item IDs must be absent at commit time', async () => {
  const store = createStore()
  store.setTargetRevision(deriveManagedItemId(OPERATION_ID, 'draft-a'), 'unexpected-existing-row')
  const result = await createProcessor(store).process(processInput())
  assert.equal(result.kind, 'held')
  if (result.kind !== 'held') assert.fail('expected expected-absent collision hold')
  assert.equal(result.receipt.missingDependency, 'target_revalidation')
  assert.match(result.receipt.reason ?? '', /revision changed before commit/)
  assert.equal(await store.findReceipt(OPERATION_ID), null)
  assert.equal((await store.findHoldHistory(OPERATION_ID)).length, 1)
  assert.deepEqual(store.committedEffects(OPERATION_ID), [])
})

test('a competing owner cannot preempt a live lease or invoke the model', async () => {
  const store = createStore()
  const processor = createProcessor(store)
  let releasePlanning!: () => void
  let markStarted!: () => void
  const started = new Promise<void>((resolve) => { markStarted = resolve })
  const planningGate = new Promise<void>((resolve) => { releasePlanning = resolve })
  const first = processor.process(processInput({
    assertPlanningAvailable: async () => { markStarted(); await planningGate },
  }))
  await started
  let competingModelCalls = 0
  const competing = await processor.process(processInput({
    owner: 'worker-b',
    proposeOutcome: async () => { competingModelCalls += 1; return applyOutcome() },
  }))
  assert.equal(competing.kind, 'busy')
  assert.equal(competingModelCalls, 0)
  releasePlanning()
  assert.equal((await first).kind, 'accepted')
})

test('concurrent calls with the same owner cannot share one live lease', async () => {
  const store = createStore()
  const processor = createProcessor(store)
  let releaseProposal!: () => void
  let markStarted!: () => void
  const started = new Promise<void>((resolve) => { markStarted = resolve })
  const proposalGate = new Promise<void>((resolve) => { releaseProposal = resolve })
  let proposalCalls = 0
  const first = processor.process(processInput({
    proposeOutcome: async () => {
      proposalCalls += 1
      markStarted()
      await proposalGate
      return applyOutcome()
    },
  }))
  await started

  const second = await processor.process(processInput({
    proposeOutcome: async () => { proposalCalls += 1; return applyOutcome() },
  }))
  try {
    assert.equal(second.kind, 'busy')
    assert.equal(proposalCalls, 1)
  } finally {
    releaseProposal()
  }
  assert.equal((await first).kind, 'accepted')
})

test('lease heartbeat prevents a competing planner taking over during a slow preflight', async () => {
  const store = new RenewalObservedStore()
  const processor = createProcessor(store)
  let releasePreflight!: () => void
  let markStarted!: () => void
  const started = new Promise<void>((resolve) => { markStarted = resolve })
  const preflightGate = new Promise<void>((resolve) => { releasePreflight = resolve })
  const first = processor.process(processInput({
    assertPlanningAvailable: async () => { markStarted(); await preflightGate },
  }))
  await started
  await store.firstRenewal

  let competingModelCalls = 0
  const competing = await processor.process(processInput({
    owner: 'worker-b',
    proposeOutcome: async () => { competingModelCalls += 1; return applyOutcome() },
  }))
  assert.equal(competing.kind, 'busy')
  assert.equal(competingModelCalls, 0)
  releasePreflight()
  assert.equal((await first).kind, 'accepted')
})

test('lease heartbeat keeps ownership during a slow proposal', async () => {
  const store = new RenewalObservedStore()
  const processor = createProcessor(store)
  let releaseProposal!: () => void
  let markStarted!: () => void
  const started = new Promise<void>((resolve) => { markStarted = resolve })
  const proposalGate = new Promise<void>((resolve) => { releaseProposal = resolve })
  const first = processor.process(processInput({
    proposeOutcome: async () => { markStarted(); await proposalGate; return applyOutcome() },
  }))
  await started
  await store.firstRenewal

  const competing = await processor.process(processInput({ owner: 'worker-b' }))
  assert.equal(competing.kind, 'busy')
  releaseProposal()
  assert.equal((await first).kind, 'accepted')
})

test('lease heartbeat keeps ownership during a slow freshness check', async () => {
  const store = new RenewalObservedStore()
  const processor = createProcessor(store)
  let releaseFreshness!: () => void
  let markStarted!: () => void
  const started = new Promise<void>((resolve) => { markStarted = resolve })
  const freshnessGate = new Promise<void>((resolve) => { releaseFreshness = resolve })
  const first = processor.process(processInput({
    checkPlanFreshness: async () => {
      markStarted()
      await freshnessGate
      return { current: true, reason: '', missingDependency: '' }
    },
  }))
  await started
  await store.firstRenewal

  const competing = await processor.process(processInput({ owner: 'worker-b' }))
  assert.equal(competing.kind, 'busy')
  releaseFreshness()
  assert.equal((await first).kind, 'accepted')
})

test('lost lease heartbeat fences a slow proposal before it can commit', async () => {
  let markHeartbeatLost!: () => void
  const heartbeatLost = new Promise<void>((resolve) => { markHeartbeatLost = resolve })
  class LostHeartbeatStore extends InMemoryKnowledgeOperationStore {
    override async renewLease() {
      markHeartbeatLost()
      return null
    }
  }
  const store = new LostHeartbeatStore({ leaseTtlMs: 30 })
  for (const [targetId, revision] of Object.entries(metadata.targetRevisions)) store.setTargetRevision(targetId, revision)
  const processor = createProcessor(store)
  let releaseProposal!: () => void
  let markStarted!: () => void
  const started = new Promise<void>((resolve) => { markStarted = resolve })
  const proposalGate = new Promise<void>((resolve) => { releaseProposal = resolve })
  const first = processor.process(processInput({
    proposeOutcome: async () => { markStarted(); await proposalGate; return applyOutcome() },
  }))
  await started
  await heartbeatLost
  await new Promise((resolve) => setTimeout(resolve, 5))
  releaseProposal()

  assert.equal((await first).kind, 'fenced')
  assert.deepEqual(store.committedEffects(OPERATION_ID), [])
  assert.equal(await store.findReceipt(OPERATION_ID), null)
})

test('missing saved packet creates a durable source-packet hold before planning', async () => {
  const store = createStore()
  const processor = new ProgressionProcessor(store, { readResearchPacket: async () => null })
  let modelCalls = 0
  const result = await processor.process(processInput({
    proposeOutcome: async () => { modelCalls += 1; return applyOutcome() },
  }))
  assert.equal(result.kind, 'held')
  if (result.kind !== 'held') assert.fail('expected held result')
  assert.equal(result.receipt.missingDependency, 'source_packet')
  assert.equal(modelCalls, 0)
  assert.equal((result.receipt.retainedPayload as { metadata: ProgressionPlanMetadata }).metadata.promptVersion, 'prompt-v1')
  assert.deepEqual(store.committedEffects(OPERATION_ID), [])
})

test('evidence absent from the saved source packet is held without writes', async () => {
  const store = createStore()
  const processor = createProcessor(store)
  const outcome = applyOutcome()
  outcome.drafts[0]!.evidenceRefs[0]!.sourceRef = 'https://unlisted.example/not-in-packet'
  const result = await processor.process(processInput({ proposeOutcome: async () => outcome }))
  assert.equal(result.kind, 'held')
  if (result.kind !== 'held') assert.fail('expected held result')
  assert.equal(result.receipt.missingDependency, 'plan_validation')
  assert.deepEqual(store.committedEffects(OPERATION_ID), [])
  assert.ok(result.receipt.retainedPayload)
})


test('retain-observation is an accepted no-op receipt; explicit hold is durable and effect-free', async () => {
  const retainStore = createStore()
  const retainProcessor = createProcessor(retainStore)
  const retained = await retainProcessor.process(processInput({
    proposeOutcome: async () => ({ kind: 'retain_observation', reason: 'No new item is justified.' }),
  }))
  assert.equal(retained.kind, 'accepted')
  assert.deepEqual(retainStore.committedEffects(OPERATION_ID), [])

  const holdStore = createStore()
  const holdProcessor = createProcessor(holdStore)
  const held = await holdProcessor.process(processInput({
    proposeOutcome: async () => ({
      kind: 'hold', reason: 'Candidate entity is unresolved', missingDependency: 'entity_resolution',
    }),
  }))
  assert.equal(held.kind, 'held')
  assert.deepEqual(holdStore.committedEffects(OPERATION_ID), [])
})

test('unresolved model entity identity becomes a preserved hold, not a partial write', async () => {
  const store = createStore()
  const processor = createProcessor(store)
  const result = await processor.process(processInput({
    resolveEntityIdentity: () => null,
  }))
  assert.equal(result.kind, 'held')
  if (result.kind !== 'held') assert.fail('expected held result')
  assert.equal(result.receipt.missingDependency, 'plan_validation')
  assert.deepEqual(store.committedEffects(OPERATION_ID), [])
  assert.ok(result.receipt.retainedPayload)
})

test('a two-megabyte invalid proposal is retained in the durable overflow hold', async () => {
  const store = createStore()
  const processor = createProcessor(store)
  const largeValue = 'x'.repeat(2 * 1_048_576)
  const largeMetadata: ProgressionPlanMetadata = {
    ...metadata,
    decisionVersions: { oversized: largeValue },
  }
  const input = processInput({ metadata: largeMetadata })
  const result = await processor.process(input)
  assert.equal(result.kind, 'held')
  if (result.kind !== 'held') assert.fail('expected held result')
  assert.equal(result.receipt.retainedGroups, 3)
  const retained = result.receipt.retainedPayload as { metadata: ProgressionPlanMetadata }
  assert.equal(retained.metadata.decisionVersions.oversized?.length, largeValue.length)
  const [reloaded] = await store.findHoldHistory(input.operationId)
  assert.equal((reloaded?.retainedPayload as typeof retained).metadata.decisionVersions.oversized?.length, largeValue.length)
  assert.deepEqual(store.committedEffects(input.operationId), [])
})

test('operation identity is stable per work while item identities remain deterministic', () => {
  const operationInputs = { workId: WORK_ID, ...metadata, decisionVersions: { entity: 'v1' } }
  const operationId = deriveProgressionOperationId(operationInputs.workId)
  assert.equal(operationId, deriveProgressionOperationId(operationInputs.workId))
  assert.equal(operationId, deriveProgressionOperationId(' work-1 '))
  assert.notEqual(operationId, deriveProgressionOperationId('work-2'))
  assert.match(deriveManagedItemId('operation-1', 'draft-a'), /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  assert.notEqual(deriveManagedItemId('operation-1', 'draft-a'), deriveManagedItemId('operation-2', 'draft-a'))
})
