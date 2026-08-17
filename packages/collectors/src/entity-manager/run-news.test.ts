import assert from 'node:assert/strict'
import test from 'node:test'
import { fingerprintNewsCandidate } from '../news/fingerprint'
import { SqliteNewsStore } from '../news/sqlite-store'
import type { NewsCandidateObservationRow } from '../news/store'
import type { NewsResearchResponse, NewsCandidate } from '../news/types'
import { TEST_NEWS_SOURCE, TEST_NEWS_SOURCE_URL } from '../news/tests/fixtures'
import { InMemoryEntityMemoryStore } from './test-helpers'
import { fetchUnprocessedNewsPackets, runNewsEntityManager } from './run-news'
import type { EntityMemoryExtraction, ExtractionProvider, ResearchPacket } from './types'

const source = TEST_NEWS_SOURCE
const sourceUrl = TEST_NEWS_SOURCE_URL
const observedAt = '2026-07-04T12:00:00.000Z'

class CapturingExtractionProvider implements ExtractionProvider {
  packets: ResearchPacket[] = []

  constructor(private readonly extraction: EntityMemoryExtraction | Error) {}

  async extract(packet: ResearchPacket): Promise<EntityMemoryExtraction> {
    this.packets.push(packet)
    if (this.extraction instanceof Error) throw this.extraction
    return this.extraction
  }
}

class StatusUpdateFailingNewsStore extends SqliteNewsStore {
  async markResearchResultStatus(id: string, status: Parameters<SqliteNewsStore['markResearchResultStatus']>[1]): Promise<void> {
    if (status === 'handed_to_entity_memory') {
      throw new Error('local status update failed')
    }
    return super.markResearchResultStatus(id, status)
  }
}

function withNewsStore(fn: (store: SqliteNewsStore) => Promise<void> | void): Promise<void> {
  const store = new SqliteNewsStore(':memory:')
  return Promise.resolve()
    .then(() => fn(store))
    .finally(() => store.close())
}

function candidate(overrides: Partial<NewsCandidate> = {}): NewsCandidate {
  return {
    headline: 'Ethereum treasury article',
    article_url: 'https://www.coindesk.com/markets/2026/07/04/ethereum-treasury-article?utm_source=x',
    summary: 'Observed article summary.',
    published_at: '2026-07-04T11:00:00.000Z',
    evidence: ['article card'],
    ...overrides,
  }
}

async function insertResearchResult(
  store: SqliteNewsStore,
  inputCandidate = candidate(),
  responseOverrides: Partial<NewsResearchResponse> = {}
): Promise<Awaited<ReturnType<SqliteNewsStore['insertResearchResult']>>> {
  const [storedCandidate] = await store.insertCandidateObservations([{
    source,
    sourceUrl,
    candidate: inputCandidate,
    fingerprint: fingerprintNewsCandidate(source.sourceId, sourceUrl.urlId, inputCandidate),
    dedupeOutcome: 'new_candidate',
    observedAt,
  }])
  return store.insertResearchResult({
    candidate: storedCandidate,
    response: researchResponse(storedCandidate, responseOverrides),
    researchedAt: '2026-07-04T13:00:00.000Z',
  })
}

function researchResponse(
  storedCandidate: NewsCandidateObservationRow,
  overrides: Partial<NewsResearchResponse> = {}
): NewsResearchResponse {
  return {
    schema_version: 'myboon.hermes.research_response.v1',
    job_id: `research-${storedCandidate.id}`,
    candidate_id: storedCandidate.id,
    source_id: storedCandidate.sourceId,
    url_id: storedCandidate.urlId,
    status: 'ready_for_entity_memory',
    source_signal: {
      source_name: storedCandidate.sourceName,
      source_url: storedCandidate.sourceUrl,
      article_url: storedCandidate.rawCandidate.article_url,
      canonical_article_url: storedCandidate.canonicalArticleUrl,
      headline: storedCandidate.headline,
      visible_summary: storedCandidate.visibleSummary,
      published_at: storedCandidate.publishedAt,
      observed_at: storedCandidate.observedAt,
    },
    research_summary: {
      one_liner: 'Research gathered article context.',
      what_was_checked: ['Article page'],
      requires_followup: false,
    },
    article_claims: [{ claim_id: 'claim_1', claim: 'Article claim.' }],
    verified_facts: [{ fact: 'Verified fact.', evidence_refs: ['evidence_1'] }],
    unresolved_claims: [],
    entity_hints: [{ name: 'Ethereum', source: 'article' }],
    evidence: [{ evidence_id: 'evidence_1', title: 'Evidence', url: 'https://example.com/evidence' }],
    open_questions: [],
    limitations: [],
    errors: [],
    ...overrides,
  }
}

