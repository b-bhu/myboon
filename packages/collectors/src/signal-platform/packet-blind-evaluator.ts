import { createHash } from 'node:crypto'

import type { ResearchDepth, ResearchPacketV1, Signal } from './contracts'
import { canonicalJson } from './canonical-json'
import { validateResearchPacket } from './validation'

export const PACKET_PAIR_SCHEMA_VERSION = 'myboon.research_packet_pair.v1' as const
export const BLIND_PACKET_ASSIGNMENT_SCHEMA_VERSION = 'myboon.blind_packet_assignment.v1' as const
export const BLIND_PACKET_MANIFEST_SCHEMA_VERSION = 'myboon.blind_packet_manifest.v1' as const
export const BLIND_PACKET_SCORE_SCHEMA_VERSION = 'myboon.blind_packet_score.v1' as const
export const PACKET_COMPARISON_REPORT_SCHEMA_VERSION = 'myboon.packet_comparison_report.v1' as const

export type BlindVariant = 'A' | 'B'

export interface ResearchPacketPairV1 {
  schemaVersion: typeof PACKET_PAIR_SCHEMA_VERSION
  pairId: string
  researchDepth: Extract<ResearchDepth, 'light' | 'standard'>
  currentPacket: ResearchPacketV1
  proposedPacket: ResearchPacketV1
}

/** Reviewer-facing packet view. It deliberately excludes identity, route, model, usage, and cost. */
export interface BlindResearchPacketViewV1 {
  sourceType: Signal['sourceType']
  observedAt: string
  sourceSignal: ResearchPacketV1['sourceSignal']
  claims: ResearchPacketV1['claims']
  verifiedFacts: ResearchPacketV1['verifiedFacts']
  unresolvedClaims: ResearchPacketV1['unresolvedClaims']
  evidence: ResearchPacketV1['evidence']
  entityHints: ResearchPacketV1['entityHints']
  limitations: string[]
  openQuestions: string[]
  completion: ResearchPacketV1['completion']
}

export interface BlindPacketAssignmentV1 {
  schemaVersion: typeof BLIND_PACKET_ASSIGNMENT_SCHEMA_VERSION
  assignmentId: string
  blindingProtocolVersion: 'myboon.packet_blinding.v1'
  sourceType: Signal['sourceType']
  researchDepth: Extract<ResearchDepth, 'light' | 'standard'>
  assignmentContentSha256: string
  variants: readonly [
    { variant: 'A'; packet: BlindResearchPacketViewV1 },
    { variant: 'B'; packet: BlindResearchPacketViewV1 },
  ]
}

export interface BlindPacketManifestEntryV1 {
  pairId: string
  assignmentId: string
  sourceType: Signal['sourceType']
  researchDepth: Extract<ResearchDepth, 'light' | 'standard'>
  currentVariant: BlindVariant
  assignmentContentSha256: string
  currentPacket: ResearchPacketV1
  proposedPacket: ResearchPacketV1
}

export interface BlindPacketManifestV1 {
  schemaVersion: typeof BLIND_PACKET_MANIFEST_SCHEMA_VERSION
  datasetId: string
  blindingProtocolVersion: 'myboon.packet_blinding.v1'
  blindingSeedSha256: string
  entries: BlindPacketManifestEntryV1[]
}

export interface BlindVariantScoreV1 {
  productQualityScore: number
  evidenceQualityScore: number
  attributionQualityScore: number
  productAcceptable: boolean
}

export interface BlindPacketScoreV1 {
  schemaVersion: typeof BLIND_PACKET_SCORE_SCHEMA_VERSION
  reviewId: string
  assignmentId: string
  assignmentContentSha256: string
  reviewerIdSha256: string
  reviewedAt: string
  blindingProtocolVersion: 'myboon.packet_blinding.v1'
  providerModelUsageAndCostHidden: true
  scores: Record<BlindVariant, BlindVariantScoreV1>
  preferredVariant: BlindVariant | 'tie'
}

export interface PacketVariantAggregateV1 {
  reviewCount: number
  acceptableRate: number | null
  averageProductQualityScore: number | null
  averageEvidenceQualityScore: number | null
  averageAttributionQualityScore: number | null
  averageProviderCalls: number | null
  averageInputTokens: number | null
  averageOutputTokens: number | null
  averageToolCalls: number | null
  averageWallTimeMs: number | null
  p95WallTimeMs: number | null
}

export interface PacketComparisonReportV1 {
  schemaVersion: typeof PACKET_COMPARISON_REPORT_SCHEMA_VERSION
  datasetId: string
  manifestSha256: string
  reviewsSha256: string
  totalPairs: number
  reviewedPairs: number
  reviewCoverageRate: number
  current: PacketVariantAggregateV1
  proposed: PacketVariantAggregateV1
  preference: { currentWins: number; proposedWins: number; ties: number }
  perSource: Partial<Record<Signal['sourceType'], {
    totalPairs: number
    reviewedPairs: number
    current: PacketVariantAggregateV1
    proposed: PacketVariantAggregateV1
  }>>
}

