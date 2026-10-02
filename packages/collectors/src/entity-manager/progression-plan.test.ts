import assert from 'node:assert/strict'
import test from 'node:test'
import {
  PROGRESSION_PLAN_SCHEMA_VERSION,
  PROVISIONAL_MAX_EVIDENCE_REFS_PER_ITEM,
  PROVISIONAL_MAX_ITEMS_PER_PACKET,
  PROVISIONAL_MAX_NOTE_CHARS,
  ProgressionPlanValidationError,
  progressionPlanDigest,
  validateProgressionPlan,
} from './progression-plan'

function plan(overrides: Record<string, unknown> = {}) {
  return {
    contractVersion: 1,
    operationId: 'operation-1',
    workId: 'work-1',
    packetDigest: 'a'.repeat(64),
    contextDigest: 'b'.repeat(64),
    contextWatermark: 'watermark-17',
    policyVersion: 'policy-v1',
    promptVersion: 'prompt-v1',
    decisionVersions: { entity: 'entity-decision-v1' },
    targetRevisions: {
      'entity-uuid-1': 'entity-revision-4',
      'existing-item-uuid': 'item-revision-2',
    },
    outcome: {
      kind: 'apply',
      drafts: [{
        localKey: 'item-1',
        candidateId: 'model-candidate-1',
        note: 'An attributed, bounded note with unresolved research details preserved.',
        entityLinks: [{
          candidateEntityRef: 'candidate-entity-1',
          resolvedEntityRef: 'model-must-not-control-this-id',
          role: 'subject',
        }],
        continuityLinks: [],
        evidenceRefs: [{ claimId: 'claim-1', evidenceId: 'evidence-1', sourceRef: 'source-1' }],
      }],
      operations: [],
    },
    ...overrides,
  }
}

const resolveIdentity = (candidateEntityRef: string | null) =>
  candidateEntityRef === 'candidate-entity-1' ? 'entity-uuid-1' : null
const resolveEvidence = (candidate: { claimId: string; evidenceId: string; sourceRef: string }) =>
  candidate.claimId === 'claim-1' && candidate.evidenceId === 'evidence-1' && candidate.sourceRef === 'source-1'
    ? candidate
    : null

test('validates a bounded apply plan and replaces model identity with code-resolved Entity ID', () => {
  const validated = validateProgressionPlan(plan(), resolveIdentity, undefined, resolveEvidence)
  assert.equal(PROGRESSION_PLAN_SCHEMA_VERSION, 'myboon.progression_plan.v1')
  assert.equal(validated.contractVersion, 1)
  assert.equal(validated.outcome.kind, 'apply')
  if (validated.outcome.kind !== 'apply') assert.fail('expected apply outcome')
  assert.equal(validated.outcome.drafts[0]?.entityLinks[0]?.resolvedEntityRef, 'entity-uuid-1')
  assert.notEqual(
    validated.outcome.drafts[0]?.entityLinks[0]?.resolvedEntityRef,
    'model-must-not-control-this-id',
  )
})

test('apply with drafts fails closed without a code-owned identity resolver', () => {
  assert.throws(() => validateProgressionPlan(plan()), ProgressionPlanValidationError)
})

test('unresolved Entity identity blocks apply, but unresolved research detail is retained', () => {
  const candidate = plan()
  assert.throws(
    () => validateProgressionPlan(candidate, () => null),
    /unresolved identity blocks apply/,
  )
  const validated = validateProgressionPlan(candidate, resolveIdentity, undefined, resolveEvidence)
  assert.equal(validated.outcome.kind, 'apply')
  if (validated.outcome.kind === 'apply') {
    assert.match(validated.outcome.drafts[0]!.note, /unresolved research details/)
  }
})

test('rejects malformed SHA-256 digests and unsupported contract versions', () => {
  assert.throws(() => validateProgressionPlan(plan({ packetDigest: 'not-a-digest' }), resolveIdentity), /packetDigest/)
  assert.throws(() => validateProgressionPlan(plan({ contractVersion: 2 }), resolveIdentity), /contractVersion/)
})

test('rejects an apply plan above the provisional packet item cap', () => {
  const drafts = Array.from({ length: PROVISIONAL_MAX_ITEMS_PER_PACKET + 1 }, (_, index) => ({
    ...plan().outcome.drafts[0],
    localKey: `item-${index}`,
  }))
  const input = plan({ outcome: { kind: 'apply', drafts, operations: [] } })
  assert.throws(() => validateProgressionPlan(input, resolveIdentity), /PROVISIONAL cap/)
})

test('rejects oversized notes and evidence-reference groups rather than truncating', () => {
  const base = plan().outcome.drafts[0]
  const longNote = plan({ outcome: { kind: 'apply', drafts: [{ ...base, note: 'x'.repeat(PROVISIONAL_MAX_NOTE_CHARS + 1) }], operations: [] } })
  assert.throws(() => validateProgressionPlan(longNote, resolveIdentity), /PROVISIONAL cap/)
  const tooManyRefs = plan({ outcome: {
    kind: 'apply',
    drafts: [{ ...base, evidenceRefs: Array.from({ length: PROVISIONAL_MAX_EVIDENCE_REFS_PER_ITEM + 1 }, () => ({
      claimId: 'claim-1', evidenceId: 'evidence-1', sourceRef: 'source-1',
    })) }],
    operations: [],
  } })
  assert.throws(() => validateProgressionPlan(tooManyRefs, resolveIdentity), /PROVISIONAL cap/)
})

