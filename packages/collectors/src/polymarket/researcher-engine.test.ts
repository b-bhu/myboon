/**
 * Research-engine adoption in the Polymarket researcher (deep_web path).
 *
 * With an engine configured, deep_web candidates skip the legacy
 * planner->last30days->reflection retrieval pipeline entirely and run one
 * read-and-conclude engine task instead. The mapping under test here:
 *
 *  - answered      -> research row, status pending_editor, real verified facts
 *  - partial       -> research row, status pending_editor, needs_more_research
 *  - nothing_found -> research row, status REJECTED: full audit trail kept,
 *                     but it never enters the editor queue and never files
 *                     entity memories (both consume only pending_editor rows)
 *  - engine_failed -> the researcher's existing failure/retry lane
 *
 * No subprocess runs: the engine is injected as a stub at the
 * options.engine seam (its contract is just `research(task)`).
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { HermesService } from '../hermes'
import type { ResearchConclusion, ResearchTask } from '../research-engine'
import { SqlitePipelineStore } from '../pipeline-store/sqlite-store'
import { __testing } from './researcher'

const T0 = '2026-07-01T00:00:00.000Z'

function decision(overrides: Record<string, unknown> = {}) {
  return {
    candidate: {
      id: 'cand-1',
      source: 'polymarket',
      area: 'markets',
      candidate_type: 'market_shift',
      market_id: 'm1',
      slug: 'fed-rate-cut-september',
      title: 'Will the Fed cut rates in September?',
      tag_slug: 'macro',
      tag_label: 'Macro',
      observed_at: T0,
      what_changed: 'Yes odds moved from 41% to 58%.',
      why_flagged: 'Large repricing.',
      score: 82,
      score_breakdown: {},
      metrics: {},
      evidence_refs: [],
      status: 'researching',
      research_retry_count: 0,
      research_next_retry_at: null,
      research_last_error_kind: null,
      attempt_count: 1,
    },
    depth: 'deep_web',
    familyKey: 'title:fed-rate-cut-september',
    clusterKey: 'polymarket:markets:title:fed-rate-cut-september',
    reason: 'needs_current_context',
    polymarketNativeContext: {
      source_url: 'https://polymarket.com/market/fed-rate-cut-september',
      market: { slug: 'fed-rate-cut-september', title: 'Will the Fed cut rates in September?', description: 'Resolves YES if...', end_date: '2026-09-30', resolution_source: null },
      market_structure: { yes_price: 0.58 },
      parent_event: null,
      sibling_markets: [],
      source_native_questions: [],
    },
    ...overrides,
  }
}

const ENTITY_CONTEXT = {
  entities: [{ id: 'e1', slug: 'fed-rate-cut', name: 'Fed rate cut', summary: 'Fed policy.' }],
  recentMemories: [{
    entityId: 'e1',
    memoryType: 'market_signal',
    title: 'Odds at 41% after CPI',
    summary: 'Odds moved to 41% after the June CPI print.',
    eventAt: '2026-06-28T00:00:00.000Z',
  }],
}

function conclusion(overrides: Partial<ResearchConclusion> = {}): ResearchConclusion {
  return {
    taskId: 'polymarket:markets:cand-1',
    outcome: 'answered',
    summary: 'Powell signaled a September cut on July 29.',
    whatChanged: 'A dovish signal arrived after the last timeline entry.',
    verifiedFacts: [{
      fact: 'Powell said cuts are on the table for September.',
      evidence: [{ url: 'https://example.com/fed', title: 'Transcript' }],
    }],
    unverifiedClaims: [],
    checked: ['fed.gov', 'wire coverage'],
    openQuestions: [],
    evidenceLinks: [{ url: 'https://example.com/fed', title: 'Transcript' }],
    raw: '{}',
    durationMs: 1234,
    ...overrides,
  }
}

test('buildEngineTask asks a diff question against the timeline when entity context exists', () => {
  const task = __testing.buildEngineTask(decision({ entityContext: ENTITY_CONTEXT }) as never)

  assert.equal(task.subject, 'fed-rate-cut')
  assert.match(task.question, /2026-06-28/, 'anchored to the newest timeline entry')
  assert.match(task.question, /41% to 58%/)
  assert.equal(task.answerSpec.kind, 'catalyst')
  assert.ok(task.sourceContext, 'market-native context rides along')
  assert.equal(task.known?.recentMemories.length, 1)
})

test('buildEngineTask falls back to a from-scratch catalyst question for unresolved subjects', () => {
  const task = __testing.buildEngineTask(decision() as never)

  assert.equal(task.subject, 'fed-rate-cut-september')
  assert.equal(task.known, null)
  assert.match(task.question, /explain/i)
  assert.match(task.question, /41% to 58%/)
})

test('answered conclusion maps to a real research packet: verified facts, catalyst found, publish recommendation', () => {
  const result = __testing.engineConclusionToResearchResult(decision() as never, conclusion())

  assert.equal(result.engine_outcome, 'answered')
  assert.equal(result.catalyst_found, true)
  assert.equal(result.recommended_editor_action, 'publish_candidate')
  assert.deepEqual(result.verified_facts, ['Powell said cuts are on the table for September.'])
  assert.match(result.summary, /Powell/)
  assert.equal((result.evidence_links as Array<{ url: string }>)[0].url, 'https://example.com/fed')
})

test('nothing_found maps to reject_thin with the checked-list preserved for audit', () => {
  const result = __testing.engineConclusionToResearchResult(decision() as never, conclusion({
    outcome: 'nothing_found',
    summary: 'No catalyst found.',
    verifiedFacts: [],
    evidenceLinks: [],
  }))

  assert.equal(result.engine_outcome, 'nothing_found')
  assert.equal(result.catalyst_found, false)
  assert.equal(result.recommended_editor_action, 'reject_thin')
  assert.match(result.notes, /fed\.gov/, 'what was checked is preserved')
})

test('partial maps to needs_more_research', () => {
  const result = __testing.engineConclusionToResearchResult(decision() as never, conclusion({
    outcome: 'partial',
    verifiedFacts: [],
  }))

  assert.equal(result.engine_outcome, 'partial')
  assert.equal(result.catalyst_found, false)
  assert.equal(result.recommended_editor_action, 'needs_more_research')
})

test('nothing_found rows are written status=rejected; answered and partial rows stay pending_editor', () => {
  const decisions = [
    decision(),
    decision({ candidate: { ...(decision() as { candidate: Record<string, unknown> }).candidate, id: 'cand-2', slug: 'slug-2' } }),
  ]
  const results = new Map([
    ['cand-1', __testing.engineConclusionToResearchResult(decisions[0] as never, conclusion())],
    ['cand-2', __testing.engineConclusionToResearchResult(decisions[1] as never, conclusion({ outcome: 'nothing_found', verifiedFacts: [] }))],
  ])

  const rows = __testing.buildHermesResearchRows(decisions as never, results as never, T0, {
    backend: 'hermes_cli',
    researchModel: 'hermes_cli',
  } as never)

  assert.equal(rows.find((row) => row.candidate_id === 'cand-1')?.status, 'pending_editor')
  assert.equal(rows.find((row) => row.candidate_id === 'cand-2')?.status, 'rejected')
})

test('engine_failed routes to the researcher failure lane, never into a research row', async () => {
  const store = new SqlitePipelineStore(':memory:')
  try {
    const engine = {
      research: async (): Promise<ResearchConclusion> => conclusion({ outcome: 'engine_failed', summary: 'Research engine run timed_out (exit=none).' }),
    }
    const attempt = await __testing.researchCandidatesWithFallback(
      [decision() as never],
      {
        engine,
        hermes: new HermesService({ command: 'hermes', execFileImpl: async () => { throw new Error('legacy path must not run') } }),
      } as never,
      store,
      new Set<string>()
    )

    assert.equal(attempt.results.size, 0)
    assert.equal(attempt.failures.length, 1)
    assert.match(attempt.failures[0].error, /timed_out/)
  } finally {
    store.close()
  }
})

test('with an engine configured the legacy planner/retrieval path is not consulted', async () => {
  const store = new SqlitePipelineStore(':memory:')
  try {
    let engineCalls = 0
    const engine = {
      research: async (task: ResearchTask): Promise<ResearchConclusion> => {
        engineCalls += 1
        assert.match(task.taskId, /cand-1/)
        return conclusion()
      },
    }
    const attempt = await __testing.researchCandidatesWithFallback(
      [decision() as never],
      {
        engine,
        hermes: new HermesService({ command: 'hermes', execFileImpl: async () => { throw new Error('legacy path must not run') } }),
      } as never,
      store,
      new Set<string>()
    )

    assert.equal(engineCalls, 1)
    assert.equal(attempt.failures.length, 0)
    assert.equal(attempt.results.get('cand-1')?.engine_outcome, 'answered')
  } finally {
    store.close()
  }
})
