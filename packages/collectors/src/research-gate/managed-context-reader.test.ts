import assert from 'node:assert/strict'
import test from 'node:test'
import { InternalResearchEntityMemoryReader, isTransientContextFailure, type ManagedResearchContextPort } from './managed-context-reader'
import { gateSignal } from './gate'
import { v4Classifier, v4ContextReader, V4_NOW } from '../research-engine/v4-test-fixtures'
import { ArticleHistoryCache } from './article-history-cache'

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

const historyEntity = { id: 'entity-a', name: 'Entity A', slug: 'entity-a', summary: null }
const historyItem = (id: string, origin: 'legacy' | 'managed', observedAt: string) => ({
  itemId: id, entityId: historyEntity.id, origin, title: id, summary: `Development ${id}`, observedAt,
})

function articleReader(input: {
  cache: ArticleHistoryCache
  managed: ManagedResearchContextPort
  source?: string
  legacyRecent?: () => Promise<Array<{ id: string, entityId: string, memoryType: string, title: string, summary: string, eventAt: string }>>
  legacyTargeted?: () => Promise<[]>
}) {
  return new InternalResearchEntityMemoryReader({
    managed: input.managed, historyCache: input.cache, source: input.source ?? 'news', sourceRefs: [], labels: ['Entity A'],
    legacy: { entityIdsForSourceRef: async () => [], entitiesByIds: async () => [], searchEntities: async () => [],
      recentMemories: input.legacyRecent ?? (async () => []),
      findMemoriesForArticle: input.legacyTargeted ?? (async () => []),
    },
  })
}

function combinedPort(read: NonNullable<ManagedResearchContextPort['articleContext']>): ManagedResearchContextPort {
  return { articleHistoryCoverage: 'legacy_and_managed',
    researchContext: async () => { throw new Error('article context required') }, articleContext: read }
}

test('combined recent history is lazy, shares a short cache across articles and preserves per-article snapshots', async () => {
  let now = 0
  let recentReads = 0
  let legacyReads = 0
  let targetedReads = 0
  const cache = new ArticleHistoryCache(60_000, () => now)
  const managed = combinedPort(async input => {
    if (input.historyMode === 'recent') recentReads += 1
    else if (input.entityIds?.length) targetedReads += 1
    return { entities: [historyEntity], items: [], digest: 'fixture', watermark: '0',
      // The older planning-item bound does not imply a missing recent story.
      truncated: true, candidateTruncated: false, articleItems: input.historyMode === 'recent'
        ? [{ ...historyItem(`private-${recentReads}`, 'managed', '2026-10-08T12:00:00Z'),
            eventAt: null, publishedAt: '2026-10-10T12:00:00Z' },
          { ...historyItem('legacy', 'legacy', '2026-10-08T12:00:00Z'), eventAt: '2026-10-09T12:00:00Z' }]
        : input.entityIds?.length ? [historyItem('older', 'legacy', '2026-10-01T12:00:00Z')] : [] }
  })
  const createReader = () => articleReader({ cache, managed, legacyRecent: async () => { legacyReads += 1; return [] } })
  const first = await createReader().articleContext()
  const second = await createReader().articleContext()
  assert.equal(recentReads, 0, 'history loads only after placement selects an entity')
  const [firstHistory, secondHistory] = await Promise.all([first.loadHistory!(historyEntity.id), second.loadHistory!(historyEntity.id)])
  assert.equal(recentReads, 1)
  assert.equal(legacyReads, 1)
  assert.deepEqual(firstHistory.map(item => [item.id, item.source, item.eventAt]), [
    ['private-1', 'managed', '2026-10-10T12:00:00Z'], ['legacy', 'legacy', '2026-10-09T12:00:00Z'],
  ])
  firstHistory[0].summary = 'This article owns its snapshot'
  assert.equal(secondHistory[0].summary, 'Development private-1')
  now = 60_000
  const third = await createReader().articleContext()
  assert.equal((await third.loadHistory!(historyEntity.id))[0].id, 'private-2')
  assert.equal((await first.loadHistory!(historyEntity.id))[0].id, 'private-1')
  assert.equal(recentReads, 2)
  assert.equal(legacyReads, 2)
  await first.lookupOlderDuplicate!(historyEntity.id)
  await third.lookupOlderDuplicate!(historyEntity.id)
  assert.equal(targetedReads, 2, 'older duplicate checks never use the shared recent cache')
  assert.deepEqual(first.coverageFailures, [])
})

