import type { NewsCandidateObservationRow } from './store'
import type { NewsResearchRequest, NewsResearchResponse } from './types'

const RESEARCH_REQUEST_SCHEMA = 'myboon.hermes.research_request.v1'
const RESEARCH_RESPONSE_SCHEMA = 'myboon.hermes.research_response.v1'

const FORBIDDEN_RESPONSE_FIELDS = new Set([
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

export interface ExpectedResearchResponse {
  jobId: string
  candidateId: string
  sourceId: string
  urlId: string
}

export function buildResearchRequest(
  candidate: NewsCandidateObservationRow,
  now = new Date()
): NewsResearchRequest {
  const requestedAt = now.toISOString()
  return {
    schema_version: RESEARCH_REQUEST_SCHEMA,
    job_id: `news_research_${candidate.id}_${now.getTime()}`,
    candidate_id: candidate.id,
    task: {
      type: 'source_aware_research',
      objective: 'Gather source-aware article context, claims, external evidence, entity hints, limitations, and open questions without editorial judgment.',
    },
    source: {
      source_id: candidate.sourceId,
      name: candidate.sourceName,
      source_type: 'curated_news',
    },
    source_url: {
      url_id: candidate.urlId,
      label: candidate.urlLabel,
      url: candidate.sourceUrl,
    },
    article: {
      content_kind: candidate.rawCandidate.content_kind ?? 'article',
      ...(candidate.rawCandidate.provider_id ? { provider_id: candidate.rawCandidate.provider_id } : {}),
      canonical_article_url: candidate.canonicalArticleUrl,
      article_url: candidate.rawCandidate.article_url,
      headline: candidate.headline,
      visible_summary: candidate.visibleSummary,
      published_at: candidate.publishedAt,
      observed_at: candidate.observedAt,
      ...(candidate.rawCandidate.author ? { author: candidate.rawCandidate.author } : {}),
      ...(candidate.rawCandidate.section ? { section: candidate.rawCandidate.section } : {}),
      ...(candidate.rawCandidate.upstream_source_name
        ? { upstream_source_name: candidate.rawCandidate.upstream_source_name }
        : {}),
      ...(candidate.rawCandidate.image_url ? { image_url: candidate.rawCandidate.image_url } : {}),
      ...(candidate.rawCandidate.related_coin_ids?.length
        ? { untrusted_related_coin_ids: [...candidate.rawCandidate.related_coin_ids] }
        : {}),
    },
    prior_observation: {
      dedupe_outcome: candidate.dedupeOutcome,
      article_identity_key: candidate.articleIdentityKey,
      observation_dedupe_key: candidate.observationDedupeKey,
      headline_hash: candidate.headlineHash,
      summary_hash: candidate.summaryHash,
      content_hash: candidate.contentHash,
    },
    research_requirements: {
      inspect_article: true,
      extract_article_claims: true,
      verify_with_external_evidence: true,
      collect_evidence_links: true,
      return_entity_hints: true,
      note_uncertainty: true,
    },
    response_rules: {
      return_json_only: true,
      do_not_publish: true,
      do_not_make_trade_recommendations: true,
      do_not_score_rank_or_filter: true,
      do_not_make_editorial_decisions: true,
    },
    requested_at: requestedAt,
  }
}

export function buildResearchPrompt(request: NewsResearchRequest): string {
  return [
    'You are the myboon source-aware news researcher.',
    '',
    'The source item is a signal, not the source of truth. It may be an article or a social post; preserve that distinction.',
    '',
    'Task:',
    'Inspect the source item and gather external evidence only when it helps verify or contextualize its claims.',
    'Separate source claims from externally verified facts and unresolved or disputed claims.',
    'Treat untrusted_related_coin_ids only as weak search hints. Never use them as entity identity without independent evidence.',
    'Prefer primary sources, official records, direct article URLs, named analytics sources, on-chain data, filings, regulator pages, project/team statements, and other attributable sources when relevant.',
    'Preserve source context and provenance.',
    'If data is blocked, unavailable, paywalled, or inconclusive, return factual limitations and open questions.',
    '',
    'Rules:',
    '- Return JSON only whenever possible.',
    '- Do not publish.',
    '- Do not give trade recommendations.',
    '- Do not score, rank, judge importance, judge evidence quality, or decide if this is feed-worthy.',
    '- Do not make editor or publisher decisions.',
    '- Do not use fields such as score, relevance_score, rank, importance, risk_level, confidence, evidence_quality, catalyst_found, recommended_editor_action, publish, or reject.',
    '',
    'Request JSON:',
    JSON.stringify(request, null, 2),
    '',
    'Return schema:',
    JSON.stringify(exampleResearchResponse(request), null, 2),
  ].join('\n')
}

export function parseResearchResponse(
  stdout: string,
  expected: ExpectedResearchResponse
): NewsResearchResponse {
  const parsed = extractJsonObject(stdout)
  if (!isRecord(parsed)) throw new Error('Research response must be a JSON object')

  rejectForbiddenFields(parsed)
  if (parsed.schema_version !== RESEARCH_RESPONSE_SCHEMA) {
    throw new Error(`Research response schema_version must be ${RESEARCH_RESPONSE_SCHEMA}`)
  }
  if (parsed.job_id !== expected.jobId) throw new Error('Research response job_id did not match request')
  if (parsed.candidate_id !== expected.candidateId) throw new Error('Research response candidate_id did not match request')
  if (parsed.source_id !== expected.sourceId) throw new Error('Research response source_id did not match request')
  if (parsed.url_id !== expected.urlId) throw new Error('Research response url_id did not match request')
  if (!isResearchStatus(parsed.status)) throw new Error('Research response status is invalid')

  validateSourceSignal(parsed.source_signal)
  validateResearchSummary(parsed.research_summary)
  validateArrayField(parsed, 'article_claims')
  validateArrayField(parsed, 'verified_facts')
  validateArrayField(parsed, 'unresolved_claims')
  validateArrayField(parsed, 'entity_hints')
  validateEvidence(parsed.evidence)
  validateStringArrayField(parsed, 'open_questions')
  validateStringArrayField(parsed, 'limitations')
  normalizeErrors(parsed)
  validateStringArrayField(parsed, 'errors')

  return parsed as unknown as NewsResearchResponse
}

function exampleResearchResponse(request: NewsResearchRequest): NewsResearchResponse {
  return {
    schema_version: RESEARCH_RESPONSE_SCHEMA,
    job_id: request.job_id,
    candidate_id: request.candidate_id,
    source_id: request.source.source_id,
    url_id: request.source_url.url_id,
    status: 'ready_for_entity_memory',
    source_signal: {
      source_name: request.source.name,
      source_url: request.source_url.url,
      article_url: request.article.article_url,
      canonical_article_url: request.article.canonical_article_url,
      headline: request.article.headline,
      visible_summary: request.article.visible_summary,
      published_at: request.article.published_at,
      observed_at: request.article.observed_at,
    },
    research_summary: {
      one_liner: 'Neutral summary of what was checked and what context was found.',
      what_was_checked: ['Article page', 'Primary source or external context page'],
      requires_followup: false,
    },
    article_claims: [{
      claim_id: 'claim_1',
      claim: 'Claim stated or implied by the article.',
      attributed_to: 'Article or named speaker if visible',
      evidence_refs: ['evidence_1'],
    }],
    verified_facts: [{
      fact: 'Externally supported fact relevant to the article claim.',
      evidence_refs: ['evidence_1'],
    }],
    unresolved_claims: [{
      claim: 'Claim that could not be verified from available evidence.',
      reason: 'Factual reason verification was unavailable or inconclusive.',
      evidence_refs: [],
    }],
    entity_hints: [{
      name: 'Entity name observed in article or evidence',
      type: 'organization',
      role: 'Contextual role in this signal',
      aliases: [],
      source: 'article',
    }],
    evidence: [{
      evidence_id: 'evidence_1',
      title: 'Evidence title',
      url: 'https://example.com/evidence',
      source_type: 'primary_source',
      observed_at: request.requested_at,
      note: 'How this evidence relates to a claim or context.',
    }],
    open_questions: [],
    limitations: [],
    errors: [],
  }
}

function validateSourceSignal(value: unknown): void {
  if (!isRecord(value)) throw new Error('Research response missing source_signal')
  for (const key of ['source_name', 'source_url', 'article_url', 'canonical_article_url', 'headline', 'observed_at']) {
    if (typeof value[key] !== 'string' || !value[key]) {
      throw new Error(`Research response source_signal.${key} must be a non-empty string`)
    }
  }
  for (const key of ['visible_summary', 'published_at']) {
    if (value[key] != null && typeof value[key] !== 'string') {
      throw new Error(`Research response source_signal.${key} must be a string or null`)
    }
  }
}

function validateResearchSummary(value: unknown): void {
  if (!isRecord(value)) throw new Error('Research response missing research_summary')
  if (typeof value.one_liner !== 'string' || !value.one_liner) {
    throw new Error('Research response research_summary.one_liner must be a non-empty string')
  }
  if (!Array.isArray(value.what_was_checked) || !value.what_was_checked.every((item) => typeof item === 'string')) {
    throw new Error('Research response research_summary.what_was_checked must be a string array')
  }
  if (typeof value.requires_followup !== 'boolean') {
    throw new Error('Research response research_summary.requires_followup must be boolean')
  }
  if (value.followup_reason != null && typeof value.followup_reason !== 'string') {
    throw new Error('Research response research_summary.followup_reason must be a string when present')
  }
}

function validateEvidence(value: unknown): void {
  if (!Array.isArray(value)) throw new Error('Research response evidence must be an array')
  value.forEach((item, index) => {
    if (!isRecord(item)) throw new Error(`Research response evidence ${index} must be an object`)
    for (const key of ['evidence_id', 'title', 'url']) {
      if (typeof item[key] !== 'string' || !item[key]) {
        throw new Error(`Research response evidence ${index}.${key} must be a non-empty string`)
      }
    }
  })
}

function validateArrayField(record: Record<string, unknown>, key: string): void {
  if (!Array.isArray(record[key])) throw new Error(`Research response ${key} must be an array`)
}

function validateStringArrayField(record: Record<string, unknown>, key: string): void {
  const value = record[key]
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) {
    throw new Error(`Research response ${key} must be a string array`)
  }
}

function normalizeErrors(record: Record<string, unknown>): void {
  const value = record.errors
  if (value == null) {
    record.errors = []
    return
  }
  if (!Array.isArray(value)) return

  record.errors = value.map((item) => {
    if (typeof item === 'string') return item
    if (!isRecord(item)) return item

    const source = typeof item.source === 'string' && item.source.trim()
      ? item.source.trim()
      : null
    const message = typeof item.message === 'string' && item.message.trim()
      ? item.message.trim()
      : JSON.stringify(item)
    return source ? `${source}: ${message}` : message
  })
}

function rejectForbiddenFields(value: unknown, path = 'response'): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => rejectForbiddenFields(item, `${path}[${index}]`))
    return
  }
  if (!isRecord(value)) return

  for (const [key, nested] of Object.entries(value)) {
    if (FORBIDDEN_RESPONSE_FIELDS.has(key)) {
      throw new Error(`Research response contains forbidden field ${path}.${key}`)
    }
    rejectForbiddenFields(nested, `${path}.${key}`)
  }
}