export function prepareBlindPacketEvaluation(input: {
  datasetId: string
  blindingSeed: string
  pairs: ResearchPacketPairV1[]
}): { assignments: BlindPacketAssignmentV1[]; manifest: BlindPacketManifestV1 } {
  const datasetId = requiredText(input.datasetId, 'datasetId')
  const seed = requiredText(input.blindingSeed, 'blindingSeed')
  if (input.pairs.length === 0) throw new Error('pairs must not be empty')
  const pairIds = new Set<string>()
  const assignmentIds = new Set<string>()
  const entries: BlindPacketManifestEntryV1[] = []
  const assignments: BlindPacketAssignmentV1[] = []
  for (const value of input.pairs) {
    const pair = validatePair(value)
    if (pairIds.has(pair.pairId)) throw new Error(`Duplicate pairId: ${pair.pairId}`)
    pairIds.add(pair.pairId)
    const assignmentId = digest(`${datasetId}\0${seed}\0${pair.pairId}`)
    if (assignmentIds.has(assignmentId)) throw new Error('Blind assignment collision')
    assignmentIds.add(assignmentId)
    const currentVariant: BlindVariant = Number.parseInt(
      digest(`${seed}\0${pair.pairId}\0placement`).slice(0, 2), 16,
    ) % 2 === 0 ? 'A' : 'B'
    const currentView = blindView(pair.currentPacket)
    const proposedView = blindView(pair.proposedPacket)
    const variants: BlindPacketAssignmentV1['variants'] = currentVariant === 'A'
      ? [{ variant: 'A', packet: currentView }, { variant: 'B', packet: proposedView }]
      : [{ variant: 'A', packet: proposedView }, { variant: 'B', packet: currentView }]
    const assignmentBody = {
      schemaVersion: BLIND_PACKET_ASSIGNMENT_SCHEMA_VERSION,
      assignmentId,
      blindingProtocolVersion: 'myboon.packet_blinding.v1',
      sourceType: pair.currentPacket.sourceType,
      researchDepth: pair.researchDepth,
      variants: Object.freeze(variants),
    } as const
    const assignmentContentSha256 = digest(canonicalJson(assignmentBody))
    assignments.push(Object.freeze({ ...assignmentBody, assignmentContentSha256 }))
    entries.push({
      pairId: pair.pairId,
      assignmentId,
      sourceType: pair.currentPacket.sourceType,
      researchDepth: pair.researchDepth,
      currentVariant,
      assignmentContentSha256,
      currentPacket: pair.currentPacket,
      proposedPacket: pair.proposedPacket,
    })
  }
  return {
    assignments,
    manifest: {
      schemaVersion: BLIND_PACKET_MANIFEST_SCHEMA_VERSION,
      datasetId,
      blindingProtocolVersion: 'myboon.packet_blinding.v1',
      blindingSeedSha256: digest(seed),
      entries,
    },
  }
}

export function evaluateBlindPacketComparison(input: {
  manifest: BlindPacketManifestV1
  reviews: BlindPacketScoreV1[]
}): PacketComparisonReportV1 {
  const manifest = validateManifest(input.manifest)
  const reviews = input.reviews.map(validateScore)
  const entries = new Map(manifest.entries.map((entry) => [entry.assignmentId, entry]))
  const reviewIds = new Set<string>()
  const reviewedAssignments = new Set<string>()
  const joined: JoinedReview[] = []
  for (const review of reviews) {
    if (reviewIds.has(review.reviewId)) throw new Error(`Duplicate reviewId: ${review.reviewId}`)
    reviewIds.add(review.reviewId)
    if (reviewedAssignments.has(review.assignmentId)) throw new Error(`Duplicate review for assignment: ${review.assignmentId}`)
    reviewedAssignments.add(review.assignmentId)
    const entry = entries.get(review.assignmentId)
    if (!entry) throw new Error(`Review references unknown assignment: ${review.assignmentId}`)
    if (review.assignmentContentSha256 !== entry.assignmentContentSha256) {
      throw new Error(`Review assignment content does not match manifest: ${review.assignmentId}`)
    }
    const proposedVariant: BlindVariant = entry.currentVariant === 'A' ? 'B' : 'A'
    joined.push({
      entry,
      currentScore: review.scores[entry.currentVariant],
      proposedScore: review.scores[proposedVariant],
      preference: review.preferredVariant === 'tie' ? 'tie'
        : review.preferredVariant === entry.currentVariant ? 'current' : 'proposed',
    })
  }
  const perSource: PacketComparisonReportV1['perSource'] = {}
  for (const sourceType of ['news', 'polymarket', 'market_calendar', 'x'] as const) {
    const sourceEntries = manifest.entries.filter((entry) => entry.sourceType === sourceType)
    if (sourceEntries.length === 0) continue
    const sourceReviews = joined.filter((row) => row.entry.sourceType === sourceType)
    perSource[sourceType] = {
      totalPairs: sourceEntries.length,
      reviewedPairs: sourceReviews.length,
      current: aggregate(sourceReviews, 'current'),
      proposed: aggregate(sourceReviews, 'proposed'),
    }
  }
  return {
    schemaVersion: PACKET_COMPARISON_REPORT_SCHEMA_VERSION,
    datasetId: manifest.datasetId,
    manifestSha256: digest(canonicalJson(manifest)),
    reviewsSha256: digest(canonicalJson(reviews)),
    totalPairs: manifest.entries.length,
    reviewedPairs: joined.length,
    reviewCoverageRate: manifest.entries.length === 0 ? 0 : joined.length / manifest.entries.length,
    current: aggregate(joined, 'current'),
    proposed: aggregate(joined, 'proposed'),
    preference: {
      currentWins: joined.filter((row) => row.preference === 'current').length,
      proposedWins: joined.filter((row) => row.preference === 'proposed').length,
      ties: joined.filter((row) => row.preference === 'tie').length,
    },
    perSource,
  }
}

