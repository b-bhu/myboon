import type { PipelineCandidateRow, PipelineResearchRow } from '../../pipeline-store/store'
import {
  RESEARCH_PACKET_SCHEMA_VERSION,
  SIGNAL_SCHEMA_VERSION,
  type PolymarketSignal,
  type ResearchPacketV1,
  type ResearchWorkItem,
} from '../contracts'
import { validateResearchPacket, validateSignal } from '../validation'
import { asRecord, asStringArray, isPublicHttpUrl, stableContractId } from './identity'
import type { LegacyPacketMigrationPolicy, LegacyWorkMigrationPolicy } from './migration-policy'
import { legacySignalToResearchWork } from './work'
import type { SignalSourceAdapter } from '../signal-source-adapter'

export const legacyPolymarketSignalAdapter: SignalSourceAdapter<PipelineCandidateRow, PolymarketSignal> = {
  sourceType: 'polymarket',
  contentKind: 'market_event',
  normalize: adaptLegacyPolymarketSignal,
}

export function adaptLegacyPolymarketSignal(row: PipelineCandidateRow): PolymarketSignal {
  return validateSignal({
    schemaVersion: SIGNAL_SCHEMA_VERSION,
    signalId: stableContractId('sig', 'polymarket', row.dedupeKey),
    sourceType: 'polymarket',
    contentKind: 'market_event',
    content: {
      schemaVersion: 'myboon.signal_content.market_event.v1',
      marketId: row.marketId,
      slug: row.slug,
      candidateType: row.candidateType,
      whatChanged: row.whatChanged,
      metrics: row.metrics,
    },
    sourceId: `polymarket:market:${row.marketId}`,
    observedAt: row.observedAt,
    publishedAt: null,
    canonicalUrl: isPublicHttpUrl(`https://polymarket.com/event/${row.slug}`)
      ? `https://polymarket.com/event/${row.slug}` : null,
    title: row.title,
    visibleSummary: row.whatChanged,
    media: { imageUrl: null, attribution: null },
    sourceHints: { entities: [], assets: [], eventId: row.marketId, deadline: null },
    provenance: {
      provider: row.source || 'polymarket',
      upstreamSource: row.area,
      rawPayloadRef: row.id,
    },
    idempotencyKey: row.dedupeKey,
    migration: {
      legacyTable: 'polymarket_market_candidates',
      legacyRowId: row.id,
      legacyStatus: row.status,
      candidateType: row.candidateType,
      score: row.score,
      scoreBreakdown: row.scoreBreakdown,
      metrics: row.metrics,
      evidenceRefs: row.evidenceRefs,
      whyFlagged: row.whyFlagged,
      tagSlug: row.tagSlug,
      tagLabel: row.tagLabel,
      limitations: [
        'legacy_polymarket_candidate_is_a_mutable_thread_snapshot',
        'legacy_polymarket_candidate_has_no_canonical_market_deadline',
      ],
    },
  }) as PolymarketSignal
}

export function adaptLegacyPolymarketWork(
  row: PipelineCandidateRow,
  policy: LegacyWorkMigrationPolicy,
): ResearchWorkItem {
  return legacySignalToResearchWork(adaptLegacyPolymarketSignal(row), policy)
}