test('rejects duplicate local keys and continuity references outside the saved plan', () => {
  const draft = plan().outcome.drafts[0]
  const duplicate = plan({ outcome: { kind: 'apply', drafts: [draft, { ...draft }], operations: [] } })
  assert.throws(() => validateProgressionPlan(duplicate, resolveIdentity), /duplicate localKey/)
  const dangling = plan({ outcome: { kind: 'apply', drafts: [{
    ...draft,
    continuityLinks: [{ toLocalKey: 'missing-item', kind: 'continues' }],
  }], operations: [] } })
  assert.throws(() => validateProgressionPlan(dangling, resolveIdentity), /unresolved local key/)
})

test('accepts explicit hold and retain-observation outcomes without creating an item', () => {
  const held = validateProgressionPlan(plan({ outcome: {
    kind: 'hold', reason: 'Candidate identity needs review', missingDependency: 'entity_resolution',
  } }))
  assert.deepEqual(held.outcome, {
    kind: 'hold', reason: 'Candidate identity needs review', missingDependency: 'entity_resolution',
  })
  const retained = validateProgressionPlan(plan({ outcome: {
    kind: 'retain_observation', reason: 'No new item is justified by the saved evidence',
  } }))
  assert.deepEqual(retained.outcome, {
    kind: 'retain_observation', reason: 'No new item is justified by the saved evidence',
  })
})

test('existing-item operations require and use a code-owned item resolver', () => {
  const operationOutcome = {
    kind: 'apply',
    drafts: [],
    operations: [{
      candidateItemRef: 'candidate-item-1',
      itemId: 'model-must-not-control-this-id',
      kind: 'annotate',
      payload: { note: 'Attribute a new claim to the existing managed item.' },
    }],
  }
  const candidate = plan({ outcome: operationOutcome })
  assert.throws(
    () => validateProgressionPlan(candidate),
    /code-owned resolver/,
  )
  const validated = validateProgressionPlan(
    candidate,
    undefined,
    (candidateRef) => candidateRef === 'candidate-item-1' ? 'existing-item-uuid' : null,
  )
  assert.equal(validated.outcome.kind, 'apply')
  if (validated.outcome.kind !== 'apply') assert.fail('expected apply outcome')
  assert.equal(validated.outcome.operations[0]?.itemId, 'existing-item-uuid')
  assert.notEqual(validated.outcome.operations[0]?.itemId, 'model-must-not-control-this-id')
})

test('existing-item operation payload has a provisional byte cap', () => {
  const candidate = plan({ outcome: {
    kind: 'apply',
    drafts: [],
    operations: [{
      candidateItemRef: 'candidate-item-1',
      kind: 'correct',
      payload: { note: 'x'.repeat(16_500) },
    }],
  } })
  assert.throws(
    () => validateProgressionPlan(candidate, undefined, () => 'existing-item-uuid'),
    /PROVISIONAL cap/,
  )
})
test('evidence refs must resolve from saved source material; target revisions must cover each managed target', () => {
  assert.throws(
    () => validateProgressionPlan(plan(), resolveIdentity, undefined, () => null),
    /not present in the saved source packet/,
  )
  assert.throws(
    () => validateProgressionPlan(plan({ targetRevisions: {} }), resolveIdentity, undefined, resolveEvidence),
    /managed writes require code-owned target revision expectations/,
  )
})

test('validated plan snapshots are deeply immutable', () => {
  const validated = validateProgressionPlan(plan(), resolveIdentity, undefined, resolveEvidence)
  assert.ok(Object.isFrozen(validated.outcome))
  if (validated.outcome.kind !== 'apply') assert.fail('expected apply outcome')
  const drafts = validated.outcome.drafts
  assert.ok(Object.isFrozen(drafts))
  const draft = drafts[0]!
  assert.ok(Object.isFrozen(draft))
  assert.ok(Object.isFrozen(draft.evidenceRefs[0]))
  assert.throws(() => { draft.note = 'mutated' }, TypeError)
})


test('plan digest is a stable 64-character SHA-256 over the normalized validated plan', () => {
  const first = validateProgressionPlan(plan(), resolveIdentity, undefined, resolveEvidence)
  const replay = validateProgressionPlan(plan(), resolveIdentity, undefined, resolveEvidence)
  assert.match(progressionPlanDigest(first), /^[0-9a-f]{64}$/)
  assert.equal(progressionPlanDigest(first), progressionPlanDigest(replay))
  const changed = validateProgressionPlan(plan({ outcome: {
    kind: 'retain_observation', reason: 'Different accepted outcome',
  } }))
  assert.notEqual(progressionPlanDigest(first), progressionPlanDigest(changed))
})
