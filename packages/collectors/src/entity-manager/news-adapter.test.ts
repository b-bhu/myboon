import assert from 'node:assert/strict'
import test from 'node:test'
import { normalizeExtraction } from './normalization'
import { newsResearchToPacket } from './news-adapter'
import type { NewsCandidateObservationRow, NewsResearchResultRow } from '../news/store'

const FORBIDDEN_KEYS = new Set([
  'score',
  'relevance_score',
  'rank',
  'importance',
  'risk_level',
  'confidence',
  'evidence_quality',
  'catalyst_found',
  'recommended_editor_action',
  'publish',
  'reject',
])

function containsForbiddenKey(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsForbiddenKey)
  if (!value || typeof value !== 'object') return false
  return Object.entries(value).some(([key, nested]) => (
    FORBIDDEN_KEYS.has(key) || containsForbiddenKey(nested)
  ))
}

const candidate: NewsCandidateObservationRow = {
  id: 'candidate-1',
  sourceRunId: 'run-1',
  sourceId: 'news_feed:articles',
  sourceName: 'CoinDesk',
  urlId: 'feed',
  urlLabel: 'Structured News Feed',
  sourceUrl: 'https://api.tokens.xyz/v1/news/feed',
  canonicalArticleUrl: 'https://www.coindesk.com/policy/2026/07/04/stablecoin-filing',
  headline: 'Stablecoin filing appears in public records',
  visibleSummary: 'A filing related to a stablecoin product appeared in public records.',
  publishedAt: '2026-07-04T10:00:00.000Z',
  observedAt: '2026-07-04T12:00:00.000Z',
  headlineHash: 'headline-hash',
  summaryHash: 'summary-hash',
  contentHash: 'content-hash',
  articleIdentityKey: 'news_feed:articles:article:https://www.coindesk.com/policy/2026/07/04/stablecoin-filing',
  observationDedupeKey: 'dedupe-key',
  dedupeOutcome: 'new_candidate',
  status: 'researched',
  lastResearchJobId: null,
  researchWorkerStatus: null,
  researchError: null,
  researchRawResponse: null,
  researchStderr: null,
  rawCandidate: {
    headline: 'Stablecoin filing appears in public records',
    article_url: 'https://www.coindesk.com/policy/2026/07/04/stablecoin-filing?utm_source=x',
    summary: 'A filing related to a stablecoin product appeared in public records.',
  },
  createdAt: '2026-07-04T12:00:00.000Z',
  updatedAt: '2026-07-04T12:00:00.000Z',
}

const row: NewsResearchResultRow = {
  id: 'research-1',
  candidateObservationId: candidate.id,
  sourceId: candidate.sourceId,
  sourceName: candidate.sourceName,
  urlId: candidate.urlId,
  urlLabel: candidate.urlLabel,
  sourceUrl: candidate.sourceUrl,
  canonicalArticleUrl: candidate.canonicalArticleUrl,
  articleIdentityKey: candidate.articleIdentityKey,
  observationDedupeKey: candidate.observationDedupeKey,
  researchJobId: 'research-job-1',
  status: 'pending_entity_memory',
  responseStatus: 'ready_for_entity_memory',
  sourceSignal: {
    source_name: candidate.sourceName,
    source_url: candidate.sourceUrl,
    article_url: candidate.rawCandidate.article_url,
    canonical_article_url: candidate.canonicalArticleUrl,
    headline: candidate.headline,
    visible_summary: candidate.visibleSummary,
    published_at: candidate.publishedAt,
    observed_at: candidate.observedAt,
  },
  researchSummary: {
    one_liner: 'The filing was checked against a public records page.',
    what_was_checked: ['Article page', 'Public records page'],
    requires_followup: false,
  },
  articleClaims: [{
    claim_id: 'claim_1',
    claim: 'A stablecoin filing appeared in public records.',
    evidence_refs: ['evidence_1'],
  }],
  verifiedFacts: [{
    fact: 'The public records page listed the filing.',
    evidence_refs: ['evidence_1'],
  }],
  unresolvedClaims: [],
  entityHints: [{
    name: 'Example Stablecoin Issuer',
    type: 'organization',
    source: 'article',
  }],
  evidence: [{
    evidence_id: 'evidence_1',
    title: 'Public records page',
    url: 'https://example.com/public-records',
    source_type: 'official_record',
  }, {
    evidence_id: 'duplicate',
    title: 'Duplicate public records page',
    url: 'https://example.com/public-records',
  }],
  openQuestions: ['Whether the filing has been approved.'],
  limitations: ['Some article text was unavailable.'],
  errors: [],
  rawResponse: {} as NewsResearchResultRow['rawResponse'],
  researchedAt: '2026-07-04T13:00:00.000Z',
  createdAt: '2026-07-04T13:00:00.000Z',
  updatedAt: '2026-07-04T13:00:00.000Z',
}

