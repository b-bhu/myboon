import assert from 'node:assert/strict'
import test from 'node:test'
import { HermesService } from '../hermes'
import type { PolymarketResearcherOptions } from './researcher'
import { __testing } from './researcher'

const options: Required<PolymarketResearcherOptions> = {
  now: '2026-06-10T00:00:00.000Z',
  batchSize: 10,
  slugCooldownMinutes: 60,
  retryWindowMinutes: 240,
  maxRetryCount: 2,
  structureOnlyScoreMax: 55,
  thinVolume24hMax: 1_000,
  thinLiquidityMax: 1_000,
  backend: 'hermes_cli',
  researchModel: 'hermes_cli',
  hermesCommand: 'hermes',
  researchPlannerHermesToolsets: '',
  researchPlannerHermesIgnoreRules: false,
  researchPlannerHermesTimeoutMs: 60_000,
  last30DaysPython: 'python3.12',
  last30DaysScript: '/tmp/last30days.py',
  last30DaysTimeoutMs: 300_000,
  last30DaysWebBackend: 'auto',
  maxCandidateAgeHours: 48,
  leaseOwner: 'researcher:test-owner',
  leaseSeconds: 1200,
  hermes: new HermesService({ command: 'hermes' }),
  gate: null,
}

function candidate(overrides: Record<string, unknown> = {}): any {
  return {
    id: String(overrides.id ?? 'candidate-1'),
    source: 'polymarket',
    area: 'markets',
    candidate_type: String(overrides.candidate_type ?? 'odds_moved'),
    market_id: String(overrides.market_id ?? 'market-1'),
    slug: String(overrides.slug ?? 'will-fed-cut-rates-in-june'),
    title: String(overrides.title ?? 'Will Fed cut rates in June?'),
    tag_slug: String(overrides.tag_slug ?? 'macro'),
    tag_label: String(overrides.tag_label ?? 'Macro'),
    observed_at: String(overrides.observed_at ?? options.now),
    what_changed: String(overrides.what_changed ?? 'Odds moved from 40% to 46%.'),
    why_flagged: String(overrides.why_flagged ?? 'Odds moved above threshold.'),
    score: Number(overrides.score ?? 80),
    score_breakdown: {},
    metrics: (overrides.metrics as unknown) ?? { oddsDelta: 0.06, currentVolume24h: 10_000, liquidity: 5_000 },
    evidence_refs: (overrides.evidence_refs as unknown) ?? [{ source_url: 'https://polymarket.com/event/test' }],
    status: String(overrides.status ?? 'pending_research'),
    research_retry_count: (overrides.research_retry_count as number | null | undefined) ?? 0,
    research_next_retry_at: (overrides.research_next_retry_at as string | null | undefined) ?? null,
    research_last_error_kind: (overrides.research_last_error_kind as string | null | undefined) ?? null,
    attempt_count: (overrides.attempt_count as number | undefined) ?? 0,
  }
}

function prior(overrides: Record<string, unknown> = {}): any {
  return {
    id: String(overrides.id ?? 'research-1'),
    candidate_id: String(overrides.candidate_id ?? 'old-candidate'),
    slug: String(overrides.slug ?? 'will-fed-cut-rates-in-june'),
    research_mode: String(overrides.research_mode ?? 'macro_crypto'),
    summary: String(overrides.summary ?? 'Prior summary'),
    notes: String(overrides.notes ?? 'Prior notes'),
    key_findings: (overrides.key_findings as unknown) ?? ['Finding'],
    evidence_links: (overrides.evidence_links as unknown) ?? [{ url: 'https://example.com/source' }],
    related_context: (overrides.related_context as unknown) ?? ['Context'],
    uncertainty: String(overrides.uncertainty ?? 'Prior uncertainty'),
    editor_notes: String(overrides.editor_notes ?? 'Prior editor note'),
    researched_at: String(overrides.researched_at ?? '2026-06-09T23:30:00.000Z'),
    research_family_key: (overrides.research_family_key as string | null | undefined) ?? 'title:fed-cut-rates-june',
    research_cluster_key: (overrides.research_cluster_key as string | null | undefined) ?? 'polymarket:markets:title:fed-cut-rates-june',
    research_depth: (overrides.research_depth as string | null | undefined) ?? 'deep_web',
    evidence_quality: (overrides.evidence_quality as string | null | undefined) ?? 'strong',
    catalyst_found: (overrides.catalyst_found as boolean | null | undefined) ?? true,
    recommended_editor_action: (overrides.recommended_editor_action as string | null | undefined) ?? 'publish_candidate',
    research_backend: (overrides.research_backend as string | null | undefined) ?? 'hermes_cli',
    research_model: (overrides.research_model as string | null | undefined) ?? 'hermes_cli',
  }
}

