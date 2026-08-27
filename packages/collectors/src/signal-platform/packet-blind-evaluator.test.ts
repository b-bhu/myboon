import assert from 'node:assert/strict'
import test from 'node:test'

import { evaluatePacketComparisonEvidence } from './packet-blind-evaluation-command'
import {
  BLIND_PACKET_SCORE_SCHEMA_VERSION,
  PACKET_PAIR_SCHEMA_VERSION,
  evaluateBlindPacketComparison,
  prepareBlindPacketEvaluation,
  type BlindPacketScoreV1,
  type ResearchPacketPairV1,
} from './packet-blind-evaluator'
import { operatorPacket } from './operator-fixtures.test-support'

const NOW = '2026-08-26T12:00:00.000Z'

function pair(id: string, sourceType: 'news' | 'polymarket' = 'news'): ResearchPacketPairV1 {
  const currentPacket = operatorPacket(sourceType, id, {
    budgetUsed: {
      providerCalls: 12, repairCalls: 1, inputTokens: 50_000, outputTokens: 10_000,
      toolCalls: 5, wallTimeMs: 300_000, budgetExceeded: false,
    },
    execution: {
      provider: 'legacy-provider', model: 'legacy-model', fallbackProvider: null, fallbackModel: null,
      fallbackUsed: false, promptVersion: 'legacy', policyVersion: 'legacy', traceId: `trace-${id}`, attempt: 1,
    },
  })
  const proposedPacket = operatorPacket(sourceType, `${id}-proposed`, {
    signalId: currentPacket.signalId,
    sourceSignal: currentPacket.sourceSignal,
    budgetUsed: {
      providerCalls: 1, repairCalls: 0, inputTokens: 2_000, outputTokens: 500,
      toolCalls: 0, wallTimeMs: 60_000, budgetExceeded: false,
    },
    execution: {
      provider: 'new-provider', model: 'new-model', fallbackProvider: null, fallbackModel: null,
      fallbackUsed: false, promptVersion: 'new', policyVersion: 'new', traceId: `trace-${id}`, attempt: 1,
    },
  })
  return {
    schemaVersion: PACKET_PAIR_SCHEMA_VERSION,
    pairId: `pair-${id}`,
    researchDepth: 'light',
    currentPacket,
    proposedPacket,
  }
}

function score(assignmentId: string, assignmentContentSha256: string, currentVariant: 'A' | 'B'): BlindPacketScoreV1 {
  const proposedVariant = currentVariant === 'A' ? 'B' : 'A'
  return {
    schemaVersion: BLIND_PACKET_SCORE_SCHEMA_VERSION,
    reviewId: `review-${assignmentId}`,
    assignmentId,
    assignmentContentSha256,
    reviewerIdSha256: 'a'.repeat(64),
    reviewedAt: NOW,
    blindingProtocolVersion: 'myboon.packet_blinding.v1',
    providerModelUsageAndCostHidden: true,
    scores: {
      [currentVariant]: {
        productQualityScore: 3, evidenceQualityScore: 3, attributionQualityScore: 3, productAcceptable: true,
      },
      [proposedVariant]: {
        productQualityScore: 4, evidenceQualityScore: 4, attributionQualityScore: 4, productAcceptable: true,
      },
    } as BlindPacketScoreV1['scores'],
    preferredVariant: proposedVariant,
  }
}

test('prepares reviewer-safe randomized assignments and a separately held identity manifest', () => {
  const bundle = prepareBlindPacketEvaluation({ datasetId: 'dataset-1', blindingSeed: 'secret-seed', pairs: [pair('1')] })
  assert.equal(bundle.assignments.length, 1)
  assert.equal(bundle.manifest.entries.length, 1)
  assert.match(bundle.assignments[0]!.assignmentId, /^[a-f0-9]{64}$/)
  const reviewerJson = JSON.stringify(bundle.assignments)
  for (const hidden of [
    'legacy-provider', 'legacy-model', 'new-provider', 'new-model',
    'budgetUsed', 'execution', 'packet-1', 'work-1', 'signal-1', 'currentVariant',
  ]) assert.equal(reviewerJson.includes(hidden), false, `review assignment leaked ${hidden}`)
  assert.equal(reviewerJson.includes('claims'), true)
  assert.equal(bundle.manifest.blindingSeedSha256.length, 64)
  assert.equal(JSON.stringify(bundle.manifest).includes('secret-seed'), false)
})

