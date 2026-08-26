import type { ResearchPacketV1, Signal } from '../signal-platform/contracts'
import { PlatformFailure } from '../signal-platform/failures'
import { validateResearchPacket } from '../signal-platform/validation'
import type { ResearchPacket } from './types'

export const CANONICAL_PACKET_ADAPTER_VERSION = 'myboon.entity_packet_adapter.v1' as const

export interface CanonicalPacketSourcePolicy {
  sourceType: Signal['sourceType']
  sourceArea: string
  legacySourceType: string
  allowPartial: boolean
  sourceResearchId: 'packetId'
  sourceRefId: 'signalId'
  allowedContextAdditions: readonly string[]
  contextAdditions(packet: ResearchPacketV1): Record<string, unknown>
  eventAt(packet: ResearchPacketV1): string
}

export class CanonicalPacketAdapterError extends PlatformFailure {
  constructor(message: string, category: 'invalid_structured_output' | 'schema_version_mismatch' = 'invalid_structured_output') {
    super({ category, message, retryable: false })
    this.name = 'CanonicalPacketAdapterError'
  }
}

export class CanonicalPacketSourcePolicyRegistry {
  private readonly policies: ReadonlyMap<string, CanonicalPacketSourcePolicy>

  constructor(policies: readonly CanonicalPacketSourcePolicy[]) {
    const bySource = new Map<string, CanonicalPacketSourcePolicy>()
    for (const policy of policies) {
      if (bySource.has(policy.sourceType)) {
        throw new CanonicalPacketAdapterError(`Duplicate canonical packet policy: ${policy.sourceType}`)
      }
      bySource.set(policy.sourceType, policy)
    }
    this.policies = bySource
  }

  policyFor(sourceType: string): CanonicalPacketSourcePolicy {
    const policy = this.policies.get(sourceType)
    if (!policy) throw new CanonicalPacketAdapterError(`No Entity Manager source policy registered for: ${sourceType}`)
    return policy
  }
}

const COMMON_CONTEXT_KEYS = [
  'content_kind',
  'content',
  'media',
  'source_hints',
] as const

const DEFAULT_SOURCE_POLICIES: readonly CanonicalPacketSourcePolicy[] = [
  policy({ sourceType: 'news', sourceArea: 'feed', legacySourceType: 'article', allowPartial: false }),
  policy({ sourceType: 'polymarket', sourceArea: 'markets', legacySourceType: 'market_event', allowPartial: false }),
  policy({ sourceType: 'market_calendar', sourceArea: 'events', legacySourceType: 'calendar_event', allowPartial: true }),
  policy({ sourceType: 'x', sourceArea: 'social', legacySourceType: 'social_thread', allowPartial: false }),
]

export const canonicalPacketSourcePolicies = new CanonicalPacketSourcePolicyRegistry(DEFAULT_SOURCE_POLICIES)

/**
 * Pure bridge from the canonical packet into the legacy EntityService input.
 * The complete canonical packet remains under context.canonical_packet while
 * policies expose only explicitly permitted convenience fields.
 */
