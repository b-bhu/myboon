import { createHash } from 'node:crypto'
import { canonicalJson } from '../signal-platform/canonical-json'
import type { ResearchPacketV1 } from '../signal-platform/contracts'
import { validateResearchPacket } from '../signal-platform/validation'
import type { ProgressionSourcePacketReadPort, SavedProgressionSourcePacket } from './progression-processor'

/** Digest the complete validated packet, not only the references used by a plan. */
export function progressionSourcePacketDigest(packet: unknown): string {
  const validated = validateResearchPacket(packet)
  return createHash('sha256').update(canonicalJson(validated)).digest('hex')
}

/**
 * Code-owned bridge from the saved Research packet store to the progression
 * validator. It rejects a changed/mis-linked packet and derives allowable
 * evidence tuples only from claim-to-evidence edges persisted in that packet.
 */
export class ProgressionSourcePacketEvidenceReader {
  constructor(private readonly packets: ProgressionSourcePacketReadPort) {}

  async loadSavedPacket(input: {
    workId: string
    packetDigest: string
  }): Promise<SavedProgressionSourcePacket | null> {
    if (!input.workId.trim() || !/^[0-9a-f]{64}$/.test(input.packetDigest)) return null
    const raw = await this.packets.readResearchPacket(input.workId)
    if (raw === null) return null

    let packet: ResearchPacketV1
    try {
      packet = validateResearchPacket(raw)
      if (packet.workId !== input.workId || progressionSourcePacketDigest(packet) !== input.packetDigest) return null
    } catch {
      return null
    }

    const sourceByEvidenceId = new Map<string, string>()
    for (const evidence of packet.evidence) {
      if (sourceByEvidenceId.has(evidence.evidenceId)) return null
      sourceByEvidenceId.set(evidence.evidenceId, evidence.url)
    }

    const seenClaimIds = new Set<string>()
    const evidenceRefs: SavedProgressionSourcePacket['evidenceRefs'][number][] = []
    const seenReferences = new Set<string>()
    for (const claim of packet.claims) {
      if (seenClaimIds.has(claim.claimId)) return null
      seenClaimIds.add(claim.claimId)
      for (const evidenceId of claim.evidenceRefs) {
        const sourceRef = sourceByEvidenceId.get(evidenceId)
        if (sourceRef === undefined) return null
        const key = `${claim.claimId}\u0000${evidenceId}`
        if (seenReferences.has(key)) return null
        seenReferences.add(key)
        evidenceRefs.push({ claimId: claim.claimId, evidenceId, sourceRef })
      }
    }

    return Object.freeze({
      workId: packet.workId,
      packetDigest: input.packetDigest,
      evidenceRefs: Object.freeze(evidenceRefs.map((reference) => Object.freeze(reference))),
    })
  }
}