test('classifyResearchDepth reuses recent exact-slug research', () => {
  const row = prior()
  const decision = __testing.classifyResearchDepth(
    candidate(),
    { bySlug: new Map([[row.slug, [row]]]), byFamilyKey: new Map() },
    Date.parse(options.now),
    options
  )

  assert.equal(decision.depth, 'reuse_prior')
  assert.equal(decision.prior?.id, row.id)
  assert.equal(decision.reason, 'recent_exact_slug_research')
})

test('classifyResearchDepth routes low-score thin markets to market-structure-only', () => {
  const decision = __testing.classifyResearchDepth(
    candidate({
      slug: 'will-random-token-hit-123',
      title: 'Will random token hit 123?',
      tag_slug: 'markets',
      tag_label: 'Markets',
      score: 35,
      metrics: { oddsDelta: 0.05, currentVolume24h: 250, liquidity: 300 },
      what_changed: 'Odds moved mechanically.',
      why_flagged: 'Small move on thin market.',
    }),
    { bySlug: new Map(), byFamilyKey: new Map() },
    Date.parse(options.now),
    options
  )

  assert.equal(decision.depth, 'market_structure_only')
})

test('buildReusePriorRow preserves prior metadata without copying prior related context', () => {
  const row = prior({
    related_context: [
      { kind: 'large_prior_context', payload: 'x'.repeat(10_000) },
    ],
  })
  const current = candidate()
  const decision = {
    candidate: current,
    depth: 'reuse_prior' as const,
    familyKey: __testing.primaryFamilyKey(current),
    clusterKey: __testing.clusterKeyForCandidate(current),
    prior: row,
    reason: 'recent_exact_slug_research',
  }

  const research = __testing.buildReusePriorRow(decision, options.now, options)

  assert.equal(research.research_depth, 'reuse_prior')
  assert.equal(research.duplicate_of_research_id, row.id)
  assert.equal(research.evidence_quality, 'strong')
  assert.equal(research.catalyst_found, true)
  assert.deepEqual(research.related_context, [{
    kind: 'reused_prior_research',
    research_id: row.id,
    slug: row.slug,
    researched_at: row.researched_at,
  }])
})

test('buildMarketStructureRow writes neutral market-structure packets', () => {
  const current = candidate({
    score: 30,
    metrics: { oddsDelta: 0.04, currentVolume24h: 100, liquidity: 100 },
    evidence_refs: [],
  })
  const decision = {
    candidate: current,
    depth: 'market_structure_only' as const,
    familyKey: __testing.primaryFamilyKey(current),
    clusterKey: __testing.clusterKeyForCandidate(current),
    reason: 'low_score_thin_market_structure',
  }

  const research = __testing.buildMarketStructureRow(decision, options.now, options)

  assert.equal(research.research_depth, 'market_structure_only')
  assert.equal(research.evidence_quality, 'medium')
  assert.equal(research.recommended_editor_action, 'needs_more_research')
  assert.doesNotMatch(research.editor_notes, /reject/i)
})

test('retry helpers classify timeout failures and existing retry counts', () => {
  assert.equal(__testing.errorKind('Hermes timed out after 600000ms'), 'timeout')

  // attempt_count is the SQL-side counter claimWithLease increments
  // atomically (see store.ts's doc comment: "must be incremented in the
  // database, never read-modify-write"). retryCount must prefer it over
  // research_retry_count so retry limiting is based on the race-free count,
  // not a value that could be stale after a crash mid-research.
  assert.equal(__testing.retryCount(candidate({ research_retry_count: '1', attempt_count: 3 })), 3)

  // Falls back to research_retry_count only when attempt_count is genuinely
  // absent (e.g. a PendingCandidate constructed by hand without ever going
  // through claimWithLease).
  const { attempt_count: _drop, ...withoutAttemptCount } = candidate({ research_retry_count: '1' })
  assert.equal(__testing.retryCount(withoutAttemptCount), 1)
})

test('candidateAgeCutoff computes the expireAgedWork threshold, not a fetch filter', () => {
  // BUG 2 fix: this cutoff used to also gate the pending-candidate FETCH
  // (`.gte('observed_at', cutoff)`), so anything older silently vanished from
  // every future query with no terminal status. It is now used ONLY to feed
  // expireAgedWork, which WRITES the terminal 'stale_expired' status - see
  // runPolymarketResearcher and the aging-pass test coverage in
  // pipeline-store/store-contract.ts.
  assert.equal(__testing.candidateAgeCutoff(options), '2026-06-08T00:00:00.000Z')
  assert.equal(__testing.candidateAgeCutoff({ ...options, maxCandidateAgeHours: 0 }), null)
})