test('readers without a combined-coverage guarantee retain both history paths and do not share cache', async () => {
  let legacyReads = 0
  let privateReads = 0
  const cache = new ArticleHistoryCache()
  const managed: ManagedResearchContextPort = {
    researchContext: async () => ({ entities: [], items: [], digest: 'fixture', watermark: null, truncated: false }),
    articleContext: async input => {
      if (input.historyMode === 'recent') privateReads += 1
      return { entities: [historyEntity], items: [], digest: 'fixture', watermark: null, truncated: false,
        articleItems: input.historyMode === 'recent' ? [historyItem('private', 'managed', '2026-10-09T12:00:00Z')] : [] }
    },
  }
  for (let index = 0; index < 2; index += 1) {
    const context = await articleReader({ cache, managed, legacyRecent: async () => {
      legacyReads += 1
      return [{ id: 'legacy', entityId: historyEntity.id, memoryType: 'news', title: 'Legacy', summary: 'Legacy development', eventAt: '2026-10-10T12:00:00Z' }]
    } }).articleContext()
    assert.deepEqual((await context.loadHistory!(historyEntity.id)).map(item => item.id), ['legacy', 'private'])
  }
  assert.deepEqual([legacyReads, privateReads], [2, 2])
})

test('failed or unsupported recent coverage is held and never cached as healthy', async () => {
  for (const variant of ['failure', 'missing-marker', 'missing-items', 'missing-entity'] as const) {
    let recentReads = 0
    const cache = new ArticleHistoryCache()
    const managed = combinedPort(async input => {
      const recent = input.historyMode === 'recent'
      if (recent && ++recentReads === 1 && variant === 'failure') throw Object.assign(new Error('database unavailable'), { code: 'PGRST002' })
      const invalid = recent && recentReads === 1
      return { entities: invalid && variant === 'missing-entity' ? [] : [historyEntity], items: [], digest: 'fixture', watermark: null, truncated: false,
        candidateTruncated: invalid && variant === 'missing-marker' ? undefined : false,
        articleItems: invalid && variant === 'missing-items' ? undefined : recent ? [historyItem('fresh', 'managed', V4_NOW)] : [] }
    })
    const first = await articleReader({ cache, managed }).articleContext()
    assert.deepEqual(await first.loadHistory!(historyEntity.id), [], variant)
    assert.ok(first.coverageFailures.length > 0, variant)
    assert.equal(first.coverageFailureKind, variant === 'failure' ? 'transient' : 'permanent')
    const second = await articleReader({ cache, managed }).articleContext()
    assert.equal((await second.loadHistory!(historyEntity.id))[0].id, 'fresh', variant)
    assert.equal(recentReads, 2, variant)
  }
})

test('an observed coverage outage clears cached history and source lanes cannot share a hit', async () => {
  let recentReads = 0
  const cache = new ArticleHistoryCache()
  const managed = combinedPort(async input => {
    if (input.historyMode === 'recent') recentReads += 1
    return { entities: [historyEntity], items: [], articleItems: [historyItem('fresh', 'managed', V4_NOW)],
      digest: 'fixture', watermark: null, truncated: false, candidateTruncated: false }
  })
  for (const source of ['news', 'polymarket']) {
    const context = await articleReader({ cache, managed, source }).articleContext()
    await context.loadHistory!(historyEntity.id)
  }
  assert.equal(recentReads, 2)
  const failedReader = new InternalResearchEntityMemoryReader({ managed, historyCache: cache, source: 'news', sourceRefs: [], labels: [],
    legacy: { entityIdsForSourceRef: async () => [], entitiesByIds: async () => [], recentMemories: async () => [],
      searchEntities: async () => { throw Object.assign(new Error('schema cache unavailable'), { code: 'PGRST002' }) } } })
  const failed = await failedReader.articleContext()
  assert.equal(failed.coverageFailureKind, 'transient')
  const healthy = await articleReader({ cache, managed }).articleContext()
  await healthy.loadHistory!(historyEntity.id)
  assert.equal(recentReads, 3)
})

