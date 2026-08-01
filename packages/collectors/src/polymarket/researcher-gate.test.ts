/**
 * Pre-research entity gate integration with the Polymarket researcher.
 *
 * The gate runs BEFORE deep_web research: candidates whose signal is already
 * covered by entity memory are terminally skipped ('skipped_recently_researched')
 * without paying for a planner/retrieval pass and WITHOUT producing a research
 * row for the editor. Everything else proceeds exactly as before, now carrying
 * the entity timeline as research context.
 *
 * Like researcher-lease.test.ts, this drives runPolymarketResearcher against a
 * REAL SqlitePipelineStore(':memory:'), because the invariant under test is a
 * no-silent-loss one: a gated-out candidate must land in a terminal,
 * queryable status with its lease released - never a stranded row.
 *
 * The hermes gate call is faked at the HermesService seam (execFileImpl), so
 * no subprocess runs. Candidates that PROCEED past the gate would enter the
 * real deep_web path (native-context HTTP + hermes + last30days), so
 * integration tests here only drive batches that gate to already_known;
 * partition behavior for proceed verdicts is covered at the unit level via
 * __testing.gateDeepWebDecisions.
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import type { SupabaseClient } from '@supabase/supabase-js'
import { HermesService } from '../hermes'
import type { EntityMemoryReader } from '../research-gate'
import type { PipelineCandidateInsertInput } from '../pipeline-store/store'
import { SqlitePipelineStore } from '../pipeline-store/sqlite-store'
import { runPolymarketResearcher, __testing } from './researcher'

const FAKE_SUPABASE = {} as SupabaseClient
const T0 = '2026-07-01T00:00:00.000Z'

let seedCounter = 0
function nextId(prefix: string): string {
  seedCounter += 1
  return `${prefix}-${seedCounter}`
}

/** A candidate engineered to classify as 'deep_web': high score, real volume,
 * current-context cue words in the title. */
function makeDeepCandidate(overrides: Partial<PipelineCandidateInsertInput> = {}): PipelineCandidateInsertInput {
  const id = nextId('deep')
  return {
    source: 'polymarket',
    area: 'markets',
    candidateType: 'market_shift',
    marketId: `market-${id}`,
    slug: `fed-rate-cut-${id}`,
    title: `Will the Fed cut rates in ${id}`,
    tagSlug: 'macro',
    tagLabel: 'Macro',
    observedAt: T0,
    whatChanged: 'Yes odds moved from 41% to 58%.',
    whyFlagged: 'Large repricing.',
    score: 82,
    scoreBreakdown: {},
    metrics: { currentVolume24h: 250_000, liquidity: 90_000 },
    evidenceRefs: [],
    dedupeKey: `dedupe-${id}`,
    ...overrides,
  }
}

function knownEntityReader(): EntityMemoryReader {
  return {
    entityIdsForSourceRef: async () => ['entity-fed'],
    entitiesByIds: async () => [
      { id: 'entity-fed', slug: 'fed-rate-cut', name: 'Fed rate cut', summary: 'Tracks Fed rate policy.' },
    ],
    recentMemories: async () => [
      {
        entityId: 'entity-fed',
        memoryType: 'market_signal',
        title: 'Fed cut odds repricing',
        summary: 'Odds already moved to 58% after the CPI print.',
        eventAt: '2026-06-30T00:00:00.000Z',
      },
    ],
  }
}

function gateHermes(verdictJson: string): HermesService {
  return new HermesService({
    command: 'hermes',
    execFileImpl: async () => ({ stdout: verdictJson, stderr: '' }),
  })
}

test('gate already_known: candidate terminally skipped, no research row, no editor handoff, lease released', async () => {
  const store = new SqlitePipelineStore(':memory:')
  try {
    const seeded = await store.insertCandidates([makeDeepCandidate(), makeDeepCandidate()])

    const result = await runPolymarketResearcher(store, FAKE_SUPABASE, {
      now: T0,
      leaseOwner: 'owner-gate-test',
      hermes: gateHermes('{"verdict":"already_known","reason":"Timeline already records the 58% move."}'),
      gate: { reader: knownEntityReader() },
    })

    assert.equal(result.skippedRecentlyResearched, 2)
    assert.equal(result.researchRowsWritten, 0)
    assert.equal(result.candidatesMarkedResearched, 0)
    assert.equal(result.candidatesMarkedFailed, 0)
    assert.equal(result.deepWebResearched, 0)
    assert.equal(result.skipped.length, 2)
    assert.match(result.skipped[0].reason, /gate_already_known/)
    assert.match(result.skipped[0].reason, /58% move/)

    // Terminal, lease-free, and not re-claimable: the no-silent-loss invariant.
    const after = await store.getCandidatesByIds(seeded.map((row) => row.id))
    for (const row of after) {
      assert.equal(row.status, 'skipped_recently_researched')
      assert.equal(row.leaseOwner, null)
      assert.equal(row.leaseExpiresAt, null)
    }
    const reclaimed = await store.claimWithLease({
      source: 'polymarket',
      area: 'markets',
      stage: 'research',
      limit: 10,
      leaseOwner: 'someone-else',
      leaseSeconds: 60,
      now: '2026-07-01T01:00:00.000Z',
    })
    assert.equal(reclaimed.length, 0)
  } finally {
    store.close()
  }
})

