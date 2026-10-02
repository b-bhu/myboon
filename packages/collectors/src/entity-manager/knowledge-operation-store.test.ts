import assert from 'node:assert/strict'
import test from 'node:test'
import {
  InMemoryKnowledgeOperationStore,
  KnowledgeOperationConflictError,
  KnowledgeOperationFencingError,
  KnowledgeOperationStaleTargetError,
  knowledgeOperationHoldContentDigest,
  knowledgeOperationSemanticDigest,
} from './knowledge-operation-store'

const PLAN_DIGEST = 'a'.repeat(64)
const ATTEMPT_DIGEST = 'c'.repeat(64)
const EFFECTS = [{
  itemId: '11111111-1111-4111-8111-111111111111',
  kind: 'managed_item' as const,
  payload: { title: 'A bounded accepted development', evidenceIds: ['evidence-1'] },
}]
const CONTENT_DIGEST = knowledgeOperationSemanticDigest(EFFECTS)

function createStore() {
  let now = new Date('2026-10-02T00:00:00.000Z')
  const store = new InMemoryKnowledgeOperationStore({ leaseTtlMs: 1_000, now: () => now })
  return { store, advance: (milliseconds: number) => { now = new Date(now.getTime() + milliseconds) } }
}

function commit(owner: string, epoch: number, overrides: Record<string, unknown> = {}) {
  return {
    operationId: 'operation-1',
    workId: 'work-1',
    owner,
    epoch,
    attemptDigest: ATTEMPT_DIGEST,
    planRevision: 1,
    planDigest: PLAN_DIGEST,
    contentDigest: CONTENT_DIGEST,
    targetRevisions: {},
    expectedAbsentItemIds: [EFFECTS[0]!.itemId],
    effects: EFFECTS,
    ...overrides,
  }
}

function hold(owner: string, epoch: number, overrides: Record<string, unknown> = {}) {
  const detail = {
    reason: 'Plan exceeds the bounded writer contract',
    missingDependency: 'plan_review',
    retainedGroups: 2,
    retainedPayload: [{ group: 'group-1' }, { group: 'group-2' }],
  }
  return {
    operationId: 'operation-1',
    workId: 'work-1',
    owner,
    epoch,
    attemptDigest: ATTEMPT_DIGEST,
    planRevision: null,
    planDigest: PLAN_DIGEST,
    contentDigest: knowledgeOperationHoldContentDigest(detail),
    ...detail,
    ...overrides,
  }
}

test('semantic digest is SHA-256 and canonical across object key order', () => {
  const first = knowledgeOperationSemanticDigest({ b: 2, nested: { z: true, a: 1 } })
  const replay = knowledgeOperationSemanticDigest({ nested: { a: 1, z: true }, b: 2 })
  assert.match(first, /^[0-9a-f]{64}$/)
  assert.equal(first, replay)
  assert.notEqual(first, knowledgeOperationSemanticDigest({ b: 3, nested: { z: true, a: 1 } }))
})

test('stale owner epochs cannot commit and the replacement owner can', async () => {
  const { store, advance } = createStore()
  const first = await store.acquireLease('operation-1', 'worker-a')
  assert.ok(first)
  assert.equal(await store.acquireLease('operation-1', 'worker-b'), null)
  advance(1_001)
  await assert.rejects(
    store.commitOperations(commit(first.owner, first.epoch)),
    KnowledgeOperationFencingError,
  )
  const second = await store.acquireLease('operation-1', 'worker-b')
  assert.ok(second)
  assert.equal(second.epoch, first.epoch + 1)
  await assert.rejects(
    store.commitOperations(commit(first.owner, first.epoch)),
    KnowledgeOperationFencingError,
  )
  const result = await store.commitOperations(commit(second.owner, second.epoch))
  assert.equal(result.alreadyAccepted, false)
  assert.equal(result.receipt?.status, 'accepted')
  assert.equal(store.committedEffects('operation-1').length, 1)
})

