import { compactString } from './normalization'
import type { NewsCandidateObservationRow, NewsResearchResultRow } from '../news/store'
import type { ResearchPacket } from './types'

function evidenceUrl(value: unknown): string | null {
  if (!value || typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  return compactString(record.url)
}

function dedupeEvidence(items: unknown[]): unknown[] {
  const seenUrls = new Set<string>()
  const output: unknown[] = []
  for (const item of items) {
    const url = evidenceUrl(item)
    if (url) {
      if (seenUrls.has(url)) continue
      seenUrls.add(url)
    }
    output.push(item)
  }
  return output
}

function packetEvidence(row: NewsResearchResultRow, candidate: NewsCandidateObservationRow): unknown[] {
  const sourceType = candidate.rawCandidate.content_kind === 'social_post'
    ? 'social_post'
    : 'article'
  const articleEvidence = [{
    evidence_id: 'article_canonical',
    title: candidate.headline,
    url: candidate.canonicalArticleUrl,
    source_type: sourceType,
    observed_at: candidate.observedAt,
  }]
  const originalArticleUrl = compactString(row.sourceSignal.article_url)
  if (originalArticleUrl && originalArticleUrl !== candidate.canonicalArticleUrl) {
    articleEvidence.push({
      evidence_id: 'article_original',
      title: candidate.headline,
      url: originalArticleUrl,
      source_type: sourceType,
      observed_at: candidate.observedAt,
    })
  }
  return dedupeEvidence([...articleEvidence, ...row.evidence])
}

function packetBody(row: NewsResearchResultRow): string {
  return [
    row.researchSummary.one_liner,
    row.researchSummary.what_was_checked.length
      ? `Checked: ${row.researchSummary.what_was_checked.join('; ')}`
      : '',
    row.openQuestions.length ? `Open questions: ${row.openQuestions.join('; ')}` : '',
    row.limitations.length ? `Limitations: ${row.limitations.join('; ')}` : '',
  ].filter(Boolean).join('\n\n')
}

export function newsResearchToPacket(
  row: NewsResearchResultRow,
  candidate: NewsCandidateObservationRow
): ResearchPacket {
  if (row.candidateObservationId !== candidate.id) {
    throw new Error(`News research result ${row.id} does not match candidate ${candidate.id}`)
  }

  const summary = compactString(row.researchSummary.one_liner)
    || candidate.visibleSummary
    || candidate.headline
  const sourceType = candidate.rawCandidate.content_kind === 'social_post'
    ? 'social_post'
    : 'article'

  return {
    id: `news:${row.sourceId}:${row.id}`,
    source: 'news',
    sourceArea: row.sourceId,
    sourceResearchId: row.id,
    sourceType,
    sourceRefId: candidate.canonicalArticleUrl,
    title: candidate.headline,
    summary,
    body: packetBody(row) || summary,
    observedAt: candidate.observedAt,
    eventAt: candidate.publishedAt || candidate.observedAt,
    url: candidate.canonicalArticleUrl,
    evidence: packetEvidence(row, candidate),
    metrics: {
      articleClaimCount: row.articleClaims.length,
      verifiedFactCount: row.verifiedFacts.length,
      unresolvedClaimCount: row.unresolvedClaims.length,
      evidenceCount: row.evidence.length,
      entityHintCount: row.entityHints.length,
      openQuestionCount: row.openQuestions.length,
      limitationCount: row.limitations.length,
    },
    context: {
      source: 'news_research_results',
      source_id: row.sourceId,
      source_name: row.sourceName,
      url_id: row.urlId,
      url_label: row.urlLabel,
      source_url: row.sourceUrl,
      candidate_observation_id: candidate.id,
      research_result_id: row.id,
      research_job_id: row.researchJobId,
      response_status: row.responseStatus,
      dedupe_outcome: candidate.dedupeOutcome,
      article_identity_key: candidate.articleIdentityKey,
      observation_dedupe_key: candidate.observationDedupeKey,
      headline_hash: candidate.headlineHash,
      summary_hash: candidate.summaryHash,
      content_hash: candidate.contentHash,
      source_signal: row.sourceSignal,
      article_claims: row.articleClaims,
      verified_facts: row.verifiedFacts,
      unresolved_claims: row.unresolvedClaims,
      entity_hints: row.entityHints,
      open_questions: row.openQuestions,
      limitations: row.limitations,
      errors: row.errors,
      content_kind: sourceType,
      provider_id: candidate.rawCandidate.provider_id ?? null,
      upstream_source_name: candidate.rawCandidate.upstream_source_name ?? null,
      image_url: candidate.rawCandidate.image_url ?? null,
      untrusted_related_coin_ids: candidate.rawCandidate.related_coin_ids ?? [],
    },
  }
}