export function adaptLegacyPolymarketPacket(
  row: PipelineResearchRow,
  candidate: PipelineCandidateRow,
  work: ResearchWorkItem,
  policy: LegacyPacketMigrationPolicy,
): ResearchPacketV1 {
  const signal = adaptLegacyPolymarketSignal(candidate)
  const packetContext = findResearchPacketContext(row.relatedContext)
  const evidenceLinks = Array.isArray(row.evidenceLinks) ? row.evidenceLinks : []
  const evidence = evidenceLinks.flatMap((item, index) => {
    const record = asRecord(item)
    const url = typeof item === 'string' ? item
      : typeof record?.url === 'string' ? record.url : null
    if (!isPublicHttpUrl(url)) return []
    const title = typeof record?.title === 'string' && record.title.length > 0 ? record.title : url
    return [{
      evidenceId: stableContractId('evidence', row.id, String(index), url),
      title,
      url,
      sourceType: typeof record?.source_type === 'string' ? record.source_type : null,
      observedAt: typeof record?.observed_at === 'string' ? record.observed_at : null,
      note: typeof record?.note === 'string' ? record.note : null,
    }]
  })
  const claims = recordList(packetContext?.claims_found).map((claim, index) => ({
    claimId: typeof claim.claim_id === 'string' ? claim.claim_id : stableContractId('claim', row.id, String(index)),
    claim: stringField(claim, 'claim') ?? stringField(claim, 'text') ?? JSON.stringify(claim),
    attributedTo: stringField(claim, 'attributed_to'),
    evidenceRefs: asStringArray(claim.evidence_refs),
  }))
  const facts = valueList(packetContext?.verified_facts).map((value) => {
    const record = asRecord(value)
    return {
      fact: typeof value === 'string' ? value : stringField(record, 'fact') ?? JSON.stringify(value),
      evidenceRefs: asStringArray(record?.evidence_refs),
    }
  })
  const unresolved = valueList(packetContext?.unverified_claims).map((value) => {
    const record = asRecord(value)
    return {
      claim: typeof value === 'string' ? value : stringField(record, 'claim') ?? JSON.stringify(value),
      reason: stringField(record, 'reason') ?? 'Legacy research did not verify this claim.',
      evidenceRefs: asStringArray(record?.evidence_refs),
    }
  })
  const limitations = ['legacy_polymarket_candidate_is_a_mutable_thread_snapshot']
  if (!packetContext) limitations.push('legacy_structured_research_packet_context_unavailable')
  if (evidence.length !== evidenceLinks.length) limitations.push('legacy_evidence_with_invalid_or_unstructured_url_omitted')
  if (row.uncertainty.trim()) limitations.push(row.uncertainty.trim())

  return validateResearchPacket({
    schemaVersion: RESEARCH_PACKET_SCHEMA_VERSION,
    packetId: stableContractId('packet', 'polymarket', row.id, work.workId),
    workId: work.workId,
    signalId: signal.signalId,
    sourceType: 'polymarket',
    observedAt: candidate.observedAt,
    sourceSignal: {
      title: signal.title,
      canonicalUrl: signal.canonicalUrl,
      publishedAt: null,
      provenance: signal.provenance,
      visibleSummary: signal.visibleSummary,
    },
    claims,
    verifiedFacts: facts,
    unresolvedClaims: unresolved,
    evidence,
    entityHints: valueList(packetContext?.entities_mentioned).flatMap((value) => {
      const record = asRecord(value)
      const name = typeof value === 'string' ? value : stringField(record, 'name')
      return name ? [{
        name,
        type: stringField(record, 'type'),
        role: stringField(record, 'role'),
        aliases: asStringArray(record?.aliases),
        source: 'legacy_polymarket_research',
        claimRefs: asStringArray(record?.claim_refs),
        evidenceRefs: asStringArray(record?.evidence_refs),
      }] : []
    }),
    limitations,
    openQuestions: asStringArray(packetContext?.open_questions),
    completion: row.status === 'needs_more_research' ? 'partial' : row.status === 'rejected' ? 'failed' : 'complete',
    budgetUsed: policy.budgetUsed,
    execution: policy.execution,
    researchContractVersion: RESEARCH_PACKET_SCHEMA_VERSION,
    createdAt: policy.createdAt,
    migration: {
      legacyTable: 'polymarket_market_candidate_research',
      legacyRowId: row.id,
      legacyStatus: row.status,
      summary: row.summary,
      notes: row.notes,
      keyFindings: row.keyFindings,
      relatedContext: row.relatedContext,
      recommendedEditorAction: row.recommendedEditorAction,
      evidenceQuality: row.evidenceQuality,
    },
  })
}

function findResearchPacketContext(value: unknown): Record<string, unknown> | null {
  for (const item of valueList(value)) {
    const record = asRecord(item)
    if (record?.kind === 'research_packet') return record
  }
  return null
}

function valueList(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function recordList(value: unknown): Record<string, unknown>[] {
  return valueList(value).flatMap((item) => {
    const record = asRecord(item)
    return record ? [record] : []
  })
}

function stringField(record: Record<string, unknown> | null | undefined, key: string): string | null {
  return typeof record?.[key] === 'string' && record[key].length > 0 ? record[key] as string : null
}
