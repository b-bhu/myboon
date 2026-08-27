import assert from 'node:assert/strict'
import test from 'node:test'

import type { NewsSignal, ResearchWorkItem } from '../signal-platform/contracts'
import { BoundedStandardSearch, SearchConnectorRegistry, type RegisteredSearchConnector } from './search-connector'

const signal: NewsSignal = {
  schemaVersion: 'myboon.signal.v1', signalId: 'signal-1', sourceType: 'news', sourceId: 'source-1',
  contentKind: 'article', content: { schemaVersion: 'myboon.signal_content.article.v1' },
  observedAt: '2026-08-26T12:00:00.000Z', publishedAt: null, canonicalUrl: 'https://source.example/story',
  title: 'Example earnings', visibleSummary: null, media: { imageUrl: null, attribution: null },
  sourceHints: { entities: [], assets: [], eventId: null, deadline: null },
  provenance: { provider: 'test', upstreamSource: null, rawPayloadRef: 'raw-1' }, idempotencyKey: 'key-1',
}

function work(overrides: Partial<ResearchWorkItem> = {}): ResearchWorkItem {
  return {
    schemaVersion: 'myboon.research_work.v1', workId: 'work-1', signalId: signal.signalId, sourceType: 'news',
    researchDepth: 'standard', deepReason: null, priorityClass: 'P1', priorityScore: 0.8,
    freshnessDeadline: '2026-08-26T14:00:00.000Z', policyVersion: 'policy-v1',
    researchContractVersion: 'myboon.research_packet.v1',
    retrievalPlan: { sourceUrl: signal.canonicalUrl, allowedDomains: ['source.example', 'sec.gov'], maxExternalSources: 3 },
    budget: { maxProviderCalls: 1, maxRepairCalls: 1, maxInputTokens: 10_000, maxOutputTokens: 2_000, maxToolCalls: 0, maxWallTimeMs: 60_000 },
    status: 'research_pending', attemptCount: 0, nextAttemptAt: null, leaseOwner: null, leaseId: null,
    leaseExpiresAt: null, failureCategory: null, failureDetail: null, traceId: 'trace-1',
    createdAt: signal.observedAt, updatedAt: signal.observedAt, ...overrides,
  }
}

function fixture(results: Awaited<ReturnType<RegisteredSearchConnector['search']>>) {
  const calls: unknown[] = []
  const connector: RegisteredSearchConnector = {
    connectorId: 'official-search',
    async search(input) { calls.push(input); return results },
  }
  const search = new BoundedStandardSearch(new SearchConnectorRegistry([connector]), {
    policyVersion: 'search-v1', connectorId: connector.connectorId, maxQueries: 1,
    maxResultsPerQuery: 3, maxQueryChars: 120, timeoutMs: 2_000,
  })
  return { search, calls }
}

test('standard discovery is bounded, allowlisted, deduplicated, and source-cap aware', async () => {
  const f = fixture([
    { url: 'https://www.sec.gov/filing', title: 'Filing', providerResultId: '1' },
    { url: 'https://evil.example/item', title: 'Bad', providerResultId: '2' },
    { url: 'https://www.sec.gov/filing', title: 'Duplicate', providerResultId: '3' },
  ])
  const plan = await f.search.discover({ signal, work: work(), queries: ['  Example   earnings filing ', 'ignored'] })
  assert.equal(plan.queryCount, 1)
  assert.deepEqual(plan.urls, [{
    url: 'https://www.sec.gov/filing', authority: 'search_connector', authorityId: 'official-search:1',
  }])
  assert.equal(f.calls.length, 1)
})

test('light and deep research cannot invoke the standard search connector', async () => {
  const f = fixture([])
  for (const researchDepth of ['light', 'deep'] as const) {
    await assert.rejects(f.search.discover({
      signal,
      work: work({ researchDepth, deepReason: researchDepth === 'deep' ? 'manual_analyst_request' : null }),
      queries: ['query'],
    }), /only for standard/)
  }
  assert.equal(f.calls.length, 0)
})

test('external capacity does not subtract the canonical source URL', async () => {
  const f = fixture([{ url: 'https://sec.gov/item', title: null, providerResultId: '1' }])
  const plan = await f.search.discover({
    signal, work: work({ retrievalPlan: { sourceUrl: signal.canonicalUrl, allowedDomains: ['sec.gov'], maxExternalSources: 1 } }),
    queries: ['query'],
  })
  assert.equal(plan.queryCount, 1)
  assert.equal(plan.urls.length, 1)
  assert.equal(f.calls.length, 1)
})

test('zero external capacity makes zero connector calls', async () => {
  const f = fixture([{ url: 'https://sec.gov/item', title: null, providerResultId: '1' }])
  const plan = await f.search.discover({
    signal, work: work({ retrievalPlan: { sourceUrl: signal.canonicalUrl, allowedDomains: ['sec.gov'], maxExternalSources: 0 } }),
    queries: ['query'],
  })
  assert.equal(plan.queryCount, 0)
  assert.deepEqual(plan.urls, [])
  assert.equal(f.calls.length, 0)
})

test('connector overproduction and unregistered connector fail closed', async () => {
  const tooMany = fixture(Array.from({ length: 4 }, (_, index) => ({
    url: `https://sec.gov/${index}`, title: null, providerResultId: String(index),
  })))
  await assert.rejects(tooMany.search.discover({ signal, work: work(), queries: ['query'] }), /result budget/)
  const missing = new BoundedStandardSearch(new SearchConnectorRegistry([]), {
    policyVersion: 'v1', connectorId: 'missing', maxQueries: 1, maxResultsPerQuery: 1,
    maxQueryChars: 100, timeoutMs: 1000,
  })
  await assert.rejects(missing.discover({ signal, work: work(), queries: ['query'] }), /unavailable/)
})
