import assert from 'node:assert/strict'
import test from 'node:test'
import type { NewsCandidateObservationRow, NewsResearchResultRow } from '../../news/store'
import type { PipelineCandidateRow, PipelineResearchRow } from '../../pipeline-store/store'
import { adaptLegacyNewsPacket, adaptLegacyNewsSignal, adaptLegacyNewsWork } from './news'
import { adaptLegacyPolymarketPacket, adaptLegacyPolymarketSignal, adaptLegacyPolymarketWork } from './polymarket'
import { adaptLivePolymarketSignal, type PolymarketLiveSignalInput } from './polymarket-live'
import type { LegacyPacketMigrationPolicy, LegacyWorkMigrationPolicy } from './migration-policy'

const workPolicy: LegacyWorkMigrationPolicy = {
  policyVersion: 'migration-v1',
  researchDepth: 'standard',
  deepReason: null,
  priorityClass: 'P1',
  priorityScore: 0.8,
  freshnessDeadline: '2026-08-26T13:00:00.000Z',
  retrievalPlan: { sourceUrl: 'https://example.com/article', allowedDomains: ['example.com'], maxExternalSources: 2 },
  budget: {
    maxProviderCalls: 1, maxRepairCalls: 1, maxInputTokens: 2000,
    maxOutputTokens: 1000, maxToolCalls: 0, maxWallTimeMs: 60_000,
  },
  status: 'research_pending',
  attemptCount: 0,
  nextAttemptAt: null,
  leaseOwner: null,
  leaseId: null,
  leaseExpiresAt: null,
  failureCategory: null,
  failureDetail: null,
  traceId: 'trace-migration',
  createdAt: '2026-08-26T12:00:00.000Z',
  updatedAt: '2026-08-26T12:00:00.000Z',
}

const packetPolicy: LegacyPacketMigrationPolicy = {
  budgetUsed: {
    providerCalls: 1, repairCalls: 0, inputTokens: 100, outputTokens: 50,
    toolCalls: 0, wallTimeMs: 1000, budgetExceeded: false,
  },
  execution: {
    provider: 'legacy', model: 'legacy-model', fallbackProvider: null, fallbackModel: null,
    fallbackUsed: false, promptVersion: 'legacy-prompt', policyVersion: 'migration-v1',
    traceId: 'trace-migration', attempt: 1,
  },
  createdAt: '2026-08-26T12:05:00.000Z',
}

const newsCandidate: NewsCandidateObservationRow = {
  id: 'news-row', sourceRunId: 'run', sourceId: 'source', sourceName: 'Outlet',
  urlId: 'url', urlLabel: 'Top', sourceUrl: 'https://example.com',
  canonicalArticleUrl: 'https://example.com/article', headline: 'Material news',
  visibleSummary: 'Summary', publishedAt: '2026-08-26T11:55:00.000Z',
  observedAt: '2026-08-26T12:00:00.000Z', headlineHash: 'hh', summaryHash: 'sh',
  contentHash: 'ch', articleIdentityKey: 'article-key', observationDedupeKey: 'observation-key',
  dedupeOutcome: 'new_candidate', status: 'pending_research', lastResearchJobId: null,
  researchWorkerStatus: null, researchError: null, researchRawResponse: null, researchStderr: null,
  rawCandidate: {
    headline: 'Material news', article_url: 'https://example.com/article?utm_source=x',
    content_kind: 'article', provider_id: 'aggregator', upstream_source_name: 'Outlet',
    related_coin_ids: ['btc'], image_url: 'https://example.com/image.jpg',
  },
  createdAt: '2026-08-26T12:00:00.000Z', updatedAt: '2026-08-26T12:00:00.000Z',
}

