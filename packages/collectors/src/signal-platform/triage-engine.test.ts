import assert from 'node:assert/strict'
import test from 'node:test'
import { SIGNAL_SCHEMA_VERSION, type NewsSignal } from './contracts'
import {
  COMMON_PRIORITY_SEMANTICS,
  TRIAGE_CLASSIFIER_RESULT_SCHEMA_VERSION,
  type CheapToollessTriageClassifier,
  type RulesFirstTriageInput,
} from './triage-contracts'
import {
  RulesFirstTriageEngine,
  createPriorityPolicyV1,
  createResearchWorkItemFromDecision,
} from './triage-engine'
import { runTriageShadowEvaluation } from './triage-evaluator'
import { validateBoundedClassifierResult, validatePriorityPolicy } from './triage-validation'

const policy = createPriorityPolicyV1({
  policyVersion: 'priority-2026-08-26.1',
  budgetPolicyVersion: 'budget-2026-08-26.1',
})

function signal(overrides: Partial<NewsSignal> = {}): NewsSignal {
  return {
    schemaVersion: SIGNAL_SCHEMA_VERSION,
    signalId: 'signal-1',
    sourceType: 'news',
    sourceId: 'source-1',
    contentKind: 'article',
    content: { schemaVersion: 'myboon.signal_content.article.v1' },
    observedAt: '2026-08-26T12:00:00.000Z',
    publishedAt: '2026-08-26T11:55:00.000Z',
    canonicalUrl: 'https://example.com/article',
    title: 'Signal title',
    visibleSummary: 'Signal summary',
    media: { imageUrl: null, attribution: null },
    sourceHints: { entities: [], assets: [], eventId: null, deadline: null },
    provenance: { provider: 'fixture', upstreamSource: 'Example', rawPayloadRef: 'row-1' },
    idempotencyKey: 'key-1',
    ...overrides,
  }
}

function capacity(overrides: Partial<RulesFirstTriageInput['capacity']> = {}): RulesFirstTriageInput['capacity'] {
  const bucket = { available: 100, reservedAvailable: 10, utilization: 0.2 }
  return {
    byPriority: {
      P0: { ...bucket }, P1: { ...bucket }, P2: { ...bucket }, P3: { ...bucket },
    },
    byDepth: { light: { ...bucket }, standard: { ...bucket }, deep: { ...bucket } },
    ...overrides,
  }
}

function input(overrides: Partial<RulesFirstTriageInput> = {}): RulesFirstTriageInput {
  return {
    signal: signal(),
    dedupeOutcome: 'new_observation',
    sourceAuthorityScore: 0.7,
    officialSource: false,
    entityCanonOverlap: true,
    novelty: 'low',
    materialityTags: [],
    eventDeadline: null,
    capacity: capacity(),
    providerHealth: 'healthy',
    ambiguity: { isAmbiguous: false, reasons: [] },
    deepEscalation: null,
    now: '2026-08-26T12:00:00.000Z',
    ...overrides,
  }
}

test('PriorityPolicyV1 locks exact common P0/P1/P2/P3 semantics', () => {
  assert.deepEqual(Object.fromEntries(Object.entries(policy.classes).map(([key, value]) => [key, value.meaning])), COMMON_PRIORITY_SEMANTICS)
  assert.throws(() => validatePriorityPolicy({
    ...policy,
    classes: { ...policy.classes, P0: { ...policy.classes.P0, meaning: 'Everything is urgent.' } },
  }), /must equal/)
})

test('exact duplicates archive while material changes retain research admission', async () => {
  const engine = new RulesFirstTriageEngine({ policy })
  assert.equal((await engine.decide(input({ dedupeOutcome: 'exact_duplicate' }))).outcome, 'archive')
  const changed = await engine.decide(input({
    dedupeOutcome: 'material_change',
    materialityTags: ['low_value'],
    eventDeadline: '2026-08-26T11:00:00.000Z',
  }))
  assert.equal(changed.outcome, 'standard')
  assert.ok(changed.reasons.some((reason) => reason.code === 'material_change'))
})