export function adaptCanonicalResearchPacket(
  value: unknown,
  registry: CanonicalPacketSourcePolicyRegistry = canonicalPacketSourcePolicies,
): ResearchPacket {
  const packet = canonicalPacket(value)
  const sourcePolicy = registry.policyFor(packet.sourceType)
  validateLinkage(packet)
  validateEvidenceLinkage(packet)
  if (packet.completion === 'failed') {
    throw new CanonicalPacketAdapterError(`Failed Research Packet cannot enter Entity Manager: ${packet.packetId}`)
  }
  if (packet.completion === 'partial' && !sourcePolicy.allowPartial) {
    throw new CanonicalPacketAdapterError(`Partial Research Packet is disallowed by ${packet.sourceType} policy.`)
  }

  const additions = sourcePolicy.contextAdditions(packet)
  const allowed = new Set(sourcePolicy.allowedContextAdditions)
  for (const key of Object.keys(additions)) {
    if (!allowed.has(key)) {
      throw new CanonicalPacketAdapterError(`${packet.sourceType} policy emitted forbidden context key: ${key}`)
    }
  }

  const summary = packet.verifiedFacts[0]?.fact
    ?? packet.claims[0]?.claim
    ?? sourceSignalString(packet, 'visibleSummary')
    ?? packet.sourceSignal.title

  return {
    id: `canonical-packet:${packet.packetId}`,
    source: packet.sourceType,
    sourceArea: sourcePolicy.sourceArea,
    sourceResearchId: packet.packetId,
    sourceType: sourcePolicy.legacySourceType,
    sourceRefId: packet.signalId,
    title: packet.sourceSignal.title,
    summary,
    body: deterministicBody(packet, summary),
    observedAt: packet.observedAt,
    eventAt: sourcePolicy.eventAt(packet),
    url: packet.sourceSignal.canonicalUrl,
    evidence: clone(packet.evidence),
    metrics: {
      claimCount: packet.claims.length,
      verifiedFactCount: packet.verifiedFacts.length,
      unresolvedClaimCount: packet.unresolvedClaims.length,
      evidenceCount: packet.evidence.length,
      entityHintCount: packet.entityHints.length,
      budgetUsed: clone(packet.budgetUsed),
    },
    context: {
      adapter_version: CANONICAL_PACKET_ADAPTER_VERSION,
      packet_id: packet.packetId,
      work_id: packet.workId,
      signal_id: packet.signalId,
      trace_id: packet.execution.traceId,
      policy_version: packet.execution.policyVersion,
      prompt_version: packet.execution.promptVersion,
      research_contract_version: packet.researchContractVersion,
      completion: packet.completion,
      execution: clone(packet.execution),
      budget_used: clone(packet.budgetUsed),
      claims: clone(packet.claims),
      verified_facts: clone(packet.verifiedFacts),
      unresolved_claims: clone(packet.unresolvedClaims),
      evidence: clone(packet.evidence),
      entity_hints: clone(packet.entityHints),
      limitations: clone(packet.limitations),
      open_questions: clone(packet.openQuestions),
      source_signal: clone(packet.sourceSignal),
      canonical_packet: clone(packet),
      source_policy: {
        source_type: sourcePolicy.sourceType,
        source_area: sourcePolicy.sourceArea,
        legacy_source_type: sourcePolicy.legacySourceType,
        allow_partial: sourcePolicy.allowPartial,
        source_research_id: sourcePolicy.sourceResearchId,
        source_ref_id: sourcePolicy.sourceRefId,
      },
      ...clone(additions),
    },
  }
}

function policy(input: Pick<
  CanonicalPacketSourcePolicy,
  'sourceType' | 'sourceArea' | 'legacySourceType' | 'allowPartial'
>): CanonicalPacketSourcePolicy {
  return {
    ...input,
    sourceResearchId: 'packetId',
    sourceRefId: 'signalId',
    allowedContextAdditions: COMMON_CONTEXT_KEYS,
    contextAdditions(packet) {
      return {
        content_kind: sourceSignalValue(packet, 'contentKind') ?? input.legacySourceType,
        content: clone(sourceSignalRecord(packet, 'content')),
        media: clone(sourceSignalRecord(packet, 'media')),
        source_hints: clone(sourceSignalRecord(packet, 'sourceHints')),
      }
    },
    eventAt(packet) {
      if (input.sourceType === 'market_calendar') {
        const content = sourceSignalRecord(packet, 'content')
        const eventAt = timestampValue(content.eventAt ?? content.startAt ?? content.effectiveAt)
        if (eventAt) return eventAt
      }
      return packet.sourceSignal.publishedAt ?? packet.observedAt
    },
  }
}

function canonicalPacket(value: unknown): ResearchPacketV1 {
  try {
    return validateResearchPacket(value)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Invalid canonical Research Packet.'
    const category = /schemaVersion|researchContractVersion/.test(message)
      ? 'schema_version_mismatch' as const
      : 'invalid_structured_output' as const
    throw new CanonicalPacketAdapterError(message, category)
  }
}

