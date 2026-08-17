import assert from 'node:assert/strict'
import test from 'node:test'
import {
  buildResearchPrompt,
  buildResearchRequest,
  parseResearchResponse,
} from '../research-contract'
import type { NewsCandidateObservationRow } from '../store'
import type { NewsResearchResponse, NewsCandidate } from '../types'

const rawCandidate: NewsCandidate = {
  headline: 'CoinDesk reports a new stablecoin filing',
  article_url: 'https://www.coindesk.com/policy/2026/07/04/stablecoin-filing',
  summary: 'A firm filed paperwork related to a stablecoin product.',
  published_at: '2026-07-04T10:00:00.000Z',
  author: 'CoinDesk Staff',
  section: 'Policy',
  evidence: ['article card'],
}

const candidate: NewsCandidateObservationRow = {
  id: 'candidate-1',
  sourceRunId: 'run-1',
  sourceId: 'coindesk',
  sourceName: 'CoinDesk',
  urlId: 'latest_crypto_news',
  urlLabel: 'Latest Crypto News',
  sourceUrl: 'https://www.coindesk.com/latest-crypto-news',
  canonicalArticleUrl: 'https://www.coindesk.com/policy/2026/07/04/stablecoin-filing',
  headline: rawCandidate.headline,
  visibleSummary: rawCandidate.summary ?? null,
  publishedAt: rawCandidate.published_at ?? null,
  observedAt: '2026-07-04T12:00:00.000Z',
  headlineHash: 'headline-hash',
  summaryHash: 'summary-hash',
  contentHash: 'content-hash',
  articleIdentityKey: 'coindesk:article:https://www.coindesk.com/policy/2026/07/04/stablecoin-filing',
  observationDedupeKey: 'coindesk:latest_crypto_news:https://www.coindesk.com/policy/2026/07/04/stablecoin-filing:headline-hash:summary-hash',
  dedupeOutcome: 'new_candidate',
  status: 'pending_research',
  lastResearchJobId: null,
  researchWorkerStatus: null,
  researchError: null,
  researchRawResponse: null,
  researchStderr: null,
  rawCandidate,
  createdAt: '2026-07-04T12:00:00.000Z',
  updatedAt: '2026-07-04T12:00:00.000Z',
}

const now = new Date('2026-07-04T13:00:00.000Z')
const request = buildResearchRequest(candidate, now)
const expected = {
  jobId: request.job_id,
  candidateId: candidate.id,
  sourceId: candidate.sourceId,
  urlId: candidate.urlId,
}

function validResponse(overrides: Partial<NewsResearchResponse> = {}): NewsResearchResponse {
  return {
    schema_version: 'myboon.hermes.research_response.v1',
    job_id: request.job_id,
    candidate_id: candidate.id,
    source_id: candidate.sourceId,
    url_id: candidate.urlId,
    status: 'ready_for_entity_memory',
    source_signal: {
      source_name: candidate.sourceName,
      source_url: candidate.sourceUrl,
      article_url: rawCandidate.article_url,
      canonical_article_url: candidate.canonicalArticleUrl,
      headline: candidate.headline,
      visible_summary: candidate.visibleSummary,
      published_at: candidate.publishedAt,
      observed_at: candidate.observedAt,
    },
    research_summary: {
      one_liner: 'The article claim was checked against an official filing page.',
      what_was_checked: ['Article page', 'Official filing page'],
      requires_followup: false,
    },
    article_claims: [{
      claim_id: 'claim_1',
      claim: 'A firm filed paperwork related to a stablecoin product.',
      evidence_refs: ['evidence_1'],
    }],
    verified_facts: [{
      fact: 'The filing page lists a submission dated July 4, 2026.',
      evidence_refs: ['evidence_1'],
    }],
    unresolved_claims: [{
      claim: 'The product launch timeline was not visible in primary records.',
      reason: 'No launch date was found in the checked documents.',
      evidence_refs: ['evidence_1'],
    }],
    entity_hints: [{
      name: 'Example Firm',
      type: 'organization',
      role: 'Article subject',
      aliases: ['Example'],
      source: 'article',
    }],
    evidence: [{
      evidence_id: 'evidence_1',
      title: 'Official filing page',
      url: 'https://example.com/filing',
      source_type: 'official_record',
      observed_at: now.toISOString(),
      note: 'Primary record checked for filing metadata.',
    }],
    open_questions: ['Whether the product has a confirmed launch date.'],
    limitations: ['Some article text was behind a paywall.'],
    errors: [],
    ...overrides,
  }
}

test('buildResearchRequest uses a persisted candidate observation row', () => {
  assert.equal(request.schema_version, 'myboon.hermes.research_request.v1')
  assert.equal(request.job_id, 'news_research_candidate-1_1783170000000')
  assert.equal(request.candidate_id, candidate.id)
  assert.equal(request.source.source_id, 'coindesk')
  assert.equal(request.source_url.url_id, 'latest_crypto_news')
  assert.equal(request.article.content_kind, 'article')
  assert.equal(request.article.article_url, rawCandidate.article_url)
  assert.equal(request.prior_observation.dedupe_outcome, 'new_candidate')
  assert.equal(request.response_rules.do_not_score_rank_or_filter, true)
  assert.equal(request.response_rules.do_not_make_editorial_decisions, true)
})

