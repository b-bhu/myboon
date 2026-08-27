import assert from 'node:assert/strict'
import test from 'node:test'
import type { NewsSignal } from './contracts'
import { evaluateTriageDataset, parseTriageEvaluationArgs } from './triage-evaluation-command'
import { createPriorityPolicyV1, RulesFirstTriageEngine } from './triage-engine'
import type { TriageEvaluationRecord } from './triage-evaluator'

const NOW = '2026-08-26T00:00:00.000Z'

function signal(): NewsSignal {
  return {
    schemaVersion: 'myboon.signal.v1', signalId: 'signal-eval', sourceType: 'news', sourceId: 'source-eval',
    contentKind: 'article', content: { schemaVersion: 'myboon.signal_content.article.v1' },
    observedAt: NOW, publishedAt: NOW, canonicalUrl: 'https://example.com/report', title: 'Official inflation report',
    visibleSummary: 'Prices moved', media: { imageUrl: null, attribution: null },
    sourceHints: { entities: [], assets: [], eventId: null, deadline: null },
    provenance: { provider: 'fixture', upstreamSource: null, rawPayloadRef: 'fixture' }, idempotencyKey: 'eval-key',
  }
}

async function record(): Promise<TriageEvaluationRecord> {
  const source = signal()
  const engine = new RulesFirstTriageEngine({
    policy: createPriorityPolicyV1({ policyVersion: 'eval-policy.v1', budgetPolicyVersion: 'eval-budget.v1' }),
  })
  const bucket = { available: 100, reservedAvailable: 10, utilization: 0 }
  const decision = await engine.decide({
    signal: source, now: NOW, dedupeOutcome: 'material_change', entityCanonOverlap: true,
    novelty: 'material', officialSource: true, sourceAuthorityScore: 1, materialityTags: ['market_material'],
    providerHealth: 'healthy', eventDeadline: null, ambiguity: { isAmbiguous: false, reasons: [] },
    capacity: {
      byPriority: { P0: bucket, P1: bucket, P2: bucket, P3: bucket },
      byDepth: { light: bucket, standard: bucket, deep: bucket },
    }, deepEscalation: null,
  })
  return {
    recordId: 'eval-1', signal: source,
    decision,
    label: { productRelevant: true, usefulEntityMemory: true },
    observedCost: { latencyMs: 100, providerCalls: 1, inputTokens: 10, outputTokens: 5, toolCalls: 0 },
    blindReview: {
      schemaVersion: 'myboon.blind_packet_review.v1', reviewId: 'review-1', blindAssignmentId: 'blind-1',
      reviewerIdSha256: 'a'.repeat(64), reviewedAt: NOW, blindingProtocolVersion: 'blind.v1',
      providerModelUsageAndCostHidden: true,
      productQualityScore: 4, evidenceQualityScore: 4, attributionQualityScore: 4,
      productAcceptable: true,
    },
  }
}

test('parses explicit reviewed thresholds and defaults to a 1,000-record gate', () => {
  const command = parseTriageEvaluationArgs([
    '--input', 'records.jsonl', '--max-false-negative-rate', '0.05',
    '--min-metered-completion-rate', '1',
    '--max-provider-calls-per-completion', '2', '--max-input-tokens-per-completion', '5000',
    '--max-output-tokens-per-completion', '1000', '--max-p95-latency-ms', '90000',
    '--min-blind-review-rate', '1', '--min-blind-acceptance-rate', '0.9',
    '--min-blind-product-quality', '3', '--min-blind-evidence-quality', '3',
    '--min-blind-attribution-quality', '3',
  ])
  assert.equal(command.thresholds.minimumRecords, 1_000)
  assert.throws(() => parseTriageEvaluationArgs(['--input', 'x']), /required/)
})

test('emits a deterministic-input aggregate artifact and fails unmet gates without exposing source content', async () => {
  const bytes = JSON.stringify([await record()])
  const artifact = evaluateTriageDataset({
    bytes, now: new Date(NOW),
    thresholds: {
      minimumRecords: 1, maxFalseNegativeRate: 0, maxProviderCallsPerObservedCompletion: 1,
      minimumObservedCompletionRate: 1,
      maxInputTokensPerObservedCompletion: 10, maxOutputTokensPerObservedCompletion: 5, maxP95LatencyMs: 100,
      minimumBlindReviewRate: 1, minimumBlindAcceptanceRate: 1,
      minimumBlindProductQualityScore: 4, minimumBlindEvidenceQualityScore: 4,
      minimumBlindAttributionQualityScore: 4,
    },
  })
  assert.equal(artifact.passed, true)
  assert.equal(artifact.sourceType, 'news')
  assert.equal(artifact.stage, 'research')
  assert.equal(artifact.sampleSize, 1)
  assert.match(artifact.inputSha256, /^[a-f0-9]{64}$/)
  assert.equal(JSON.stringify(artifact).includes('Prices moved'), false)
  assert.equal(JSON.stringify(artifact).includes('signal-eval'), false)
  assert.equal(artifact.report.blindReview.coverageRate, 1)
  const failed = evaluateTriageDataset({
    bytes, thresholds: { ...artifact.thresholds, minimumRecords: 2, maxProviderCallsPerObservedCompletion: 0 },
  })
  assert.equal(failed.passed, false)
  assert.equal(failed.failures.length, 3)
  const duplicateRecords = JSON.stringify([await record(), await record()])
  const malformedCost = JSON.stringify([{ ...await record(), observedCost: { latencyMs: -1 } }])
  assert.throws(() => evaluateTriageDataset({
    bytes: duplicateRecords, thresholds: artifact.thresholds,
  }), /Duplicate evaluation recordId/)
  assert.throws(() => evaluateTriageDataset({
    bytes: malformedCost, thresholds: artifact.thresholds,
  }), /observedCost\.latencyMs/)
  const toolRecord = { ...await record(), observedCost: {
    latencyMs: 100, providerCalls: 1, inputTokens: 10, outputTokens: 5, toolCalls: 1,
  } }
  const toolArtifact = evaluateTriageDataset({
    bytes: JSON.stringify([toolRecord]), thresholds: artifact.thresholds,
  })
  assert.equal(toolArtifact.passed, false)
  assert.match(toolArtifact.failures.join(' '), /interactive_tool_calls/)

  const noBlind = { ...await record(), blindReview: null }
  const noBlindArtifact = evaluateTriageDataset({
    bytes: JSON.stringify([noBlind]), thresholds: artifact.thresholds,
  })
  assert.equal(noBlindArtifact.passed, false)
  assert.match(noBlindArtifact.failures.join(' '), /blind_review_rate/)
})
