import { createHash } from 'node:crypto'
import { canonicalJson } from '../signal-platform/canonical-json'
import { RESEARCH_PACKET_SCHEMA_VERSION, type ResearchPacketV1, type ResearchWorkItem,
  type RetrievedEvidence, type Signal } from '../signal-platform/contracts'
import { validateLegacyResearchPacket } from '../signal-platform/validation'
import type { EntityMemoryReader, GateDecision, GateSignal } from '../research-gate/types'
import type { ResearchV4StorePort } from './v4-store'
import { deterministicPacketId } from './structured-synthesizer'
import { sourceMaterialHash } from './evidence-reuse-policy'
import type { ClassificationResult } from '../inference-gateway'
import { buildNoveltyLookup } from '../research-gate/gate'

export interface KnownObservationResolution {
  policyVersion: string
  packetId: string
  sourceMaterialDigest: string
  capturedEvidenceDigest: string
  comparisonDigest: string
  contextDigest: string
  consultedItemRefs: string[]
  decisionDigest: string
  assessedAt: string
  owedAction: 'none'
}

const digest = (value: unknown) => createHash('sha256').update(canonicalJson(value)).digest('hex')
export const capturedObservationDigest = (evidence: readonly RetrievedEvidence[]) => digest(evidence)

export function completeKnownComparison(decision: GateDecision, sourceComplete: boolean): boolean {
  const lookup = decision.noveltyContext
  return sourceComplete && decision.verdict === 'already_known' && !decision.proceed
    && Boolean(decision.entityContext?.entities.length && decision.entityContext.recentMemories.length)
    && Boolean(lookup?.resolvedCandidateRefs.length && lookup.itemRefs.length)
    && lookup?.evidenceRan === true && !lookup.truncated && !lookup.unrelated && lookup.lookupFailures.length === 0
}

