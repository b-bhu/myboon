import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { canonicalJson } from '../../signal-platform/canonical-json'
import { researchNoveltyDefinition, researchFollowupValueDefinition, type ResearchNoveltyState,
  type ResearchNoveltyDecision, type ResearchFollowupValueDecision } from '../../inference-gateway/classification-definitions'
import type { JevAnswer, ClassificationDefinition } from '../../inference-gateway/classification-types'
import { RESEARCH_EVALUATION_FIXTURES, type ResearchEvaluationFixture } from './fixtures'

export interface RecordedResearchAnswer {
  fixtureId: string
  stateAndQuestionsDigest: string
  provenance: 'synthetic_mock' | 'recorded_provider'
  actualProvider: string
  actualModel: string
  answers: Readonly<Record<string, JevAnswer>>
  usage?: { providerCalls: number | null, inputTokens: number | null, outputTokens: number | null, costUsdMicros: number | null, durationMs: number | null }
  assignmentUsage?: { totalProviderCalls: number, synthesisCalls: number, followupSynthesisCalls: number, baselineProviderCalls: number | null }
}

/** Produces reviewed TypeSafe API bodies but has no transport or credentials. */
export function prepareResearchEvaluation(fixtures: readonly ResearchEvaluationFixture[] = RESEARCH_EVALUATION_FIXTURES) {
  return fixtures.map((fixture) => {
    const definition: ClassificationDefinition<ResearchNoveltyState, ResearchNoveltyDecision | ResearchFollowupValueDecision> =
      fixture.workload === 'novelty' ? researchNoveltyDefinition() : researchFollowupValueDefinition()
    const state = definition.validateState(fixture.state)
    if (!state.valid) throw new Error(`Invalid fixture ${fixture.id}: ${state.issues.join('; ')}`)
    const body = { model: definition.jevTarget.model, state: state.value, questions: definition.questions(state.value) }
    return { fixtureId: fixture.id, fixtureType: 'synthetic_hand_labeled' as const, expectedLabel: fixture.label,
      workload: definition.workload, decisionVersion: definition.decisionVersion,
      stateAndQuestionsDigest: createHash('sha256').update(canonicalJson(body)).digest('hex'), body }
  })
}

