import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import type { PipelineCandidateInsertInput } from './store'
import { SqlitePipelineStore } from './sqlite-store'
import { buildPipelineStatusReport } from './status'

const T0 = '2026-07-01T00:00:00.000Z'

function makeCandidate(overrides: Partial<PipelineCandidateInsertInput> = {}): PipelineCandidateInsertInput {
  const id = randomUUID()
  return {
    source: 'polymarket',
    area: 'markets',
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
    scoreBreakdown: {},
    metrics: {},
    evidenceRefs: [],
    dedupeKey: `dedupe-${id}`,
    ...overrides,
  }
}

test('buildPipelineStatusReport reflects seeded backlog state accurately', async () => {
  const store = new SqlitePipelineStore(':memory:')
  try {
    // 2 pending, 1 failed, 1 stale_expired for polymarket/markets.
    await store.insertCandidates([
      makeCandidate({ dedupeKey: 'status-pending-1' }),
      makeCandidate({ dedupeKey: 'status-pending-2' }),
    ])
    const [failed] = await store.insertCandidates([makeCandidate({ dedupeKey: 'status-failed-1' })])
    await store.setCandidateStatus({ ids: [failed.id], status: 'research_failed', observedAt: T0 })
    const [stale] = await store.insertCandidates([makeCandidate({ dedupeKey: 'status-stale-1' })])
    await store.setCandidateStatus({ ids: [stale.id], status: 'stale_expired', observedAt: T0 })

    // A different area must not leak into polymarket/markets counts.
    await store.insertCandidates([
      makeCandidate({ source: 'polymarket', area: 'sports', dedupeKey: 'status-other-area' }),
    ])

    const report = await buildPipelineStatusReport(
      store,
      [{ source: 'polymarket', area: 'markets' }, { source: 'polymarket', area: 'sports' }],
      T0
    )

    assert.equal(report.generatedAt, T0)
    assert.equal(report.areas.length, 2)

    const markets = report.areas.find((a) => a.area === 'markets')
    assert.ok(markets)
    assert.equal(markets!.source, 'polymarket')
    assert.equal(markets!.backlog.candidatesPending, 2)
    assert.equal(markets!.backlog.candidatesFailed, 1)
    assert.equal(markets!.backlog.candidatesStaleExpired, 1)
    assert.equal(markets!.flags.hasFailures, true)
    assert.equal(markets!.flags.hasStaleExpired, true)
    assert.equal(markets!.flags.hasUnrecoveredExpiredLeases, false)

    const sports = report.areas.find((a) => a.area === 'sports')
    assert.ok(sports)
    assert.equal(sports!.backlog.candidatesPending, 1)
    assert.equal(sports!.backlog.candidatesFailed, 0)
    assert.equal(sports!.flags.hasFailures, false)
  } finally {
    store.close()
  }
})

test('buildPipelineStatusReport surfaces in-flight work with a live lease vs. an expired-but-unrecovered lease', async () => {
  const store = new SqlitePipelineStore(':memory:')
  try {
    await store.insertCandidates([makeCandidate({ dedupeKey: 'status-lease-live' })])
    await store.claimWithLease({
      source: 'polymarket',
      area: 'markets',
      stage: 'research',
      limit: 1,
      leaseOwner: 'owner-live',
      leaseSeconds: 7200,
      now: T0,
    })

    await store.insertCandidates([makeCandidate({ dedupeKey: 'status-lease-expired' })])
    await store.claimWithLease({
      source: 'polymarket',
      area: 'markets',
      stage: 'research',
      limit: 1,
      leaseOwner: 'owner-expired',
      leaseSeconds: 1,
      now: T0,
    })

    const readAt = '2026-07-01T01:00:00.000Z' // T0 + 1h: well past both claim times
    const report = await buildPipelineStatusReport(store, [{ source: 'polymarket', area: 'markets' }], readAt)

    const markets = report.areas[0]
    assert.equal(markets.backlog.candidatesInFlight, 1)
    assert.equal(markets.backlog.candidatesLeaseExpired, 1)
    assert.equal(markets.flags.hasUnrecoveredExpiredLeases, true)
  } finally {
    store.close()
  }
})

test('buildPipelineStatusReport returns zeroed counts and false flags for an area with no work', async () => {
  const store = new SqlitePipelineStore(':memory:')
  try {
    const report = await buildPipelineStatusReport(store, [{ source: 'polymarket', area: 'empty' }], T0)
    const area = report.areas[0]
    assert.equal(area.backlog.candidatesPending, 0)
    assert.equal(area.backlog.candidatesFailed, 0)
    assert.equal(area.backlog.candidatesStaleExpired, 0)
    assert.equal(area.backlog.candidatesLeaseExpired, 0)
    assert.equal(area.flags.hasFailures, false)
    assert.equal(area.flags.hasStaleExpired, false)
    assert.equal(area.flags.hasUnrecoveredExpiredLeases, false)
  } finally {
    store.close()
  }
})
