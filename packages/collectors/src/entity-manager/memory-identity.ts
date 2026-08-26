import { createHash } from 'node:crypto'
import type { ResearchPacketV1 } from '../signal-platform/contracts'
import type { EntityKnowledgeMemoryType } from './entity-knowledge-reader'

export const MEMORY_IDENTITY_VERSION = 'myboon.memory_identity.v1' as const

const MEMORY_TYPES = new Set<EntityKnowledgeMemoryType>([
  'research_note',
  'market_signal',
  'news_event',
  'social_signal',
  'timeline_event',
  'metric_change',
])

export interface MemoryIdentityPacketRef {
  packetId: ResearchPacketV1['packetId']
  workId: ResearchPacketV1['workId']
  researchContractVersion: ResearchPacketV1['researchContractVersion'] | string
}

export interface MemoryIdentityInput {
  packet: MemoryIdentityPacketRef
  canonicalEntityId: string
  memoryType: EntityKnowledgeMemoryType
  memoryRole: string
  representedClaimIds?: readonly string[]
  representedEvidenceIds?: readonly string[]
}

/**
 * Derives an opaque replay-stable key. Generated title, summary, and body are
 * intentionally absent from the canonical hash payload.
 */
export function deriveMemoryIdentityKey(input: MemoryIdentityInput): string {
  const representedClaimIds = sortedIds(input.representedClaimIds ?? [], 'representedClaimIds')
  const representedEvidenceIds = sortedIds(input.representedEvidenceIds ?? [], 'representedEvidenceIds')
  if (representedClaimIds.length === 0 && representedEvidenceIds.length === 0) {
    throw new MemoryIdentityValidationError('At least one represented claim or evidence ID is required.')
  }

  const canonical = JSON.stringify({
    identityVersion: MEMORY_IDENTITY_VERSION,
    packetId: nonEmpty(input.packet.packetId, 'packet.packetId'),
    workId: nonEmpty(input.packet.workId, 'packet.workId'),
    researchContractVersion: nonEmpty(input.packet.researchContractVersion, 'packet.researchContractVersion'),
    canonicalEntityId: nonEmpty(input.canonicalEntityId, 'canonicalEntityId'),
    memoryType: memoryType(input.memoryType),
    memoryRole: nonEmpty(input.memoryRole, 'memoryRole'),
    representedClaimIds,
    representedEvidenceIds,
  })
  const digest = createHash('sha256').update(canonical, 'utf8').digest('hex')
  return `${MEMORY_IDENTITY_VERSION}:${digest}`
}

export class MemoryIdentityValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'MemoryIdentityValidationError'
  }
}

function sortedIds(values: readonly string[], field: string): string[] {
  if (!Array.isArray(values)) throw new MemoryIdentityValidationError(`${field} must be an array.`)
  return [...new Set(values.map((value) => nonEmpty(value, field)))].sort((left, right) => (
    left < right ? -1 : left > right ? 1 : 0
  ))
}

function nonEmpty(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new MemoryIdentityValidationError(`${field} must be a non-empty string.`)
  }
  return value.trim()
}

function memoryType(value: unknown): EntityKnowledgeMemoryType {
  const normalized = nonEmpty(value, 'memoryType') as EntityKnowledgeMemoryType
  if (!MEMORY_TYPES.has(normalized)) throw new MemoryIdentityValidationError(`Unsupported memoryType: ${normalized}`)
  return normalized
}
