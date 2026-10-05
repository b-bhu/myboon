import { createHash } from 'node:crypto'
import { canonicalJson } from '../signal-platform/canonical-json'
import { stableContractId } from '../signal-platform/adapters/identity'
import { isArticleResearchPacket, type ResearchPacket, type ResearchPacketV1, type ResearchWorkItem, type RetrievedEvidence, type Signal } from '../signal-platform/contracts'
import { validateLegacyResearchPacket } from '../signal-platform/validation'
import { deterministicPacketId } from './structured-synthesizer'
import type { ResearchV4StorePort } from './v4-store'

export interface ResearchReusePolicy {
  policyVersion: string
  maxEvidenceAgeMs: number
  maxResearchAgeMs: number
}

/** Admission owns the meaning of the assignment, not a headline similarity heuristic. */
export interface ResearchReuseContract {
  question: string
  scope: string
  applicability: string
  correctionSignature: string
  /** Digest of relevant full source material, independently of collector lane. */
  sourceMaterialDigest: string
}

export interface ResearchResultOwnerPort {
  artifactStoreId(): string
  getResearchWork(workId: string): ResearchWorkItem | null
  getResearchPacket(packetId: string): ResearchPacket | null
  listEvidenceByWork(workId: string, limit: number): RetrievedEvidence[]
  listRecentResearchPackets(limit: number): ResearchPacket[]
}

export function researchReuseContract(work: ResearchWorkItem): ResearchReuseContract | null {
  return parseReuseContract(work.retrievalPlan.researchReuseContract)
}

function parseReuseContract(value: unknown): ResearchReuseContract | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const object = value as Record<string, unknown>
  const keys = ['question', 'scope', 'applicability', 'correctionSignature', 'sourceMaterialDigest'] as const
  if (!keys.every((key) => typeof object[key] === 'string' && (object[key] as string).trim().length > 0)) return null
  return Object.fromEntries(keys.map((key) => [key, object[key]])) as unknown as ResearchReuseContract
}

/** The deterministic synthesis task is a known contract, rather than an inferred headline question. */
export function structuredAssignmentReuseContract(input: {
  work: ResearchWorkItem, signal: Signal, evidence: readonly RetrievedEvidence[],
  promptVersion: string, knowledgeDigest: string | null,
}): ResearchReuseContract | null {
  const admitted = researchReuseContract(input.work)
  if (admitted) return admitted
  if (input.knowledgeDigest === null) return null
  return {
    question: `research.structured-synthesis:${input.work.researchContractVersion}:${input.promptVersion}`,
    scope: canonicalJson({ depth: input.work.researchDepth, sourceUrls: input.evidence.map((item) => item.requestedUrl).sort(),
      allowedDomains: [...input.work.retrievalPlan.allowedDomains].sort() }),
    applicability: canonicalJson({ entities: [...input.signal.sourceHints.entities].sort(), assets: [...input.signal.sourceHints.assets].sort(),
      eventId: input.signal.sourceHints.eventId ?? null }),
    correctionSignature: input.knowledgeDigest,
    sourceMaterialDigest: createHash('sha256').update(canonicalJson({ title: input.signal.title,
      visibleSummary: input.signal.visibleSummary, content: input.signal.content, media: input.signal.media,
      evidence: materialEvidenceDigest(input.evidence) })).digest('hex'),
  }
}

export function materialEvidenceDigest(evidence: readonly RetrievedEvidence[]): string {
  return createHash('sha256').update(canonicalJson(evidence.map((artifact) => ({
    requestedUrl: artifact.requestedUrl, finalUrl: artifact.finalUrl,
    contentHash: artifact.contentHash, authority: artifact.authority, truncated: artifact.truncated,
  })).sort((a, b) => canonicalJson(a).localeCompare(canonicalJson(b))))).digest('hex')
}