test('cached recent history preserves the original five-item merge at mixed-origin date ties', async () => {
  const date = '2026-10-10T12:00:00Z'
  const legacyRows = Array.from({ length: 8 }, (_, index) => ({
    ...historyItem(`b0${index}`, 'legacy', date), eventAt: null,
  }))
  const privateRows = Array.from({ length: 4 }, (_, index) => ({
    ...historyItem(`a0${index}`, 'managed', '2026-10-09T12:00:00Z'),
    eventAt: index === 0 ? '2026-10-10T12:00:01Z' : null, publishedAt: date,
  }))
  // Matches the SQL combined bound: event/publication/observation descending,
  // then item ID ascending. The REST bound independently uses ID descending.
  const sqlRows = [...legacyRows, ...privateRows].sort((left, right) =>
    Date.parse(right.eventAt ?? ('publishedAt' in right ? right.publishedAt : right.observedAt))
      - Date.parse(left.eventAt ?? ('publishedAt' in left ? left.publishedAt : left.observedAt))
      || left.itemId.localeCompare(right.itemId),
  ).slice(0, 5)
  const restRows = legacyRows.slice().sort((left, right) => right.itemId.localeCompare(left.itemId)).slice(0, 5)
  const managed = combinedPort(async () => ({ entities: [historyEntity], items: [], articleItems: sqlRows,
    digest: 'fixture', watermark: null, truncated: true, candidateTruncated: false }))
  const cache = new ArticleHistoryCache()
  let legacyReads = 0
  for (let article = 0; article < 2; article += 1) {
    const context = await articleReader({ cache, managed, legacyRecent: async () => {
      legacyReads += 1
      return restRows.map(row => ({ id: row.itemId, entityId: row.entityId, memoryType: 'news', title: row.title,
        summary: row.summary, eventAt: row.eventAt ?? row.observedAt }))
    } }).articleContext()
    const result = await context.loadHistory!(historyEntity.id)
    assert.deepEqual(result.map(item => [item.id, item.source, item.eventAt]), [
      ['a00', 'managed', '2026-10-10T12:00:01Z'], ['b00', 'legacy', date], ['b03', 'legacy', date],
      ['b04', 'legacy', date], ['b05', 'legacy', date],
    ])
    assert.equal(result.length, 5)
  }
  assert.equal(legacyReads, 1, 'subsequent articles reuse the successfully merged snapshot')
})

test('coalesced recent history retains a legacy transient error for every participating article', async () => {
  const cache = new ArticleHistoryCache()
  const managed = combinedPort(async () => ({ entities: [historyEntity], items: [], articleItems: [historyItem('item', 'managed', V4_NOW)],
    digest: 'fixture', watermark: null, truncated: false, candidateTruncated: false }))
  const createReader = () => articleReader({ cache, managed, legacyRecent: async () => {
    throw Object.assign(new Error('schema cache unavailable'), { code: 'PGRST002' })
  } })
  const first = await createReader().articleContext()
  const second = await createReader().articleContext()
  assert.deepEqual(await Promise.all([first.loadHistory!(historyEntity.id), second.loadHistory!(historyEntity.id)]), [[], []])
  assert.equal(first.coverageFailureKind, 'transient')
  assert.equal(second.coverageFailureKind, 'transient')
  assert.ok(first.coverageFailures.some(message => message.includes('schema cache unavailable')))
  assert.ok(second.coverageFailures.some(message => message.includes('schema cache unavailable')))
})
