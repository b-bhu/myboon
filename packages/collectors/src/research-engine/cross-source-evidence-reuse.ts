import { stableContractId } from '../signal-platform/adapters/identity'
import type { ResearchWorkItem, RetrievedEvidence, Signal } from '../signal-platform/contracts'
import { artifactRef, type ArtifactOwnerPort } from './artifact-repository'
import { withEvidenceReuseContext } from './evidence-reuse-policy'
import type { ResearchReusePolicy } from './research-result-reuse'
import type { ResearchV4StorePort } from './v4-store'

export function reusePlannedSourceEvidence(input: {
  owners: readonly (ArtifactOwnerPort & { listRecentEvidence(limit: number): RetrievedEvidence[] })[]
  consumer: ResearchV4StorePort & { artifactStoreId(): string }
  signal: Signal
  work: ResearchWorkItem
  urls: readonly string[]
  policy: ResearchReusePolicy
  maxBytesPerSource: number
  maxTotalBytes: number
  now: string
}): RetrievedEvidence[] {
  const reused = new Map<string, RetrievedEvidence>()
  const nowMs = Date.parse(input.now)
  for (const owner of input.owners) {
    for (const artifact of owner.listRecentEvidence(100)) {
      if (artifact.workId === input.work.workId || reused.has(artifact.requestedUrl)
        || !input.urls.includes(artifact.requestedUrl)) continue
      const capturedAt = Date.parse(artifact.retrievedAt)
      const state = input.work.retrievalPlan.evidenceReuseState as {
        contentHashByRequestedUrl?: Record<string, string>, finalUrlByRequestedUrl?: Record<string, string>,
        blockedRequestedUrls?: string[], manuallyInvalidatedEvidenceIds?: string[],
      } | undefined
      if (!Number.isFinite(capturedAt) || capturedAt > nowMs
        || nowMs - capturedAt > input.policy.maxEvidenceAgeMs || artifact.truncated
        || !artifact.text.trim() || artifact.httpStatus < 200 || artifact.httpStatus >= 300
        || artifact.byteLength > input.maxBytesPerSource
        || [...reused.values()].reduce((sum, captured) => sum + captured.byteLength, 0) + artifact.byteLength > input.maxTotalBytes
        || state?.blockedRequestedUrls?.includes(artifact.requestedUrl)
        || state?.manuallyInvalidatedEvidenceIds?.includes(artifact.evidenceId)
        || (state?.contentHashByRequestedUrl?.[artifact.requestedUrl]
          && state.contentHashByRequestedUrl[artifact.requestedUrl] !== artifact.contentHash)
        || (state?.finalUrlByRequestedUrl?.[artifact.requestedUrl]
          && state.finalUrlByRequestedUrl[artifact.requestedUrl] !== artifact.finalUrl)) continue
      // Source reuse requires an admitted full-material contract. New signals
      // with no comparable material cannot inherit an older source capture.
      const producer = owner.getResearchWork(artifact.workId)
      const producerContract = producer?.retrievalPlan.researchReuseContract as { sourceMaterialDigest?: string, correctionSignature?: string } | undefined
      const consumerContract = input.work.retrievalPlan.researchReuseContract as { sourceMaterialDigest?: string, correctionSignature?: string } | undefined
      if (!consumerContract?.sourceMaterialDigest || !consumerContract.correctionSignature
        || producerContract?.sourceMaterialDigest !== consumerContract.sourceMaterialDigest
        || producerContract?.correctionSignature !== consumerContract.correctionSignature) continue
      const ref = artifactRef(owner.artifactStoreId(), owner.sourceType, artifact)
      const pin = owner.pinArtifact(ref, input.consumer.artifactStoreId(), input.work.workId, input.now)
      const resolved = owner.resolvePinnedArtifact(pin)
      if (!resolved) continue
      const evidenceId = stableContractId('reused_evidence', input.work.workId, ref.ownerStoreId, ref.artifactId, ref.digest)
      const approval = {
        policyVersion: input.policy.policyVersion, maxAgeMs: input.policy.maxEvidenceAgeMs,
        validatedAt: input.now, originalRetrievedAt: artifact.retrievedAt, ref, pinId: pin.pinId,
      }
      const copy = withEvidenceReuseContext({
        ...resolved, evidenceId, workId: input.work.workId, reuseApproval: approval,
        // retrievedAt remains the producer capture time; a reuse is not a fresh retrieval.
      }, { signal: input.signal, workItem: input.work })
      const existing = input.consumer.getResearchV4Record('evidence_reuse', input.work.workId, evidenceId)
      if (!existing) input.consumer.putResearchV4Record('evidence_reuse', input.work.workId, evidenceId, {
        evidenceId, ownerRef: ref, pinId: pin.pinId, decision: 'eligible_evidence',
        policyVersion: input.policy.policyVersion, capture: copy,
        limitations: ['Source capture reused within the configured freshness window; not fetched again.'],
      })
      const saved = input.consumer.getResearchV4Record<{ capture: RetrievedEvidence }>('evidence_reuse', input.work.workId, evidenceId)
      if (saved) reused.set(artifact.requestedUrl, saved.capture)
    }
  }
  return [...reused.values()]
}
