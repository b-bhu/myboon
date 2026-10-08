import assert from 'node:assert/strict'
import test from 'node:test'
import { InternalResearchEntityMemoryReader, isTransientContextFailure, type ManagedResearchContextPort } from './managed-context-reader'
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

test('PostgREST connection outages are typed as transient article coverage failures', async () => {
  const outage = Object.assign(new Error('database connection timeout'), { code: 'PGRST002' })
  const reader = new InternalResearchEntityMemoryReader({
    legacy: v4ContextReader(), source: 'news', sourceRefs: ['Atlas-ref'], labels: ['Atlas'],
    managed: { researchContext: async () => { throw outage } },
  })
  const context = await reader.articleContext({ sourceUrl: null, terms: ['Atlas'] })
  assert.equal(context.coverageFailureKind, 'transient')
  assert.match(context.coverageFailures[0]!, /PGRST002|connection timeout/)
  for (const code of ['PGRST000', 'PGRST001', 'PGRST002', 'PGRST003', 'ECONNRESET', '57014']) {
    assert.equal(isTransientContextFailure({ code, message: code }), true, code)
  }
  for (const message of ['connection refused', 'TimeoutError: The operation was aborted due to timeout']) {
    assert.equal(isTransientContextFailure(new Error(message)), true, message)
  }
})

test('wrapped Supabase schema-cache retry text remains transient while missing-schema text stays permanent', async () => {
  const wrapped = {
    ...v4ContextReader(),
    searchEntities: async () => {
      throw new Error('article entity lookup failed: Could not query the database for the schema cache. Retrying.')
    },
  }
  const managed: ManagedResearchContextPort = {
    researchContext: async () => ({ entities: [], items: [], digest: 'fixture', watermark: '0', truncated: false }),
    articleContext: async () => ({ entities: [], items: [], articleItems: [], digest: 'fixture', watermark: '0', truncated: false, candidateTruncated: false }),
  }
  const transient = new InternalResearchEntityMemoryReader({ managed, legacy: wrapped, source: 'news', sourceRefs: [], labels: ['Atlas'] })
  assert.equal((await transient.articleContext()).coverageFailureKind, 'transient')

  const permanent = new InternalResearchEntityMemoryReader({
    managed, legacy: { ...wrapped, searchEntities: async () => { throw new Error('article entity lookup failed: relation entities does not exist') } },
    source: 'news', sourceRefs: [], labels: ['Atlas'],
  })
  assert.equal((await permanent.articleContext()).coverageFailureKind, 'permanent')
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

test('article candidate merge prioritizes an exact private identity over more than 32 broad matches', async () => {
  const exact = { id: 'z-raoul', slug: 'raoul-pal', name: 'Raoul Pal', aliases: ['Raoul'], summary: 'Macro commentator.' }
  const noise = Array.from({ length: 40 }, (_, i) => ({ id: `a-noise-${i}`, slug: `noise-${i}`, name: `Topic ${i}`, summary: 'Raoul Pal is mentioned in broad market coverage.' }))
  const legacy = { ...v4ContextReader(), searchEntities: async (_labels: string[], _limit: number, options?: {exactOnly?: boolean}) => options?.exactOnly ? [] : noise }
  const managed: ManagedResearchContextPort = { researchContext: async () => ({ entities: [], items: [], digest: 'fixture', watermark: '0', truncated: false }),
    articleContext: async input => {
      if (input.identityOnly) assert.deepEqual(input.sourceRefs, [])
      return { entities: [exact], items: [], articleItems: [], digest: 'fixture', watermark: '0', truncated: false, candidateTruncated: false }
    } }
  const reader = new InternalResearchEntityMemoryReader({ legacy, managed, source: 'news', sourceRefs: [], labels: [] })
  const context = await reader.articleContext({ sourceUrl: null, terms: ['Raoul Pal'] })
  assert.equal(context.candidates.length, 32)
  assert.equal(context.candidates[0].id, exact.id)
  assert.deepEqual((await context.findExactEntities!(['Raoul Pal'])).map(e => e.id), [exact.id])
})

test('article candidate projection bounds descriptions while retaining the original profile summary', async () => {
  const longSummary = 'Profile detail '.repeat(120)
  const emptySummary = '   '
  const managed: ManagedResearchContextPort = {
    researchContext: async () => ({ entities: [], items: [], digest: 'fixture', watermark: '0', truncated: false }),
    articleContext: async () => ({ entities: [
      { id: 'long', slug: 'long', name: 'Long Profile', summary: longSummary },
      { id: 'empty', slug: 'empty', name: 'Empty Profile', summary: emptySummary },
    ], items: [], articleItems: [], digest: 'fixture', watermark: '0', truncated: false, candidateTruncated: false }),
  }
  const reader = new InternalResearchEntityMemoryReader({ legacy: v4ContextReader(), managed, source: 'news', sourceRefs: [], labels: [] })
  const context = await reader.articleContext()
  const long = context.candidates.find(candidate => candidate.id === 'long')!
  const empty = context.candidates.find(candidate => candidate.id === 'empty')!
  assert.equal(long.summary, longSummary)
  assert.ok((long.decisionSummary?.length ?? 0) <= 1_000)
  assert.match(long.decisionSummary!, /\[excerpted\]$/)
  assert.equal(empty.summary, emptySummary)
  assert.equal(empty.decisionSummary, null)
})

test('article creation cannot assume complete exact identity coverage from an old or truncated managed context', async () => {
  for (const candidateTruncated of [undefined, true]) {
    const response = { entities: [], items: [], articleItems: [], digest: 'fixture', watermark: '0', truncated: false, candidateTruncated }
    const reader = new InternalResearchEntityMemoryReader({ legacy: v4ContextReader(), source: 'news', sourceRefs: [], labels: [],
      managed: { researchContext: async () => response, articleContext: async () => response } })
    const context = await reader.articleContext()
    await assert.rejects(context.findExactEntities!(['Missing identity']), /migration|candidate bound/)
  }
})
