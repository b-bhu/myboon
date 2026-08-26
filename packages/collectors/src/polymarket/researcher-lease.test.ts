/**
 * Lease/crash-recovery behavior of the Polymarket researcher.
 *
 * These are concurrency/crash-timing bugs that cannot be found by hand or by
 * the pure-function unit tests in researcher.test.ts. This file drives
 * runPolymarketResearcher against a REAL SqlitePipelineStore(':memory:') -
 * not a mock - because the entire point is proving the real store's lease
 * semantics actually get exercised correctly by the researcher, closing:
 *
 *   BUG 1 - the 'researching' black hole: a crash between claiming a
 *   candidate and finishing its research used to strand it in 'researching'
 *   forever (fetches only look at 'pending_research' / 'research_failed').
 *
 *   BUG 2 - the 48h silent filter: candidates older than maxCandidateAgeHours
 *   used to drop out of every fetch with no terminal status, sitting in
 *   'pending_research' forever, invisible.
 *
 * Every candidate seeded here is built to classify as 'market_structure_only'
 * (low score, thin volume/liquidity, no current-context-cue words) so triage
 * never enters the deep_web path, which shells out to hermes/last30days
 * subprocesses. That keeps these tests fast, deterministic, and focused on
 * store/lease behavior rather than external process integration.
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { PipelineCandidateInsertInput } from '../pipeline-store/store'
import { SqlitePipelineStore } from '../pipeline-store/sqlite-store'
import { HermesService } from '../hermes'
import type { PolymarketResearcherOptions } from './researcher'
import { runPolymarketResearcher, __testing } from './researcher'

// runPolymarketResearcher takes a SupabaseClient purely for signature parity
// with sibling pipeline stages (see run-researcher.ts) - nothing in the
// researcher module actually reads or writes through it. A stub is enough.
const FAKE_SUPABASE = {} as SupabaseClient

const T0 = '2026-07-01T00:00:00.000Z'

function fullOptions(overrides: Partial<PolymarketResearcherOptions> = {}): Required<PolymarketResearcherOptions> {
  return {
    now: T0,
    batchSize: 20,
    slugCooldownMinutes: 60,
    retryWindowMinutes: 240,
    maxRetryCount: 2,
    structureOnlyScoreMax: 55,
    thinVolume24hMax: 1_000,
    thinLiquidityMax: 1_000,
    backend: 'hermes_cli',
    researchModel: 'hermes_cli',
    hermesCommand: 'hermes',
    researchPlannerHermesToolsets: 'browser',
    researchPlannerHermesIgnoreRules: false,
    researchPlannerHermesTimeoutMs: 60_000,
    last30DaysPython: 'python3.12',
    last30DaysScript: '/tmp/last30days.py',
    last30DaysTimeoutMs: 300_000,
    last30DaysWebBackend: 'auto',
    maxCandidateAgeHours: 48,
    leaseOwner: 'owner-test-default',
    leaseSeconds: 1200,
    hermes: new HermesService({ command: 'hermes' }),
    gate: null,
    engine: null,
    ...overrides,
  }
}

let seedCounter = 0
function nextId(prefix: string): string {
  seedCounter += 1
  return `${prefix}-${seedCounter}`
}

/** A candidate engineered to classify as 'market_structure_only': low score,
 * thin volume/liquidity, no current-context-cue words in any text field. */
function makeQuietCandidate(overrides: Partial<PipelineCandidateInsertInput> = {}): PipelineCandidateInsertInput {
  const id = nextId('cand')
  return {
    source: 'polymarket',
    area: 'markets',
    candidateType: 'market_shift',
    marketId: `market-${id}`,
    slug: `slug-${id}`,
    title: `Will outcome ${id} happen`,
    tagSlug: 'misc',
    tagLabel: 'Misc',
    observedAt: T0,
    whatChanged: 'Price moved slightly.',
    whyFlagged: 'Minor threshold crossing.',
    score: 10,
    scoreBreakdown: {},
    metrics: { currentVolume24h: 10, liquidity: 10 },
    evidenceRefs: [],
    dedupeKey: `dedupe-${id}`,
    ...overrides,
  }
}