test('newsResearchToPacket maps news research rows to a source-agnostic ResearchPacket', () => {
  const packet = newsResearchToPacket(row, candidate)

  assert.equal(packet.id, 'news:news_feed:articles:research-1')
  assert.equal(packet.source, 'news')
  assert.equal(packet.sourceArea, row.sourceId)
  assert.equal(packet.sourceResearchId, row.id)
  assert.equal(packet.sourceType, 'article')
  assert.equal(packet.sourceRefId, candidate.canonicalArticleUrl)
  assert.equal(packet.title, candidate.headline)
  assert.equal(packet.summary, row.researchSummary.one_liner)
  assert.equal(packet.observedAt, candidate.observedAt)
  assert.equal(packet.eventAt, candidate.publishedAt)
  assert.equal(packet.url, candidate.canonicalArticleUrl)
  assert.match(packet.body, /Checked: Article page; Public records page/)
  assert.match(packet.body, /Open questions: Whether the filing has been approved\./)

  assert.deepEqual(packet.metrics, {
    articleClaimCount: 1,
    verifiedFactCount: 1,
    unresolvedClaimCount: 0,
    evidenceCount: 2,
    entityHintCount: 1,
    openQuestionCount: 1,
    limitationCount: 1,
  })
  assert.deepEqual(packet.evidence, [
    {
      evidence_id: 'article_canonical',
      title: candidate.headline,
      url: candidate.canonicalArticleUrl,
      source_type: 'article',
      observed_at: candidate.observedAt,
    },
    {
      evidence_id: 'article_original',
      title: candidate.headline,
      url: candidate.rawCandidate.article_url,
      source_type: 'article',
      observed_at: candidate.observedAt,
    },
    row.evidence[0],
  ])

  assert.equal(packet.context.source, 'news_research_results')
  assert.equal(packet.context.source_id, 'news_feed:articles')
  assert.equal(packet.context.url_id, 'feed')
  assert.equal(packet.context.candidate_observation_id, candidate.id)
  assert.equal(packet.context.research_result_id, row.id)
  assert.equal(packet.context.research_job_id, row.researchJobId)
  assert.equal(packet.context.dedupe_outcome, 'new_candidate')
  assert.deepEqual(packet.context.article_claims, row.articleClaims)
  assert.deepEqual(packet.context.verified_facts, row.verifiedFacts)
  assert.deepEqual(packet.context.entity_hints, row.entityHints)

  assert.equal(containsForbiddenKey({
    metrics: packet.metrics,
    evidence: packet.evidence,
    context: packet.context,
  }), false)
})

test('normalizeExtraction defaults article packet memories to news_event', () => {
  const packet = newsResearchToPacket(row, candidate)
  const extraction = normalizeExtraction({
    primaryEntities: [{
      name: 'Example Stablecoin Issuer',
      type: 'organization',
      slug: 'example-stablecoin-issuer',
    }],
    memories: [{
      entitySlug: 'example-stablecoin-issuer',
      title: 'Stablecoin filing appeared in public records',
      summary: 'A public records page listed a filing described in the article.',
    }],
  }, packet)

  assert.equal(extraction.memories.length, 1)
  assert.equal(extraction.memories[0].memoryType, 'news_event')
})

test('social-post candidates remain social signals through entity normalization', () => {
  const socialCandidate: NewsCandidateObservationRow = {
    ...candidate,
    sourceId: 'news_feed:social',
    sourceName: '@tokens',
    rawCandidate: {
      ...candidate.rawCandidate,
      content_kind: 'social_post',
      upstream_source_name: '@tokens',
      related_coin_ids: ['bitcoin'],
    },
  }
  const socialRow: NewsResearchResultRow = {
    ...row,
    sourceId: 'news_feed:social',
    sourceName: '@tokens',
    candidateObservationId: socialCandidate.id,
  }
  const packet = newsResearchToPacket(socialRow, socialCandidate)
  const extraction = normalizeExtraction({
    primaryEntities: [{ name: 'Bitcoin', type: 'asset', slug: 'bitcoin' }],
    memories: [{
      entitySlug: 'bitcoin',
      memoryType: 'news_event',
      title: 'Bitcoin appeared in a public filing post',
      summary: 'The post described a public filing that named Bitcoin.',
    }],
  }, packet)

  assert.equal(packet.sourceType, 'social_post')
  assert.equal(packet.context.content_kind, 'social_post')
  assert.deepEqual(packet.context.untrusted_related_coin_ids, ['bitcoin'])
  // The source kind wins even when extraction supplies another allowed type.
  assert.equal(extraction.memories[0].memoryType, 'social_signal')
})