test('absence from entity canon alone never archives and novel entities are explicitly preserved', async () => {
  const engine = new RulesFirstTriageEngine({ policy })
  const absent = await engine.decide(input({ entityCanonOverlap: false, novelty: 'none' }))
  assert.notEqual(absent.outcome, 'archive')
  const novel = await engine.decide(input({ entityCanonOverlap: false, novelty: 'novel_entity' }))
  assert.equal(novel.outcome, 'light')
  assert.equal(novel.priorityClass, 'P2')
  assert.ok(novel.reasons.some((reason) => reason.code === 'novel_entity_preserved'))
})

test('official urgent P0 uses reserved path through outage/capacity while official alone is not urgent', async () => {
  const engine = new RulesFirstTriageEngine({ policy })
  const exhausted = capacity({
    byPriority: {
      P0: { available: 0, reservedAvailable: 2, utilization: 1 },
      P1: { available: 0, reservedAvailable: 0, utilization: 1 },
      P2: { available: 0, reservedAvailable: 0, utilization: 1 },
      P3: { available: 0, reservedAvailable: 0, utilization: 1 },
    },
    byDepth: {
      light: { available: 0, reservedAvailable: 0, utilization: 1 },
      standard: { available: 0, reservedAvailable: 0, utilization: 1 },
      deep: { available: 0, reservedAvailable: 0, utilization: 1 },
    },
  })
  const urgent = await engine.decide(input({
    officialSource: true,
    sourceAuthorityScore: 1,
    materialityTags: ['official_release'],
    eventDeadline: '2026-08-26T12:10:00.000Z',
    providerHealth: 'unavailable',
    capacity: exhausted,
  }))
  assert.equal(urgent.priorityClass, 'P0')
  assert.equal(urgent.outcome, 'standard')
  assert.ok(urgent.reasons.some((reason) => reason.code === 'official_urgent_reserved_path'))
  const background = await engine.decide(input({
    officialSource: true, sourceAuthorityScore: 1, materialityTags: ['background'], novelty: 'none',
  }))
  assert.equal(background.priorityClass, 'P3')
})

test('provider outage defers lower priority without mutating or dropping the Signal', async () => {
  const engine = new RulesFirstTriageEngine({ policy })
  const source = signal()
  const before = structuredClone(source)
  const decision = await engine.decide(input({ signal: source, providerHealth: 'circuit_open' }))
  assert.equal(decision.outcome, 'defer')
  assert.equal(decision.signalId, source.signalId)
  assert.deepEqual(source, before)
})

test('overload tightens deep before light and requires a typed eligible reason', async () => {
  const engine = new RulesFirstTriageEngine({ policy })
  const deepPressure = capacity()
  deepPressure.byDepth.deep = { available: 2, reservedAvailable: 0, utilization: 0.95 }
  const requested = await engine.decide(input({
    officialSource: true,
    sourceAuthorityScore: 1,
    materialityTags: ['regulatory'],
    deepEscalation: {
      reason: 'regulatory_interpretation_required',
      evidenceRefs: ['evidence-1'],
      unresolvedQuestion: 'What is the scope?',
      policyRule: 'deep-regulatory-v1',
    },
    capacity: deepPressure,
  }))
  assert.equal(requested.outcome, 'standard')
  assert.ok(requested.reasons.some((reason) => reason.code === 'deep_capacity_tightened'))
  const light = await engine.decide(input({ capacity: deepPressure }))
  assert.equal(light.outcome, 'light')

  const admitted = await engine.decide(input({
    officialSource: true,
    sourceAuthorityScore: 1,
    materialityTags: ['regulatory'],
    deepEscalation: {
      reason: 'regulatory_interpretation_required',
      evidenceRefs: ['evidence-1'],
      unresolvedQuestion: 'What is the scope?',
      policyRule: 'deep-regulatory-v1',
    },
  }))
  assert.equal(admitted.outcome, 'deep')
  assert.equal(admitted.deepEscalationReason, 'regulatory_interpretation_required')
})