function validateLinkage(packet: ResearchPacketV1): void {
  const sourceSignal = packet.sourceSignal as Record<string, unknown>
  if (sourceSignal.signalId !== undefined && sourceSignal.signalId !== packet.signalId) {
    throw new CanonicalPacketAdapterError('Research Packet signalId does not match sourceSignal.signalId.')
  }
  if (sourceSignal.sourceType !== undefined && sourceSignal.sourceType !== packet.sourceType) {
    throw new CanonicalPacketAdapterError('Research Packet sourceType does not match sourceSignal.sourceType.')
  }
  if (sourceSignal.workId !== undefined && sourceSignal.workId !== packet.workId) {
    throw new CanonicalPacketAdapterError('Research Packet workId does not match sourceSignal.workId.')
  }
}

function validateEvidenceLinkage(packet: ResearchPacketV1): void {
  const evidenceIds = uniqueIds(packet.evidence.map((evidence) => evidence.evidenceId), 'evidence')
  const claimIds = uniqueIds(packet.claims.map((claim) => claim.claimId), 'claim')
  for (const [index, claim] of packet.claims.entries()) {
    references(claim.evidenceRefs, evidenceIds, `claims[${index}].evidenceRefs`)
  }
  for (const [index, fact] of packet.verifiedFacts.entries()) {
    references(fact.evidenceRefs, evidenceIds, `verifiedFacts[${index}].evidenceRefs`)
  }
  for (const [index, claim] of packet.unresolvedClaims.entries()) {
    references(claim.evidenceRefs, evidenceIds, `unresolvedClaims[${index}].evidenceRefs`)
  }
  for (const [index, hint] of packet.entityHints.entries()) {
    references(hint.claimRefs, claimIds, `entityHints[${index}].claimRefs`)
    references(hint.evidenceRefs, evidenceIds, `entityHints[${index}].evidenceRefs`)
    if (hint.claimRefs.length === 0 && hint.evidenceRefs.length === 0) {
      throw new CanonicalPacketAdapterError(`entityHints[${index}] has no claim/evidence linkage.`)
    }
  }
}

function uniqueIds(ids: readonly string[], label: string): Set<string> {
  const unique = new Set(ids)
  if (unique.size !== ids.length) throw new CanonicalPacketAdapterError(`Research Packet has duplicate ${label} IDs.`)
  return unique
}

function references(values: readonly string[], known: ReadonlySet<string>, field: string): void {
  for (const value of values) {
    if (!known.has(value)) throw new CanonicalPacketAdapterError(`${field} contains unknown ID: ${value}`)
  }
}

function deterministicBody(packet: ResearchPacketV1, summary: string): string {
  const sections = [
    summary,
    ...packet.claims.map((claim) => `Claim: ${claim.claim}`),
    ...packet.verifiedFacts.map((fact) => `Verified: ${fact.fact}`),
    ...packet.unresolvedClaims.map((claim) => `Unresolved: ${claim.claim} (${claim.reason})`),
    ...packet.limitations.map((limitation) => `Limitation: ${limitation}`),
    ...packet.openQuestions.map((question) => `Open question: ${question}`),
  ]
  return [...new Set(sections)].join('\n\n')
}

function sourceSignalValue(packet: ResearchPacketV1, field: string): unknown {
  return (packet.sourceSignal as Record<string, unknown>)[field]
}

function sourceSignalString(packet: ResearchPacketV1, field: string): string | null {
  const value = sourceSignalValue(packet, field)
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function sourceSignalRecord(packet: ResearchPacketV1, field: string): Record<string, unknown> {
  const value = sourceSignalValue(packet, field)
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function timestampValue(value: unknown): string | null {
  return typeof value === 'string' && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null
}

function clone<T>(value: T): T {
  return structuredClone(value)
}
