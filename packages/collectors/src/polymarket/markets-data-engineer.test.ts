import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import type { PolymarketMarketsDataEngineerOptions } from './markets-data-engineer'
import { __testing, runPolymarketMarketsDataEngineer } from './markets-data-engineer'
import { CanonicalSourceSignalIntake } from '../signal-platform/source-intake'
import { SqliteSignalPlatformStore } from '../signal-platform/sqlite-platform-store'

const options: Required<PolymarketMarketsDataEngineerOptions> = {
  now: '2026-06-10T00:00:00.000Z',
  tagSlugs: ['crypto'],
  topMarketsPerTag: 3,
  fetchLimitPerTag: 50,
  includeManualPins: true,
  oddsMoveThreshold: 0.05,
  volumeMoveThresholdPct: 0.2,
  activitySpikeThresholdPct: 0.25,
  closingSoonHours: 72,
  candidateCooldownHours: 6,
  manualPinMaxSelected: 2,
  manualPinMaxRepresentativesPerInput: 1,
  manualPinScoreBoost: 8,
  candidateRetryFailedHours: 24,
  candidateRecentPublishedCooldownHours: 168,
  candidateMaterialMoveMultiplier: 2,
  backlogThreshold: 100,
  backlogHardCeiling: 250,
}

function market(overrides: Record<string, unknown> = {}): any {
  const slug = String(overrides.slug ?? 'market')
  return {
    marketId: `${slug}-id`,
    slug,
    title: String(overrides.title ?? slug),
    tagSlug: String(overrides.tagSlug ?? 'crypto'),
    tagLabel: String(overrides.tagLabel ?? 'Crypto'),
    eventSlug: (overrides.eventSlug as string | null | undefined) ?? null,
    eventTitle: (overrides.eventTitle as string | null | undefined) ?? null,
    endDate: (overrides.endDate as string | null | undefined) ?? null,
    yesPrice: 0.5,
    noPrice: 0.5,
    volume: 1_000,
    volume24h: 100,
    liquidity: 100,
    competitive: null,
    commentCount: null,
    lastTradePrice: null,
    oneHourPriceChange: null,
    oneDayPriceChange: null,
    oneWeekPriceChange: null,
    updatedAt: '2026-06-10T00:00:00.000Z',
    sourceUrl: 'https://example.com',
    rawPayload: {},
    isManualPin: Boolean(overrides.isManualPin),
    watchScore: Number(overrides.watchScore ?? 50),
    scoreBreakdown: {},
    selectionReason: 'test',
    ...overrides,
  }
}

function candidate(overrides: Record<string, unknown> = {}): any {
  return {
    market: market(overrides.market as Record<string, unknown> | undefined),
    draft: {
      candidateType: 'odds_moved',
      whatChanged: 'changed',
      whyFlagged: 'flagged',
      score: 60,
      scoreBreakdown: {},
      metrics: { oddsDelta: 0.06 },
      evidenceRefs: [],
      ...(overrides.draft as Record<string, unknown> | undefined),
    },
    dedupeKey: String(overrides.dedupeKey ?? 'key'),
  }
}

test('chooseWatchlist caps manual pins while retaining dynamic per-tag selections', () => {
  const markets = [
    market({ slug: 'manual-1', isManualPin: true, watchScore: 100 }),
    market({ slug: 'manual-2', isManualPin: true, watchScore: 99 }),
    market({ slug: 'manual-3', isManualPin: true, watchScore: 98 }),
    market({ slug: 'dynamic-1', watchScore: 80 }),
    market({ slug: 'dynamic-2', watchScore: 79 }),
    market({ slug: 'dynamic-3', watchScore: 78 }),
    market({ slug: 'dynamic-4', watchScore: 77 }),
  ]

  const selected = __testing.chooseWatchlist(markets, options)

  assert.equal(selected.filter((item: any) => item.isManualPin).length, 2)
  assert.deepEqual(
    selected.filter((item: any) => !item.isManualPin).map((item: any) => item.slug).sort(),
    ['dynamic-1', 'dynamic-2', 'dynamic-3']
  )
})