test('buildResearchPrompt preserves research boundary rules', () => {
  const prompt = buildResearchPrompt(request)

  assert.match(prompt, /source item is a signal, not the source of truth/)
  assert.match(prompt, /Separate source claims from externally verified facts/)
  assert.match(prompt, /untrusted_related_coin_ids only as weak search hints/)
  assert.match(prompt, /limitations and open questions/)
  assert.match(prompt, /Do not score, rank, judge importance, judge evidence quality/)
  assert.match(prompt, /Do not make editor or publisher decisions/)
  assert.match(prompt, /"schema_version": "myboon\.hermes\.research_request\.v1"/)
})

test('parseResearchResponse returns a valid response', () => {
  const parsed = parseResearchResponse(JSON.stringify(validResponse()), expected)

  assert.equal(parsed.job_id, request.job_id)
  assert.equal(parsed.candidate_id, candidate.id)
  assert.equal(parsed.source_id, 'coindesk')
  assert.equal(parsed.evidence[0].evidence_id, 'evidence_1')
})

test('parseResearchResponse normalizes structured error entries', () => {
  const parsed = parseResearchResponse(JSON.stringify({
    ...validResponse(),
    errors: [{
      source: 'browser',
      message: 'A page required verification.',
    }],
  }), expected)

  assert.deepEqual(parsed.errors, ['browser: A page required verification.'])
})

test('parseResearchResponse defaults missing errors to empty array', () => {
  const response = validResponse() as unknown as Record<string, unknown>
  delete response.errors

  const parsed = parseResearchResponse(JSON.stringify(response), expected)

  assert.deepEqual(parsed.errors, [])
})

test('parseResearchResponse defaults null errors to empty array', () => {
  const parsed = parseResearchResponse(JSON.stringify({
    ...validResponse(),
    errors: null,
  }), expected)

  assert.deepEqual(parsed.errors, [])
})

test('parseResearchResponse extracts valid JSON from wrapped stdout', () => {
  const parsed = parseResearchResponse([
    'I checked context first.',
    JSON.stringify({ note: 'not the response' }),
    'Final JSON:',
    JSON.stringify(validResponse()),
  ].join('\n'), expected)

  assert.equal(parsed.status, 'ready_for_entity_memory')
  assert.equal(parsed.verified_facts.length, 1)
})

test('parseResearchResponse rejects stdout with no JSON object', () => {
  assert.throws(
    () => parseResearchResponse('no structured output here', expected),
    /did not contain a JSON object/
  )
})

test('parseResearchResponse rejects wrong schema version', () => {
  assert.throws(
    () => parseResearchResponse(JSON.stringify({
      ...validResponse(),
      schema_version: 'wrong',
    }), expected),
    /schema_version/
  )
})

test('parseResearchResponse rejects wrong candidate ID', () => {
  assert.throws(
    () => parseResearchResponse(JSON.stringify({
      ...validResponse(),
      candidate_id: 'wrong-candidate',
    }), expected),
    /candidate_id/
  )
})

test('parseResearchResponse rejects wrong source ID', () => {
  assert.throws(
    () => parseResearchResponse(JSON.stringify({
      ...validResponse(),
      source_id: 'wrong-source',
    }), expected),
    /source_id/
  )
})

test('parseResearchResponse rejects wrong URL ID', () => {
  assert.throws(
    () => parseResearchResponse(JSON.stringify({
      ...validResponse(),
      url_id: 'wrong-url',
    }), expected),
    /url_id/
  )
})

test('parseResearchResponse rejects missing evidence', () => {
  const response = validResponse() as unknown as Record<string, unknown>
  delete response.evidence

  assert.throws(
    () => parseResearchResponse(JSON.stringify(response), expected),
    /evidence/
  )
})

test('parseResearchResponse rejects missing research summary', () => {
  const response = validResponse() as unknown as Record<string, unknown>
  delete response.research_summary

  assert.throws(
    () => parseResearchResponse(JSON.stringify(response), expected),
    /research_summary/
  )
})

test('parseResearchResponse rejects invalid status', () => {
  assert.throws(
    () => parseResearchResponse(JSON.stringify({
      ...validResponse(),
      status: 'pending_editor',
    }), expected),
    /status/
  )
})

test('parseResearchResponse rejects forbidden judgment and scoring fields', () => {
  assert.throws(
    () => parseResearchResponse(JSON.stringify({
      ...validResponse(),
      research_summary: {
        ...validResponse().research_summary,
        evidence_quality: 'strong',
      },
    }), expected),
    /forbidden field/
  )
})
