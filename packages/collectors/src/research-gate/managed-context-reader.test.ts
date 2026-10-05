import assert from 'node:assert/strict'
import test from 'node:test'
import { InternalResearchEntityMemoryReader, type ManagedResearchContextPort } from './managed-context-reader'
import { gateSignal } from './gate'
import { v4Classifier, v4ContextReader, V4_NOW } from '../research-engine/v4-test-fixtures'

function privateReader(overrides: Record<string, unknown> = {}) {
  const context = { entities: [{ id: 'entity-atlas', slug: 'atlas', name: 'Atlas', summary: null }],
    items: [{ itemId: 'private-item', entityIds: ['entity-atlas'], note: 'Atlas claimed Friday as launch date.', status: 'active', revision: '2',
      observedAt: V4_NOW, packetRefs: ['producer-packet'], evidenceRefs: [] }], digest: 'private-digest', watermark: '2', truncated: false, ...overrides }
  const managed: ManagedResearchContextPort = { researchContext: async () => context }
  return new InternalResearchEntityMemoryReader({ legacy: v4ContextReader(), managed, source: 'news', sourceRefs: ['Atlas-ref'], labels: ['Atlas'] })
}
const signal = { source: 'news', sourceRefId: 'Atlas-ref', title: 'Atlas launch date', whatChanged: 'Atlas says Friday.',
  observedAt: V4_NOW, sourceMaterial: 'Complete source: Atlas says Friday.', sourceMaterialComplete: true }

test('actual class reader noveltyEvidence retains its receiver through gate composition and supports guarded covered comparison', async () => {
  const reader = privateReader()
  const classifier = v4Classifier({ verdict: 'already_known', reason: 'Complete source claim already recorded.' })
  const result = await gateSignal(signal, { reader, classification: classifier.port })
  assert.equal(result.verdict, 'already_known')
  assert.equal(result.proceed, false)
  assert.deepEqual(result.noveltyContext?.lookupFailures, [])
  assert.deepEqual(result.noveltyContext?.itemRefs, ['private-item'])
  assert.match(result.noveltyContext!.digest, /private-digest/)
})

test('missing, truncated or failed private context cannot suppress a signal as known', async () => {
  for (const variant of ['missing', 'truncated', 'failed'] as const) {
    const legacy = v4ContextReader()
    const reader = variant === 'missing'
      ? new InternalResearchEntityMemoryReader({ legacy, source: 'news', sourceRefs: ['Atlas-ref'], labels: ['Atlas'] })
      : variant === 'failed' ? new InternalResearchEntityMemoryReader({ legacy, source: 'news', sourceRefs: ['Atlas-ref'], labels: ['Atlas'],
        managed: { researchContext: async () => { throw new Error('Private context unavailable') } } }) : privateReader({ truncated: true })
    const result = await gateSignal(signal, { reader, classification: v4Classifier({ verdict: 'already_known', reason: 'Semantic guess' }).port })
    assert.equal(result.proceed, true, variant)
    assert.notEqual(result.verdict, 'already_known', variant)
  }
})

test('omitted private note body is incomplete comparison coverage even when every row was returned', async () => {
  const reader = privateReader({ items: [{ itemId: 'large-note', entityIds: ['entity-atlas'], note: 'x'.repeat(2_001), status: 'active',
    revision: '1', observedAt: V4_NOW, packetRefs: ['packet'], evidenceRefs: [] }] })
  const result = await gateSignal(signal, { reader, classification: v4Classifier({ verdict: 'already_known', reason: 'Title matches' }).port })
  assert.equal(result.proceed, true)
  assert.equal(result.noveltyContext?.truncated, true)
})

test('exact accepted producer packet target requires one active immutable managed item and never guesses across corrections', async () => {
  assert.equal((await privateReader().attachmentTargetForPacket('producer-packet'))?.targetId, 'private-item')
  assert.equal(await privateReader().attachmentTargetForPacket('unrelated-packet'), null)
  assert.equal(await privateReader({ truncated: true }).attachmentTargetForPacket('producer-packet'), null)
  assert.equal(await privateReader({ items: [{ itemId: 'old', entityIds: ['entity-atlas'], note: 'Corrected prior item', status: 'superseded',
    revision: '1', observedAt: V4_NOW, packetRefs: ['producer-packet'], evidenceRefs: [] }] }).attachmentTargetForPacket('producer-packet'), null)
})