test('claimed work carries a lease with owner and expiry, not a bare status flip', async () => {
  const store = new SqlitePipelineStore(':memory:')
  try {
    const [seeded] = await store.insertCandidates([makeQuietCandidate()])
    assert.equal(seeded.leaseOwner, null)
    assert.equal(seeded.leaseExpiresAt, null)

    await runPolymarketResearcher(store, FAKE_SUPABASE, { now: T0, leaseOwner: 'owner-a', leaseSeconds: 1200 })

    // The row must be in a terminal status once the run completes (this
    // candidate classifies as market_structure_only, which always succeeds
    // synchronously) - and leases are released once a terminal status is
    // written (see runPolymarketResearcher's releaseLease call), so by now
    // the lease fields are cleared again. The important assertion is what
    // happened DURING the claim, which the next test isolates directly via
    // the store's own claimWithLease.
    const [after] = await store.getCandidatesByIds([seeded.id])
    assert.equal(after.status, 'researched')
    assert.equal(after.leaseOwner, null)
    assert.equal(after.leaseExpiresAt, null)
    assert.equal(after.attemptCount, 1)
  } finally {
    store.close()
  }
})

test('claimWithLease itself attaches owner + expiry at the moment of claim (mid-flight snapshot)', async () => {
  const store = new SqlitePipelineStore(':memory:')
  try {
    const [seeded] = await store.insertCandidates([makeQuietCandidate()])

    const claimed = await store.claimWithLease({
      source: 'polymarket',
      area: 'markets',
      stage: 'research',
      limit: 10,
      leaseOwner: 'owner-mid-flight',
      leaseSeconds: 1200,
      now: T0,
    })

    assert.equal(claimed.length, 1)
    assert.equal(claimed[0].id, seeded.id)
    assert.equal(claimed[0].status, 'researching')
    assert.equal(claimed[0].leaseOwner, 'owner-mid-flight')
    assert.equal(claimed[0].leaseExpiresAt, new Date(new Date(T0).getTime() + 1200 * 1000).toISOString())
    assert.equal(claimed[0].attemptCount, 1)
  } finally {
    store.close()
  }
})

test('expired lease returns work to claimable with incremented attempt count', async () => {
  const store = new SqlitePipelineStore(':memory:')
  try {
    const [seeded] = await store.insertCandidates([makeQuietCandidate()])

    const firstClaim = await store.claimWithLease({
      source: 'polymarket',
      area: 'markets',
      stage: 'research',
      limit: 10,
      leaseOwner: 'owner-crashed',
      leaseSeconds: 60, // expires 60s after T0
      now: T0,
    })
    assert.equal(firstClaim.length, 1)
    assert.equal(firstClaim[0].attemptCount, 1)

    // Simulate that owner crashing: nothing releases or renews the lease.
    const muchLater = new Date(new Date(T0).getTime() + 2 * 60 * 60 * 1000).toISOString() // T0 + 2h
    const reclaimed = await store.claimWithLease({
      source: 'polymarket',
      area: 'markets',
      stage: 'research',
      limit: 10,
      leaseOwner: 'owner-recovered',
      leaseSeconds: 1200,
      now: muchLater,
    })

    assert.equal(reclaimed.length, 1)
    assert.equal(reclaimed[0].id, seeded.id)
    assert.equal(reclaimed[0].leaseOwner, 'owner-recovered')
    assert.equal(reclaimed[0].attemptCount, 2)
  } finally {
    store.close()
  }
})

