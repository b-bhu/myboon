import assert from 'node:assert/strict'
import test from 'node:test'
import type { EntityKnowledgeMemoryV1 } from './entity-knowledge-reader'
import { ConsumerCheckpointsV2, FixtureKnowledgeReaderV2, InvalidKnowledgeV2CursorError, type KnowledgeItemV2 } from './knowledge-reader-v2'

const memory = { schemaVersion: 'myboon.entity_knowledge.v1', id: 'item-1', entityId: 'entity-a', memoryType: 'news_event', title: 'Fixture', summary: 'Summary', body: null, eventAt: null, observedAt: '2026-01-01T00:00:00Z', confidence: null, evidence: [], mentions: [], metrics: {}, context: {}, media: { imageUrl: null, imageKind: null, attribution: null }, provenance: { provider: 'fixture', sourceArea: 'news', sourceType: 'article', sourceRefId: 'source-1', researchPacketId: 'packet-1' }, priorityClass: null, createdAt: null, updatedAt: '2026-01-01T00:00:00Z' } as EntityKnowledgeMemoryV1
const item = (revisionId: string, changeId: string, entityIds: string[], status: KnowledgeItemV2['status'] = 'active'): KnowledgeItemV2 => ({ id: 'item-1', revisionId, changeId, status, memory: { ...memory, entityId: entityIds[0] ?? 'entity-a' }, entityIds, changedAt: '2026-01-01T00:00:00Z' })

test('fixture pages immutable revisions and reports removed memberships', () => {
  const reader = new FixtureKnowledgeReaderV2([item('r1', 'c1', ['entity-a', 'entity-b'])])
  reader.put(item('r2', 'c2', ['entity-a'], 'corrected'), '2026-01-02T00:00:00Z', ['entity-a', 'entity-b'])
  const page = reader.readChanges({ limit: 1, filter: { entityIds: ['entity-b'] } })
  assert.equal(page.changes[0]?.changeId, 'c1')
  const next = reader.readChanges({ after: page.nextCursor, limit: 2, filter: { entityIds: ['entity-b'] }, snapshot: page.snapshot })
  assert.deepEqual(next.changes[0]?.affectedEntityIds, ['entity-a', 'entity-b'])
  assert.equal(next.changes[0]?.status, 'corrected')
})

test('cursor binds filters/snapshot and hydration never reports partial success', () => {
  const reader = new FixtureKnowledgeReaderV2([item('r1', 'c1', ['entity-a'])])
  const page = reader.readChanges({ limit: 1, filter: { entityIds: ['entity-a'] } })
  assert.throws(() => reader.readChanges({ after: page.nextCursor, limit: 1, filter: { entityIds: ['entity-b'] }, snapshot: page.snapshot }), InvalidKnowledgeV2CursorError)
  assert.equal(reader.hydrateExact(['item-1', 'absent'], 4).outcome, 'failed')
  assert.equal(reader.hydrateExact(['item-1', 'absent'], 1).outcome, 'truncated')
  assert.equal(reader.hydrateExact(['item-1'], 4).outcome, 'complete')
})

test('change IDs are unique and same-timestamp changes page by log position', () => {
  const reader = new FixtureKnowledgeReaderV2([item('r1', 'c1', ['entity-a'])])
  assert.throws(() => reader.put(item('r2', 'c1', ['entity-a'])), /duplicate change ID/)
  reader.put(item('r2', 'c2', ['entity-a']), '2026-01-01T00:00:00Z')
  reader.put(item('r3', 'c3', ['entity-a']), '2026-01-01T00:00:00Z')
  const first = reader.readChanges({ limit: 1 })
  const second = reader.readChanges({ after: first.nextCursor, limit: 1, snapshot: first.snapshot })
  const third = reader.readChanges({ after: second.nextCursor, limit: 1, snapshot: first.snapshot })
  assert.deepEqual([first.changes[0]?.changeId, second.changes[0]?.changeId, third.changes[0]?.changeId], ['c1', 'c2', 'c3'])
  assert.throws(() => reader.readChanges({ after: Buffer.from(JSON.stringify({ v: 2, index: 999, filter: '{}', snapshot: first.snapshot })).toString('base64url'), limit: 1, snapshot: first.snapshot }), InvalidKnowledgeV2CursorError)
  assert.throws(() => reader.readChanges({ snapshot: '999', limit: 1 }), InvalidKnowledgeV2CursorError)
})

test('evidence-only revisions are delivered even when item identity and membership stay stable', () => {
  const reader = new FixtureKnowledgeReaderV2([item('r1', 'c1', ['entity-a'])])
  const revised = item('r2', 'c2', ['entity-a'])
  revised.memory = { ...revised.memory, evidence: [{ kind: 'fixture', ref: 'source-2' }] } as EntityKnowledgeMemoryV1
  reader.put(revised, '2026-01-02T00:00:00Z')
  const page = reader.readChanges({ after: reader.readChanges({ limit: 1 }).nextCursor, limit: 1 })
  assert.equal(page.changes[0]?.itemId, 'item-1')
  assert.equal(page.changes[0]?.revisionId, 'r2')
  assert.deepEqual(page.changes[0]?.item.memory.evidence, [{ kind: 'fixture', ref: 'source-2' }])
})

test('consumer checkpoints are independent', () => {
  const checkpoints = new ConsumerCheckpointsV2()
  checkpoints.advance('research', 'cursor-a')
  checkpoints.advance('editor', 'cursor-b')
  assert.equal(checkpoints.get('research'), 'cursor-a')
  assert.equal(checkpoints.get('editor'), 'cursor-b')
})