test('no gate configured: deep candidates flow to research untouched (back-compat default)', async () => {
  const decisions = [
    { candidate: { id: 'c1', source: 'polymarket', slug: 's1', title: 't1', what_changed: 'w1', observed_at: T0 }, depth: 'deep_web', familyKey: 'f', clusterKey: 'k', reason: 'r' },
  ] as never[]

  const gated = await __testing.gateDeepWebDecisions(decisions as never, {
    gate: null,
    hermes: gateHermes('{"verdict":"already_known","reason":"must not be consulted"}'),
  } as never)

  assert.equal(gated.proceed.length, 1)
  assert.equal(gated.known.length, 0)
  assert.equal((gated.proceed[0] as { entityContext?: unknown }).entityContext, undefined)
})

test('mixed verdicts partition: known stops, new/contradiction/unavailable proceed with context attached', async () => {
  const verdicts = [
    '{"verdict":"already_known","reason":"covered"}',
    '{"verdict":"new_information","reason":"timeline is behind"}',
    '{"verdict":"contradicts_prior","reason":"conflicts"}',
    'not json at all',
  ]
  let call = 0
  const hermes = new HermesService({
    command: 'hermes',
    execFileImpl: async () => ({ stdout: verdicts[call++] ?? '', stderr: '' }),
  })

  const candidates = ['a', 'b', 'c', 'd'].map((id) => ({
    candidate: { id, source: 'polymarket', slug: `slug-${id}`, title: `t-${id}`, what_changed: 'w', observed_at: T0 },
    depth: 'deep_web',
    familyKey: `f-${id}`,
    clusterKey: `k-${id}`,
    reason: 'needs_current_context',
  }))

  const gated = await __testing.gateDeepWebDecisions(candidates as never, {
    gate: { reader: knownEntityReader() },
    hermes,
  } as never)

  assert.equal(gated.known.length, 1)
  assert.equal(gated.known[0].decision.candidate.id, 'a')
  assert.deepEqual(gated.proceed.map((d: { candidate: { id: string } }) => d.candidate.id), ['b', 'c', 'd'])
  // proceed decisions carry the entity timeline for the planner
  for (const decision of gated.proceed as Array<{ entityContext?: { recentMemories: unknown[] } }>) {
    assert.ok(decision.entityContext)
    assert.equal(decision.entityContext?.recentMemories.length, 1)
  }
})

test('planner prompt gains the timeline section and the diff instruction when entity context exists', () => {
  const context = {
    source_url: 'https://polymarket.com/market/fed-rate-cut',
    market: { slug: 'fed-rate-cut', title: 'Will the Fed cut rates', description: '', end_date: null, resolution_source: null },
    market_structure: { yes_price: 0.58 },
    parent_event: null,
    sibling_markets: [],
    source_native_questions: [],
  }
  const candidate = {
    id: 'c1',
    candidate_type: 'market_shift',
    slug: 'fed-rate-cut',
    title: 'Will the Fed cut rates',
    tag_slug: 'macro',
    tag_label: 'Macro',
    observed_at: T0,
    what_changed: 'Odds moved 41% to 58%',
    why_flagged: 'Large repricing',
    score: 82,
    score_breakdown: {},
    metrics: {},
  }
  const entityContext = {
    entities: [{ id: 'entity-fed', slug: 'fed-rate-cut', name: 'Fed rate cut', summary: 'Fed policy.' }],
    recentMemories: [{
      entityId: 'entity-fed',
      memoryType: 'market_signal',
      title: 'Odds moved to 41% after CPI',
      summary: 'Repricing after the CPI print.',
      eventAt: '2026-06-28T00:00:00.000Z',
    }],
  }

  const withContext = __testing.buildPlannerPrompt(context as never, candidate as never, entityContext)
  assert.match(withContext, /Entity memory timeline/)
  assert.match(withContext, /Odds moved to 41% after CPI/)
  assert.match(withContext, /changed AFTER the newest timeline entry/)

  const withoutContext = __testing.buildPlannerPrompt(context as never, candidate as never)
  assert.doesNotMatch(withoutContext, /Entity memory timeline/)
})