test('BUG 1 fix: simulated crash mid-batch strands NOTHING - after recovery every item is completed or claimable, zero non-terminal items with no live lease', async () => {
  const store = new SqlitePipelineStore(':memory:')
  try {
    const seeded = await store.insertCandidates(
      Array.from({ length: 5 }, () => makeQuietCandidate())
    )

    // Simulate a worker claiming the whole batch and then crashing before
    // writing any terminal status - exactly the old markCandidatesResearching
    // failure mode, reproduced directly against the real store rather than
    // through the researcher (which would actually finish the run).
    const claimed = await store.claimWithLease({
      source: 'polymarket',
      area: 'markets',
      stage: 'research',
      limit: 10,
      leaseOwner: 'owner-crashed-mid-batch',
      leaseSeconds: 60, // expires 60s after T0 - short-lived, simulating a real crash window
      now: T0,
    })
    assert.equal(claimed.length, 5)
    // Confirm the crash scenario: every row is 'researching' with a lease,
    // and NONE of them are visible to a fresh pending/retry fetch - this is
    // the exact black hole the old flip produced.
    const midCrash = await store.getCandidatesByIds(seeded.map((row) => row.id))
    assert.ok(midCrash.every((row) => row.status === 'researching' && row.leaseOwner === 'owner-crashed-mid-batch'))
    const invisibleDuringCrash = await store.fetchPendingCandidates({ source: 'polymarket', area: 'markets', limit: 50 })
    assert.equal(invisibleDuringCrash.length, 0)

    // Time passes well beyond the lease window with no renewal/release -
    // this is what a recovery pass run at the start of the NEXT tick does.
    const afterCrashWindow = new Date(new Date(T0).getTime() + 60 * 60 * 1000).toISOString() // T0 + 1h
    const recovery = await store.recoverExpiredLeases({ stage: 'research', now: afterCrashWindow })
    assert.equal(recovery.recovered, 5)
    assert.deepEqual([...recovery.ids].sort(), seeded.map((row) => row.id).sort())

    // The actual proof: after recovery, EVERY item is either a terminal
    // status, or claimable again (pending_research with no live lease).
    // Zero items are left in a non-terminal status with a dead/absent lease.
    const afterRecovery = await store.getCandidatesByIds(seeded.map((row) => row.id))
    const TERMINAL = new Set(['researched', 'research_failed', 'rejected', 'published', 'stale_expired', 'skipped_recently_researched'])
    const strandedNonTerminalNoLiveLease = afterRecovery.filter((row) => {
      if (TERMINAL.has(row.status)) return false
      const hasLiveLease = row.leaseExpiresAt != null && new Date(row.leaseExpiresAt).getTime() > new Date(afterCrashWindow).getTime()
      return !hasLiveLease
        ? row.status !== 'pending_research' // non-terminal AND not claimable is stranded
        : false
    })
    assert.deepEqual(strandedNonTerminalNoLiveLease, [])
    assert.ok(afterRecovery.every((row) => row.status === 'pending_research' && row.leaseOwner === null))

    // And the pipeline can actually pick the recovered work back up.
    const reclaimed = await store.claimWithLease({
      source: 'polymarket',
      area: 'markets',
      stage: 'research',
      limit: 10,
      leaseOwner: 'owner-after-recovery',
      leaseSeconds: 1200,
      now: afterCrashWindow,
    })
    assert.equal(reclaimed.length, 5)
  } finally {
    store.close()
  }
})

test('BUG 1 fix end-to-end: runPolymarketResearcher recovers a batch stranded by a prior crash', async () => {
  const store = new SqlitePipelineStore(':memory:')
  try {
    const seeded = await store.insertCandidates(
      Array.from({ length: 3 }, () => makeQuietCandidate())
    )

    // Simulate a PRIOR run that claimed these rows and then crashed - no
    // status was ever written past 'researching', and the lease is long
    // expired by the time this test's run starts.
    await store.claimWithLease({
      source: 'polymarket',
      area: 'markets',
      stage: 'research',
      limit: 10,
      leaseOwner: 'owner-prior-crashed-run',
      leaseSeconds: 60,
      now: T0,
    })

    const nextTick = new Date(new Date(T0).getTime() + 60 * 60 * 1000).toISOString() // T0 + 1h, well past the 60s lease
    const result = await runPolymarketResearcher(store, FAKE_SUPABASE, {
      now: nextTick,
      leaseOwner: 'owner-next-tick',
      leaseSeconds: 1200,
    })

    // runPolymarketResearcher's own recoverExpiredLeases pass (step 1 of the
    // run) must have picked these back up and researched them in the SAME
    // run - they must not require a third run.
    assert.equal(result.pendingFetched, 3)
    assert.equal(result.candidatesMarkedResearched, 3)

    const finished = await store.getCandidatesByIds(seeded.map((row) => row.id))
    assert.ok(finished.every((row) => row.status === 'researched'))
  } finally {
    store.close()
  }
})