test('the same owner cannot reacquire a live lease, and release preserves the next fence epoch', async () => {
  const { store } = createStore()
  const first = await store.acquireLease('operation-1', 'worker-a')
  assert.ok(first)
  assert.equal(await store.acquireLease('operation-1', 'worker-a'), null)
  assert.equal(await store.releaseLease('operation-1', first.owner, first.epoch), true)

  const retry = await store.acquireLease('operation-1', 'worker-a')
  assert.ok(retry)
  assert.equal(retry.epoch, first.epoch + 1)
  assert.equal(await store.releaseLease('operation-1', first.owner, first.epoch), false)
})

test('effects and receipt commit together and an identical replay does not duplicate effects', async () => {
  const { store, advance } = createStore()
  const first = await store.acquireLease('operation-1', 'worker-a')
  assert.ok(first)
  const accepted = await store.commitOperations(commit(first.owner, first.epoch))
  assert.equal(accepted.alreadyAccepted, false)
  assert.equal(accepted.receipt?.ownerEpoch, first.epoch)
  assert.deepEqual(store.committedEffects('operation-1'), EFFECTS)

  advance(1_001)
  const replay = await store.commitOperations(commit(first.owner, first.epoch))
  assert.equal(replay.alreadyAccepted, true)
  assert.equal(replay.receipt?.committedAt, accepted.receipt?.committedAt)
  assert.equal(replay.receipt?.ownerEpoch, first.epoch)
  assert.deepEqual(store.committedEffects('operation-1'), EFFECTS)
})

test('a failed all-or-nothing commit leaves no effects and no receipt', async () => {
  const { store } = createStore()
  const lease = await store.acquireLease('operation-1', 'worker-a')
  assert.ok(lease)
  store.setCommitInterceptor(() => { throw new Error('synthetic transaction failure') })
  await assert.rejects(store.commitOperations(commit(lease.owner, lease.epoch)), /synthetic transaction failure/)
  assert.equal(await store.findReceipt('operation-1'), null)
  assert.deepEqual(store.committedEffects('operation-1'), [])
})

test('a new managed item must still be absent at commit time', async () => {
  const { store } = createStore()
  const lease = await store.acquireLease('operation-1', 'worker-a')
  assert.ok(lease)
  store.setTargetRevision(EFFECTS[0]!.itemId, 'unexpected-existing-row')
  await assert.rejects(
    store.commitOperations(commit(lease.owner, lease.epoch)),
    KnowledgeOperationStaleTargetError,
  )
  assert.equal(await store.findReceipt('operation-1'), null)
  assert.deepEqual(store.committedEffects('operation-1'), [])
})

test('the absent-item expectation must match the code-derived managed item effects', async () => {
  const { store } = createStore()
  const lease = await store.acquireLease('operation-1', 'worker-a')
  assert.ok(lease)
  await assert.rejects(
    store.commitOperations(commit(lease.owner, lease.epoch, { expectedAbsentItemIds: [] })),
    /expectedAbsentItemIds must exactly match new managed item effects/,
  )
  assert.equal(await store.findReceipt('operation-1'), null)
  assert.deepEqual(store.committedEffects('operation-1'), [])
})

test('an existing-item operation requires its expected target revision', async () => {
  const { store } = createStore()
  const lease = await store.acquireLease('operation-1', 'worker-a')
  assert.ok(lease)
  const targetId = 'existing-item-1'
  const effects = [{ itemId: targetId, kind: 'existing_item_operation' as const, payload: { kind: 'revise' } }]
  const effectOverrides = {
    effects,
    expectedAbsentItemIds: [],
    contentDigest: knowledgeOperationSemanticDigest(effects),
  }
  store.setTargetRevision(targetId, 'revision-1')

  await assert.rejects(
    store.commitOperations(commit(lease.owner, lease.epoch, effectOverrides)),
    /targetRevisions must include the expected revision for managed target existing-item-1/,
  )
  assert.equal(await store.findReceipt('operation-1'), null)
  assert.deepEqual(store.committedEffects('operation-1'), [])

  const accepted = await store.commitOperations(commit(lease.owner, lease.epoch, {
    ...effectOverrides,
    targetRevisions: { [targetId]: 'revision-1' },
  }))
  assert.equal(accepted.receipt?.status, 'accepted')
  assert.deepEqual(store.committedEffects('operation-1'), effects)

  const replay = await store.commitOperations(commit(lease.owner, lease.epoch, effectOverrides))
  assert.equal(replay.alreadyAccepted, true)
  assert.deepEqual(replay.receipt, accepted.receipt)
})