test('cheap classifier is called only for explicit ambiguity and its result is strictly bounded', async () => {
  let calls = 0
  const classifier: CheapToollessTriageClassifier = {
    classify: () => {
      calls += 1
      return {
        schemaVersion: TRIAGE_CLASSIFIER_RESULT_SCHEMA_VERSION,
        suggestedOutcome: 'standard',
        scoreAdjustment: 0.05,
        reason: 'material_relevance',
        explanation: 'The supplied facts are materially relevant.',
      }
    },
  }
  const engine = new RulesFirstTriageEngine({ policy, classifier })
  await engine.decide(input())
  assert.equal(calls, 0)
  const ambiguous = await engine.decide(input({
    ambiguity: { isAmbiguous: true, reasons: ['mixed source indicators'] },
  }))
  assert.equal(calls, 1)
  assert.equal(ambiguous.outcome, 'standard')
  assert.equal(ambiguous.classifierUsed, true)
  assert.throws(() => validateBoundedClassifierResult({
    schemaVersion: TRIAGE_CLASSIFIER_RESULT_SCHEMA_VERSION,
    suggestedOutcome: 'standard', scoreAdjustment: 0, reason: 'material_relevance',
    explanation: 'bounded', unsupportedToolRequest: 'browser',
  }), /unsupported fields/)
})

test('ResearchWorkItem creation has deterministic identity, trace, budgets, freshness, and policy versions', async () => {
  const engine = new RulesFirstTriageEngine({ policy })
  const source = signal()
  const triage = await engine.decide(input({ signal: source, materialityTags: ['market_material'], officialSource: true }))
  const creation = {
    signal: source,
    decision: triage,
    retrievalPolicy: {
      policyVersion: 'retrieval-v1',
      allowedDomains: ['example.com'],
      maxExternalSourcesByDepth: { light: 1, standard: 3, deep: 5 },
    },
  }
  const first = createResearchWorkItemFromDecision(creation)
  const second = createResearchWorkItemFromDecision(structuredClone(creation))
  assert.deepEqual(first, second)
  assert.equal(first.policyVersion, policy.policyVersion)
  assert.equal(first.budgetPolicyVersion, policy.budgetPolicyVersion)
  assert.deepEqual(first.budget, triage.budget)
  assert.equal(first.freshnessDeadline, triage.freshnessDeadline)
  assert.equal(first.status, 'research_pending')
})

test('historical/shadow evaluation reports distributions, false negatives, capacity, latency, budgets, source and priority outcomes', async () => {
  const engine = new RulesFirstTriageEngine({ policy })
  const report = await runTriageShadowEvaluation(engine, [
    {
      recordId: 'duplicate-relevant',
      input: input({ dedupeOutcome: 'exact_duplicate' }),
      label: { productRelevant: true, usefulEntityMemory: true },
      observedCost: null,
      arrivalWeight: 2,
    },
    {
      recordId: 'provider-defer-relevant',
      input: input({
        signal: signal({ signalId: 'signal-2', idempotencyKey: 'key-2' }),
        providerHealth: 'unavailable', novelty: 'material', materialityTags: ['market_material'],
      }),
      label: { productRelevant: true, usefulEntityMemory: false },
      arrivalWeight: 1,
    },
    {
      recordId: 'admitted',
      input: input({
        signal: signal({ signalId: 'signal-3', idempotencyKey: 'key-3' }),
        officialSource: true, materialityTags: ['market_material'],
      }),
      label: { productRelevant: true, usefulEntityMemory: true },
      observedCost: { latencyMs: 1200, providerCalls: 1, inputTokens: 100, outputTokens: 40, toolCalls: 0 },
      arrivalWeight: 3,
    },
  ])
  assert.equal(report.totalRecords, 3)
  assert.equal(report.distribution.outcomes.archive.count, 1)
  assert.equal(report.distribution.outcomes.defer.count, 1)
  assert.equal(report.distribution.outcomes.standard.count, 1)
  assert.equal(report.falseNegativeCount, 2)
  assert.equal(report.falseNegativeRate, 2 / 3)
  assert.equal(report.capacityProjection.weightedAdmissions, 3)
  assert.equal(report.capacityProjection.weightedAdmissionRate, 0.5)
  assert.ok(report.budgetProjection.maxProviderCalls > 0)
  assert.equal(report.observedProjection.p95LatencyMs, 1200)
  assert.equal(report.perSource.news?.total, 3)
  assert.equal(report.perPriority.P1.outcomes.standard.count, 1)
  assert.equal('accepted' in report, false)
})