test('chooseWatchlist does not let a lower-scored manual duplicate replace a stronger dynamic market', () => {
  const selected = __testing.chooseWatchlist([
    market({ slug: 'same-market', isManualPin: true, watchScore: 40 }),
    market({ slug: 'same-market', isManualPin: false, watchScore: 85 }),
  ], options)

  assert.equal(selected.length, 1)
  assert.equal(selected[0].isManualPin, false)
  assert.equal(selected[0].watchScore, 85)
})

test('selectManualPinRepresentatives chooses the strongest child from a multi-market pin', () => {
  const selected = __testing.selectManualPinRepresentatives('event-pin', [
    market({ slug: 'thin-child', isManualPin: true, watchScore: 75, volume: 100, volume24h: 10, liquidity: 10 }),
    market({ slug: 'liquid-child', isManualPin: true, watchScore: 70, volume: 100_000, volume24h: 20_000, liquidity: 50_000 }),
  ], Date.parse(options.now), 1)

  assert.equal(selected.length, 1)
  assert.equal(selected[0].slug, 'liquid-child')
  assert.equal(selected[0].scoreBreakdown.manualResolvedMarkets, 2)
})

test('dedupeCandidateInserts collapses cross-type family candidates to the highest score', () => {
  const low = candidate({ dedupeKey: 'family-key', draft: { candidateType: 'odds_moved', score: 50 } })
  const high = candidate({ dedupeKey: 'family-key', draft: { candidateType: 'volume_moved', score: 85 } })

  const selected = __testing.dedupeCandidateInserts([low, high])

  assert.equal(selected.length, 1)
  assert.equal(selected[0].draft.candidateType, 'volume_moved')
})

test('blocksCandidate suppresses unresolved backlog but lets material moves through', () => {
  const pendingBlock = {
    kind: 'candidate_unresolved',
    slug: 'same-market',
    title: 'Same market',
    status: 'pending_research',
    at: options.now,
  } as const

  assert.equal(__testing.blocksCandidate(candidate(), [pendingBlock as any], options.now, options), true)
  assert.equal(
    __testing.blocksCandidate(candidate({ draft: { metrics: { oddsDelta: 0.12 }, score: 75 } }), [pendingBlock as any], options.now, options),
    false
  )
})

test('blocksCandidate respects failed-research retry window', () => {
  const recentFailed = {
    kind: 'research_failed_recent',
    slug: 'same-market',
    title: 'Same market',
    status: 'research_failed',
    at: '2026-06-09T12:00:00.000Z',
  } as const
  const staleFailed = {
    ...recentFailed,
    kind: 'research_failed_stale' as const,
    at: '2026-06-08T00:00:00.000Z',
  }

  assert.equal(__testing.blocksCandidate(candidate(), [recentFailed as any], options.now, options), true)
  assert.equal(__testing.blocksCandidate(candidate(), [staleFailed as any], options.now, options), false)
})

// ---------------------------------------------------------------------------
// Backpressure: backpressureVerdict (bounded material-move bypass)
// ---------------------------------------------------------------------------

const normalCandidate = candidate() // oddsDelta 0.06 / threshold 0.05 = 1.2x, score 60 -> not material
const materialCandidate = candidate({ draft: { metrics: { oddsDelta: 0.15 }, score: 60 } }) // 0.15/0.05 = 3x >= multiplier 2 -> material

test('isMaterialCandidate classifies the shared fixtures as expected', () => {
  assert.equal(__testing.isMaterialCandidate(normalCandidate.draft, options), false)
  assert.equal(__testing.isMaterialCandidate(materialCandidate.draft, options), true)
})

test('backpressure: normal candidate is allowed below backlogThreshold', () => {
  assert.equal(__testing.backpressureVerdict(normalCandidate, options.backlogThreshold - 1, options), 'allow')
})

test('backpressure: normal candidate is blocked at/above backlogThreshold', () => {
  assert.equal(__testing.backpressureVerdict(normalCandidate, options.backlogThreshold, options), 'throttled_normal')
  assert.equal(__testing.backpressureVerdict(normalCandidate, options.backlogThreshold + 50, options), 'throttled_normal')
})