test('BUG 2 fix: aged work receives the TERMINAL stale_expired status - the status is WRITTEN, not merely absent from queries', async () => {
  const store = new SqlitePipelineStore(':memory:')
  try {
    const [oldCandidate] = await store.insertCandidates([makeQuietCandidate()])
    // Push observed_at back well past the default 48h maxCandidateAgeHours.
    const tenDaysAgo = new Date(new Date(T0).getTime() - 10 * 24 * 60 * 60 * 1000).toISOString()
    await store.setCandidateStatus({ ids: [oldCandidate.id], status: 'pending_research', observedAt: tenDaysAgo })

    const [freshCandidate] = await store.insertCandidates([makeQuietCandidate({ observedAt: T0 })])

    const result = await runPolymarketResearcher(store, FAKE_SUPABASE, {
      now: T0,
      leaseOwner: 'owner-aging',
      leaseSeconds: 1200,
      maxCandidateAgeHours: 48,
    })

    // The old candidate must not silently vanish from the fetch AND stay
    // 'pending_research' forever - it must be written to the terminal
    // 'stale_expired' status. This is the crux of the bug: a status that is
    // merely absent from a query result is NOT the same as a status that was
    // actually persisted.
    const [oldAfter] = await store.getCandidatesByIds([oldCandidate.id])
    assert.equal(oldAfter.status, 'stale_expired')

    // The fresh candidate must NOT be aged out and must be research eligible.
    const [freshAfter] = await store.getCandidatesByIds([freshCandidate.id])
    assert.equal(freshAfter.status, 'researched')
    assert.equal(result.candidatesMarkedResearched, 1)
    assert.equal(result.pendingFetched, 1)
  } finally {
    store.close()
  }
})

test('BUG 2 fix: the fetch itself no longer filters out aged pending work (no silent disappearance)', async () => {
  const store = new SqlitePipelineStore(':memory:')
  try {
    const tenDaysAgo = new Date(new Date(T0).getTime() - 10 * 24 * 60 * 60 * 1000).toISOString()
    const [oldCandidate] = await store.insertCandidates([makeQuietCandidate()])
    await store.setCandidateStatus({ ids: [oldCandidate.id], status: 'pending_research', observedAt: tenDaysAgo })

    // Disable aging entirely (maxCandidateAgeHours: 0) so expireAgedWork never
    // runs, and confirm the candidate is still fetched/claimed - proving the
    // fetch query itself carries no age filter anymore. (BUG 2 was that the
    // fetch's own `.gte('observed_at', cutoff)` silently excluded old rows;
    // that filter must be gone independent of whether expiry runs.)
    const claimed = await store.claimWithLease({
      source: 'polymarket',
      area: 'markets',
      stage: 'research',
      limit: 10,
      leaseOwner: 'owner-no-age-filter',
      leaseSeconds: 1200,
      now: T0,
    })

    assert.equal(claimed.length, 1)
    assert.equal(claimed[0].id, oldCandidate.id)
  } finally {
    store.close()
  }
})

