import { createHash } from 'node:crypto'
import type { GateEntityContext, GateSignal } from '../../research-gate/types'

/** Synthetic domain fixtures, hand-labeled from supplied facts, never production evidence. */
export interface ResearchEvaluationFixture {
  id: string
  source: 'news' | 'polymarket'
  workload: 'novelty' | 'followup'
  label: 'already_known' | 'new_information' | 'contradicts_prior' | 'worthwhile' | 'not_worthwhile' | 'uncertain'
  rationale: string
  state: { signal: GateSignal, context: GateEntityContext }
  coverage: { completeSource: boolean, completeLookup: boolean, itemRefs: string[], failures: string[] }
}

const context = (note: string): GateEntityContext => ({
  entities: [{ id: 'synthetic-atlas', slug: 'atlas', name: 'Atlas', summary: null }],
  recentMemories: [{ entityId: 'synthetic-atlas', memoryType: 'managed_knowledge', title: 'Prior source record', summary: note,
    eventAt: '2026-10-02T09:00:00.000Z' }],
})

function fixture(id: string, source: 'news' | 'polymarket', workload: 'novelty' | 'followup',
  label: ResearchEvaluationFixture['label'], material: string, memory: string, rationale: string,
  coverage: Partial<ResearchEvaluationFixture['coverage']> = {}): ResearchEvaluationFixture {
  const completeSource = coverage.completeSource ?? true
  return { id, source, workload, label, rationale,
    state: { signal: { source, sourceRefId: `synthetic:${id}`, title: 'Atlas launch update', whatChanged: material.slice(0, 2_000),
      observedAt: '2026-10-03T09:00:00.000Z', sourceMaterial: material,
      sourceMaterialDigest: createHash('sha256').update(material).digest('hex'), sourceMaterialComplete: completeSource }, context: context(memory) },
    coverage: { completeSource, completeLookup: true, itemRefs: ['synthetic-item-atlas'], failures: [], ...coverage } }
}

export const RESEARCH_EVALUATION_FIXTURES: readonly ResearchEvaluationFixture[] = [
  fixture('news-same-source-claim', 'news', 'novelty', 'already_known', 'Atlas says its product launches Friday.',
    'Atlas says its product launches Friday.', 'The exact attributed assertion is already present; this does not verify the launch.'),
  fixture('news-unseen-body', 'news', 'novelty', 'new_information', 'Same launch headline. The full body additionally says the regulator license arrived today.',
    'Atlas says its product launches Friday.', 'A matching headline cannot erase the additional body fact.'),
  fixture('news-title-only', 'news', 'novelty', 'new_information', 'Title only: Atlas launch update. Full article unavailable.',
    'Atlas says its product launches Friday.', 'Incomplete source cannot support skipping Research.', { completeSource: false }),
  fixture('news-correction', 'news', 'novelty', 'contradicts_prior', 'Atlas corrects its launch date to Monday and withdraws the Friday announcement.',
    'Atlas says its product launches Friday.', 'Explicit correction conflicts with the saved Friday claim.'),
  fixture('news-new-attribution', 'news', 'novelty', 'new_information', 'The regulator independently says Atlas received a launch license.',
    'Atlas claimed it received a launch license.', 'A new authority and evidence contribution are new information, not proof inferred from repetition.'),
  fixture('news-truncated-history', 'news', 'novelty', 'new_information', 'Atlas says its product launches Friday.',
    'Only the first historical note was available.', 'Truncated comparison cannot justify already_known.', { completeLookup: false }),
  fixture('news-lookup-error', 'news', 'novelty', 'new_information', 'Atlas reports a launch update.',
    'Lookup failed; no current relevant history available.', 'Lookup errors are not evidence of prior knowledge.',
    { completeLookup: false, itemRefs: [], failures: ['private lookup unavailable'] }),
  fixture('news-unrelated-context', 'news', 'novelty', 'new_information', 'Atlas reports launch Friday.',
    'A different company named Atlas launches a different product.', 'Co-occurrence is not related knowledge coverage.', { completeLookup: false }),
  fixture('poly-same-odds-state', 'polymarket', 'novelty', 'already_known', 'Atlas launch market Yes probability is 58%, observed unchanged.',
    'Atlas launch market Yes probability is 58%.', 'The unchanged same market state is already recorded.'),
  fixture('poly-new-odds-state', 'polymarket', 'novelty', 'new_information', 'Atlas launch market Yes probability moved from 58% to 35%.',
    'Atlas launch market Yes probability moved from 41% to 58%.', 'A later distinct move is a new state, even when the market subject repeats.'),
  fixture('poly-official-resolution', 'polymarket', 'novelty', 'new_information', 'The market resolver finalized Atlas launch market as Yes.',
    'Atlas launch market was open at 58% Yes probability.', 'Resolution is different from previously observed odds.'),
  fixture('poly-retracted-resolution', 'polymarket', 'novelty', 'contradicts_prior', 'Resolver withdrew the previous Yes result and reopened the disputed market.',
    'Atlas launch market finalized as Yes.', 'Lifecycle correction must invalidate prior coverage.'),
  fixture('news-bounded-regulator-question', 'news', 'followup', 'worthwhile',
    'Assignment: identify attributed launch dates. Baseline: Atlas says Friday; regulator date unresolved. Admitted regulator URL can answer that exact question in one bounded fetch.',
    'Atlas source claim says Friday; no regulator date saved.', 'An available bounded source can add an assignment-relevant factual contribution.'),
  fixture('news-no-additional-question', 'news', 'followup', 'not_worthwhile',
    'Assignment: record Atlas source assertion. Baseline already records the complete Friday claim and its source. No material open question.',
    'Same complete attributed Friday announcement.', 'Further investigation adds nothing to this assignment.'),
  fixture('news-unbounded-search', 'news', 'followup', 'uncertain',
    'Assignment asks launch date; possible sources and bounded access are unknown. Baseline contains one Friday claim.',
    'Prior claim says Friday.', 'Possible benefit cannot authorize an unspecified paid investigation.'),
  fixture('news-incomplete-followup-context', 'news', 'followup', 'uncertain',
    'Only a headline is available; assignment and source body are missing.', 'No relevant research context available.',
    'Insufficient context requires no extra paid follow-up.', { completeSource: false, completeLookup: false, itemRefs: [] }),
  fixture('poly-odds-not-outcome-proof', 'polymarket', 'followup', 'worthwhile',
    'Assignment asks whether the regulator announced a license. Baseline only reports 80% market odds. One admitted regulator notice can establish the attributed regulator announcement.',
    'Only market odds are retained, no notice.', 'A bounded primary notice adds information; odds alone do not establish the outcome.'),
  fixture('poly-closed-question', 'polymarket', 'followup', 'not_worthwhile',
    'Assignment records the latest market odds. Baseline captures the exact latest 58% state and timestamp. No further market source can add to this observation.',
    'Latest identical 58% snapshot is saved.', 'Bounded follow-up is redundant for the stated task.'),
  fixture('poly-conflicting-sources', 'polymarket', 'followup', 'worthwhile',
    'Baseline retains conflicting attributed launch dates. Assignment asks current regulator date. One admitted dated correction notice is available.',
    'Atlas says Friday; regulator previously said Monday.', 'A specific bounded correction source can resolve relevant disagreement without treating odds as facts.'),
  fixture('poly-no-supported-access', 'polymarket', 'followup', 'uncertain',
    'The only proposed evidence is an unavailable private chat. No supported bounded source or retrieval route is admitted.',
    'Market odds moved; cause is unknown.', 'No supported execution path means value cannot authorize a paid replacement route.'),
]