interface JoinedReview {
  entry: BlindPacketManifestEntryV1
  currentScore: BlindVariantScoreV1
  proposedScore: BlindVariantScoreV1
  preference: 'current' | 'proposed' | 'tie'
}

function aggregate(rows: JoinedReview[], variant: 'current' | 'proposed'): PacketVariantAggregateV1 {
  const scores = rows.map((row) => variant === 'current' ? row.currentScore : row.proposedScore)
  const packets = rows.map((row) => variant === 'current' ? row.entry.currentPacket : row.entry.proposedPacket)
  const wallTimes = packets.map((packet) => packet.budgetUsed.wallTimeMs).sort((a, b) => a - b)
  return {
    reviewCount: rows.length,
    acceptableRate: rate(scores.map((score) => score.productAcceptable)),
    averageProductQualityScore: average(scores.map((score) => score.productQualityScore)),
    averageEvidenceQualityScore: average(scores.map((score) => score.evidenceQualityScore)),
    averageAttributionQualityScore: average(scores.map((score) => score.attributionQualityScore)),
    averageProviderCalls: average(packets.map((packet) => packet.budgetUsed.providerCalls)),
    averageInputTokens: average(packets.map((packet) => packet.budgetUsed.inputTokens)),
    averageOutputTokens: average(packets.map((packet) => packet.budgetUsed.outputTokens)),
    averageToolCalls: average(packets.map((packet) => packet.budgetUsed.toolCalls)),
    averageWallTimeMs: average(wallTimes),
    p95WallTimeMs: percentile(wallTimes, 0.95),
  }
}

function validatePair(value: ResearchPacketPairV1): ResearchPacketPairV1 {
  if (value.schemaVersion !== PACKET_PAIR_SCHEMA_VERSION) throw new Error('pair schemaVersion is invalid')
  const pairId = requiredText(value.pairId, 'pairId')
  if (value.researchDepth !== 'light' && value.researchDepth !== 'standard') {
    throw new Error('researchDepth must be light or standard')
  }
  const currentPacket = validateResearchPacket(value.currentPacket)
  const proposedPacket = validateResearchPacket(value.proposedPacket)
  if (currentPacket.signalId !== proposedPacket.signalId || currentPacket.sourceType !== proposedPacket.sourceType) {
    throw new Error(`Packet pair ${pairId} does not share signal identity`)
  }
  return { ...value, pairId, currentPacket, proposedPacket }
}