const polymarketCandidate: PipelineCandidateRow = {
  id: 'poly-row', source: 'polymarket', area: 'crypto', candidateType: 'probability_move',
  marketId: 'market-1', slug: 'will-it-happen', title: 'Will it happen?', tagSlug: 'crypto',
  tagLabel: 'Crypto', observedAt: '2026-08-26T12:00:00.000Z', whatChanged: 'Price moved',
  whyFlagged: 'Material change', score: 0.9, scoreBreakdown: { movement: 1 }, metrics: { yes: 0.7 },
  evidenceRefs: [], status: 'pending_research', dedupeKey: 'poly-dedupe', researchError: null,
  researchAttemptedAt: null, researchRetryCount: 0, researchNextRetryAt: null,
  researchLastErrorKind: null, researchFamilyKey: null, researchClusterKey: null,
  researchDepth: null, leaseOwner: null, leaseExpiresAt: null, attemptCount: 0,
  createdAt: '2026-08-26T12:00:00.000Z', updatedAt: '2026-08-26T12:00:00.000Z',
}

test('News adapter is deterministic and preserves identity, provenance, and source limitations', () => {
  const first = adaptLegacyNewsSignal(newsCandidate)
  const second = adaptLegacyNewsSignal(structuredClone(newsCandidate))
  assert.deepEqual(first, second)
  assert.equal(first.contentKind, 'article')
  assert.equal(first.content.schemaVersion, 'myboon.signal_content.article.v1')
  assert.equal(first.provenance.rawPayloadRef, 'news-row')
  assert.deepEqual(first.sourceHints.assets, ['btc'])
  const work = adaptLegacyNewsWork(newsCandidate, workPolicy)
  assert.equal(work.policyVersion, 'migration-v1')
  assert.equal(work.signalId, first.signalId)
})

test('Polymarket adapter emits market_event and preserves mutable-thread limitations', () => {
  const signal = adaptLegacyPolymarketSignal(polymarketCandidate)
  assert.equal(signal.contentKind, 'market_event')
  assert.equal(signal.content.schemaVersion, 'myboon.signal_content.market_event.v1')
  assert.equal(signal.sourceHints.eventId, 'market-1')
  assert.ok((signal.migration as { limitations: string[] }).limitations.includes(
    'legacy_polymarket_candidate_is_a_mutable_thread_snapshot',
  ))
  assert.equal(adaptLegacyPolymarketWork(polymarketCandidate, workPolicy).signalId, signal.signalId)
})

test('live Polymarket identity ignores polling time but changes for material facts or upstream updates', () => {
  const input: PolymarketLiveSignalInput = {
    observedAt: '2026-08-26T12:00:00.000Z', area: 'markets',
    market: {
      marketId: 'market-1', slug: 'market-one', title: 'Market one?', tagSlug: 'crypto',
      tagLabel: 'Crypto', endDate: null, sourceUpdatedAt: '2026-08-26T11:59:00.000Z',
    },
    observation: {
      candidateType: 'odds_moved', whatChanged: 'Odds moved six points', whyFlagged: 'material move',
      score: 72, scoreBreakdown: {}, metrics: { oddsDelta: 0.06 }, evidenceRefs: [],
    },
  }
  const first = adaptLivePolymarketSignal(input)
  const laterPoll = adaptLivePolymarketSignal({ ...input, observedAt: '2026-08-26T12:05:00.000Z' })
  const changed = adaptLivePolymarketSignal({
    ...input,
    observation: { ...input.observation, whatChanged: 'Odds moved twelve points', metrics: { oddsDelta: 0.12 } },
  })
  const upstreamUpdate = adaptLivePolymarketSignal({
    ...input,
    market: { ...input.market, sourceUpdatedAt: '2026-08-26T12:04:00.000Z' },
  })
  assert.deepEqual(laterPoll, first)
  assert.notEqual(changed.signalId, first.signalId)
  assert.notEqual(upstreamUpdate.signalId, first.signalId)
  assert.equal(first.observedAt, input.market.sourceUpdatedAt)
})

