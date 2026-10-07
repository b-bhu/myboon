import assert from 'node:assert/strict'
import test from 'node:test'
import { actualSourceEvaluationCases } from './actual-source-cases'

const observedAt = '2026-09-18T01:00:00.000Z'
const memory = { caseId: 'hosted-memory:polluted', memoryId: 'stored-solana-note', entityId: 'gpt-5.6', source: 'polymarket' as const,
  sourceRefId: 'original-source-ref', title: 'Solana fundamentals', summary: 'Solana is a public blockchain; SOL is its native cryptocurrency.',
  body: null, observedAt, eventAt: observedAt, memoryType: 'market_event' }
const hosted = { schemaVersion: 'myboon.v4_live_database_cases.v1', capturedAt: '2026-10-03T04:00:00.000Z', cases: [memory], legacyContext: [memory],
  entities: [{ id: 'gpt-5.6', name: 'GPT-5.6', slug: 'gpt-5.6', summary: 'OpenAI language model family with tiers Sol, Terra and Luna.' }] }
const reviewed = { schemaVersion: 'review.v1', reviewer: 'human', cases: [{ caseId: memory.caseId,
  category: 'catalog_identity_pollution', expectation: 'Solana note cannot establish GPT-5.6 membership.', expectedEntityNames: ['Solana'],
  forbiddenEntityIds: ['gpt-5.6'], resolvedSourceEntityId: 'solana' }] }
const source = { schemaVersion: 'myboon.entity_v4_actual_source_cases.v1', snapshotCapturedAt: hosted.capturedAt, cases: [{
  caseId: 'captured-poly', sourceType: 'polymarket' as const, title: 'Solana market observation', body: 'Retained original source.',
  observedAt, nativePayloadReference: 'native:captured-poly', sourceSignalId: 'signal-original', evidenceCapturedAt: observedAt,
  signal: { visibleSummary: 'Market outcome remains unresolved.' }, entityLabels: ['Solana'], capturedEvidence: [{ evidenceId: 'capture-1', finalUrl: 'https://polymarket.com/event/original' }],
  coverage: { fullArticleCompletenessVerified: false, exportTruncated: false, upstreamCaptureTruncated: false },
  retainedResearch: { openQuestions: ['What is the outcome?'], completion: 'partial', claims: [], limitations: ['No independent outcome evidence.'] },
}] }

test('actual-source admission preserves original incomplete coverage/time and separates natural cases from reviewed transforms', () => {
  const cases = actualSourceEvaluationCases(hosted, source, reviewed)
  assert.equal(cases.length, 4)
  const natural = cases.filter((item) => item.origin?.kind === 'actual_source')
  assert.equal(natural.length, 3)
  assert.ok(natural.every((item) => item.label === null))
  assert.ok(cases.every((item) => item.state.signal.observedAt === observedAt))
  assert.ok(cases.every((item) => !item.coverage.completeSource && !item.coverage.completeLookup))
  assert.ok(cases.every((item) => item.state.signal.sourceMaterialComplete === false))
  assert.equal(cases.find((item) => item.id.includes('unrelated-gpt-history'))?.label, 'new_information')
  const polluted = cases.find((item) => item.id.includes('unrelated-gpt-history'))!
  assert.equal(polluted.state.context.recentMemories[0].summary, hosted.entities[0].summary)
  assert.equal(polluted.state.context.recentMemories[0].memoryType, 'evaluation_catalogue_summary')
})

test('reviewer assertions stay out of model state; no completed legacy packet fabricates independent coverage or admission', () => {
  const cases = actualSourceEvaluationCases(hosted, source, reviewed)
  assert.ok(cases.every((item) => !JSON.stringify(item.state).includes(reviewed.cases[0].expectation)))
  const followup = cases.find((item) => item.workload === 'followup')!
  assert.ok(followup.state.signal.sourceMaterial?.includes('No additional retrieval admission'))
  assert.equal(followup.label, null)
  assert.equal(followup.state.signal.sourceRefId, 'signal-original')
  assert.equal(followup.origin?.capturedAt, observedAt)
})

test('unreviewed/missing catalogue references cannot enter a partially paid live admission', () => {
  assert.throws(() => actualSourceEvaluationCases(hosted, source, { ...reviewed, cases: [] }), /separate coverage review/)
  assert.throws(() => actualSourceEvaluationCases({ ...hosted, entities: [] }, source, reviewed), /catalogue row/)
  assert.throws(() => actualSourceEvaluationCases({ ...hosted, schemaVersion: 'other' }, source, reviewed), /named source/)
})