function validateManifest(value: BlindPacketManifestV1): BlindPacketManifestV1 {
  if (value.schemaVersion !== BLIND_PACKET_MANIFEST_SCHEMA_VERSION
    || value.blindingProtocolVersion !== 'myboon.packet_blinding.v1'
    || !/^[a-f0-9]{64}$/.test(value.blindingSeedSha256)) throw new Error('Blind packet manifest is invalid')
  requiredText(value.datasetId, 'manifest.datasetId')
  if (!Array.isArray(value.entries) || value.entries.length === 0) throw new Error('manifest.entries must not be empty')
  const pairIds = new Set<string>()
  const assignmentIds = new Set<string>()
  for (const entry of value.entries) {
    requiredText(entry.pairId, 'manifest.entry.pairId')
    if (!/^[a-f0-9]{64}$/.test(entry.assignmentId)) throw new Error('manifest assignmentId is invalid')
    if (!/^[a-f0-9]{64}$/.test(entry.assignmentContentSha256)) throw new Error('manifest assignment digest is invalid')
    if (entry.currentVariant !== 'A' && entry.currentVariant !== 'B') throw new Error('manifest currentVariant is invalid')
    const pair = validatePair({
      schemaVersion: PACKET_PAIR_SCHEMA_VERSION,
      pairId: entry.pairId,
      researchDepth: entry.researchDepth,
      currentPacket: entry.currentPacket,
      proposedPacket: entry.proposedPacket,
    })
    if (entry.sourceType !== pair.currentPacket.sourceType) throw new Error('manifest sourceType is invalid')
    const variants: BlindPacketAssignmentV1['variants'] = entry.currentVariant === 'A'
      ? [{ variant: 'A', packet: blindView(pair.currentPacket) }, { variant: 'B', packet: blindView(pair.proposedPacket) }]
      : [{ variant: 'A', packet: blindView(pair.proposedPacket) }, { variant: 'B', packet: blindView(pair.currentPacket) }]
    const expectedAssignmentDigest = digest(canonicalJson({
      schemaVersion: BLIND_PACKET_ASSIGNMENT_SCHEMA_VERSION,
      assignmentId: entry.assignmentId,
      blindingProtocolVersion: 'myboon.packet_blinding.v1',
      sourceType: entry.sourceType,
      researchDepth: entry.researchDepth,
      variants,
    }))
    if (expectedAssignmentDigest !== entry.assignmentContentSha256) {
      throw new Error('manifest assignment digest does not match packet content')
    }
    if (pairIds.has(entry.pairId) || assignmentIds.has(entry.assignmentId)) throw new Error('manifest identities must be unique')
    pairIds.add(entry.pairId)
    assignmentIds.add(entry.assignmentId)
  }
  return value
}

function validateScore(value: BlindPacketScoreV1): BlindPacketScoreV1 {
  if (value.schemaVersion !== BLIND_PACKET_SCORE_SCHEMA_VERSION
    || value.blindingProtocolVersion !== 'myboon.packet_blinding.v1'
    || value.providerModelUsageAndCostHidden !== true) throw new Error('Blind packet score protocol is invalid')
  requiredText(value.reviewId, 'review.reviewId')
  if (!/^[a-f0-9]{64}$/.test(value.assignmentId)) throw new Error('review.assignmentId is invalid')
  if (!/^[a-f0-9]{64}$/.test(value.assignmentContentSha256)) throw new Error('review.assignmentContentSha256 is invalid')
  if (!/^[a-f0-9]{64}$/.test(value.reviewerIdSha256)) throw new Error('review.reviewerIdSha256 is invalid')
  if (!Number.isFinite(Date.parse(value.reviewedAt))) throw new Error('review.reviewedAt is invalid')
  if (value.preferredVariant !== 'A' && value.preferredVariant !== 'B' && value.preferredVariant !== 'tie') {
    throw new Error('review.preferredVariant is invalid')
  }
  validateVariantScore(value.scores?.A, 'A')
  validateVariantScore(value.scores?.B, 'B')
  return value
}

function validateVariantScore(value: BlindVariantScoreV1, variant: BlindVariant): void {
  if (!value || typeof value !== 'object') throw new Error(`review.scores.${variant} is required`)
  for (const field of ['productQualityScore', 'evidenceQualityScore', 'attributionQualityScore'] as const) {
    if (!Number.isInteger(value[field]) || value[field] < 0 || value[field] > 4) {
      throw new Error(`review.scores.${variant}.${field} must be an integer from 0 to 4`)
    }
  }
  if (typeof value.productAcceptable !== 'boolean') throw new Error(`review.scores.${variant}.productAcceptable is invalid`)
}

function blindView(packet: ResearchPacketV1): BlindResearchPacketViewV1 {
  return Object.freeze({
    sourceType: packet.sourceType,
    observedAt: packet.observedAt,
    sourceSignal: packet.sourceSignal,
    claims: packet.claims,
    verifiedFacts: packet.verifiedFacts,
    unresolvedClaims: packet.unresolvedClaims,
    evidence: packet.evidence,
    entityHints: packet.entityHints,
    limitations: packet.limitations,
    openQuestions: packet.openQuestions,
    completion: packet.completion,
  })
}

function requiredText(value: string, name: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} is required`)
  return value.trim()
}

function digest(value: string): string { return createHash('sha256').update(value).digest('hex') }
function average(values: number[]): number | null {
  return values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0) / values.length
}
function rate(values: boolean[]): number | null {
  return values.length === 0 ? null : values.filter(Boolean).length / values.length
}
function percentile(sorted: number[], fraction: number): number | null {
  return sorted.length === 0 ? null : sorted[Math.ceil(sorted.length * fraction) - 1] ?? null
}