function extraction(): EntityMemoryExtraction {
  return {
    primaryEntities: [{
      name: 'Ethereum',
      type: 'asset',
      slug: 'ethereum',
      aliases: ['ETH'],
      summary: 'Ethereum asset.',
      createIfMissing: true,
    }],
    memories: [{
      entitySlug: 'ethereum',
      memoryType: 'news_event',
      title: 'Ethereum treasury article observed',
      summary: 'CoinDesk article context was gathered for Ethereum.',
      body: 'Neutral source context.',
      observedAt,
      evidence: [{ url: 'https://example.com/evidence' }],
      mentions: ['CoinDesk'],
      metrics: { articleClaimCount: 1 },
      context: { source: 'news' },
    }],
  }
}

test('fetchUnprocessedNewsPackets adapts pending local news research into ResearchPacket', async () => {
  await withNewsStore(async (newsStore) => {
    const entityStore = new InMemoryEntityMemoryStore()
    const result = await insertResearchResult(newsStore)

    const packets = await fetchUnprocessedNewsPackets({
      newsStore,
      entityStore,
      batchSize: 10,
    })

    assert.equal(packets.length, 1)
    assert.equal(packets[0].result.id, result.id)
    assert.equal(packets[0].packet.source, 'news')
    assert.equal(packets[0].packet.sourceArea, source.sourceId)
    assert.equal(packets[0].packet.sourceResearchId, result.id)
    assert.equal(packets[0].packet.sourceType, 'article')
    assert.equal(packets[0].packet.sourceRefId, result.canonicalArticleUrl)
  })
})

test('fetchUnprocessedNewsPackets ignores non-ready research results', async () => {
  await withNewsStore(async (newsStore) => {
    const entityStore = new InMemoryEntityMemoryStore()
    const result = await insertResearchResult(
      newsStore,
      candidate({ article_url: 'https://www.coindesk.com/needs-followup' }),
      {
        status: 'needs_followup',
        research_summary: {
          one_liner: 'Research needs followup.',
          what_was_checked: ['Article'],
          requires_followup: true,
        },
        open_questions: ['Need original source.'],
      }
    )

    const packets = await fetchUnprocessedNewsPackets({
      newsStore,
      entityStore,
      batchSize: 10,
    })

    assert.deepEqual(packets, [])
    assert.equal((await newsStore.fetchResearchResult(result.id))?.status, 'not_ready_for_entity_memory')
  })
})

test('runNewsEntityManager writes entity memory and local handed-off status without a source_marker row', async () => {
  await withNewsStore(async (newsStore) => {
    const entityStore = new InMemoryEntityMemoryStore()
    const provider = new CapturingExtractionProvider(extraction())
    const resultRow = await insertResearchResult(newsStore)

    const result = await runNewsEntityManager({
      newsStore,
      entityStore,
      extractionProvider: provider,
      batchSize: 10,
    })

    assert.equal(result.fetched, 1)
    assert.equal(result.processed, 1)
    assert.equal(result.failed, 0)
    assert.equal(result.skippedAlreadyMarked, 0)
    assert.equal(provider.packets.length, 1)
    assert.equal(provider.packets[0].sourceResearchId, resultRow.id)
    assert.equal(result.results[0].markerStatus, 'processed')

    const stored = await newsStore.fetchResearchResult(resultRow.id)
    assert.equal(stored?.status, 'handed_to_entity_memory')
    assert.equal((await newsStore.fetchCandidateObservation(resultRow.candidateObservationId))?.status, 'handed_to_entity_memory')

    const normalMemory = entityStore.memories.find((memory) => memory.title === 'Ethereum treasury article observed')
    assert.equal(normalMemory?.memory_type, 'news_event')
    // entity_memories forbids memory_type = 'source_marker' post-migration:
    // the "processed" outcome is reported via result.results[0].markerStatus
    // above and via the news lane's own local status, not a persisted marker row.
    assert.equal(entityStore.memories.some((memory) => memory.memory_type === 'source_marker'), false)
  })
})

test('runNewsEntityManager writes local failed status without a source_marker row when extraction fails', async () => {
  await withNewsStore(async (newsStore) => {
    const entityStore = new InMemoryEntityMemoryStore()
    const provider = new CapturingExtractionProvider(new Error('extract failed'))
    const resultRow = await insertResearchResult(newsStore)

    const result = await runNewsEntityManager({
      newsStore,
      entityStore,
      extractionProvider: provider,
      batchSize: 10,
    })

    assert.equal(result.fetched, 1)
    assert.equal(result.processed, 0)
    assert.equal(result.failed, 1)
    assert.equal(result.failures[0].sourceResearchId, resultRow.id)
    assert.match(result.failures[0].error, /extract failed/)
    assert.equal(result.memoriesWritten, 0)

    const stored = await newsStore.fetchResearchResult(resultRow.id)
    assert.equal(stored?.status, 'failed_entity_memory')
    assert.equal(entityStore.memories.some((memory) => memory.memory_type === 'source_marker'), false)
  })
})

