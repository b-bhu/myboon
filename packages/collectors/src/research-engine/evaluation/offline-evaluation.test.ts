import assert from 'node:assert/strict'
import test from 'node:test'
import { RESEARCH_EVALUATION_FIXTURES } from './fixtures'
import { prepareResearchEvaluation, evaluateRecordedResearchAnswers, type RecordedResearchAnswer } from './offline-evaluation'

function recorded(fixtureId: string, selected: string, confidence = 0.99): RecordedResearchAnswer {
  const request = prepareResearchEvaluation().find((value) => value.fixtureId === fixtureId)!
  const key = 'novelty' in request.body.questions ? 'novelty' : 'followup_value'
  const criteria = (request.body.questions[key] as { criteria: Record<string, unknown> }).criteria
  const alternatives = Object.keys(criteria)
  return { fixtureId, stateAndQuestionsDigest: request.stateAndQuestionsDigest, provenance: 'synthetic_mock', actualProvider: 'offline', actualModel: 'offline',
    answers: { [key]: { type: 'choice', choice: selected, confidence,
      probabilities: Object.fromEntries(alternatives.map((choice) => [choice, choice === selected ? 0.99 : 0.005])) } } }
}

test('20 synthetic News/Polymarket cases produce exact pinned approved request contracts without executing a transport', () => {
  const requests = prepareResearchEvaluation()
  assert.equal(requests.length, 20)
  assert.deepEqual(new Set(RESEARCH_EVALUATION_FIXTURES.map((fixture) => fixture.source)), new Set(['news', 'polymarket']))
  assert.deepEqual(new Set(RESEARCH_EVALUATION_FIXTURES.map((fixture) => fixture.workload)), new Set(['novelty', 'followup']))
  assert.ok(requests.every((request) => request.body.model === 'jev-1.13.0'))
  assert.ok(requests.every((request) => request.stateAndQuestionsDigest.length === 64))
})

test('mock label agreement validates harness arithmetic only, while unknown spend and missing observations remain explicit', () => {
  const records = RESEARCH_EVALUATION_FIXTURES.map((fixture) => recorded(fixture.id, fixture.label))
  const result = evaluateRecordedResearchAnswers(records)
  assert.equal(result.evidenceKind, 'includes_mock_arithmetic_only')
  assert.equal(result.observedCount, 20)
  assert.equal(result.labelAgreementCount, 20)
  assert.equal(result.acceptedCount, 20)
  assert.equal(result.measuredCostUsdMicros, null)
  assert.equal(result.unknownCostCount, 20)
  assert.equal(result.assignmentProviderCalls, null)
  assert.equal(result.pairedProviderCallDifference, null)
  assert.equal(evaluateRecordedResearchAnswers([]).missingFixtureIds.length, 20)
  assert.equal(evaluateRecordedResearchAnswers([]).measuredCostUsdMicros, null)
})

test('high confidence wrong-known response remains a raw quality error; incomplete coverage blocks its suppression', () => {
  const result = evaluateRecordedResearchAnswers([recorded('news-title-only', 'already_known'), recorded('news-unseen-body', 'already_known')])
  assert.equal(result.rawFalseAlreadyKnownCount, 2)
  assert.equal(result.guardedFalseAlreadyKnownCount, 1, 'Complete-body semantic error still requires real quality evaluation')
  assert.equal(result.rows[0].eligibleKnownSkip, false)
  assert.equal(result.rows[1].eligibleKnownSkip, true)
  assert.equal(result.missingFixtureIds.length, 18)
})

test('registry confidence abstention, model/state identity and duplicate observations cannot be hidden in metrics', () => {
  const answer = recorded('poly-same-odds-state', 'already_known', 0.70)
  const result = evaluateRecordedResearchAnswers([answer])
  assert.equal(result.abstainedCount, 1)
  assert.equal(result.rows[0].eligibleKnownSkip, false)
  assert.throws(() => evaluateRecordedResearchAnswers([answer, answer]), /Duplicate/)
  assert.throws(() => evaluateRecordedResearchAnswers([{ ...answer, stateAndQuestionsDigest: 'old-state' }]), /exact fixture/)
  assert.throws(() => evaluateRecordedResearchAnswers([{ ...answer, provenance: 'recorded_provider', actualProvider: 'typesafe', actualModel: 'jev-latest' }]), /pinned actual/)
})

test('paired assignment accounting includes extra classification/follow-up calls and measured costs without invented savings', () => {
  const answer = recorded('news-bounded-regulator-question', 'worthwhile')
  const result = evaluateRecordedResearchAnswers([{ ...answer,
    usage: { providerCalls: 1, inputTokens: 500, outputTokens: 30, costUsdMicros: 100, durationMs: 200 },
    assignmentUsage: { totalProviderCalls: 4, synthesisCalls: 1, followupSynthesisCalls: 1, baselineProviderCalls: 1 } }])
  assert.equal(result.measuredCostUsdMicros, 100)
  assert.equal(result.assignmentProviderCalls, 4)
  assert.equal(result.pairedProviderCallDifference, 3)
})