test('backpressure: material candidate is ALLOWED above backlogThreshold (bounded bypass)', () => {
  // Backlog is past the normal threshold but still below the hard ceiling -
  // this is exactly the bypass window the policy grants to material moves.
  const depth = options.backlogThreshold + 20
  assert.ok(depth < options.backlogHardCeiling)
  assert.equal(__testing.backpressureVerdict(materialCandidate, depth, options), 'allow')
})

test('backpressure: material candidate is BLOCKED at/above backlogHardCeiling', () => {
  assert.equal(__testing.backpressureVerdict(materialCandidate, options.backlogHardCeiling, options), 'throttled_hard_ceiling')
  assert.equal(__testing.backpressureVerdict(materialCandidate, options.backlogHardCeiling + 100, options), 'throttled_hard_ceiling')
})

test('backpressure: material candidate below backlogThreshold is simply allowed', () => {
  assert.equal(__testing.backpressureVerdict(materialCandidate, 0, options), 'allow')
})

test('buildThreadUpdatePayload reopens an existing researched family for material movement', () => {
  const input = candidate({
    market: { slug: 'whoop-ipo-before-2027', title: 'WHOOP IPO before 2027?' },
    draft: {
      candidateType: 'odds_moved',
      score: 82,
      metrics: { oddsDelta: 0.12 },
    },
  })
  input.familyKey = __testing.primaryMarketFamilyKey(input.market)
  input.clusterKey = `polymarket:markets:${input.familyKey}`

  const payload = __testing.buildThreadUpdatePayload({
    id: 'existing-id',
    slug: 'whoop-ipo-before-2027',
    title: 'WHOOP IPO before 2027?',
    status: 'researched',
    observed_at: '2026-06-09T00:00:00.000Z',
    score: 70,
    metrics: {
      thread: {
        firstObservedAt: '2026-06-08T00:00:00.000Z',
        observationCount: 2,
        observationHistory: [{ observedAt: '2026-06-09T00:00:00.000Z' }],
      },
    },
    research_family_key: input.familyKey,
    research_cluster_key: input.clusterKey,
  }, input, options.now, options)

  assert.equal(payload.status, 'pending_research')
  assert.equal(payload.observed_at, options.now)
  assert.equal(payload.research_family_key, 'title:whoop-ipo-2027')
  assert.equal((payload.metrics as any).thread.observationCount, 3)
  assert.equal((payload.metrics as any).thread.firstObservedAt, '2026-06-08T00:00:00.000Z')
  assert.equal((payload.score_breakdown as any).reopenedForResearch, true)
})

test('buildThreadUpdatePayload keeps researched status for non-material repeated movement', () => {
  const input = candidate({
    market: { slug: 'whoop-ipo-before-2027', title: 'WHOOP IPO before 2027?' },
    draft: {
      candidateType: 'odds_moved',
      score: 61,
      metrics: { oddsDelta: 0.06 },
    },
  })
  input.familyKey = __testing.primaryMarketFamilyKey(input.market)
  input.clusterKey = `polymarket:markets:${input.familyKey}`

  const payload = __testing.buildThreadUpdatePayload({
    id: 'existing-id',
    slug: 'whoop-ipo-before-2027',
    title: 'WHOOP IPO before 2027?',
    status: 'researched',
    observed_at: '2026-06-09T00:00:00.000Z',
    score: 70,
    metrics: {},
    research_family_key: input.familyKey,
    research_cluster_key: input.clusterKey,
  }, input, options.now, options)

  assert.equal(payload.status, 'researched')
  assert.equal(payload.score, 70)
  assert.equal((payload.metrics as any).thread.observationCount, 1)
  assert.equal((payload.score_breakdown as any).reopenedForResearch, false)
})