test('News packet maps structured fields and explicitly records invalid legacy evidence', () => {
  const work = adaptLegacyNewsWork(newsCandidate, workPolicy)
  const rawResponse = {
    schema_version: 'myboon.hermes.research_response.v1' as const,
    job_id: 'job', candidate_id: newsCandidate.id, source_id: 'source', url_id: 'url',
    status: 'needs_followup' as const,
    source_signal: {
      source_name: 'Outlet', source_url: 'https://example.com', article_url: 'https://example.com/article',
      canonical_article_url: 'https://example.com/article', headline: 'Material news', visible_summary: 'Summary',
      published_at: newsCandidate.publishedAt, observed_at: newsCandidate.observedAt,
    },
    research_summary: { one_liner: 'Summary', what_was_checked: ['source'], requires_followup: true },
    article_claims: [{ claim_id: 'c1', claim: 'Claim' }],
    verified_facts: [{ fact: 'Fact', evidence_refs: ['e1'] }],
    unresolved_claims: [{ claim: 'Open', reason: 'Unknown' }],
    entity_hints: [{ name: 'Bitcoin', type: 'asset' }],
    evidence: [
      { evidence_id: 'e1', title: 'Valid', url: 'https://example.com/evidence' },
      { evidence_id: 'bad', title: 'Bad', url: 'file:///etc/passwd' },
    ],
    open_questions: ['What next?'], limitations: [], errors: [],
  }
  const row = {
    id: 'news-result', candidateObservationId: newsCandidate.id, sourceId: 'source', sourceName: 'Outlet',
    urlId: 'url', urlLabel: 'Top', sourceUrl: 'https://example.com', canonicalArticleUrl: 'https://example.com/article',
    articleIdentityKey: 'article-key', observationDedupeKey: 'observation-key', researchJobId: 'job',
    status: 'not_ready_for_entity_memory', responseStatus: rawResponse.status,
    sourceSignal: rawResponse.source_signal, researchSummary: rawResponse.research_summary,
    articleClaims: rawResponse.article_claims, verifiedFacts: rawResponse.verified_facts,
    unresolvedClaims: rawResponse.unresolved_claims, entityHints: rawResponse.entity_hints,
    evidence: rawResponse.evidence, openQuestions: rawResponse.open_questions,
    limitations: rawResponse.limitations, errors: rawResponse.errors, rawResponse,
    researchedAt: packetPolicy.createdAt, createdAt: packetPolicy.createdAt, updatedAt: packetPolicy.createdAt,
  } as NewsResearchResultRow
  const packet = adaptLegacyNewsPacket(row, newsCandidate, work, packetPolicy)
  assert.equal(packet.completion, 'partial')
  assert.equal(packet.evidence.length, 1)
  assert.ok(packet.limitations.includes('legacy_evidence_with_invalid_url_omitted'))
})

test('Polymarket packet retains legacy context and states structural limitations', () => {
  const work = adaptLegacyPolymarketWork(polymarketCandidate, workPolicy)
  const row = {
    id: 'poly-result', candidateId: polymarketCandidate.id, source: 'polymarket', area: 'crypto',
    slug: polymarketCandidate.slug, title: polymarketCandidate.title, candidateType: polymarketCandidate.candidateType,
    researchMode: 'deep', summary: 'Summary', notes: 'Notes', keyFindings: ['finding'],
    evidenceLinks: [{ title: 'Source', url: 'https://example.com/source' }],
    relatedContext: [{ kind: 'research_packet', claims_found: [{ claim: 'Claim' }], verified_facts: ['Fact'],
      unverified_claims: ['Open'], entities_mentioned: ['Entity'], open_questions: ['Question'] }],
    uncertainty: 'Legacy uncertainty', editorNotes: '', status: 'pending_editor', researchedAt: packetPolicy.createdAt,
    researchFamilyKey: 'family', researchClusterKey: 'cluster', researchDepth: 'deep_web', evidenceQuality: 'strong',
    catalystFound: true, recommendedEditorAction: 'publish_candidate', duplicateOfResearchId: null,
    researchBackend: 'legacy', researchModel: 'model', entityManagerStatus: 'pending', entityManagerAttemptCount: 0,
    entityManagerNextRetryAt: null, createdAt: packetPolicy.createdAt, updatedAt: packetPolicy.createdAt,
  } as unknown as PipelineResearchRow
  const packet = adaptLegacyPolymarketPacket(row, polymarketCandidate, work, packetPolicy)
  assert.equal(packet.claims.length, 1)
  assert.equal(packet.verifiedFacts.length, 1)
  assert.equal(packet.entityHints[0]?.name, 'Entity')
  assert.ok(packet.limitations.includes('legacy_polymarket_candidate_is_a_mutable_thread_snapshot'))
})
