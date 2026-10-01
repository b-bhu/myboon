import { createHash } from 'node:crypto'
import { stableContractId } from '../signal-platform/adapters/identity'
import { canonicalJson } from '../signal-platform/canonical-json'
import type { ResearchWorkItem, RetrievedEvidence, Signal } from '../signal-platform/contracts'

export const ARTIFACT_USAGE_SCHEMA_VERSION = 'myboon.artifact_usage.v1' as const
export const ARTIFACT_ELIGIBILITY_POLICY_VERSION = 'myboon.artifact_eligibility.v1' as const

/** Identifies immutable bytes in the producer's store, independent of a consumer job. */
export interface ArtifactRef {
  ownerStoreId: string
  ownerSourceType: Signal['sourceType']
  artifactId: string
  captureVersion: string
  digest: string
}

export interface ArtifactPin {
  pinId: string
  ref: ArtifactRef
  consumerStoreId: string
  consumerWorkId: string
  pinnedAt: string
}

export type ArtifactEligibilityDecision = 'background_only' | 'rejected'
export type ArtifactEligibilityReason =
  | 'relevant_context'
  | 'unrelated'
  | 'invalid_window'
  | 'source_unavailable'

/** The consumer's durable record of what it decided about a producer capture. */
export interface ArtifactUsage {
  schemaVersion: typeof ARTIFACT_USAGE_SCHEMA_VERSION
  usageId: string
  consumerStoreId: string
  consumerWorkId: string
  consumerSourceType: Signal['sourceType']
  ref: ArtifactRef
  pinId: string | null
  decision: ArtifactEligibilityDecision
  reason: ArtifactEligibilityReason
  eligibilityPolicyVersion: typeof ARTIFACT_ELIGIBILITY_POLICY_VERSION
  decidedAt: string
}

export interface ArtifactOwnerPort {
  readonly sourceType: Signal['sourceType']
  artifactStoreId(): string
  getEvidence(evidenceId: string): RetrievedEvidence | null
  getResearchWork(workId: string): ResearchWorkItem | null
  getSignal(signalId: string): Signal | null
  pinArtifact(ref: ArtifactRef, consumerStoreId: string, consumerWorkId: string, now: string): ArtifactPin
  getArtifactPin(pinId: string): ArtifactPin | null
  resolvePinnedArtifact(pin: ArtifactPin): RetrievedEvidence | null
}

export interface ArtifactConsumerPort {
  readonly sourceType: Signal['sourceType']
  artifactStoreId(): string
  getResearchWork(workId: string): ResearchWorkItem | null
  getSignal(signalId: string): Signal | null
  recordArtifactUsage(usage: ArtifactUsage, pin: ArtifactPin | null): ArtifactUsage
}

export function artifactRef(ownerStoreId: string, ownerSourceType: Signal['sourceType'], artifact: RetrievedEvidence): ArtifactRef {
  if (!ownerStoreId.trim()) throw new Error('Artifact owner store ID is required')
  return {
    ownerStoreId,
    ownerSourceType,
    artifactId: artifact.evidenceId,
    captureVersion: artifact.retrievedAt,
    digest: createHash('sha256').update(canonicalJson(artifact)).digest('hex'),
  }
}

export function artifactPinId(ref: ArtifactRef, consumerStoreId: string, consumerWorkId: string): string {
  return stableContractId('artifact_pin', ref.ownerStoreId, ref.artifactId, ref.captureVersion,
    ref.digest, consumerStoreId, consumerWorkId)
}

export function artifactUsageId(ref: ArtifactRef, consumerStoreId: string, consumerWorkId: string): string {
  return stableContractId('artifact_usage', consumerStoreId, consumerWorkId, ref.ownerStoreId, ref.artifactId,
    ref.captureVersion, ref.digest, ARTIFACT_ELIGIBILITY_POLICY_VERSION)
}

export function artifactRefMatchesArtifact(ref: ArtifactRef, artifact: RetrievedEvidence): boolean {
  return ref.artifactId === artifact.evidenceId
    && ref.captureVersion === artifact.retrievedAt
    && ref.digest === artifactRef(ref.ownerStoreId, ref.ownerSourceType, artifact).digest
}

/**
 * Cross-job evidence is context only. It cannot stand in for a fresh retrieval
 * or a completed Research conclusion. Relevance is based on exact source hints
 * and remains explicitly recorded; no unapproved age threshold is invented.
 */