test('retry cap honored; exhaustion lands in a visible terminal state (research_failed), never vanishes', async () => {
  const store = new SqlitePipelineStore(':memory:')
  try {
    const [seeded] = await store.insertCandidates([makeQuietCandidate()])

    // Drive attempt_count up to the cap the same way production would:
    // claim (which increments attempt_count SQL-side), then release without
    // ever writing a success - simulating repeated failed attempts. This is
    // the exact counter retryCount()/fetchRetryableCandidates' gate now
    // depends on (see the retryCount doc comment in researcher.ts).
    for (let i = 0; i < 2; i += 1) {
      await store.claimWithLease({
        source: 'polymarket',
        area: 'markets',
        stage: 'research',
        limit: 10,
        leaseOwner: `owner-attempt-${i}`,
        leaseSeconds: 1,
        now: T0,
      })
      await store.releaseLease([seeded.id], `owner-attempt-${i}`)
    }
    // Land the candidate in the retry lane at the cap, with its error intact.
    await store.setCandidateStatus({
      ids: [seeded.id],
      status: 'research_failed',
      observedAt: T0,
      researchError: 'synthetic failure for retry-cap test',
      extra: {
        researchRetryCount: 2,
        researchNextRetryAt: T0,
        researchLastErrorKind: 'backend_error',
      },
    })

    const [beforeRun] = await store.getCandidatesByIds([seeded.id])
    assert.equal(beforeRun.attemptCount, 2)

    const result = await runPolymarketResearcher(store, FAKE_SUPABASE, {
      now: T0,
      leaseOwner: 'owner-retry-cap-check',
      leaseSeconds: 1200,
      maxRetryCount: 2, // attemptCount (2) is not < maxRetryCount (2): capped out
    })

    // The retry-capped candidate must NOT be fetched/researched again...
    assert.equal(result.pendingFetched, 0)
    assert.equal(result.retriedFailedCandidates, 0)
    // ...and it must remain in a visible, queryable terminal-for-retry-purposes
    // state (research_failed with its error intact) rather than disappearing.
    const [after] = await store.getCandidatesByIds([seeded.id])
    assert.equal(after.status, 'research_failed')
    assert.equal(after.researchError, 'synthetic failure for retry-cap test')
    assert.equal(after.attemptCount, 2)
  } finally {
    store.close()
  }
})

test('concurrent claims never double-claim the same candidate', async () => {
  const store = new SqlitePipelineStore(':memory:')
  try {
    const seeded = await store.insertCandidates(
      Array.from({ length: 10 }, () => makeQuietCandidate())
    )

    // Fire several "concurrent" claimWithLease calls (JS is single-threaded,
    // but node:sqlite's synchronous statements plus this store's BEGIN/COMMIT
    // transaction wrapper is what's actually under test: each call must see
    // a consistent claimable set and never hand out the same row twice).
    const [claimA, claimB, claimC, claimD] = await Promise.all([
      store.claimWithLease({ source: 'polymarket', area: 'markets', stage: 'research', limit: 3, leaseOwner: 'owner-a', leaseSeconds: 1200, now: T0 }),
      store.claimWithLease({ source: 'polymarket', area: 'markets', stage: 'research', limit: 3, leaseOwner: 'owner-b', leaseSeconds: 1200, now: T0 }),
      store.claimWithLease({ source: 'polymarket', area: 'markets', stage: 'research', limit: 3, leaseOwner: 'owner-c', leaseSeconds: 1200, now: T0 }),
      store.claimWithLease({ source: 'polymarket', area: 'markets', stage: 'research', limit: 3, leaseOwner: 'owner-d', leaseSeconds: 1200, now: T0 }),
    ])

    const allClaimedIds = [...claimA, ...claimB, ...claimC, ...claimD].map((row) => row.id)
    const uniqueClaimedIds = new Set(allClaimedIds)
    assert.equal(allClaimedIds.length, uniqueClaimedIds.size, 'the same candidate id was claimed more than once')
    assert.ok(allClaimedIds.length <= seeded.length)
    assert.ok(allClaimedIds.length > 0)
  } finally {
    store.close()
  }
})

