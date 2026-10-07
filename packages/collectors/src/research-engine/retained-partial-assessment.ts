import { stableContractId } from '../signal-platform/adapters/identity'
import { assessResearchReadiness, type ResearchReadiness } from '../signal-platform/research-readiness'
import type { CanonicalPlatformStore } from '../signal-platform/platform-store'
import type { ResearchV4StorePort } from './v4-store'

export interface RetainedPartialAssessment {
  assessmentId: string
  admissionId: string
  operatorId: string
  packetId: string
  workId: string
  assessedAt: string
  decision: ResearchReadiness
  /** A later explicit operator admission is required before any handoff. */
  disposition: 'retained_for_review'
}

/** Supplied packet IDs only. No historical scan, queue mutation, promotion, or paid call. */
export function assessRetainedPartialResearch(input: {
  store: CanonicalPlatformStore & ResearchV4StorePort
  packetIds: readonly string[]
  admissionId: string
  operatorId: string
  limit: number
  now: string
}): RetainedPartialAssessment[] {
  if (!input.admissionId.trim() || !input.operatorId.trim()
    || !Number.isInteger(input.limit) || input.limit < 1 || input.limit > 100
    || input.packetIds.length === 0 || input.packetIds.length > input.limit
    || new Set(input.packetIds).size !== input.packetIds.length
    || !Number.isFinite(Date.parse(input.now))) {
    throw new Error('Retained partial assessment requires an explicit operator admission and 1–100 unique packet IDs within its bound')
  }
  // Resolve every supplied dependency before writing the first assessment.
  const eligible = input.packetIds.map((packetId) => {
    const packet = input.store.getResearchPacket(packetId)
    if (!packet || packet.completion !== 'partial') throw new Error(`Packet ${packetId} is not a retained partial Research packet`)
    const work = input.store.getResearchWork(packet.workId)
    const signal = work && input.store.getSignal(work.signalId)
    if (!work || !signal) throw new Error(`Packet ${packetId} has unavailable retained work/source material`)
    if (input.store.getResearchReadinessByPacket(packetId)) throw new Error(`Packet ${packetId} already has an authoritative readiness decision`)
    return { packet, work, signal }
  })
  return eligible.map(({ packet, work, signal }) => {
    const assessmentId = stableContractId('retained_partial_assessment', input.admissionId, packet.packetId)
    const saved = input.store.getResearchV4Record<RetainedPartialAssessment>('retained_partial_assessment', work.workId, assessmentId)
    if (saved) return saved
    const decision = assessResearchReadiness({
      work, signal, packet, persistedEvidence: input.store.listEvidenceByWork(work.workId, 1_000),
      assessedAt: input.now, assessedBy: `operator_admitted:${input.operatorId}`,
    })
    return input.store.putResearchV4Record('retained_partial_assessment', work.workId, assessmentId, {
      assessmentId, admissionId: input.admissionId, operatorId: input.operatorId,
      packetId: packet.packetId, workId: work.workId, assessedAt: input.now,
      decision, disposition: 'retained_for_review' as const,
    })
  })
}
