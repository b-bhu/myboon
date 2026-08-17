import assert from 'node:assert/strict'
import test from 'node:test'
import type { NewsFeedItem } from '@myboon/shared/news-feed'
import { newsResearchToPacket } from '../../entity-manager/news-adapter'
import { runPendingNewsResearch } from '../runner'
import { SqliteNewsStore } from '../sqlite-store'
import { runNewsFeedIngestionOnce } from '../news-feed-ingestor'
import type {
  HermesWorkerRequest,
  HermesWorkerResult,
  NewsResearchRequest,
  NewsResearchResponse,
} from '../types'

const now = new Date('2026-08-15T12:00:00.000Z')

const feedItems: NewsFeedItem[] = [{
  kind: 'article',
  title: 'Bitcoin filing appears in public records',
  url: 'https://example.com/bitcoin-filing',
  publishedAt: '2026-08-15T11:00:00.000Z',
  outlet: 'Example News',
  author: null,
  imageUrl: null,
  relatedCoinIds: ['bitcoin'],
}, {
  kind: 'post',
  text: 'NEW: A public filing names Bitcoin as a treasury asset.',
  url: 'https://x.com/tokens/status/456',
  postedAt: '2026-08-15T11:30:00.000Z',
  handle: '@tokens',
  imageUrl: null,
  relatedCoinIds: ['bitcoin'],
}]

class FakeResearchHermes {
  calls: HermesWorkerRequest[] = []

  async run(workerRequest: HermesWorkerRequest): Promise<HermesWorkerResult> {
    this.calls.push(workerRequest)
    assert.equal(workerRequest.taskType, 'source_aware_research')
    const request = extractRequest(workerRequest.prompt)
    const response: NewsResearchResponse = {
      schema_version: 'myboon.hermes.research_response.v1',
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
        one_liner: 'The source claim was checked against a public record.',
        what_was_checked: ['Source item', 'Public record'],
        requires_followup: false,
      },
      article_claims: [{ claim_id: 'claim_1', claim: request.article.headline }],
      verified_facts: [{ fact: 'A matching public record exists.', evidence_refs: ['evidence_1'] }],
      unresolved_claims: [],
      entity_hints: [{ name: 'Bitcoin', type: 'asset', source: 'researcher_hint' }],
      evidence: [{ evidence_id: 'evidence_1', title: 'Public record', url: 'https://example.com/record' }],
      open_questions: [],
      limitations: [],
      errors: [],
    }
    return {
      jobId: workerRequest.jobId,
      taskType: workerRequest.taskType,
      status: 'succeeded',
      stdout: JSON.stringify(response),
      stderr: '',
      exitCode: 0,
      startedAt: now.toISOString(),
      finishedAt: now.toISOString(),
      durationMs: 1,
    }
  }
}

test('news feed articles and posts enter existing research and retain their entity-memory kind', async () => {
  const store = new SqliteNewsStore(':memory:')
  try {
    const collection = await runNewsFeedIngestionOnce({
      store,
      now,
      fetcher: async () => ({
        items: feedItems,
        meta: {
          mode: 'global',
          terms: [],
          limit: 50,
          coingeckoCandidates: 1,
          xCandidates: 1,
        },
      }),
    })
    const hermes = new FakeResearchHermes()
    const research = await runPendingNewsResearch({
      store,
      hermes,
      options: { now, batchSize: 10 },
    })
    const pending = await store.fetchPendingResearchResults(10)
    const packets = pending.map(({ result, candidate }) => newsResearchToPacket(result, candidate))

    assert.equal(collection.candidateObservationsInserted, 2)
    assert.equal(research.researchSucceeded, 2)
    assert.equal(hermes.calls.length, 2)
    assert.equal(hermes.calls.every((call) => call.taskType === 'source_aware_research'), true)
    assert.deepEqual(
      packets.map((packet) => [packet.sourceArea, packet.sourceType]).sort(),
      [['news_feed:articles', 'article'], ['news_feed:social', 'social_post']],
    )
    assert.deepEqual(packets.map((packet) => packet.context.provider_id), ['tokens_xyz', 'tokens_xyz'])
  } finally {
    store.close()
  }
})

function extractRequest(prompt: string): NewsResearchRequest {
  const marker = 'Request JSON:\n'
  const start = prompt.indexOf(marker)
  const end = prompt.indexOf('\n\nReturn schema:', start)
  assert.notEqual(start, -1)
  assert.notEqual(end, -1)
  return JSON.parse(prompt.slice(start + marker.length, end)) as NewsResearchRequest
}