test('joins blind scores to current/proposed only after review and meters canonical packet usage', () => {
  const bundle = prepareBlindPacketEvaluation({ datasetId: 'dataset-1', blindingSeed: 'secret-seed', pairs: [pair('1')] })
  const entry = bundle.manifest.entries[0]!
  const report = evaluateBlindPacketComparison({
    manifest: bundle.manifest,
    reviews: [score(entry.assignmentId, entry.assignmentContentSha256, entry.currentVariant)],
  })
  assert.equal(report.reviewedPairs, 1)
  assert.equal(report.proposed.averageProductQualityScore, 4)
  assert.equal(report.current.averageProductQualityScore, 3)
  assert.equal(report.proposed.averageProviderCalls, 1)
  assert.equal(report.current.averageProviderCalls, 12)
  assert.deepEqual(report.preference, { currentWins: 0, proposedWins: 1, ties: 0 })
  const output = JSON.stringify(report)
  assert.equal(output.includes('legacy-provider'), false)
  assert.equal(output.includes('new-provider'), false)
  assert.equal(output.includes('Claim'), false)
})

test('enforces per-source sample, blind quality, zero-tool, latency, and regression gates', () => {
  const bundle = prepareBlindPacketEvaluation({
    datasetId: 'dataset-1', blindingSeed: 'secret-seed', pairs: [pair('n', 'news'), pair('p', 'polymarket')],
  })
  const reviews = bundle.manifest.entries.map((entry) => score(
    entry.assignmentId, entry.assignmentContentSha256, entry.currentVariant,
  ))
  const artifact = evaluatePacketComparisonEvidence({
    manifest: bundle.manifest,
    reviews,
    now: new Date(NOW),
    thresholds: {
      requiredSourceTypes: ['news', 'polymarket'],
      minimumPairsPerSource: 1,
      minimumReviewCoverageRate: 1,
      minimumProposedAcceptableRate: 1,
      minimumProposedProductQualityScore: 4,
      minimumProposedEvidenceQualityScore: 4,
      minimumProposedAttributionQualityScore: 4,
      maximumProductQualityRegression: 0,
      maximumEvidenceQualityRegression: 0,
      maximumAttributionQualityRegression: 0,
      maximumProposedProviderCalls: 1.1,
      maximumProposedInputTokens: 2_000,
      maximumProposedOutputTokens: 500,
      maximumProposedP95WallTimeMs: 90_000,
    },
  })
  assert.equal(artifact.passed, true)
  assert.deepEqual(artifact.sourceTypes, ['news', 'polymarket'])
  const failed = evaluatePacketComparisonEvidence({
    manifest: bundle.manifest,
    reviews: reviews.slice(0, 1),
    thresholds: { ...artifact.thresholds, minimumPairsPerSource: 2 },
  })
  assert.equal(failed.passed, false)
  assert.match(failed.failures.join(' '), /news\.pairs|polymarket\.pairs/)
  assert.match(failed.failures.join(' '), /review_coverage/)
  const missingSource = evaluatePacketComparisonEvidence({
    manifest: prepareBlindPacketEvaluation({
      datasetId: 'news-only', blindingSeed: 'seed', pairs: [pair('only-news', 'news')],
    }).manifest,
    reviews: [], thresholds: artifact.thresholds,
  })
  assert.match(missingSource.failures.join(' '), /polymarket\.pairs 0/)
})

test('rejects identity mismatch, duplicate reviews, unknown assignments, and non-blind attestations', () => {
  const mismatched = pair('1')
  mismatched.proposedPacket = { ...mismatched.proposedPacket, signalId: 'another-signal' }
  assert.throws(() => prepareBlindPacketEvaluation({
    datasetId: 'dataset', blindingSeed: 'seed', pairs: [mismatched],
  }), /does not share signal identity/)

  const bundle = prepareBlindPacketEvaluation({ datasetId: 'dataset', blindingSeed: 'seed', pairs: [pair('2')] })
  const entry = bundle.manifest.entries[0]!
  const review = score(entry.assignmentId, entry.assignmentContentSha256, entry.currentVariant)
  assert.throws(() => evaluateBlindPacketComparison({
    manifest: bundle.manifest, reviews: [review, { ...review, reviewId: 'second' }],
  }), /Duplicate review for assignment/)
  assert.throws(() => evaluateBlindPacketComparison({
    manifest: bundle.manifest, reviews: [{ ...review, assignmentId: 'b'.repeat(64) }],
  }), /unknown assignment/)
  assert.throws(() => evaluateBlindPacketComparison({
    manifest: bundle.manifest,
    reviews: [{ ...review, providerModelUsageAndCostHidden: false as true }],
  }), /protocol is invalid/)
  assert.throws(() => evaluateBlindPacketComparison({
    manifest: bundle.manifest,
    reviews: [{ ...review, assignmentContentSha256: 'c'.repeat(64) }],
  }), /does not match manifest/)
})