/** Measures supplied recorded answers only. Mock outputs prove harness arithmetic, never Jev quality. */
export function evaluateRecordedResearchAnswers(records: readonly RecordedResearchAnswer[],
  fixtures: readonly ResearchEvaluationFixture[] = RESEARCH_EVALUATION_FIXTURES) {
  const prepared = new Map(prepareResearchEvaluation(fixtures).map((request) => [request.fixtureId, request]))
  const byId = new Map(fixtures.map((fixture) => [fixture.id, fixture]))
  if (new Set(records.map((record) => record.fixtureId)).size !== records.length) throw new Error('Duplicate recorded fixture answer')
  const rows = records.map((record) => {
    const fixture = byId.get(record.fixtureId), request = prepared.get(record.fixtureId)
    if (!fixture || !request || record.stateAndQuestionsDigest !== request.stateAndQuestionsDigest) throw new Error('Recorded answer is not bound to the exact fixture state and questions')
    if (record.provenance !== 'synthetic_mock' && record.provenance !== 'recorded_provider') throw new Error('Recorded answer requires explicit provenance')
    if (record.provenance === 'recorded_provider' && (record.actualProvider !== 'typesafe' || record.actualModel !== request.body.model)) {
      throw new Error('Provider evaluation must retain the pinned actual TypeSafe route; use a separately reviewed comparison for another model')
    }
    if (record.usage && !Object.values(record.usage).every((value) => value === null || (Number.isSafeInteger(value) && value >= 0))) {
      throw new Error('Recorded usage must retain non-negative safe integer counts or explicit unknown values')
    }
    if (record.assignmentUsage && (!Object.values(record.assignmentUsage).every((value) => value === null || (Number.isSafeInteger(value) && value >= 0))
      || record.assignmentUsage.synthesisCalls + record.assignmentUsage.followupSynthesisCalls > record.assignmentUsage.totalProviderCalls)) {
      throw new Error('Recorded assignment usage must include every classifier and synthesis call without invalid counts')
    }
    const definition: ClassificationDefinition<ResearchNoveltyState, ResearchNoveltyDecision | ResearchFollowupValueDecision> =
      fixture.workload === 'novelty' ? researchNoveltyDefinition() : researchFollowupValueDefinition()
    const decoded = definition.decodeJev(record.answers, request.body.state)
    const acceptance = decoded.valid
      ? definition.acceptJev(record.answers, decoded.value, request.body.state)
      : { accepted: false, reason: 'Invalid typed decision' }
    const decision = decoded.valid ? ('verdict' in decoded.value ? decoded.value.verdict : decoded.value.direction) : null
    const accepted = decoded.valid && acceptance.accepted
    const eligibleKnownSkip = accepted && decision === 'already_known' && fixture.coverage.completeSource
      && fixture.coverage.completeLookup && fixture.coverage.itemRefs.length > 0 && fixture.coverage.failures.length === 0
      && fixture.state.context.entities.length > 0 && fixture.state.context.recentMemories.length > 0
    return { fixtureId: fixture.id, source: fixture.source, workload: fixture.workload, expected: fixture.label,
      decision, accepted, agreesWithLabel: decision === fixture.label, eligibleKnownSkip,
      rawFalseAlreadyKnown: decision === 'already_known' && fixture.label !== 'already_known',
      guardedFalseAlreadyKnown: eligibleKnownSkip && fixture.label !== 'already_known', provenance: record.provenance,
      usage: record.usage ?? null, assignmentUsage: record.assignmentUsage ?? null }
  })
  const measuredCosts = rows.flatMap((row) => typeof row.usage?.costUsdMicros === 'number' ? [row.usage.costUsdMicros] : [])
  const measuredDurations = rows.flatMap((row) => typeof row.usage?.durationMs === 'number' ? [row.usage.durationMs] : []).sort((a, b) => a - b)
  return { evidenceKind: rows.some((row) => row.provenance === 'synthetic_mock') ? 'includes_mock_arithmetic_only' : 'recorded_provider_responses',
    fixtureCount: fixtures.length, observedCount: rows.length, missingFixtureIds: fixtures.filter((fixture) => !rows.some((row) => row.fixtureId === fixture.id)).map((fixture) => fixture.id),
    acceptedCount: rows.filter((row) => row.accepted).length, abstainedCount: rows.filter((row) => !row.accepted).length,
    rawFalseAlreadyKnownCount: rows.filter((row) => row.rawFalseAlreadyKnown).length,
    guardedFalseAlreadyKnownCount: rows.filter((row) => row.guardedFalseAlreadyKnown).length,
    labelAgreementCount: rows.filter((row) => row.agreesWithLabel).length,
    measuredCostUsdMicros: measuredCosts.length ? measuredCosts.reduce((sum, cost) => sum + cost, 0) : null,
    unknownCostCount: rows.length - measuredCosts.length,
    durationMsP50: measuredDurations.length ? measuredDurations[Math.ceil(measuredDurations.length * 0.5) - 1] : null,
    durationMsP95: measuredDurations.length ? measuredDurations[Math.ceil(measuredDurations.length * 0.95) - 1] : null,
    assignmentProviderCalls: rows.every((row) => row.assignmentUsage) && rows.length
      ? rows.reduce((sum, row) => sum + row.assignmentUsage!.totalProviderCalls, 0) : null,
    pairedProviderCallDifference: rows.every((row) => row.assignmentUsage?.baselineProviderCalls !== null && row.assignmentUsage !== null) && rows.length
      ? rows.reduce((sum, row) => sum + row.assignmentUsage!.totalProviderCalls - row.assignmentUsage!.baselineProviderCalls!, 0) : null,
    rows, limitation: 'Synthetic fixtures and mocked answers do not establish real Jev quality, calibrated thresholds, representative traffic, financial savings, or factual truth. Unknown usage remains unknown.' }
}

if (require.main === module) {
  // Offline: export prepared requests, or score an explicitly supplied recording.
  // No fetch, API key access, paid execution, automatic retries or deployment.
  const args = process.argv.slice(2)
  if (args.length === 0) console.log(JSON.stringify(prepareResearchEvaluation(), null, 2))
  else if (args.length === 2 && args[0] === '--recordings') {
    console.log(JSON.stringify(evaluateRecordedResearchAnswers(JSON.parse(readFileSync(args[1], 'utf8')) as RecordedResearchAnswer[]), null, 2))
  } else throw new Error('Usage: offline-evaluation.ts [--recordings PATH]')
}