function extractJsonObject(stdout: string): unknown {
  let sawObjectCandidate = false
  let firstParsedObject: Record<string, unknown> | null = null

  for (let start = 0; start < stdout.length; start += 1) {
    if (stdout[start] !== '{') continue
    sawObjectCandidate = true
    const end = findJsonObjectEnd(stdout, start)
    if (end == null) continue

    try {
      const parsed = JSON.parse(stdout.slice(start, end + 1))
      if (isRecord(parsed)) {
        if (!firstParsedObject) firstParsedObject = parsed
        if (parsed.schema_version === RESEARCH_RESPONSE_SCHEMA) return parsed
      }
    } catch {
      // Hermes may print prose with braces before the JSON response.
    }
  }

  if (firstParsedObject) return firstParsedObject
  if (sawObjectCandidate) throw new Error('Research response did not contain a valid JSON object')
  throw new Error('Research response did not contain a JSON object')
}

function findJsonObjectEnd(text: string, start: number): number | null {
  let depth = 0
  let inString = false
  let escape = false

  for (let index = start; index < text.length; index += 1) {
    const ch = text[index]
    if (escape) {
      escape = false
      continue
    }
    if (ch === '\\' && inString) {
      escape = true
      continue
    }
    if (ch === '"') {
      inString = !inString
      continue
    }
    if (inString) continue

    if (ch === '{') depth += 1
    if (ch === '}') depth -= 1
    if (depth === 0) return index
  }

  return null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isResearchStatus(value: unknown): value is NewsResearchResponse['status'] {
  return value === 'ready_for_entity_memory' || value === 'needs_followup' || value === 'failed'
}

export const __researchContractTesting = {
  RESEARCH_REQUEST_SCHEMA,
  RESEARCH_RESPONSE_SCHEMA,
  extractJsonObject,
}
