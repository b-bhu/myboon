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
  signalId: ResearchPacketV1['signalId']
  researchContractVersion: ResearchPacketV1['researchContractVersion'] | string
  sourceType: ResearchPacketV1['sourceType']
  sourceSignal: { [key: string]: unknown }
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
 * Derives one opaque replay-stable key per canonical packet/article and Entity.
 * Model-authored memory shape and wording are validated where applicable but
 * intentionally absent from the canonical hash payload.
 */
export function deriveMemoryIdentityKey(input: MemoryIdentityInput): string {
  const representedClaimIds = sortedIds(input.representedClaimIds ?? [], 'representedClaimIds')
  const representedEvidenceIds = sortedIds(input.representedEvidenceIds ?? [], 'representedEvidenceIds')
  if (representedClaimIds.length === 0 && representedEvidenceIds.length === 0) {
    throw new MemoryIdentityValidationError('At least one represented claim or evidence ID is required.')
  }
  memoryType(input.memoryType)
  nonEmpty(input.memoryRole, 'memoryRole')

  const canonical = JSON.stringify({
    identityVersion: MEMORY_IDENTITY_VERSION,
    scope: input.packet.sourceType === 'news'
      ? {
        sourceType: 'news',
        sourceItemId: sourceItemIdentity(input.packet),
      }
      : {
        packetId: nonEmpty(input.packet.packetId, 'packet.packetId'),
        workId: nonEmpty(input.packet.workId, 'packet.workId'),
        researchContractVersion: nonEmpty(input.packet.researchContractVersion, 'packet.researchContractVersion'),
      },
    canonicalEntityId: nonEmpty(input.canonicalEntityId, 'canonicalEntityId'),
  })
  const digest = createHash('sha256').update(canonical, 'utf8').digest('hex')
  return `${MEMORY_IDENTITY_VERSION}:${digest}`
}

function sourceItemIdentity(packet: MemoryIdentityPacketRef): string {
  const explicit = packet.sourceSignal.sourceId
  return typeof explicit === 'string' && explicit.trim() !== ''
    ? explicit.trim()
    : nonEmpty(packet.signalId, 'packet.signalId')
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
