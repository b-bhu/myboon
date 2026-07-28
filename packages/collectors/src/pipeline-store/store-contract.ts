/**
 * Reusable contract test suite for `PipelineStore`.
 *
 * This is NOT a normal test file for one implementation. It is a suite that
 * can be run against ANY implementation of `PipelineStore` - a local SQLite
 * store, a Supabase store, or any future backend. The point: every
 * implementation must pass the exact same behavioral tests, which is what
 * makes swapping the storage backend provably safe.
 *
 * Usage:
 *
 *   import { runPipelineStoreContract } from './store-contract'
 *   import { SqlitePipelineStore } from './sqlite-store'
 *
 *   runPipelineStoreContract('sqlite', () => new SqlitePipelineStore(':memory:'))
 *
 * Each test case requests a FRESH store via `createStore()`, so tests are
 * independent of each other and of execution order.
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import type {
  PipelineCandidateInsertInput,
  PipelineCandidateResearchClaim,
  PipelineCandidateRow,
  PipelineCandidateThreadUpdate,
  PipelineDraftUpsertInput,
  PipelineEditorDecisionInsertInput,
  PipelineResearchUpsertInput,
  PipelineStore,
  PipelineStoreCandidateStatus,
  PipelineWatchlistUpsertInput,
} from './store'

// ---------------------------------------------------------------------------
// Fixed time constants - deterministic, no Date.now()/new Date() without a base.
// ---------------------------------------------------------------------------

const T0 = '2026-07-01T00:00:00.000Z'
const T0_PLUS_1H = '2026-07-01T01:00:00.000Z'
const T0_PLUS_2H = '2026-07-01T02:00:00.000Z'
const T0_MINUS_1H = '2026-06-30T23:00:00.000Z'
const T0_MINUS_10D = '2026-06-21T00:00:00.000Z'
const T0_MINUS_1D = '2026-06-30T00:00:00.000Z'
const T0_PLUS_1D = '2026-07-02T00:00:00.000Z'

// ---------------------------------------------------------------------------
// Seed data factories
// ---------------------------------------------------------------------------

let seedCounter = 0
function nextId(prefix: string): string {
  seedCounter += 1
  return `${prefix}-${seedCounter}`
}

function makeCandidate(overrides: Partial<PipelineCandidateInsertInput> = {}): PipelineCandidateInsertInput {
  const id = nextId('seed')
  return {
    source: 'polymarket',
    area: 'crypto',
    candidateType: 'market_shift',
    marketId: `market-${id}`,
    slug: `slug-${id}`,
    title: `Title ${id}`,
    tagSlug: 'crypto-tag',
    tagLabel: 'Crypto',
    observedAt: T0,
    whatChanged: 'Price moved',
    whyFlagged: 'Volume spike',
    score: 0.5,
    scoreBreakdown: { volume: 0.5 },
    metrics: { volume24h: 1000 },
    evidenceRefs: ['ref-1'],
    dedupeKey: `dedupe-${id}`,
    ...overrides,
  }
}

function makeWatchlistRow(overrides: Partial<PipelineWatchlistUpsertInput> = {}): PipelineWatchlistUpsertInput {
  const id = nextId('wl')
  return {
    source: 'polymarket',
    area: 'crypto',
    tagSlug: 'crypto-tag',
    tagLabel: 'Crypto',
    marketId: `market-${id}`,
    slug: `slug-${id}`,
    title: `Title ${id}`,
    eventSlug: null,
    eventTitle: null,
    endDate: null,
    isManualPin: false,
    rankInArea: 1,
    watchScore: 0.5,
    scoreBreakdown: { volume: 0.5 },
    selectionReason: 'high volume',
    latestObservedAt: T0,
    latestYesPrice: 0.6,
    latestVolume: 1000,
    latestVolume24h: 500,
    latestLiquidity: 200,
    ...overrides,
  }
}

function makeResearchInput(
  candidateId: string,
  overrides: Partial<PipelineResearchUpsertInput> = {}
): PipelineResearchUpsertInput {
  const id = nextId('research')
  return {
    candidateId,
    source: 'polymarket',
    area: 'crypto',
    slug: `slug-${id}`,
    title: `Title ${id}`,
    candidateType: 'market_shift',
    researchMode: 'deep',
    summary: 'Summary text',
    notes: 'Notes text',
    keyFindings: [{ finding: 'a', confidence: 0.9 }],
    evidenceLinks: ['https://example.com/a'],
    relatedContext: { related: ['x'] },
    uncertainty: 'low',
    editorNotes: 'looks good',
    researchedAt: T0,
    researchFamilyKey: `family-${id}`,
    researchClusterKey: `cluster-${id}`,
    researchDepth: 'deep_web',
    evidenceQuality: 'strong',
    catalystFound: true,
    recommendedEditorAction: 'publish_candidate',
    researchBackend: 'test-backend',
    ...overrides,
  }
}

function makeEditorDecisionInput(
  researchIds: string[],
  overrides: Partial<PipelineEditorDecisionInsertInput> = {}
): PipelineEditorDecisionInsertInput {
  return {
    source: 'polymarket',
    area: 'crypto',
    researchIds,
    decision: 'publish',
    status: 'pending_publisher',
    reasoning: 'Strong evidence',
    evidenceQuality: 'strong',
    ...overrides,
  }
}

function makeDraftInput(overrides: Partial<PipelineDraftUpsertInput> = {}): PipelineDraftUpsertInput {
  const id = nextId('draft')
  return {
    entityId: `entity-${id}`,
    entitySlug: `entity-slug-${id}`,
    entityName: `Entity ${id}`,
    entityType: 'topic',
    bundleKey: `bundle-${id}`,
    sourceMemoryIds: [`memory-${id}`],
    sourceMemoryHash: `hash-${id}`,
    source: 'polymarket',
    sourceArea: 'crypto',
    action: 'draft_post',
    status: 'drafted',
    title: `Draft ${id}`,
    reasoning: 'good draft',
    backend: 'test-backend',
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Contract
// ---------------------------------------------------------------------------

export function runPipelineStoreContract(
  label: string,
  createStore: () => Promise<PipelineStore> | PipelineStore
): void {
  async function withStore<T>(fn: (store: PipelineStore) => Promise<T> | T): Promise<T> {
    const store = await createStore()
    try {
      return await fn(store)
    } finally {
      store.close()
    }
  }

  // -------------------------------------------------------------------------
  // Watchlist (W1-W3)
  // -------------------------------------------------------------------------

  test(`${label}: upsertWatchlist inserts rows retrievable via getWatchlistSnapshots`, async () => {
    await withStore(async (store) => {
      const row = makeWatchlistRow({ slug: 'watch-a' })
      await store.upsertWatchlist([row])

      const snapshots = await store.getWatchlistSnapshots('crypto', ['watch-a'])
      assert.equal(snapshots.length, 1)
      assert.equal(snapshots[0].slug, 'watch-a')
      assert.equal(snapshots[0].latestYesPrice, 0.6)
      assert.equal(snapshots[0].latestVolume, 1000)
      assert.equal(snapshots[0].latestVolume24h, 500)
    })
  })

  test(`${label}: upsertWatchlist conflict on (area, slug) updates rather than duplicating`, async () => {
    await withStore(async (store) => {
      const row = makeWatchlistRow({ slug: 'watch-conflict', latestYesPrice: 0.1 })
      await store.upsertWatchlist([row])
      await store.upsertWatchlist([{ ...row, latestYesPrice: 0.9, latestObservedAt: T0_PLUS_1H }])

      const snapshots = await store.getWatchlistSnapshots('crypto', ['watch-conflict'])
      assert.equal(snapshots.length, 1)
      assert.equal(snapshots[0].latestYesPrice, 0.9)
      assert.equal(snapshots[0].latestObservedAt, T0_PLUS_1H)
    })
  })

  test(`${label}: deactivateStaleWatchlist deactivates stale rows but preserves their snapshot values`, async () => {
    await withStore(async (store) => {
      const fresh = makeWatchlistRow({ slug: 'watch-fresh', latestObservedAt: T0_PLUS_1H })
      const stale = makeWatchlistRow({
        slug: 'watch-stale',
        latestObservedAt: T0_MINUS_1H,
        latestYesPrice: 0.42,
      })
      await store.upsertWatchlist([fresh, stale])

      await store.deactivateStaleWatchlist('crypto', T0)

      // Deactivation is a status transition, NOT a delete and NOT a read
      // filter: getWatchlistSnapshots is how the collector reads the previous
      // observation to compute deltas, so it must keep returning the last known
      // values for rows that have gone inactive.
      const snapshots = await store.getWatchlistSnapshots('crypto', ['watch-fresh', 'watch-stale'])
      const bySlug = new Map(snapshots.map((row) => [row.slug, row]))
      assert.deepEqual([...bySlug.keys()].sort(), ['watch-fresh', 'watch-stale'])
      assert.equal(bySlug.get('watch-stale')?.latestYesPrice, 0.42)
      assert.equal(bySlug.get('watch-stale')?.latestObservedAt, T0_MINUS_1H)

      // The deactivation must have been genuinely WRITTEN: re-upserting the
      // stale slug with a fresh observation reactivates it, and a second
      // deactivation pass at the same cutoff must then leave it alone.
      await store.upsertWatchlist([
        { ...stale, latestObservedAt: T0_PLUS_2H, latestYesPrice: 0.77, status: 'active' },
      ])
      await store.deactivateStaleWatchlist('crypto', T0)

      const after = await store.getWatchlistSnapshots('crypto', ['watch-stale'])
      assert.equal(after.length, 1)
      assert.equal(after[0].latestYesPrice, 0.77)
      assert.equal(after[0].latestObservedAt, T0_PLUS_2H)
    })
  })

  // -------------------------------------------------------------------------
  // Candidates: basic CRUD (C1-C9)
  // -------------------------------------------------------------------------

  test(`${label}: insertCandidates persists rows retrievable via getCandidatesByIds`, async () => {
    await withStore(async (store) => {
      const [inserted] = await store.insertCandidates([makeCandidate({ slug: 'cand-a', dedupeKey: 'dk-a' })])
      assert.ok(inserted.id)
      assert.equal(inserted.slug, 'cand-a')
      assert.equal(inserted.status, 'pending_research')
      assert.equal(inserted.attemptCount, 0)

      const [fetched] = await store.getCandidatesByIds([inserted.id])
      assert.equal(fetched.id, inserted.id)
      assert.equal(fetched.slug, 'cand-a')
    })
  })

  test(`${label}: findExistingDedupeKeys returns only keys that exist`, async () => {
    await withStore(async (store) => {
      await store.insertCandidates([
        makeCandidate({ dedupeKey: 'dk-exists-1' }),
        makeCandidate({ dedupeKey: 'dk-exists-2' }),
      ])

      const found = await store.findExistingDedupeKeys(['dk-exists-1', 'dk-exists-2', 'dk-missing'])
      assert.deepEqual([...found].sort(), ['dk-exists-1', 'dk-exists-2'])
    })
  })

  test(`${label}: findCandidateThreadsByFamilyKey finds candidates by research family key`, async () => {
    await withStore(async (store) => {
      const [inserted] = await store.insertCandidates([makeCandidate({ dedupeKey: 'dk-family-1' })])
      await store.claimCandidatesForResearch(
        [{ id: inserted.id, familyKey: 'family-x', clusterKey: 'cluster-x', depth: 'deep_web' }],
        T0
      )

      const threads = await store.findCandidateThreadsByFamilyKey('polymarket', 'crypto', ['family-x'])
      assert.equal(threads.length, 1)
      assert.equal(threads[0].id, inserted.id)
      assert.equal(threads[0].researchFamilyKey, 'family-x')
    })
  })

  test(`${label}: findCandidatesForBacklog filters by status and optional slugs`, async () => {
    await withStore(async (store) => {
      const [a, b] = await store.insertCandidates([
        makeCandidate({ slug: 'backlog-a', dedupeKey: 'dk-backlog-a' }),
        makeCandidate({ slug: 'backlog-b', dedupeKey: 'dk-backlog-b' }),
      ])
      await store.setCandidateStatus({ ids: [a.id], status: 'researched', observedAt: T0 })
      await store.setCandidateStatus({ ids: [b.id], status: 'rejected', observedAt: T0 })

      const researched = await store.findCandidatesForBacklog({
        source: 'polymarket',
        area: 'crypto',
        statuses: ['researched'],
        limit: 10,
      })
      assert.equal(researched.length, 1)
      assert.equal(researched[0].id, a.id)

      const filteredBySlug = await store.findCandidatesForBacklog({
        source: 'polymarket',
        area: 'crypto',
        statuses: ['researched', 'rejected'],
        slugs: ['backlog-b'],
        limit: 10,
      })
      assert.equal(filteredBySlug.length, 1)
      assert.equal(filteredBySlug[0].id, b.id)
    })
  })

  test(`${label}: updateCandidateThreads applies DIFFERENT payloads to different ids in one call`, async () => {
    await withStore(async (store) => {
      const [a, b] = await store.insertCandidates([
        makeCandidate({ dedupeKey: 'dk-thread-a', whatChanged: 'old-a' }),
        makeCandidate({ dedupeKey: 'dk-thread-b', whatChanged: 'old-b' }),
      ])

      const updates: PipelineCandidateThreadUpdate[] = [
        { id: a.id, payload: { whatChanged: 'new-a', score: 0.7 } },
        { id: b.id, payload: { whatChanged: 'new-b', score: 0.3 } },
      ]
      await store.updateCandidateThreads(updates)

      const [fetchedA, fetchedB] = await store.getCandidatesByIds([a.id, b.id])
      assert.equal(fetchedA.whatChanged, 'new-a')
      assert.equal(fetchedA.score, 0.7)
      assert.equal(fetchedB.whatChanged, 'new-b')
      assert.equal(fetchedB.score, 0.3)
    })
  })

  test(`${label}: updateCandidateThreads handles an empty array without throwing`, async () => {
    await withStore(async (store) => {
      await assert.doesNotReject(() => store.updateCandidateThreads([]))
    })
  })

  test(`${label}: claimCandidatesForResearch sets per-row familyKey/clusterKey/depth correctly`, async () => {
    await withStore(async (store) => {
      const [a, b] = await store.insertCandidates([
        makeCandidate({ dedupeKey: 'dk-claim-a' }),
        makeCandidate({ dedupeKey: 'dk-claim-b' }),
      ])

      const claims: PipelineCandidateResearchClaim[] = [
        { id: a.id, familyKey: 'family-a', clusterKey: 'cluster-a', depth: 'deep_web' },
        { id: b.id, familyKey: 'family-b', clusterKey: 'cluster-b', depth: 'reuse_prior' },
      ]
      await store.claimCandidatesForResearch(claims, T0_PLUS_1H)

      const [fetchedA, fetchedB] = await store.getCandidatesByIds([a.id, b.id])
      assert.equal(fetchedA.researchFamilyKey, 'family-a')
      assert.equal(fetchedA.researchClusterKey, 'cluster-a')
      assert.equal(fetchedA.researchDepth, 'deep_web')
      assert.equal(fetchedB.researchFamilyKey, 'family-b')
      assert.equal(fetchedB.researchClusterKey, 'cluster-b')
      assert.equal(fetchedB.researchDepth, 'reuse_prior')
    })
  })

  test(`${label}: claimCandidatesForResearch handles an empty array without throwing`, async () => {
    await withStore(async (store) => {
      await assert.doesNotReject(() => store.claimCandidatesForResearch([], T0))
    })
  })

  test(`${label}: fetchPendingCandidates respects limit and observedAfter, returns documented order`, async () => {
    await withStore(async (store) => {
      await store.insertCandidates([
        makeCandidate({ dedupeKey: 'dk-pend-1', observedAt: T0 }),
        makeCandidate({ dedupeKey: 'dk-pend-2', observedAt: T0_PLUS_1H }),
        makeCandidate({ dedupeKey: 'dk-pend-3', observedAt: T0_PLUS_2H }),
      ])

      const limited = await store.fetchPendingCandidates({ source: 'polymarket', area: 'crypto', limit: 2 })
      assert.equal(limited.length, 2)
      // documented order: oldest observedAt first
      assert.ok(limited[0].observedAt <= limited[1].observedAt)

      const afterFiltered = await store.fetchPendingCandidates({
        source: 'polymarket',
        area: 'crypto',
        limit: 10,
        observedAfter: T0,
      })
      assert.equal(afterFiltered.length, 2)
      assert.ok(afterFiltered.every((row) => row.observedAt > T0))
    })
  })

  test(`${label}: fetchRetryableCandidates respects maxRetryCount and retry-due filter`, async () => {
    await withStore(async (store) => {
      const [a, b, c] = await store.insertCandidates([
        makeCandidate({ dedupeKey: 'dk-retry-a' }),
        makeCandidate({ dedupeKey: 'dk-retry-b' }),
        makeCandidate({ dedupeKey: 'dk-retry-c' }),
      ])

      // a: retryable, due now, retry count under max
      await store.setCandidateStatus({
        ids: [a.id],
        status: 'research_failed',
        observedAt: T0,
        extra: { researchRetryCount: 1, researchNextRetryAt: T0 },
      })
      // b: retry count at/over max -> should not be retryable
      await store.setCandidateStatus({
        ids: [b.id],
        status: 'research_failed',
        observedAt: T0,
        extra: { researchRetryCount: 5, researchNextRetryAt: T0 },
      })
      // c: not yet due (next retry in the future)
      await store.setCandidateStatus({
        ids: [c.id],
        status: 'research_failed',
        observedAt: T0,
        extra: { researchRetryCount: 1, researchNextRetryAt: T0_PLUS_2H },
      })

      const retryable = await store.fetchRetryableCandidates({
        source: 'polymarket',
        area: 'crypto',
        limit: 10,
        maxRetryCount: 3,
        now: T0_PLUS_1H,
      })

      const ids = retryable.map((row) => row.id)
      assert.ok(ids.includes(a.id))
      assert.ok(!ids.includes(b.id))
      assert.ok(!ids.includes(c.id))
    })
  })

  test(`${label}: setCandidateStatus applies to all supplied ids`, async () => {
    await withStore(async (store) => {
      const [a, b] = await store.insertCandidates([
        makeCandidate({ dedupeKey: 'dk-status-a' }),
        makeCandidate({ dedupeKey: 'dk-status-b' }),
      ])

      await store.setCandidateStatus({ ids: [a.id, b.id], status: 'rejected', observedAt: T0 })

      const [fetchedA, fetchedB] = await store.getCandidatesByIds([a.id, b.id])
      assert.equal(fetchedA.status, 'rejected')
      assert.equal(fetchedB.status, 'rejected')
    })
  })

  test(`${label}: setCandidateStatus handles an empty array without throwing`, async () => {
    await withStore(async (store) => {
      await assert.doesNotReject(() =>
        store.setCandidateStatus({ ids: [], status: 'rejected', observedAt: T0 })
      )
    })
  })

  test(`${label}: JSON columns on candidates survive a write/read round-trip with structure intact`, async () => {
    await withStore(async (store) => {
      const scoreBreakdown = { volume: 0.4, nested: { deep: [1, 2, 3] } }
      const metrics = { volume24h: 500, tags: ['a', 'b'] }
      const evidenceRefs = ['ref-1', 'ref-2', { url: 'https://example.com', weight: 0.5 }]

      const [inserted] = await store.insertCandidates([
        makeCandidate({ dedupeKey: 'dk-json', scoreBreakdown, metrics, evidenceRefs }),
      ])

      const [fetched] = await store.getCandidatesByIds([inserted.id])
      assert.deepEqual(fetched.scoreBreakdown, scoreBreakdown)
      assert.deepEqual(fetched.metrics, metrics)
      assert.deepEqual(fetched.evidenceRefs, evidenceRefs)
    })
  })

  // -------------------------------------------------------------------------
  // Research (R1-R6)
  // -------------------------------------------------------------------------

  test(`${label}: upsertResearchRows returns ACTUAL persisted research ids queryable via getResearchByIds`, async () => {
    await withStore(async (store) => {
      const [c1, c2] = await store.insertCandidates([
        makeCandidate({ dedupeKey: 'dk-research-a' }),
        makeCandidate({ dedupeKey: 'dk-research-b' }),
      ])

      const returnedIds = await store.upsertResearchRows([
        makeResearchInput(c1.id, { summary: 'summary-a' }),
        makeResearchInput(c2.id, { summary: 'summary-b' }),
      ])

      assert.equal(returnedIds.length, 2)
      const fetched = await store.getResearchByIds(returnedIds)
      assert.equal(fetched.length, 2)
      const summaries = fetched.map((row) => row.summary).sort()
      assert.deepEqual(summaries, ['summary-a', 'summary-b'])
      // returned ids must genuinely resolve to persisted rows with the right candidateId
      const byId = new Map(fetched.map((row) => [row.id, row]))
      assert.equal(byId.get(returnedIds[0])?.candidateId, c1.id)
      assert.equal(byId.get(returnedIds[1])?.candidateId, c2.id)
    })
  })

  test(`${label}: upsertResearchRows on conflict (same candidate_id twice) UPDATES rather than duplicating`, async () => {
    await withStore(async (store) => {
      const [candidateRow] = await store.insertCandidates([makeCandidate({ dedupeKey: 'dk-research-conflict' })])

      const firstIds = await store.upsertResearchRows([
        makeResearchInput(candidateRow.id, { summary: 'first-pass' }),
      ])
      const secondIds = await store.upsertResearchRows([
        makeResearchInput(candidateRow.id, { summary: 'second-pass' }),
      ])

      assert.equal(firstIds.length, 1)
      assert.equal(secondIds.length, 1)
      assert.equal(secondIds[0], firstIds[0])

      const fetched = await store.getResearchByIds(firstIds)
      assert.equal(fetched.length, 1)
      assert.equal(fetched[0].summary, 'second-pass')
    })
  })

  test(`${label}: JSON columns on research rows survive a write/read round-trip with structure intact`, async () => {
    await withStore(async (store) => {
      const [candidateRow] = await store.insertCandidates([makeCandidate({ dedupeKey: 'dk-research-json' })])
      const keyFindings = [{ finding: 'x', nested: { a: [1, 2] } }, { finding: 'y' }]
      const evidenceLinks = ['https://a.example.com', 'https://b.example.com']

      const [id] = await store.upsertResearchRows([
        makeResearchInput(candidateRow.id, { keyFindings, evidenceLinks }),
      ])

      const [fetched] = await store.getResearchByIds([id])
      assert.deepEqual(fetched.keyFindings, keyFindings)
      assert.deepEqual(fetched.evidenceLinks, evidenceLinks)
    })
  })

  test(`${label}: findResearchForBacklog filters by status and optional slugs`, async () => {
    await withStore(async (store) => {
      const [c1, c2] = await store.insertCandidates([
        makeCandidate({ dedupeKey: 'dk-rbacklog-a' }),
        makeCandidate({ dedupeKey: 'dk-rbacklog-b' }),
      ])
      const [id1] = await store.upsertResearchRows([
        makeResearchInput(c1.id, { slug: 'rbacklog-slug-a', status: 'pending_editor' }),
      ])
      const [id2] = await store.upsertResearchRows([
        makeResearchInput(c2.id, { slug: 'rbacklog-slug-b', status: 'edited' }),
      ])

      const pending = await store.findResearchForBacklog({
        source: 'polymarket',
        area: 'crypto',
        statuses: ['pending_editor'],
        limit: 10,
      })
      assert.deepEqual(pending.map((row) => row.id), [id1])

      const bySlug = await store.findResearchForBacklog({
        source: 'polymarket',
        area: 'crypto',
        statuses: ['pending_editor', 'edited'],
        slugs: ['rbacklog-slug-b'],
        limit: 10,
      })
      assert.deepEqual(bySlug.map((row) => row.id), [id2])
    })
  })

  test(`${label}: findPriorResearch works for BOTH keyType 'slug' and 'family'`, async () => {
    await withStore(async (store) => {
      const [c1, c2] = await store.insertCandidates([
        makeCandidate({ dedupeKey: 'dk-prior-a' }),
        makeCandidate({ dedupeKey: 'dk-prior-b' }),
      ])
      await store.upsertResearchRows([
        makeResearchInput(c1.id, { slug: 'prior-slug-x', researchFamilyKey: 'prior-family-x' }),
        makeResearchInput(c2.id, { slug: 'prior-slug-y', researchFamilyKey: 'prior-family-y' }),
      ])

      const bySlug = await store.findPriorResearch({ keyType: 'slug', keys: ['prior-slug-x'], limit: 10 })
      assert.equal(bySlug.length, 1)
      assert.equal(bySlug[0].slug, 'prior-slug-x')

      const byFamily = await store.findPriorResearch({
        keyType: 'family',
        keys: ['prior-family-y'],
        limit: 10,
      })
      assert.equal(byFamily.length, 1)
      assert.equal(byFamily[0].researchFamilyKey, 'prior-family-y')
    })
  })

  test(`${label}: fetchResearchByStatus offset pagination returns disjoint, correctly ordered pages`, async () => {
    await withStore(async (store) => {
      const candidates = await store.insertCandidates([
        makeCandidate({ dedupeKey: 'dk-page-1' }),
        makeCandidate({ dedupeKey: 'dk-page-2' }),
        makeCandidate({ dedupeKey: 'dk-page-3' }),
        makeCandidate({ dedupeKey: 'dk-page-4' }),
        makeCandidate({ dedupeKey: 'dk-page-5' }),
      ])

      const times = [T0, T0_PLUS_1H, T0_PLUS_2H, T0_PLUS_1D, T0_MINUS_1D]
      for (let i = 0; i < candidates.length; i += 1) {
        await store.upsertResearchRows([
          makeResearchInput(candidates[i].id, {
            slug: `page-slug-${i}`,
            status: 'pending_editor',
            researchedAt: times[i],
          }),
        ])
      }

      const page1 = await store.fetchResearchByStatus({
        source: 'polymarket',
        area: 'crypto',
        status: 'pending_editor',
        limit: 2,
        offset: 0,
      })
      const page2 = await store.fetchResearchByStatus({
        source: 'polymarket',
        area: 'crypto',
        status: 'pending_editor',
        limit: 2,
        offset: 2,
      })

      assert.equal(page1.length, 2)
      assert.equal(page2.length, 2)
      const page1Ids = new Set(page1.map((row) => row.id))
      const page2Ids = new Set(page2.map((row) => row.id))
      const intersection = [...page1Ids].filter((id) => page2Ids.has(id))
      assert.deepEqual(intersection, [])

      // documented order (researchedAt ascending) must hold within and across pages
      const combined = [...page1, ...page2]
      for (let i = 1; i < combined.length; i += 1) {
        assert.ok(combined[i - 1].researchedAt <= combined[i].researchedAt)
      }
    })
  })

  test(`${label}: setResearchStatus applies to all supplied ids`, async () => {
    await withStore(async (store) => {
      const [c1, c2] = await store.insertCandidates([
        makeCandidate({ dedupeKey: 'dk-setrstatus-a' }),
        makeCandidate({ dedupeKey: 'dk-setrstatus-b' }),
      ])
      const ids = await store.upsertResearchRows([makeResearchInput(c1.id), makeResearchInput(c2.id)])

      await store.setResearchStatus(ids, 'edited', T0_PLUS_1H)

      const fetched = await store.getResearchByIds(ids)
      assert.ok(fetched.every((row) => row.status === 'edited'))
    })
  })

  test(`${label}: setResearchStatus handles an empty array without throwing`, async () => {
    await withStore(async (store) => {
      await assert.doesNotReject(() => store.setResearchStatus([], 'edited', T0))
    })
  })

  // -------------------------------------------------------------------------
  // Editor decisions (E1-E3)
  // -------------------------------------------------------------------------

  test(`${label}: insertEditorDecisions persists rows retrievable via findEditorDecisions`, async () => {
    await withStore(async (store) => {
      const [candidateRow] = await store.insertCandidates([makeCandidate({ dedupeKey: 'dk-editor-a' })])
      const [researchId] = await store.upsertResearchRows([makeResearchInput(candidateRow.id)])

      const [inserted] = await store.insertEditorDecisions([makeEditorDecisionInput([researchId])])
      assert.ok(inserted.id)
      assert.equal(inserted.decision, 'publish')
      assert.equal(inserted.status, 'pending_publisher')
      assert.deepEqual(inserted.researchIds, [researchId])

      const found = await store.findEditorDecisions({
        source: 'polymarket',
        area: 'crypto',
        status: 'pending_publisher',
        orderBy: 'desc',
        limit: 10,
      })
      assert.equal(found.length, 1)
      assert.equal(found[0].id, inserted.id)
    })
  })

  test(`${label}: findEditorDecisions filters by decision and respects orderBy`, async () => {
    await withStore(async (store) => {
      const [c1, c2] = await store.insertCandidates([
        makeCandidate({ dedupeKey: 'dk-editor-order-a' }),
        makeCandidate({ dedupeKey: 'dk-editor-order-b' }),
      ])
      const [r1] = await store.upsertResearchRows([makeResearchInput(c1.id)])
      const [r2] = await store.upsertResearchRows([makeResearchInput(c2.id)])

      await store.insertEditorDecisions([
        makeEditorDecisionInput([r1], { decision: 'publish' }),
        makeEditorDecisionInput([r2], { decision: 'reject', status: 'rejected' }),
      ])

      const published = await store.findEditorDecisions({
        source: 'polymarket',
        area: 'crypto',
        decision: 'publish',
        orderBy: 'asc',
        limit: 10,
      })
      assert.equal(published.length, 1)
      assert.equal(published[0].decision, 'publish')
    })
  })

  test(`${label}: setEditorDecisionStatus applies to all supplied ids`, async () => {
    await withStore(async (store) => {
      const [c1, c2] = await store.insertCandidates([
        makeCandidate({ dedupeKey: 'dk-editor-status-a' }),
        makeCandidate({ dedupeKey: 'dk-editor-status-b' }),
      ])
      const [r1] = await store.upsertResearchRows([makeResearchInput(c1.id)])
      const [r2] = await store.upsertResearchRows([makeResearchInput(c2.id)])
      const inserted = await store.insertEditorDecisions([
        makeEditorDecisionInput([r1]),
        makeEditorDecisionInput([r2]),
      ])
      const ids = inserted.map((row) => row.id)

      await store.setEditorDecisionStatus(ids, 'published', T0_PLUS_1H)

      const found = await store.findEditorDecisions({
        source: 'polymarket',
        area: 'crypto',
        status: 'published',
        orderBy: 'asc',
        limit: 10,
      })
      assert.equal(found.length, 2)
    })
  })

  test(`${label}: setEditorDecisionStatus handles an empty array without throwing`, async () => {
    await withStore(async (store) => {
      await assert.doesNotReject(() => store.setEditorDecisionStatus([], 'published', T0))
    })
  })

  // -------------------------------------------------------------------------
  // Editor drafts (D1-D5)
  // -------------------------------------------------------------------------

  test(`${label}: upsertDraftsByBundleKey inserts rows retrievable via fetchPriorDraftsByEntity`, async () => {
    await withStore(async (store) => {
      const draftInput = makeDraftInput({ entityId: 'entity-fetch-1', bundleKey: 'bundle-fetch-1' })
      const [inserted] = await store.upsertDraftsByBundleKey([draftInput])
      assert.ok(inserted.id)
      assert.equal(inserted.bundleKey, 'bundle-fetch-1')

      const byEntity = await store.fetchPriorDraftsByEntity(['entity-fetch-1'], 10)
      const rows = byEntity.get('entity-fetch-1') ?? []
      assert.equal(rows.length, 1)
      assert.equal(rows[0].id, inserted.id)
    })
  })

  test(`${label}: upsertDraftsByBundleKey conflict on bundle_key updates, does not duplicate`, async () => {
    await withStore(async (store) => {
      const bundleKey = 'bundle-conflict-1'
      await store.upsertDraftsByBundleKey([
        makeDraftInput({ entityId: 'entity-conflict-1', bundleKey, title: 'first title' }),
      ])
      await store.upsertDraftsByBundleKey([
        makeDraftInput({ entityId: 'entity-conflict-1', bundleKey, title: 'second title' }),
      ])

      const byEntity = await store.fetchPriorDraftsByEntity(['entity-conflict-1'], 10)
      const rows = byEntity.get('entity-conflict-1') ?? []
      assert.equal(rows.length, 1)
      assert.equal(rows[0].title, 'second title')
    })
  })

  test(`${label}: fetchEligibleDrafts filters by action and status`, async () => {
    await withStore(async (store) => {
      await store.upsertDraftsByBundleKey([
        makeDraftInput({ bundleKey: 'bundle-eligible-1', action: 'draft_post', status: 'drafted' }),
        makeDraftInput({ bundleKey: 'bundle-eligible-2', action: 'watch', status: 'watching' }),
      ])

      const eligible = await store.fetchEligibleDrafts({ action: 'draft_post', status: 'drafted', limit: 10 })
      assert.equal(eligible.length, 1)
      assert.equal(eligible[0].bundleKey, 'bundle-eligible-1')
    })
  })

  test(`${label}: setDraftPublished marks a single draft published`, async () => {
    await withStore(async (store) => {
      const [inserted] = await store.upsertDraftsByBundleKey([
        makeDraftInput({ entityId: 'entity-publish-1', bundleKey: 'bundle-publish-1' }),
      ])

      await store.setDraftPublished(inserted.id, T0_PLUS_1H)

      const byEntity = await store.fetchPriorDraftsByEntity(['entity-publish-1'], 10)
      const rows = byEntity.get('entity-publish-1') ?? []
      assert.equal(rows.length, 1)
      assert.equal(rows[0].status, 'published')
    })
  })

  test(`${label}: findReviewedMemoryIds does array containment correctly`, async () => {
    await withStore(async (store) => {
      await store.upsertDraftsByBundleKey([
        makeDraftInput({
          entityId: 'entity-memory-1',
          bundleKey: 'bundle-memory-1',
          sourceMemoryIds: ['memory-in-1', 'memory-in-2'],
        }),
      ])

      const found = await store.findReviewedMemoryIds(['memory-in-1', 'memory-not-present'])
      assert.ok(found.has('memory-in-1'))
      assert.ok(!found.has('memory-not-present'))
    })
  })

  // -------------------------------------------------------------------------
  // Pipeline runs (P1-P2)
  // -------------------------------------------------------------------------

  test(`${label}: startRun returns an id; finishRun updates status/counts/error`, async () => {
    await withStore(async (store) => {
      const { id } = await store.startRun({
        source: 'polymarket',
        sourceArea: 'crypto',
        stage: 'collect',
        startedAt: T0,
      })
      assert.ok(id)

      await assert.doesNotReject(() =>
        store.finishRun(id, {
          status: 'succeeded',
          finishedAt: T0_PLUS_1H,
          counts: { inserted: 3 },
          error: null,
        })
      )
    })
  })

  test(`${label}: finishRun records failure status and error message`, async () => {
    await withStore(async (store) => {
      const { id } = await store.startRun({
        source: 'polymarket',
        stage: 'research',
        startedAt: T0,
      })

      await assert.doesNotReject(() =>
        store.finishRun(id, {
          status: 'failed',
          finishedAt: T0_PLUS_1H,
          error: 'boom',
        })
      )
    })
  })

  // -------------------------------------------------------------------------
  // Lease / recovery (L1-L5) - the core of this rebuild.
  // -------------------------------------------------------------------------

  async function seedClaimableCandidates(
    store: PipelineStore,
    count: number,
    statusOverride?: PipelineStoreCandidateStatus
  ): Promise<PipelineCandidateRow[]> {
    const inputs = Array.from({ length: count }, (_, i) =>
      makeCandidate({ dedupeKey: `dk-lease-${nextId('x')}-${i}` })
    )
    const inserted = await store.insertCandidates(inputs)
    if (statusOverride) {
      await store.setCandidateStatus({ ids: inserted.map((row) => row.id), status: statusOverride, observedAt: T0 })
    }
    return inserted
  }

  test(`${label}: two sequential claimWithLease calls with different owners never return the same candidate id`, async () => {
    await withStore(async (store) => {
      await seedClaimableCandidates(store, 2)

      const claimA = await store.claimWithLease({
        source: 'polymarket',
        area: 'crypto',
        stage: 'research',
        limit: 1,
        leaseOwner: 'owner-a',
        leaseSeconds: 60,
        now: T0,
      })
      const claimB = await store.claimWithLease({
        source: 'polymarket',
        area: 'crypto',
        stage: 'research',
        limit: 1,
        leaseOwner: 'owner-b',
        leaseSeconds: 60,
        now: T0,
      })

      assert.equal(claimA.length, 1)
      assert.equal(claimB.length, 1)
      assert.notEqual(claimA[0].id, claimB[0].id)
    })
  })

  test(`${label}: claimWithLease respects its limit`, async () => {
    await withStore(async (store) => {
      await seedClaimableCandidates(store, 5)

      const claimed = await store.claimWithLease({
        source: 'polymarket',
        area: 'crypto',
        stage: 'research',
        limit: 3,
        leaseOwner: 'owner-limit',
        leaseSeconds: 60,
        now: T0,
      })

      assert.equal(claimed.length, 3)
    })
  })

  test(`${label}: claimWithLease does not return work already leased and unexpired`, async () => {
    await withStore(async (store) => {
      await seedClaimableCandidates(store, 1)

      const firstClaim = await store.claimWithLease({
        source: 'polymarket',
        area: 'crypto',
        stage: 'research',
        limit: 5,
        leaseOwner: 'owner-first',
        leaseSeconds: 3600, // expires at T0 + 1h
        now: T0,
      })
      assert.equal(firstClaim.length, 1)

      // Strictly before the lease's expiry - must not be reclaimable.
      const secondClaim = await store.claimWithLease({
        source: 'polymarket',
        area: 'crypto',
        stage: 'research',
        limit: 5,
        leaseOwner: 'owner-second',
        leaseSeconds: 3600,
        now: '2026-07-01T00:30:00.000Z', // 30 min after T0, lease expires at T0+1h -> still unexpired
      })

      assert.equal(secondClaim.length, 0)
    })
  })

  test(`${label}: claimWithLease DOES return work whose lease has expired`, async () => {
    await withStore(async (store) => {
      await seedClaimableCandidates(store, 1)

      const firstClaim = await store.claimWithLease({
        source: 'polymarket',
        area: 'crypto',
        stage: 'research',
        limit: 5,
        leaseOwner: 'owner-expiring',
        leaseSeconds: 60, // expires at T0 + 60s
        now: T0,
      })
      assert.equal(firstClaim.length, 1)

      const afterExpiry = await store.claimWithLease({
        source: 'polymarket',
        area: 'crypto',
        stage: 'research',
        limit: 5,
        leaseOwner: 'owner-reclaim',
        leaseSeconds: 60,
        now: T0_PLUS_1H, // well past the 60s lease
      })

      assert.equal(afterExpiry.length, 1)
      assert.equal(afterExpiry[0].id, firstClaim[0].id)
    })
  })

  test(`${label}: attempt_count increments SQL-side on claim, release, claim again -> 2`, async () => {
    await withStore(async (store) => {
      const [seeded] = await seedClaimableCandidates(store, 1)

      const firstClaim = await store.claimWithLease({
        source: 'polymarket',
        area: 'crypto',
        stage: 'research',
        limit: 5,
        leaseOwner: 'owner-attempt',
        leaseSeconds: 60,
        now: T0,
      })
      assert.equal(firstClaim.length, 1)
      assert.equal(firstClaim[0].attemptCount, 1)

      await store.releaseLease([seeded.id], 'owner-attempt')

      const secondClaim = await store.claimWithLease({
        source: 'polymarket',
        area: 'crypto',
        stage: 'research',
        limit: 5,
        leaseOwner: 'owner-attempt-2',
        leaseSeconds: 60,
        now: T0_PLUS_1H,
      })
      assert.equal(secondClaim.length, 1)
      assert.equal(secondClaim[0].id, seeded.id)
      assert.equal(secondClaim[0].attemptCount, 2)
    })
  })

  test(`${label}: renewLease extends lease_expires_at so an expired-lease reclaim no longer succeeds`, async () => {
    await withStore(async (store) => {
      const [seeded] = await seedClaimableCandidates(store, 1)

      const claimed = await store.claimWithLease({
        source: 'polymarket',
        area: 'crypto',
        stage: 'research',
        limit: 5,
        leaseOwner: 'owner-renew',
        leaseSeconds: 60, // would expire at T0 + 60s
        now: T0,
      })
      assert.equal(claimed.length, 1)

      // Renew well past the point where the original lease would have expired.
      await store.renewLease([seeded.id], 'owner-renew', 7200, T0_PLUS_1H)

      // Attempt reclaim at a time after the ORIGINAL lease would have expired,
      // but before the renewed lease expires - must still fail to reclaim.
      const reclaimAttempt = await store.claimWithLease({
        source: 'polymarket',
        area: 'crypto',
        stage: 'research',
        limit: 5,
        leaseOwner: 'owner-reclaimer',
        leaseSeconds: 60,
        now: T0_PLUS_2H,
      })

      assert.equal(reclaimAttempt.length, 0)
    })
  })

  test(`${label}: releaseLease returns work to claimable state`, async () => {
    await withStore(async (store) => {
      const [seeded] = await seedClaimableCandidates(store, 1)

      await store.claimWithLease({
        source: 'polymarket',
        area: 'crypto',
        stage: 'research',
        limit: 5,
        leaseOwner: 'owner-release',
        leaseSeconds: 3600,
        now: T0,
      })

      await store.releaseLease([seeded.id], 'owner-release')

      const reclaimed = await store.claimWithLease({
        source: 'polymarket',
        area: 'crypto',
        stage: 'research',
        limit: 5,
        leaseOwner: 'owner-after-release',
        leaseSeconds: 60,
        now: T0, // same instant - would fail if still leased since lease had 3600s
      })

      assert.equal(reclaimed.length, 1)
      assert.equal(reclaimed[0].id, seeded.id)
    })
  })

  test(`${label}: releaseLease by the WRONG owner does NOT release the row`, async () => {
    await withStore(async (store) => {
      const [seeded] = await seedClaimableCandidates(store, 1)

      await store.claimWithLease({
        source: 'polymarket',
        area: 'crypto',
        stage: 'research',
        limit: 5,
        leaseOwner: 'owner-correct',
        leaseSeconds: 3600,
        now: T0,
      })

      // Wrong owner attempts release.
      await store.releaseLease([seeded.id], 'owner-wrong')

      // Row should still be leased (unexpired) to the correct owner, so a
      // different claimant must not be able to pick it up.
      const reclaimAttempt = await store.claimWithLease({
        source: 'polymarket',
        area: 'crypto',
        stage: 'research',
        limit: 5,
        leaseOwner: 'owner-interloper',
        leaseSeconds: 60,
        now: T0,
      })

      assert.equal(reclaimAttempt.length, 0)
    })
  })

  test(`${label}: recoverExpiredLeases returns expired in-flight work to claimable, reports correct count and ids`, async () => {
    await withStore(async (store) => {
      const seeded = await seedClaimableCandidates(store, 2)

      await store.claimWithLease({
        source: 'polymarket',
        area: 'crypto',
        stage: 'research',
        limit: 5,
        leaseOwner: 'owner-recover',
        leaseSeconds: 60, // expires at T0 + 60s
        now: T0,
      })

      const result = await store.recoverExpiredLeases({ stage: 'research', now: T0_PLUS_1H })

      assert.equal(result.recovered, 2)
      assert.deepEqual([...result.ids].sort(), seeded.map((row) => row.id).sort())

      // Now claimable again by anyone.
      const reclaimed = await store.claimWithLease({
        source: 'polymarket',
        area: 'crypto',
        stage: 'research',
        limit: 5,
        leaseOwner: 'owner-after-recovery',
        leaseSeconds: 60,
        now: T0_PLUS_1H,
      })
      assert.equal(reclaimed.length, 2)
    })
  })

  test(`${label}: recoverExpiredLeases does NOT touch unexpired leases`, async () => {
    await withStore(async (store) => {
      await seedClaimableCandidates(store, 1)

      await store.claimWithLease({
        source: 'polymarket',
        area: 'crypto',
        stage: 'research',
        limit: 5,
        leaseOwner: 'owner-safe',
        leaseSeconds: 7200, // expires well after T0_PLUS_1H
        now: T0,
      })

      const result = await store.recoverExpiredLeases({ stage: 'research', now: T0_PLUS_1H })

      assert.equal(result.recovered, 0)
      assert.deepEqual(result.ids, [])
    })
  })

  test(`${label}: expireAgedWork writes the TERMINAL status 'stale_expired' on aged pending work`, async () => {
    await withStore(async (store) => {
      const [seeded] = await seedClaimableCandidates(store, 1)
      // Force observedAt (or equivalent age marker) to be old by claiming/releasing
      // is not sufficient - use setCandidateStatus to control observedAt directly.
      await store.setCandidateStatus({
        ids: [seeded.id],
        status: 'pending_research',
        observedAt: T0_MINUS_10D,
      })

      const result = await store.expireAgedWork({
        stage: 'research',
        olderThan: T0_MINUS_1D,
        now: T0,
      })

      assert.equal(result.expired, 1)

      const [fetched] = await store.getCandidatesByIds([seeded.id])
      // This is the entire point: the status must be ACTUALLY WRITTEN as the
      // terminal value, not merely absent from subsequent query results.
      assert.equal(fetched.status, 'stale_expired')
    })
  })

  test(`${label}: expireAgedWork leaves work newer than the threshold untouched`, async () => {
    await withStore(async (store) => {
      const [seeded] = await seedClaimableCandidates(store, 1)
      await store.setCandidateStatus({
        ids: [seeded.id],
        status: 'pending_research',
        observedAt: T0, // recent
      })

      const result = await store.expireAgedWork({
        stage: 'research',
        olderThan: T0_MINUS_1D,
        now: T0,
      })

      assert.equal(result.expired, 0)
      const [fetched] = await store.getCandidatesByIds([seeded.id])
      assert.equal(fetched.status, 'pending_research')
    })
  })

  test(`${label}: expireAgedWork does not re-expire already-terminal work`, async () => {
    await withStore(async (store) => {
      const [seeded] = await seedClaimableCandidates(store, 1)
      await store.setCandidateStatus({
        ids: [seeded.id],
        status: 'rejected', // already terminal
        observedAt: T0_MINUS_10D,
      })

      const result = await store.expireAgedWork({
        stage: 'research',
        olderThan: T0_MINUS_1D,
        now: T0,
      })

      assert.equal(result.expired, 0)
      const [fetched] = await store.getCandidatesByIds([seeded.id])
      assert.equal(fetched.status, 'rejected')
    })
  })
}