test('the Gamma events fetch pins order=volume24hr (regression guard for the renamed field)', async () => {
  // 2026-07-30: Gamma renamed its order field; `order=volume_24hr` started
  // returning 422 "order fields are not valid" and every market fetch died.
  // Pin the literal query string so a refactor cannot silently reintroduce
  // the old spelling.
  const { readFile } = await import('node:fs/promises')
  const { join } = await import('node:path')
  const source = await readFile(join(__dirname, 'markets-data-engineer.ts'), 'utf8')
  assert.ok(source.includes('order=volume24hr&ascending=false'), 'events URL uses the accepted order field')
  assert.ok(!source.includes('order=volume_24hr'), 'the 422-producing spelling must not reappear in any URL')
})

test('canonical Polymarket Signal survives legacy backlog throttling without legacy queue mutation', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'poly-live-signal-'))
  const canonical = new SqliteSignalPlatformStore(join(dir, 'pipeline.sqlite'), 'polymarket')
  const writes = { candidates: 0, updates: 0 }
  const fakeStore = {
    async getWatchlistSnapshots() {
      return [{ slug: 'market-one', latestObservedAt: '2026-08-26T11:00:00.000Z', latestYesPrice: 0.5,
        latestVolume: 1_000, latestVolume24h: 100, latestLiquidity: 100 }]
    },
    async upsertWatchlist() {},
    async deactivateStaleWatchlist() {},
    async findExistingDedupeKeys() { return new Set<string>() },
    async findCandidateThreadsByFamilyKey() { return [] },
    async findCandidatesForBacklog() { return [] },
    async findResearchForBacklog() { return [] },
    async findEditorDecisions() { return [] },
    async getResearchByIds() { return [] },
    async getBacklogDepth() {
      return { candidatesPending: 1, candidatesInFlight: 0, candidatesFailed: 0,
        candidatesStaleExpired: 0, candidatesLeaseExpired: 0 }
    },
    async insertCandidates() { writes.candidates += 1; return [] },
    async updateCandidateThreads(rows: unknown[]) { if (rows.length > 0) writes.updates += 1 },
  }
  const chain = {
    select() { return this }, eq() { return this }, gte() { return this }, order() { return this },
    async limit() { return { data: [], error: null } },
  }
  const fakeSupabase = { from() { return chain } }
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async (url: string | URL | Request) => {
    const value = String(url)
    const body = value.includes('/tags/slug/')
      ? { id: 'tag-1', label: 'Crypto', slug: 'crypto' }
      : [{
          id: 'event-1', title: 'Market one?', slug: 'market-one', active: true, closed: false,
          updatedAt: '2026-08-26T11:59:00.000Z',
          markets: [{
            id: 'market-1', conditionId: 'market-1', slug: 'market-one', question: 'Market one?',
            active: true, closed: false, outcomePrices: JSON.stringify([0.56, 0.44]),
            volume: 1_000, volume24hr: 100, liquidity: 100,
            updatedAt: '2026-08-26T11:59:00.000Z',
          }],
        }]
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
  }) as typeof fetch
  try {
    const result = await runPolymarketMarketsDataEngineer(
      fakeStore as never,
      fakeSupabase as never,
      {
        now: '2026-08-26T12:00:00.000Z', tagSlugs: ['crypto'], topMarketsPerTag: 1,
        fetchLimitPerTag: 10, includeManualPins: false, backlogThreshold: 1,
        backlogHardCeiling: 10, candidateMaterialMoveMultiplier: 10,
      },
      new CanonicalSourceSignalIntake({ mode: 'observe', store: canonical }),
    )
    assert.equal(result.candidatesThrottledByBackpressure, 1)
    assert.equal(result.candidatesWritten, 0)
    assert.equal(writes.candidates, 0)
    assert.equal(writes.updates, 0)
    assert.equal(result.canonicalIntake.insertedSignals, 1)
    assert.equal((await canonical.readWorkObservability({
      now: '2026-08-26T12:00:00.000Z', recentFailureSince: '2026-08-01T00:00:00.000Z', failureLimit: 10,
    })).signalCount, 1)
    assert.equal((await canonical.getSchedulerStatus({ now: '2026-08-26T12:00:00.000Z' })).total, 0)
  } finally {
    globalThis.fetch = originalFetch
    canonical.close(); rmSync(dir, { recursive: true, force: true })
  }
})
