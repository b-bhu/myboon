import assert from 'node:assert/strict'
import test from 'node:test'
import type { KnowledgeChangeV2, KnowledgeItemV2 } from '../entity-manager/knowledge-reader-v2'
import { applyManagedChanges, type ManagedChangeInvalidationState } from './managed-change-invalidation'

function event(changeId: string, revisionId: string, status: KnowledgeItemV2['status'] = 'active'): KnowledgeChangeV2 {
  const item = {
    id: 'item-1', revisionId, changeId, status, changedAt: '2026-01-01T00:00:00.000Z', entityIds: ['entity-a', 'entity-b'],
    memory: { id: 'item-1' },
  } as KnowledgeItemV2
  return { changeId, revisionId, itemId: item.id, changedAt: item.changedAt, status, affectedEntityIds: [...item.entityIds], item }
}
const seed = (): ManagedChangeInvalidationState => ({
  selections: [{ itemId: 'item-1', revisionId: 'rev-1', changeId: 'original', status: 'selected', sent: false }],
  appliedChangeIds: [],
})

test('same item evidence-only revision preserves selection and requests review', () => {
  const next = applyManagedChanges(seed(), [event('change-2', 'rev-2')])
  assert.deepEqual(next.selections[0], { itemId: 'item-1', revisionId: 'rev-2', changeId: 'change-2', status: 'review_needed', sent: false })
})

test('one immutable change appearing in two entity lanes is applied once', () => {
  const change = event('change-2', 'rev-2')
  const next = applyManagedChanges(seed(), [change, { ...change, affectedEntityIds: ['entity-b'] }])
  assert.equal(next.selections.length, 1)
  assert.deepEqual(next.appliedChangeIds, ['change-2'])
})

test('correction/retraction stales an unsent selection without deleting it', () => {
  const next = applyManagedChanges(seed(), [event('correction', 'rev-2', 'corrected')])
  assert.equal(next.selections.length, 1)
  assert.equal(next.selections[0]?.status, 'stale')
})

test('a distinct later change invalidates selection; replay is idempotent', () => {
  const first = applyManagedChanges(seed(), [event('correction-1', 'rev-2', 'corrected')])
  const second = applyManagedChanges(first, [event('correction-2', 'rev-3', 'retracted')])
  assert.equal(second.selections[0]?.revisionId, 'rev-3')
  assert.deepEqual(applyManagedChanges(second, [event('correction-2', 'rev-3', 'retracted')]), second)
})

test('already sent editorial selection remains in history as stale', () => {
  const state = seed()
  state.selections[0]!.sent = true
  const next = applyManagedChanges(state, [event('change-2', 'rev-2', 'retracted')])
  assert.equal(next.selections[0]?.status, 'stale')
  assert.equal(next.selections[0]?.sent, true)
})