test('defaultLast30DaysScriptPath uses VPS root path and local Codex path', () => {
  assert.equal(
    __testing.defaultLast30DaysScriptPath('/root'),
    '/root/.agents/skills/last30days/scripts/last30days.py'
  )
  assert.equal(
    __testing.defaultLast30DaysScriptPath('/Users/bibhu'),
    '/Users/bibhu/.codex/skills/last30days/scripts/last30days.py'
  )
})

test('last30days plan payload carries the full research brief into retrieval', () => {
  const brief: any = {
    research_goal: 'Find why July Fed hike sentiment changed.',
    last30days_topic: 'Fed July hike odds',
    lookback_days: 30,
    search_sources: ['reddit', 'grounding'],
    subreddits: ['Economics'],
    polymarket_keywords: ['fed', 'july'],
    last30days_plan: {
      intent: 'prediction',
      freshness_mode: 'strict_recent',
      cluster_mode: 'story',
      subqueries: [{
        label: 'macro',
        search_query: 'Fed July hike inflation yields',
        ranking_query: 'What changed in macro pricing?',
        sources: ['reddit', 'grounding'],
        weight: 1,
      }],
    },
    evidence_to_collect: ['Fed communication', 'inflation data'],
    expected_entities: ['Federal Reserve', 'FOMC'],
    notes: 'Do not restate market rules.',
  }

  const payload = __testing.last30DaysPlanPayload(brief)

  assert.ok(Array.isArray(payload.notes))
  assert.match((payload.notes as string[]).join('\n'), /Find why July Fed hike sentiment changed/)
  assert.match((payload.notes as string[]).join('\n'), /Fed communication/)
  assert.match((payload.notes as string[]).join('\n'), /retrieval only, not observed mentions/)
  assert.match(String((payload.subqueries as any[])[0].ranking_query), /Research goal/)
  assert.match(String((payload.subqueries as any[])[0].ranking_query), /inflation data/)
})

test('normalizeReflectionPlan falls back when planner returns empty subqueries', () => {
  const current = candidate({ title: 'Will Fed hike in July?', slug: 'will-fed-hike-in-july' })
  const context: any = {
    source_url: 'https://polymarket.com/event/fed/will-fed-hike-in-july',
    market: {
      id: 'market-1',
      condition_id: 'condition-1',
      slug: current.slug,
      title: current.title,
      description: 'Resolves based on the FOMC target range.',
      resolution_source: 'FOMC statement',
      end_date: '2026-07-29',
      updated_at: '2026-06-22T00:00:00Z',
    },
    market_structure: { yes_price: 0.2, volume: 1000, volume_24h: 100, liquidity: 200 },
    parent_event: { id: 'event-1', slug: 'fed', title: 'Fed Decision', description: null, end_date: '2026-07-29', volume: 5000, volume_24h: 300, liquidity: 800 },
    sibling_markets: [],
    source_native_questions: [],
  }

  const normalized = __testing.normalizeReflectionPlan({
    research_goal: 'Planner goal',
    last30days_topic: 'Planner topic',
    last30days_plan: {
      intent: 'prediction',
      freshness_mode: 'strict_recent',
      cluster_mode: 'story',
      subqueries: [],
    },
  }, context, current)

  assert.ok(normalized.last30days_plan.subqueries.length > 0)
  assert.equal(normalized.last30days_plan.subqueries[0].label, 'market_sentiment_change')
})

test('normalizeReflectionPlan drops unsupported last30days sources', () => {
  const current = candidate({ title: 'Will Fed hike in July?', slug: 'will-fed-hike-in-july' })
  const context: any = {
    source_url: 'https://polymarket.com/event/fed/will-fed-hike-in-july',
    market: {
      id: 'market-1',
      condition_id: 'condition-1',
      slug: current.slug,
      title: current.title,
      description: 'Resolves based on the FOMC target range.',
      resolution_source: 'FOMC statement',
      end_date: '2026-07-29',
      updated_at: '2026-06-22T00:00:00Z',
    },
    market_structure: { yes_price: 0.2, volume: 1000, volume_24h: 100, liquidity: 200 },
    parent_event: null,
    sibling_markets: [],
    source_native_questions: [],
  }

  const normalized = __testing.normalizeReflectionPlan({
    search_sources: ['reddit', 'x_search', 'x', 'twitter_search', 'grounding'],
    last30days_plan: {
      intent: 'prediction',
      freshness_mode: 'strict_recent',
      cluster_mode: 'story',
      subqueries: [{
        label: 'macro',
        search_query: 'Fed July hike',
        ranking_query: 'What changed?',
        sources: ['x_search', 'x', 'twitter_search', 'grounding'],
        weight: 1,
      }],
    },
  }, context, current)

  assert.deepEqual(normalized.search_sources, ['reddit', 'grounding'])
  assert.deepEqual(normalized.last30days_plan.subqueries[0].sources, ['grounding'])
})