test('runNewsEntityManager does not write a source_marker row when local handed-off status update fails', async () => {
  const newsStore = new StatusUpdateFailingNewsStore(':memory:')
  try {
    const entityStore = new InMemoryEntityMemoryStore()
    const provider = new CapturingExtractionProvider(extraction())
    const resultRow = await insertResearchResult(newsStore)

    const result = await runNewsEntityManager({
      newsStore,
      entityStore,
      extractionProvider: provider,
      batchSize: 10,
    })

    assert.equal(result.fetched, 1)
    assert.equal(result.processed, 1)
    assert.equal(result.failed, 0)
    assert.equal(result.failures.length, 1)
    assert.equal(result.failures[0].sourceResearchId, resultRow.id)
    assert.equal(result.failures[0].stage, 'news_status_update')
    assert.match(result.failures[0].error, /local status update failed/)
    assert.equal((await newsStore.fetchResearchResult(resultRow.id))?.status, 'pending_entity_memory')
    assert.equal(entityStore.memories.some((memory) => memory.memory_type === 'source_marker'), false)
  } finally {
    newsStore.close()
  }
})

test('runNewsEntityManager skips research results already marked handed-off or failed via the NewsStore cursor', async () => {
  await withNewsStore(async (newsStore) => {
    const entityStore = new InMemoryEntityMemoryStore()
    const processed = await insertResearchResult(newsStore, candidate({ article_url: 'https://www.coindesk.com/a' }))
    const failed = await insertResearchResult(newsStore, candidate({ article_url: 'https://www.coindesk.com/b' }))
    // Seed the skip state directly through the news lane's own authoritative
    // cursor (NewsStore.markResearchResultStatus) instead of an
    // entity_memories source_marker row - fetchPendingResearchResults filters
    // strictly on this status column.
    await newsStore.markResearchResultStatus(processed.id, 'handed_to_entity_memory')
    await newsStore.markResearchResultStatus(failed.id, 'failed_entity_memory')
    const provider = new CapturingExtractionProvider(extraction())

    const result = await runNewsEntityManager({
      newsStore,
      entityStore,
      extractionProvider: provider,
      batchSize: 10,
    })

    assert.equal(result.fetched, 0)
    assert.equal(result.skippedAlreadyMarked, 0)
    assert.equal(result.processed, 0)
    assert.equal(result.failed, 0)
    assert.equal(provider.packets.length, 0)
    assert.equal((await newsStore.fetchResearchResult(processed.id))?.status, 'handed_to_entity_memory')
    assert.equal((await newsStore.fetchResearchResult(failed.id))?.status, 'failed_entity_memory')
    assert.deepEqual(await newsStore.fetchPendingResearchResults(10), [])
  })
})

test('runNewsEntityManager rerun after processed marker does not duplicate memories', async () => {
  await withNewsStore(async (newsStore) => {
    const entityStore = new InMemoryEntityMemoryStore()
    const firstProvider = new CapturingExtractionProvider(extraction())
    const secondProvider = new CapturingExtractionProvider(extraction())
    const resultRow = await insertResearchResult(newsStore)

    const first = await runNewsEntityManager({
      newsStore,
      entityStore,
      extractionProvider: firstProvider,
      batchSize: 10,
    })
    const memoryCountAfterFirstRun = entityStore.memories.length
    const second = await runNewsEntityManager({
      newsStore,
      entityStore,
      extractionProvider: secondProvider,
      batchSize: 10,
    })

    assert.equal(first.processed, 1)
    assert.equal(second.fetched, 0)
    assert.equal(second.processed, 0)
    assert.equal(second.skippedAlreadyMarked, 0)
    assert.equal(secondProvider.packets.length, 0)
    assert.equal(entityStore.memories.length, memoryCountAfterFirstRun)
    assert.equal((await newsStore.fetchResearchResult(resultRow.id))?.status, 'handed_to_entity_memory')
  })
})

test('runNewsEntityManager does not call collection, research, or publishing stages', async () => {
  await withNewsStore(async (newsStore) => {
    const entityStore = new InMemoryEntityMemoryStore()
    const provider = new CapturingExtractionProvider(extraction())
    await insertResearchResult(newsStore)

    const result = await runNewsEntityManager({
      newsStore,
      entityStore,
      extractionProvider: provider,
      batchSize: 10,
    })

    assert.equal(result.processed, 1)
    assert.deepEqual(provider.packets.map((packet) => packet.source), ['news'])
    assert.equal(entityStore.memories.some((memory) => memory.title.includes('editor')), false)
    assert.equal(entityStore.memories.some((memory) => memory.title.includes('publisher')), false)
  })
})
