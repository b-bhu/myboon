import type { NewsCandidateObservationRow, NewsResearchResultRow } from '../../news/store'
import {
  RESEARCH_PACKET_SCHEMA_VERSION,
  SIGNAL_SCHEMA_VERSION,
  type NewsSignal,
  type ResearchPacketV1,
  type ResearchWorkItem,
} from '../contracts'
import { validateResearchPacket, validateSignal } from '../validation'
import { isPublicHttpUrl, stableContractId } from './identity'
import type { LegacyPacketMigrationPolicy, LegacyWorkMigrationPolicy } from './migration-policy'
import { legacySignalToResearchWork } from './work'
import type { SignalSourceAdapter } from '../signal-source-adapter'

export const legacyNewsSignalAdapter: SignalSourceAdapter<NewsCandidateObservationRow, NewsSignal> = {
  sourceType: 'news',
  contentKind: 'article',
  normalize: adaptLegacyNewsSignal,
}

export function adaptLegacyNewsSignal(row: NewsCandidateObservationRow): NewsSignal {
  return validateSignal({
    schemaVersion: SIGNAL_SCHEMA_VERSION,
    signalId: stableContractId('sig', 'news', row.observationDedupeKey),
    sourceType: 'news',
    contentKind: 'article',
    content: {
      schemaVersion: 'myboon.signal_content.article.v1',
      author: row.rawCandidate.author ?? null,
      section: row.rawCandidate.section ?? null,
      legacyContentKind: row.rawCandidate.content_kind ?? 'article',
    },
    sourceId: row.articleIdentityKey,
    observedAt: row.observedAt,
    publishedAt: row.publishedAt,
    canonicalUrl: isPublicHttpUrl(row.canonicalArticleUrl) ? row.canonicalArticleUrl : null,
    title: row.headline,
    visibleSummary: row.visibleSummary,
    media: {
      imageUrl: row.rawCandidate.image_url ?? null,
      attribution: row.rawCandidate.author ?? null,
    },
    sourceHints: {
      entities: [],
      assets: row.rawCandidate.related_coin_ids ?? [],
      eventId: null,
      deadline: null,
    },
    provenance: {
      provider: row.rawCandidate.provider_id ?? 'legacy_news',
      upstreamSource: row.rawCandidate.upstream_source_name ?? row.sourceName,
      rawPayloadRef: row.id,
    },
    idempotencyKey: row.observationDedupeKey,
    migration: {
      legacyTable: 'news_candidate_observations',
      legacyRowId: row.id,
      legacyStatus: row.status,
      dedupeOutcome: row.dedupeOutcome,
      headlineHash: row.headlineHash,
      summaryHash: row.summaryHash,
      contentHash: row.contentHash,
      sourceRunId: row.sourceRunId,
      originalSourceUrl: row.sourceUrl,
      originalArticleUrl: row.rawCandidate.article_url,
      limitations: [
        'legacy_news_has_no_canonical_deadline_or_entity_hints',
        ...(row.rawCandidate.content_kind === 'social_post'
          ? ['legacy_social_post_retained_as_article_until_x_source_migration'] : []),
      ],
    },
  }) as NewsSignal
}

export function adaptLegacyNewsWork(
  row: NewsCandidateObservationRow,
  policy: LegacyWorkMigrationPolicy,
): ResearchWorkItem {
  return legacySignalToResearchWork(adaptLegacyNewsSignal(row), policy)
}

export function adaptLegacyNewsPacket(
  row: NewsResearchResultRow,
  candidate: NewsCandidateObservationRow,
  work: ResearchWorkItem,
  policy: LegacyPacketMigrationPolicy,
): ResearchPacketV1 {
  const signal = adaptLegacyNewsSignal(candidate)
  const validEvidence = row.evidence.filter((item) => isPublicHttpUrl(item.url))
  const limitations = [...row.limitations]
  if (validEvidence.length !== row.evidence.length) limitations.push('legacy_evidence_with_invalid_url_omitted')
  if (row.errors.length > 0) limitations.push(...row.errors.map((error) => `legacy_error: ${error}`))

  return validateResearchPacket({
    schemaVersion: RESEARCH_PACKET_SCHEMA_VERSION,
    packetId: stableContractId('packet', 'news', row.id, work.workId),
    workId: work.workId,
    signalId: signal.signalId,
    sourceType: 'news',
    observedAt: candidate.observedAt,
    sourceSignal: {
      title: signal.title,
      canonicalUrl: signal.canonicalUrl,
      publishedAt: signal.publishedAt,
      provenance: signal.provenance,
      visibleSummary: signal.visibleSummary,
    },
    claims: row.articleClaims.map((claim) => ({
      claimId: claim.claim_id,
      claim: claim.claim,
      attributedTo: claim.attributed_to ?? null,
      evidenceRefs: claim.evidence_refs ?? [],
    })),
    verifiedFacts: row.verifiedFacts.map((fact) => ({ fact: fact.fact, evidenceRefs: fact.evidence_refs })),
    unresolvedClaims: row.unresolvedClaims.map((claim) => ({
      claim: claim.claim,
      reason: claim.reason,
      evidenceRefs: claim.evidence_refs ?? [],
    })),
    evidence: validEvidence.map((item) => ({
      evidenceId: item.evidence_id,
      title: item.title,
      url: item.url,
      sourceType: item.source_type ?? null,
      observedAt: item.observed_at ?? null,
      note: item.note ?? null,
    })),
    entityHints: row.entityHints.map((hint) => ({
      name: hint.name,
      type: hint.type ?? null,
      role: hint.role ?? null,
      aliases: hint.aliases ?? [],
      source: hint.source ?? null,
      claimRefs: [],
      evidenceRefs: [],
    })),
    limitations: row.entityHints.length > 0
      ? [...limitations, 'legacy_entity_hints_have_no_claim_or_evidence_references']
      : limitations,
    openQuestions: row.openQuestions,
    completion: row.responseStatus === 'ready_for_entity_memory'
      ? 'complete' : row.responseStatus === 'needs_followup' ? 'partial' : 'failed',
    budgetUsed: policy.budgetUsed,
    execution: policy.execution,
    researchContractVersion: RESEARCH_PACKET_SCHEMA_VERSION,
    createdAt: policy.createdAt,
    migration: {
      legacyTable: 'news_research_results',
      legacyRowId: row.id,
      researchJobId: row.researchJobId,
      legacyStatus: row.status,
      researchSummary: row.researchSummary,
      rawResponse: row.rawResponse,
    },
  })
}