export function reuseCompatibleResearchResult(input: {
  owners: readonly ResearchResultOwnerPort[]
  consumer: ResearchV4StorePort
  signal: Signal
  work: ResearchWorkItem
  evidence: readonly RetrievedEvidence[]
  policy: ResearchReusePolicy
  now: string
  currentKnowledgeDigest: string | null
  assignmentContract: ResearchReuseContract | null
}): ResearchPacketV1 | null {
  const contract = input.assignmentContract
  if (!contract || input.currentKnowledgeDigest === null) return null
  const nowMs = Date.parse(input.now)
  const evidenceDigest = materialEvidenceDigest(input.evidence)
  for (const owner of input.owners) {
    for (const packet of owner.listRecentResearchPackets(20)) {
      // Article packets have their own placement and novelty decisions. The
      // legacy reuse contract translates only claim/evidence references.
      if (isArticleResearchPacket(packet)) continue
      if (packet.workId === input.work.workId) continue
      const producer = owner.getResearchWork(packet.workId)
      const snapshot = packet.reuseSnapshot as { knowledgeDigest?: unknown, policyVersion?: unknown, assignmentContract?: unknown } | undefined
      const producerContract = producer && (researchReuseContract(producer) ?? parseReuseContract(snapshot?.assignmentContract))
      const reason = !producer || !producerContract ? 'missing_assignment_contract'
        : canonicalJson(contract) !== canonicalJson(producerContract) ? 'incompatible_question_scope_applicability_or_correction'
          : producer.policyVersion !== input.work.policyVersion
            || producer.researchContractVersion !== input.work.researchContractVersion
            || producer.researchDepth !== input.work.researchDepth ? 'incompatible_research_policy'
            : !Number.isFinite(Date.parse(packet.createdAt)) || Date.parse(packet.createdAt) > nowMs
              || nowMs - Date.parse(packet.createdAt) > input.policy.maxResearchAgeMs ? 'research_expired'
              : packet.completion === 'failed' ? 'failed_research'
                : packet.knownObservationResolution ? 'no_item_observation_requires_current_comparison'
                : null
      let rejected = reason
      const producerEvidence = owner.listEvidenceByWork(packet.workId, 1_000)
      if (!rejected && materialEvidenceDigest(producerEvidence) !== evidenceDigest) rejected = 'material_evidence_changed'
      if (!rejected && producerEvidence.some((artifact) => artifact.truncated || !Number.isFinite(Date.parse(artifact.retrievedAt))
        || nowMs - Date.parse(artifact.retrievedAt) > input.policy.maxEvidenceAgeMs
        || Date.parse(artifact.retrievedAt) > nowMs)) rejected = 'evidence_unavailable_or_expired'
      if (!rejected && (snapshot?.policyVersion !== input.policy.policyVersion
        || snapshot.knowledgeDigest !== input.currentKnowledgeDigest)) rejected = 'knowledge_or_correction_context_changed'
      // Validate all reference translations before recording an accepted reuse.
      const refs = new Map(producerEvidence.map((artifact) => [artifact.evidenceId,
        input.evidence.find((current) => current.requestedUrl === artifact.requestedUrl
          && current.finalUrl === artifact.finalUrl && current.contentHash === artifact.contentHash)?.evidenceId]))
      const translate = (ids: string[]) => ids.map((id) => refs.get(id)).filter((id): id is string => Boolean(id))
      if (!rejected && ([...packet.claims, ...packet.verifiedFacts, ...packet.unresolvedClaims, ...packet.entityHints]
        .some((item) => translate(item.evidenceRefs).length !== item.evidenceRefs.length)
        || packet.evidence.some((ref) => !refs.get(ref.evidenceId)))) rejected = 'unavailable_referenced_capture'
      const recordId = stableContractId('research_reuse', input.work.workId, owner.artifactStoreId(), packet.packetId, input.policy.policyVersion)
      const previous = input.consumer.getResearchV4Record('research_reuse', input.work.workId, recordId)
      if (!previous) input.consumer.putResearchV4Record('research_reuse', input.work.workId, recordId, {
        recordId, ownerStoreId: owner.artifactStoreId(), ownerPacketId: packet.packetId,
        ownerPacketDigest: createHash('sha256').update(canonicalJson(packet)).digest('hex'),
        materialEvidenceDigest: evidenceDigest, policyVersion: input.policy.policyVersion,
        assignmentContract: contract, knowledgeDigest: input.currentKnowledgeDigest,
        decision: rejected ? 'rejected' : 'reuse_result', reason: rejected ?? 'compatible_saved_research',
        limitations: [...packet.limitations], decidedAt: input.now,
      })
      if (rejected) continue
      // Every referenced producer artifact must map to exact current captured bytes.
      const packetId = deterministicPacketId(input.work.workId, input.work.researchContractVersion)
      const claimMap = new Map(packet.claims.map((claim, index) => [claim.claimId,
        stableContractId('research_claim', packetId, String(index), claim.claim)]))
      return validateLegacyResearchPacket({
        ...packet, packetId, workId: input.work.workId, signalId: input.signal.signalId,
        sourceType: input.signal.sourceType, observedAt: input.signal.observedAt,
        sourceSignal: { ...input.signal, provenance: { ...input.signal.provenance } },
        claims: packet.claims.map((claim) => ({ ...claim, claimId: claimMap.get(claim.claimId)!, evidenceRefs: translate(claim.evidenceRefs) })),
        verifiedFacts: packet.verifiedFacts.map((fact) => ({ ...fact, evidenceRefs: translate(fact.evidenceRefs) })),
        unresolvedClaims: packet.unresolvedClaims.map((claim) => ({ ...claim, evidenceRefs: translate(claim.evidenceRefs) })),
        entityHints: packet.entityHints.map((hint) => ({ ...hint, evidenceRefs: translate(hint.evidenceRefs),
          claimRefs: hint.claimRefs.map((id) => claimMap.get(id)).filter((id): id is string => Boolean(id)) })),
        evidence: packet.evidence.map((ref) => ({ ...ref, evidenceId: refs.get(ref.evidenceId)! })),
        limitations: [...packet.limitations, 'Reused compatible saved research; original attribution, uncertainty and completion are preserved.'],
        budgetUsed: { providerCalls: 0, repairCalls: 0, inputTokens: 0, outputTokens: 0, toolCalls: 0, wallTimeMs: 0,
          budgetExceeded: false, costUsdMicros: 0 },
        execution: { ...packet.execution, traceId: input.work.traceId, attempt: input.work.attemptCount,
          reusedResult: { ownerStoreId: owner.artifactStoreId(), packetId: packet.packetId, recordId } },
        createdAt: input.now,
      })
    }
  }
  return null
}