test('lease renewal for long work: still-outstanding claims in a batch get their lease pushed out as each candidate finishes', async () => {
  const store = new SqlitePipelineStore(':memory:')
  try {
    const seeded = await store.insertCandidates(
      Array.from({ length: 3 }, () => makeQuietCandidate())
    )

    // Claim with a short lease to make the "would have expired without
    // renewal" window easy to detect.
    const shortLeaseSeconds = 5
    const claimed = await store.claimWithLease({
      source: 'polymarket',
      area: 'markets',
      stage: 'research',
      limit: 10,
      leaseOwner: 'owner-deep-web-batch',
      leaseSeconds: shortLeaseSeconds,
      now: T0,
    })
    assert.equal(claimed.length, 3)
    const originalExpiry = claimed[0].leaseExpiresAt as string

    // Build EnrichedTriageDecision-shaped decisions with NO
    // polymarketNativeContext, so researchSingleCandidate's fast failure
    // path fires immediately (no hermes/network calls) - see its "Polymarket
    // native context unavailable" branch. This exercises the real
    // sequential per-candidate loop and its renewOutstandingLeases calls
    // without depending on any subprocess or network access.
    const decisions = claimed.map((row) => ({
      candidate: {
        id: row.id,
        source: row.source,
        area: row.area,
        candidate_type: row.candidateType,
        market_id: row.marketId,
        slug: row.slug,
        title: row.title,
        tag_slug: row.tagSlug,
        tag_label: row.tagLabel,
        observed_at: row.observedAt,
        what_changed: row.whatChanged,
        why_flagged: row.whyFlagged,
        score: row.score,
        score_breakdown: row.scoreBreakdown,
        metrics: row.metrics,
        evidence_refs: row.evidenceRefs,
        status: row.status as 'pending_research' | 'researching' | 'researched' | 'skipped_recently_researched' | 'research_failed' | 'rejected' | 'published',
        research_retry_count: row.researchRetryCount,
        research_next_retry_at: row.researchNextRetryAt,
        research_last_error_kind: row.researchLastErrorKind,
        attempt_count: row.attemptCount,
      },
      depth: 'deep_web' as const,
      familyKey: `slug:${row.slug}`,
      clusterKey: `polymarket:markets:slug:${row.slug}`,
      reason: 'needs_current_context',
      polymarketNativeContextError: 'no network access in this test',
    }))

    const attempt = await __testing.researchCandidatesWithFallback(
      decisions,
      fullOptions({ leaseOwner: 'owner-deep-web-batch', leaseSeconds: shortLeaseSeconds }),
      store,
      new Set(claimed.map((row) => row.id))
    )

    // Every candidate failed fast (no context), as expected offline.
    assert.equal(attempt.failures.length, 3)

    // The crux of the renewal test: after each candidate finishes, every
    // OTHER still-outstanding candidate's lease must have been pushed
    // forward by renewOutstandingLeases - not left at its original short
    // expiry, which a slow multi-candidate batch would otherwise blow
    // through mid-run. The FIRST candidate processed is the one exception:
    // it removes itself from the outstanding set before any renewal call is
    // made (renewal only ever targets candidates OTHER than the one that
    // just finished), so its own lease_expires_at is never touched by this
    // loop - by the time it "finished" there was nothing left to renew FOR
    // it, only for the others still waiting their turn.
    const decisionIds = decisions.map((decision) => decision.candidate.id)
    const afterRun = await store.getCandidatesByIds(decisionIds)
    const firstProcessedId = decisionIds[0]
    const renewedRows = afterRun.filter((row) => row.id !== firstProcessedId)
    const firstProcessedRow = afterRun.find((row) => row.id === firstProcessedId)

    assert.equal(renewedRows.length, 2)
    for (const row of renewedRows) {
      assert.notEqual(row.leaseExpiresAt, originalExpiry)
      assert.ok(new Date(row.leaseExpiresAt as string).getTime() > new Date(originalExpiry).getTime())
    }
    // The first-processed candidate's lease is untouched by renewal - it was
    // removed from "outstanding" before its own turn's renewal call ran.
    assert.equal(firstProcessedRow?.leaseExpiresAt, originalExpiry)
  } finally {
    store.close()
  }
})

test('retry lane candidates get the same lease safety as the pending lane (BUG 1 applies to retries too)', async () => {
  const store = new SqlitePipelineStore(':memory:')
  try {
    const [seeded] = await store.insertCandidates([makeQuietCandidate()])
    await store.setCandidateStatus({
      ids: [seeded.id],
      status: 'research_failed',
      observedAt: T0,
      researchError: 'transient failure',
      extra: { researchRetryCount: 0, researchNextRetryAt: T0, researchLastErrorKind: 'timeout' },
    })

    const result = await runPolymarketResearcher(store, FAKE_SUPABASE, {
      now: T0,
      leaseOwner: 'owner-retry-lane',
      leaseSeconds: 1200,
      maxRetryCount: 2,
    })

    assert.equal(result.retriedFailedCandidates, 1)
    assert.equal(result.candidatesMarkedResearched, 1)

    const [after] = await store.getCandidatesByIds([seeded.id])
    assert.equal(after.status, 'researched')
    // Went through claimWithLease exactly like a pending-lane candidate would.
    assert.equal(after.attemptCount, 1)
  } finally {
    store.close()
  }
})