export function assessArtifactEligibility(input: {
  producerSignal: Signal
  producerWork: ResearchWorkItem
  artifact: RetrievedEvidence
  consumerSignal: Signal
  consumerWork: ResearchWorkItem
  now: string
}): { decision: ArtifactEligibilityDecision; reason: ArtifactEligibilityReason } {
  const { producerSignal, producerWork, artifact, consumerSignal, consumerWork } = input
  const now = Date.parse(input.now)
  const capturedAt = Date.parse(artifact.retrievedAt)
  const deadline = Date.parse(consumerWork.freshnessDeadline)
  if (![now, capturedAt, deadline].every(Number.isFinite) || capturedAt > now || now > deadline
    || producerWork.workId === consumerWork.workId || artifact.workId !== producerWork.workId
    || producerWork.signalId !== producerSignal.signalId || consumerWork.signalId !== consumerSignal.signalId) {
    return { decision: 'rejected', reason: 'invalid_window' }
  }
  if (artifact.truncated || artifact.httpStatus < 200 || artifact.httpStatus >= 300 || !artifact.text.trim()) {
    return { decision: 'rejected', reason: 'source_unavailable' }
  }
  const producerHints = identityHints(producerSignal)
  const consumerHints = identityHints(consumerSignal)
  if (![...producerHints].some((hint) => consumerHints.has(hint))) {
    return { decision: 'rejected', reason: 'unrelated' }
  }
  return { decision: 'background_only', reason: 'relevant_context' }
}

/**
 * The producer acknowledges retention before the consumer records a usable
 * link. An orphan pin is safe after a consumer write failure; at read time the
 * owner must still resolve the pin and the exact digest.
 */
export function linkArtifact(input: {
  owner: ArtifactOwnerPort
  consumer: ArtifactConsumerPort
  artifactId: string
  consumerWorkId: string
  now: string
}): ArtifactUsage {
  const { owner, consumer } = input
  if (owner.sourceType === consumer.sourceType) throw new Error('Cross-source artifact link requires distinct source stores')
  if (owner.artifactStoreId() === consumer.artifactStoreId()) throw new Error('Producer and consumer store identities must differ')
  const consumerWork = consumer.getResearchWork(input.consumerWorkId)
  if (!consumerWork || consumerWork.sourceType !== consumer.sourceType) throw new Error('Consumer work is unavailable')
  const consumerSignal = consumer.getSignal(consumerWork.signalId)
  if (!consumerSignal) throw new Error('Consumer signal is unavailable')
  const artifact = owner.getEvidence(input.artifactId)
  if (!artifact) throw new Error('Producer artifact is unavailable')
  const producerWork = owner.getResearchWork(artifact.workId)
  const producerSignal = producerWork ? owner.getSignal(producerWork.signalId) : null
  if (!producerWork || !producerSignal || producerWork.sourceType !== owner.sourceType) {
    throw new Error('Producer work or signal is unavailable')
  }
  const ref = artifactRef(owner.artifactStoreId(), owner.sourceType, artifact)
  const assessment = assessArtifactEligibility({
    producerSignal, producerWork, artifact, consumerSignal, consumerWork, now: input.now,
  })
  const pin = assessment.decision === 'background_only'
    ? owner.pinArtifact(ref, consumer.artifactStoreId(), consumerWork.workId, input.now)
    : null
  const usage: ArtifactUsage = {
    schemaVersion: ARTIFACT_USAGE_SCHEMA_VERSION,
    usageId: artifactUsageId(ref, consumer.artifactStoreId(), consumerWork.workId),
    consumerStoreId: consumer.artifactStoreId(),
    consumerWorkId: consumerWork.workId,
    consumerSourceType: consumer.sourceType,
    ref,
    pinId: pin?.pinId ?? null,
    decision: assessment.decision,
    reason: assessment.reason,
    eligibilityPolicyVersion: ARTIFACT_ELIGIBILITY_POLICY_VERSION,
    decidedAt: input.now,
  }
  return consumer.recordArtifactUsage(usage, pin)
}

/** Recheck the owner on every use; a saved consumer reference alone is insufficient. */
export function resolveArtifactUsage(owner: ArtifactOwnerPort, usage: ArtifactUsage): RetrievedEvidence | null {
  if (usage.decision !== 'background_only' || usage.pinId === null
    || usage.ref.ownerStoreId !== owner.artifactStoreId()
    || usage.ref.ownerSourceType !== owner.sourceType) return null
  const pin = owner.getArtifactPin(usage.pinId)
  if (!pin || pin.consumerStoreId !== usage.consumerStoreId
    || pin.consumerWorkId !== usage.consumerWorkId
    || canonicalJson(pin.ref) !== canonicalJson(usage.ref)) return null
  return owner.resolvePinnedArtifact(pin)
}

function identityHints(signal: Signal): Set<string> {
  const hints = [
    ...signal.sourceHints.entities.map((entity) => `entity:${entity}`),
    ...signal.sourceHints.assets.map((asset) => `asset:${asset}`),
    ...(signal.sourceHints.eventId ? [`event:${signal.sourceHints.eventId}`] : []),
  ]
  return new Set(hints.map((hint) => hint.trim().toLowerCase()).filter((hint) => !hint.endsWith(':')))
}
