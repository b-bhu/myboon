import assert from 'node:assert/strict'
import test from 'node:test'
import { buildV4EvaluationReport, V4EvaluationInputError, type V4EvaluationCaseV1 } from './v4-evaluation'

function row(overrides: Partial<V4EvaluationCaseV1> = {}): V4EvaluationCaseV1 {
  return {
    caseId: 'case-1', lane: 'production', outcome: 'completed', inputCorrect: true,
    usefulAcceptedItems: 2, falseDiscard: false, providerCalls: 1, inputTokens: 10, outputTokens: 5,
    fallbackCalls: 0, repairs: 0, repeatedInferenceOnRetry: 0, durationMs: 20, costUsdMicros: 100,
    ...overrides,
  }
}

test('denominators retain failed, incomplete and false-discard cases; false discard is not success', () => {
  const report = buildV4EvaluationReport([
    row({ caseId: 'ok' }),
    row({ caseId: 'failed', outcome: 'failed', inputCorrect: false, usefulAcceptedItems: 0, falseDiscard: true }),
    row({ caseId: 'incomplete', outcome: 'incomplete', inputCorrect: false, usefulAcceptedItems: 0 }),
  ])
  assert.equal(report.production.caseCount, 3)
  assert.equal(report.production.failedCount, 1)
  assert.equal(report.production.incompleteCount, 1)
  assert.equal(report.production.inputCorrectCount, 1)
  assert.equal(report.production.falseDiscardCount, 1)
  assert.equal(report.production.usefulAcceptedItems, 2)
  assert.throws(() => buildV4EvaluationReport([row({ inputCorrect: true, falseDiscard: true })]), V4EvaluationInputError)
})

test('cost metrics use separate correct-input and useful-item denominators; p95 uses nearest rank', () => {
  const report = buildV4EvaluationReport([
    row({ caseId: 'one', costUsdMicros: 300, usefulAcceptedItems: 3, durationMs: 10 }),
    row({ caseId: 'two', costUsdMicros: 100, usefulAcceptedItems: 1, durationMs: 20 }),
    row({ caseId: 'three', costUsdMicros: 100, durationMs: 30 }),
    row({ caseId: 'four', costUsdMicros: 100, durationMs: 40 }),
    row({ caseId: 'five', costUsdMicros: 100, durationMs: 50 }),
  ])
  assert.equal(report.production.observedCostUsdMicros, 700)
  assert.equal(report.production.costPerCorrectInputUsdMicros, 140)
  assert.equal(report.production.costPerUsefulAcceptedItemUsdMicros, 70)
  assert.equal(report.production.medianDurationMs, 30)
  assert.equal(report.production.tailDurationMs, 50)
})

test('zero denominators and unavailable costs produce null rather than fabricated values', () => {
  const report = buildV4EvaluationReport([row({ inputCorrect: false, usefulAcceptedItems: 0, costUsdMicros: null })])
  assert.equal(report.production.observedCostUsdMicros, null)
  assert.equal(report.production.costPerCorrectInputUsdMicros, null)
  assert.equal(report.production.costPerUsefulAcceptedItemUsdMicros, null)
  assert.equal(report.shadow.caseCount, 0)
  assert.equal(report.shadow.medianDurationMs, null)
  assert.equal(report.shadow.tailDurationMs, null)
  assert.equal(report.shadow.observedCostUsdMicros, null)
  assert.equal(report.shadow.coveredCostUsdMicros, null)
  assert.deepEqual(report.pairedBaselineCoverage, { pairedCaseCount: 0, productionOnlyCaseCount: 1, shadowOnlyCaseCount: 0 })
})

test('cost coverage reports covered subtotal separately from full-lane cost and unit costs', () => {
  const report = buildV4EvaluationReport([
    row({ caseId: 'covered', costUsdMicros: 250 }),
    row({ caseId: 'uncovered', costUsdMicros: null }),
  ])
  assert.equal(report.production.observedCostUsdMicros, null)
  assert.equal(report.production.coveredCostUsdMicros, 250)
  assert.equal(report.production.costCoverageCaseCount, 1)
  assert.equal(report.production.costPerCorrectInputUsdMicros, null)
})

test('paired baseline coverage identifies matching lane cases without fabricating missing rows', () => {
  const report = buildV4EvaluationReport([
    row({ caseId: 'paired' }),
    row({ caseId: 'paired', lane: 'shadow', costUsdMicros: null }),
    row({ caseId: 'production-only' }),
    row({ caseId: 'shadow-only', lane: 'shadow' }),
  ])
  assert.equal(report.totalCases, 4)
  assert.deepEqual(report.pairedBaselineCoverage, { pairedCaseCount: 1, productionOnlyCaseCount: 1, shadowOnlyCaseCount: 1 })
})

test('failed or incomplete rows cannot claim correct or useful accepted outcomes', () => {
  assert.throws(() => buildV4EvaluationReport([row({ outcome: 'failed' })]), /cannot claim correct or useful/)
  assert.throws(() => buildV4EvaluationReport([row({ outcome: 'incomplete', inputCorrect: false, usefulAcceptedItems: 1 })]), /cannot claim correct or useful/)
})

test('aggregate safe-integer overflow fails closed', () => {
  assert.throws(() => buildV4EvaluationReport([
    row({ caseId: 'one', costUsdMicros: Number.MAX_SAFE_INTEGER }),
    row({ caseId: 'two', costUsdMicros: 1 }),
  ]), /aggregate costUsdMicros/)
  assert.throws(() => buildV4EvaluationReport([
    row({ caseId: 'one', providerCalls: Number.MAX_SAFE_INTEGER }),
    row({ caseId: 'two', providerCalls: 1 }),
  ]), /aggregate providerCalls/)
})

test('shadow cost and measurements are attributed separately from production', () => {
  const report = buildV4EvaluationReport([
    row({ caseId: 'prod', costUsdMicros: 100 }),
    row({ caseId: 'shadow', lane: 'shadow', costUsdMicros: 900, providerCalls: 4, fallbackCalls: 1, repairs: 1, repeatedInferenceOnRetry: 2 }),
  ])
  assert.equal(report.production.observedCostUsdMicros, 100)
  assert.equal(report.production.providerCalls, 1)
  assert.equal(report.shadow.observedCostUsdMicros, 900)
  assert.equal(report.shadow.providerCalls, 4)
  assert.equal(report.shadow.fallbackCalls, 1)
  assert.equal(report.shadow.repairs, 1)
  assert.equal(report.shadow.repeatedInferenceOnRetry, 2)
})

test('invalid values, duplicate IDs, and private payload fields fail closed', () => {
  assert.throws(() => buildV4EvaluationReport([row(), row()]), /duplicate caseId/)
  assert.throws(() => buildV4EvaluationReport([row({ durationMs: -1 })]), /durationMs/)
  assert.throws(() => buildV4EvaluationReport([row({ costUsdMicros: Number.NaN })]), /costUsdMicros/)
  assert.throws(() => buildV4EvaluationReport([{ ...row(), privatePayload: 'secret' } as V4EvaluationCaseV1]), /only the documented metric fields/)
})
