import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { extname, join } from 'node:path'
import test from 'node:test'

// History: this test used to import four Supabase SELECT column-string
// constants (one each for the editor, publisher, entity-manager, and
// researcher Polymarket stages) and assert none of them fetched
// `related_context` - a large JSON column on polymarket_market_candidate_research
// that caused an egress/cost regression when pulled on a hot, frequently-polled
// path (see commit 1668ec6, "Reduce hot-path research payloads").
//
// The Polymarket pipeline state migration (commit 5ed9205, #256) moved every
// stage - editor, publisher, entity-manager, and researcher alike - off
// Supabase reads entirely and onto the local SQLite PipelineStore. None of
// the four original constants remain: the last one
// (POLYMARKET_RESEARCHER_PRIOR_RESEARCH_SELECT) was a plain string array with
// zero production callers, kept alive only by this test's import of it. That
// made the guard vacuous - it was asserting a property of a value nothing
// ever sent over the wire.
//
// The invariant this test protects (never fetch related_context from
// Supabase in this lane) still matters: a future change could reintroduce a
// Supabase read for research data. Rather than import a constant (there is no
// longer a SELECT column-string constant anywhere under polymarket/ to
// import), this scans the source of every non-test file in this directory for
// `.select('...')` call arguments specifically - not every mention of the
// identifier, since `related_context` legitimately still appears as an
// in-memory field name on local PipelineStore row shapes (e.g.
// HermesResearchResult, ResearchRowInput in researcher.ts) and on the SQLite
// column itself. Those are local-store reads, not Supabase egress, and must
// not trip this guard. Only a literal Supabase `.select(...)` string argument
// containing the column name is the regression this test exists to catch.

const POLYMARKET_DIR = join(__dirname)
const SELECT_CALL_ARG = /\.select\(\s*(['"`])((?:(?!\1).)*)\1/g

function polymarketSourceFiles(): string[] {
  return readdirSync(POLYMARKET_DIR)
    .filter((name) => extname(name) === '.ts' && !name.endsWith('.test.ts'))
    .map((name) => join(POLYMARKET_DIR, name))
}

test('no polymarket .select(...) call fetches related_context (Supabase egress regression guard)', () => {
  for (const file of polymarketSourceFiles()) {
    const contents = readFileSync(file, 'utf8')
    for (const match of contents.matchAll(SELECT_CALL_ARG)) {
      const selectArg = match[2]
      assert.doesNotMatch(selectArg, /\brelated_context\b/, `${file}: .select('${selectArg}')`)
    }
  }
})