test('last30days result keeps planner entities as hints and preserves bounded evidence context', () => {
  const current = candidate({ id: 'candidate-fed', title: 'Will Fed hike in July?' })
  const context: any = {
    source_url: 'https://polymarket.com/event/fed/will-fed-hike',
    market: {
      id: 'market-1',
      condition_id: 'condition-1',
      slug: current.slug,
      title: current.title,
      description: 'Resolves based on the FOMC target range.',
      resolution_source: 'FOMC statement',
      end_date: '2026-07-29',
      updated_at: '2026-06-22T00:00:00Z',
    },
    market_structure: { yes_price: 0.2, volume: 1000, volume_24h: 100, liquidity: 200 },
    parent_event: { id: 'event-1', slug: 'fed', title: 'Fed Decision', description: null, end_date: '2026-07-29', volume: 5000, volume_24h: 300, liquidity: 800 },
    sibling_markets: [{ slug: 'no-change', title: 'No change', yes_price: 0.78, end_date: '2026-07-29', volume: 2000, volume_24h: 100, liquidity: 300 }],
    source_native_questions: ['What is known from Polymarket?'],
  }
  const planner: any = {
    plan: {
      known_from_polymarket: ['Current Yes price is known.'],
      do_not_research: ['Current odds already supplied.'],
    },
    raw: '{}',
    error: null,
  }
  const brief: any = {
    research_goal: 'Find what changed in Fed hike sentiment.',
    last30days_topic: 'Fed hike sentiment',
    lookback_days: 30,
    search_sources: ['reddit'],
    subreddits: ['Economics'],
    polymarket_keywords: ['fed'],
    last30days_plan: { intent: 'prediction', freshness_mode: 'strict_recent', cluster_mode: 'story', subqueries: [] },
    evidence_to_collect: ['Fed communication'],
    expected_entities: ['Federal Reserve'],
    notes: 'Research only.',
  }
  const report: any = {
    topic: 'Fed hike sentiment',
    generated_at: '2026-06-22T00:00:00Z',
    range_from: '2026-05-23',
    range_to: '2026-06-22',
    query_plan: { notes: 'brief notes' },
    provider_runtime: { planner_model: 'none' },
    items_by_source: { reddit: [{ id: 'r1' }] },
    artifacts: { plan_source: 'provided' },
    clusters: [{ cluster_id: 'cluster-1', title: 'Fed shift', score: 10, sources: ['reddit'], uncertainty: 'medium', candidate_ids: ['r1'], representative_ids: ['r1'] }],
    ranked_candidates: [{
      title: 'Fed officials sound hawkish',
      url: 'https://example.com/fed',
      source: 'reddit',
      snippet: 'Traders discussed hawkish Fed comments.',
      explanation: 'relevant',
      final_score: 80,
      freshness: 90,
      engagement: 12,
      local_relevance: 0.8,
      subquery_labels: ['macro'],
      metadata: { provenance: [{ source: 'reddit' }] },
      source_items: [{
        title: 'Fed officials sound hawkish',
        url: 'https://example.com/fed',
        source: 'reddit',
        container: 'Economics',
        published_at: '2026-06-20',
        engagement: { score: 10 },
        snippet: 'source snippet',
        metadata: { comments: 2, huge_payload: 'x'.repeat(1000) },
        why_relevant: 'Fed sentiment',
      }],
    }],
    warnings: [],
    errors_by_source: {},
  }

  const result = __testing.last30DaysToResearchResult(
    { candidate: current, familyKey: 'title:fed', clusterKey: 'polymarket:markets:title:fed', depth: 'deep_web', reason: 'test', polymarketNativeContext: context } as any,
    planner,
    brief,
    report,
    '[last30days] normal progress diagnostics',
    ['last30days.py']
  )

  assert.deepEqual(result.entities_mentioned, [])
  assert.deepEqual((result.external_research as any).planner_expected_entities, ['Federal Reserve'])
  assert.deepEqual((result.external_research as any).retrieval_diagnostics, [])
  assert.equal((result.external_research as any).diagnostics.stderr, '[last30days] normal progress diagnostics')
  assert.doesNotMatch(result.uncertainty, /source limitations/i)
  assert.equal(result.evidence_quality, 'medium')
  assert.equal(result.catalyst_found, false)
  assert.equal(result.recommended_editor_action, 'needs_more_research')
  assert.equal((result.evidence_links[0] as any).url, 'https://example.com/fed')
  assert.equal((result.polymarket_context as any).source_native_context.source_url, context.source_url)
  assert.equal((result.polymarket_context as any).source_native_context.sibling_markets[0].slug, 'no-change')
  assert.equal((result.related_context as any[]).some((item) => item.kind === 'evidence_review'), false)
  const placeholders = (result.related_context as any[]).find((item) => item.kind === 'schema_compatibility_placeholders')
  assert.match(placeholders.note, /not researcher judgments/)
  const excerpt = (result.related_context as any[]).find((item) => item.kind === 'last30days_report_excerpt')
  assert.equal(excerpt.ranked_candidates[0].source_items[0].published_at, '2026-06-20')
  assert.deepEqual(excerpt.ranked_candidates[0].source_items[0].metadata, { comments: 2 })
  assert.equal(excerpt.clusters[0].title, 'Fed shift')
})