test('a managed-item entity link requires its expected entity revision', async () => {
  const { store } = createStore()
  const lease = await store.acquireLease('operation-1', 'worker-a')
  assert.ok(lease)
  const effects = [{
    ...EFFECTS[0]!,
    payload: { ...EFFECTS[0]!.payload, entityLinks: [{ entityId: 'entity-1', role: 'subject' }] },
  }]
  const effectOverrides = {
    effects,
    contentDigest: knowledgeOperationSemanticDigest(effects),
  }
  store.setTargetRevision('entity-1', 'entity-revision-1')

  await assert.rejects(
    store.commitOperations(commit(lease.owner, lease.epoch, effectOverrides)),
    /targetRevisions must include the expected revision for managed target entity-1/,
  )
  assert.equal(await store.findReceipt('operation-1'), null)

  const accepted = await store.commitOperations(commit(lease.owner, lease.epoch, {
    ...effectOverrides,
    targetRevisions: { 'entity-1': 'entity-revision-1' },
  }))
  assert.equal(accepted.receipt?.status, 'accepted')
})

test('lease renewal preserves the epoch and an expired owner cannot renew or commit', async () => {
  const { store, advance } = createStore()
  const lease = await store.acquireLease('operation-1', 'worker-a')
  assert.ok(lease)
  const renewed = await store.renewLease('operation-1', lease.owner, lease.epoch)
  assert.ok(renewed)
  assert.equal(renewed.epoch, lease.epoch)
  advance(1_001)
  assert.equal(await store.renewLease('operation-1', lease.owner, lease.epoch), null)
  await assert.rejects(
    store.commitOperations(commit(lease.owner, lease.epoch)),
    KnowledgeOperationFencingError,
  )
})

test('effect digest mismatches and conflicting replays fail closed', async () => {
  const { store } = createStore()
  const lease = await store.acquireLease('operation-1', 'worker-a')
  assert.ok(lease)
  await assert.rejects(
    store.commitOperations(commit(lease.owner, lease.epoch, { contentDigest: '0'.repeat(64) })),
    KnowledgeOperationConflictError,
  )
  assert.equal(await store.findReceipt('operation-1'), null)

  await store.commitOperations(commit(lease.owner, lease.epoch))
  await assert.rejects(
    store.commitOperations(commit(lease.owner, lease.epoch, { workId: 'different-work' })),
    KnowledgeOperationConflictError,
  )
})

test('holds append attempt history and a later accepted attempt does not erase it', async () => {
  const { store } = createStore()
  const lease = await store.acquireLease('operation-1', 'worker-a')
  assert.ok(lease)
  const held = await store.commitHold(hold(lease.owner, lease.epoch))
  assert.equal(held.receipt?.status, 'held')
  assert.equal(held.receipt?.retainedGroups, 2)
  assert.deepEqual(held.receipt?.retainedPayload, [{ group: 'group-1' }, { group: 'group-2' }])
  assert.equal(store.committedEffects('operation-1').length, 0)

  const replay = await store.commitHold(hold(lease.owner, lease.epoch))
  assert.equal(replay.alreadyAccepted, false)
  assert.equal(replay.receipt?.status, 'held')
  assert.equal(await store.findReceipt('operation-1'), null)
  assert.equal((await store.findHoldHistory('operation-1')).length, 1)

  const accepted = await store.commitOperations(commit(lease.owner, lease.epoch, {
    attemptDigest: 'd'.repeat(64),
    planRevision: 2,
  }))
  assert.equal(accepted.receipt?.status, 'accepted')
  assert.equal((await store.findHoldHistory('operation-1')).length, 1)
  assert.equal(store.committedEffects('operation-1').length, 1)
})
