import assert from 'node:assert/strict'
import test from 'node:test'
import { POLYMARKET_RESEARCHER_PRIOR_RESEARCH_SELECT } from './researcher'

// The editor, publisher, and entity-manager Polymarket stages no longer fetch
// research rows over Supabase egress at all - polymarket_market_candidates,
// polymarket_market_candidate_research, and polymarket_market_editor_decisions
// moved to the local PipelineStore (SQLite), so there is no `.select(...)`
// column string left to guard for those three. Only the researcher stage
// still reads prior research from Supabase.
const HOT_RESEARCH_SELECTS = [
  ['researcher prior research', POLYMARKET_RESEARCHER_PRIOR_RESEARCH_SELECT],
] as const

test('hot polymarket worker research selectors do not fetch related_context', () => {
  for (const [label, select] of HOT_RESEARCH_SELECTS) {
    assert.doesNotMatch(select, /\brelated_context\b/, label)
  }
})