test('briefFromRetrievalReflection applies a transient second-pass search plan', () => {
  const priorBrief: any = {
    research_goal: 'Find why WHOOP IPO odds moved.',
    last30days_topic: 'WHOOP IPO odds',
    lookback_days: 30,
    search_sources: ['reddit', 'grounding', 'polymarket'],
    subreddits: ['investing'],
    polymarket_keywords: ['WHOOP', 'IPO'],
    last30days_plan: {
      intent: 'prediction',
      freshness_mode: 'strict_recent',
      cluster_mode: 'story',
      subqueries: [{ label: 'initial', search_query: 'WHOOP IPO', ranking_query: 'What changed?', sources: ['reddit', 'grounding'], weight: 1 }],
    },
    evidence_to_collect: ['IPO filing'],
    expected_entities: ['WHOOP'],
    notes: 'Initial search.',
  }
  const reflection = __testing.normalizeRetrievalReflection({
    search_again: true,
    next_last30days_topic: 'WHOOP IPO delay funding valuation 2026',
    next_search_sources: ['reddit', 'x_search', 'grounding'],
    next_subreddits: ['investing', 'stocks'],
    next_polymarket_keywords: ['WHOOP IPO delay'],
    next_subqueries: [{
      label: 'whoop_ipo_delay',
      search_query: 'WHOOP IPO delayed 2026 filing funding valuation',
      ranking_query: 'Collect recent context about WHOOP IPO timing or valuation.',
      sources: ['x_search', 'grounding'],
      weight: 1,
    }],
    notes: 'Search directly for IPO timing context.',
  } as any, priorBrief)

  const next = __testing.briefFromRetrievalReflection(priorBrief, reflection)

  assert.equal(reflection.search_again, true)
  assert.equal(next.last30days_topic, 'WHOOP IPO delay funding valuation 2026')
  assert.deepEqual(next.search_sources, ['reddit', 'grounding'])
  assert.deepEqual(next.last30days_plan.subqueries[0].sources, ['grounding'])
  assert.equal(next.last30days_plan.subqueries[0].label, 'whoop_ipo_delay')
  assert.match(next.notes, /Retrieval adjustment/)
})

test('normalizeRetrievalReflection does not request another pass without a changed plan', () => {
  const priorBrief: any = {
    research_goal: 'Find direct context.',
    last30days_topic: 'topic',
    lookback_days: 30,
    search_sources: ['reddit', 'grounding'],
    subreddits: ['news'],
    polymarket_keywords: [],
    last30days_plan: {
      intent: 'prediction',
      freshness_mode: 'strict_recent',
      cluster_mode: 'story',
      subqueries: [{ label: 'initial', search_query: 'topic', ranking_query: 'Collect context.', sources: ['reddit'], weight: 1 }],
    },
    evidence_to_collect: ['direct source'],
    expected_entities: [],
    notes: 'Research.',
  }

  const reflection = __testing.normalizeRetrievalReflection({
    search_again: true,
    next_search_sources: ['x_search'],
    next_subqueries: [],
  } as any, priorBrief)

  assert.equal(reflection.search_again, false)
  assert.deepEqual(reflection.next_search_sources, ['reddit', 'grounding'])
})