/** Retain a covered observation without authoring any new factual claim. */
export async function resolveKnownObservation(input: {
  store: ResearchV4StorePort; work: ResearchWorkItem; signal: Signal; evidence: readonly RetrievedEvidence[]
  gateSignal: GateSignal; decision: GateDecision; reader: EntityMemoryReader; policyVersion: string
  stillOwnsLease(): Promise<boolean>; now(): string
}): Promise<ResearchPacketV1 | null> {
  const { store, work, signal, decision } = input
  if (!completeKnownComparison(decision, input.gateSignal.sourceMaterialComplete === true)
    || !input.reader.noveltyEvidence || !input.evidence.length || input.evidence.some((artifact) => artifact.truncated)
    || work.retrievalPlan.requiredEntityAction || work.retrievalPlan.owedAttachment) return null
  const savedDecision = store.getResearchV4Record<GateDecision & { sourceMaterialDigest?: string, capturedEvidenceDigest?: string }>(
    'novelty', work.workId, 'decision')
  if (!savedDecision || digest(savedDecision) !== digest(decision)
    || savedDecision.sourceMaterialDigest !== sourceMaterialHash(signal)
    || savedDecision.capturedEvidenceDigest !== capturedObservationDigest(input.evidence)) return null
  // Saved semantic decisions are never assumed fresh after a restart. Re-read
  // the existing bounded internal port and compare the exact consulted context.
  try {
    const ids = await input.reader.entityIdsForSourceRef(input.gateSignal.source, input.gateSignal.sourceRefId)
    const [entities, recentMemories] = await Promise.all([
      input.reader.entitiesByIds(ids), input.reader.recentMemories(ids, 12),
    ])
    const evidence = await buildNoveltyLookup(input.reader, input.gateSignal, ids, { entities, recentMemories }, 12)
    if (!entities.length || !recentMemories.length || recentMemories.length >= 12
      || evidence.truncated || evidence.unrelated || evidence.lookupFailures.length || !evidence.itemRefs.length
      || evidence.digest !== decision.noveltyContext!.digest
      || digest({ entities, recentMemories }) !== digest(decision.entityContext)
      || digest([...evidence.itemRefs].sort()) !== digest([...decision.noveltyContext!.itemRefs].sort())) return null
  } catch { return null }
  if (!await input.stillOwnsLease()) return null
  const packetId = deterministicPacketId(work.workId, work.researchContractVersion)
  const resolution: KnownObservationResolution = {
    policyVersion: input.policyVersion, packetId, sourceMaterialDigest: sourceMaterialHash(signal),
    capturedEvidenceDigest: capturedObservationDigest(input.evidence), comparisonDigest: decision.noveltyContext!.digest,
    contextDigest: digest(decision.entityContext), consultedItemRefs: [...decision.noveltyContext!.itemRefs],
    decisionDigest: digest(decision), assessedAt: input.now(), owedAction: 'none',
  }
  const existing = store.getResearchV4Record<KnownObservationResolution>('novelty', work.workId, 'no_item_resolution')
  if (existing && canonicalJson({ ...existing, assessedAt: null }) !== canonicalJson({ ...resolution, assessedAt: null })) return null
  const proof = existing ?? store.putResearchV4Record('novelty', work.workId, 'no_item_resolution', resolution)
  const classifiers = store.listResearchV4Records<ClassificationResult<unknown>>('classification_result', work.workId, 100)
  return validateLegacyResearchPacket({
    schemaVersion: RESEARCH_PACKET_SCHEMA_VERSION, packetId, workId: work.workId, signalId: signal.signalId,
    sourceType: signal.sourceType, sourceSignal: { title: signal.title, canonicalUrl: signal.canonicalUrl,
      publishedAt: signal.publishedAt, provenance: signal.provenance }, observedAt: signal.observedAt,
    claims: [], verifiedFacts: [], unresolvedClaims: [], entityHints: [],
    evidence: input.evidence.map((artifact) => ({ evidenceId: artifact.evidenceId, title: signal.title,
      url: artifact.finalUrl, sourceType: artifact.authority, observedAt: artifact.retrievedAt, note: null })),
    limitations: ['Observation retained after a complete bounded novelty comparison; no new factual claims were manufactured.',
      'Knowledge context was verified at the recorded assessment time; no cross-store transaction or timeless coverage is implied.'],
    openQuestions: [], completion: 'complete',
    budgetUsed: { providerCalls: classifiers.length, repairCalls: 0,
      inputTokens: classifiers.reduce((sum, result) => sum + result.usage.inputTokens, 0),
      outputTokens: classifiers.reduce((sum, result) => sum + result.usage.outputTokens, 0), toolCalls: 0,
      wallTimeMs: classifiers.reduce((sum, result) => sum + result.durationMs, 0), budgetExceeded: false,
      costUsdMicros: classifiers.length ? null : 0 },
    execution: { provider: 'code', model: 'none', fallbackUsed: false, fallbackProvider: null, fallbackModel: null,
      promptVersion: 'research.known-observation.v1', policyVersion: work.policyVersion, traceId: work.traceId,
      attempt: work.attemptCount, synthesisSkipped: true }, researchContractVersion: work.researchContractVersion,
    knownObservationResolution: proof, createdAt: proof.assessedAt,
  })
}

/** Validate immutable proof against persisted source/evidence inside handoff. */
export function assertKnownObservationResolution(input: {
  store: ResearchV4StorePort; packet: ResearchPacketV1; signal: Signal; work: ResearchWorkItem; evidence: readonly RetrievedEvidence[]
}): boolean {
  const marker = input.packet.knownObservationResolution
  if (!marker) return false
  const proof = input.store.getResearchV4Record<KnownObservationResolution>('novelty', input.work.workId, 'no_item_resolution')
  const decision = input.store.getResearchV4Record<GateDecision>('novelty', input.work.workId, 'decision')
  if (!proof || !decision || canonicalJson(marker) !== canonicalJson(proof) || proof.packetId !== input.packet.packetId
    || proof.sourceMaterialDigest !== sourceMaterialHash(input.signal)
    || proof.capturedEvidenceDigest !== capturedObservationDigest(input.evidence)
    || proof.decisionDigest !== digest(decision) || proof.comparisonDigest !== decision.noveltyContext?.digest
    || proof.contextDigest !== digest(decision.entityContext) || !completeKnownComparison(decision, true)
    || proof.owedAction !== 'none' || input.work.retrievalPlan.requiredEntityAction || input.work.retrievalPlan.owedAttachment
    || input.packet.requiredEntityAction || input.packet.claims.length || input.packet.verifiedFacts.length
    || input.packet.unresolvedClaims.length || input.packet.entityHints.length) {
    throw new Error('Known observation resolution does not match the persisted complete comparison and captured source')
  }
  return true
}
