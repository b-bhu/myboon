import assert from 'node:assert/strict'
import test from 'node:test'
import { fingerprintNewsCandidate } from '../fingerprint'
import {
  recoverStaleNewsWork,
  runNewsResearchPipelineOnce,
  runPendingNewsResearch,
} from '../runner'
import { SqliteNewsStore } from '../sqlite-store'
import type { NewsCandidateObservationInput } from '../store'
import type {
  HermesWorkerRequest,
  HermesWorkerResult,
  NewsResearchRequest,
  NewsResearchResponse,
  NewsCandidate,
} from '../types'
import { TEST_NEWS_SOURCE, TEST_NEWS_SOURCE_URL, testNewsCandidate } from './fixtures'

const now = new Date('2026-07-04T12:00:00.000Z')

class FakeHermes {
  calls: HermesWorkerRequest[] = []
  researchHandler: (request: NewsResearchRequest) => string = (request) => (
    JSON.stringify(researchResponse(request))
  )

  async run(request: HermesWorkerRequest): Promise<HermesWorkerResult> {
    this.calls.push(request)
    return {
      jobId: request.jobId,
      taskType: request.taskType,
      status: 'succeeded',
      stdout: this.researchHandler(extractRequest(request.prompt) as NewsResearchRequest),
      stderr: '',
      exitCode: 0,
      startedAt: now.toISOString(),
      finishedAt: now.toISOString(),
      durationMs: 1,
    }
  }
}

function withStore(fn: (store: SqliteNewsStore) => Promise<void> | void): Promise<void> {
  const store = new SqliteNewsStore(':memory:')
  return Promise.resolve().then(() => fn(store)).finally(() => store.close())
}

function observationInput(candidate: NewsCandidate): NewsCandidateObservationInput {
  return {
    source: TEST_NEWS_SOURCE,
    sourceUrl: TEST_NEWS_SOURCE_URL,
    candidate,
    fingerprint: fingerprintNewsCandidate(
      TEST_NEWS_SOURCE.sourceId,
      TEST_NEWS_SOURCE_URL.urlId,
      candidate,
    ),
    dedupeOutcome: 'new_candidate',
    observedAt: candidate.observed_at ?? now.toISOString(),
  }
}

function researchResponse(request: NewsResearchRequest): NewsResearchResponse {
  return {
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
      one_liner: 'Checked article context.',
      what_was_checked: ['Article page'],
      requires_followup: false,
    },
    article_claims: [{ claim_id: 'claim_1', claim: 'Article claim.' }],
    verified_facts: [{ fact: 'Verified fact.', evidence_refs: ['evidence_1'] }],
    unresolved_claims: [],
    entity_hints: [{ name: 'Bitcoin', source: 'article' }],
    evidence: [{ evidence_id: 'evidence_1', title: 'Article', url: request.article.article_url }],
    open_questions: [],
    limitations: [],
    errors: [],
  }
}

function extractRequest(prompt: string): unknown {
  const marker = 'Request JSON:\n'
  const start = prompt.indexOf(marker)
  const schemaStart = prompt.indexOf('\n\nReturn schema:', start)
  assert.notEqual(start, -1)
  assert.notEqual(schemaStart, -1)
  return JSON.parse(prompt.slice(start + marker.length, schemaStart))
}

test('pending candidates are researched and queued for entity memory', async () => {
  await withStore(async (store) => {
    const [storedCandidate] = await store.insertCandidateObservations([
      observationInput(testNewsCandidate()),
    ])
    const hermes = new FakeHermes()

    const result = await runPendingNewsResearch({
      store,
      hermes,
      options: { now, batchSize: 10 },
    })

    assert.equal(result.researchCandidatesFetched, 1)
    assert.equal(result.researchSucceeded, 1)
    assert.equal(result.researchResultsInserted, 1)
    assert.deepEqual(hermes.calls.map((call) => call.taskType), ['source_aware_research'])
    const pendingResults = await store.fetchPendingResearchResults(10)
    assert.equal(pendingResults.length, 1)
    assert.equal(pendingResults[0].candidate.id, storedCandidate.id)
  })
})

test('non-ready research is stored without entity handoff', async () => {
  await withStore(async (store) => {
    await store.insertCandidateObservations([observationInput(testNewsCandidate())])
    const hermes = new FakeHermes()
    hermes.researchHandler = (request) => JSON.stringify({
      ...researchResponse(request),
      status: 'needs_followup',
      research_summary: {
        one_liner: 'Checked article context but needs followup.',
        what_was_checked: ['Article page'],
        requires_followup: true,
        followup_reason: 'Original filing not yet available.',
      },
      open_questions: ['Need original filing.'],
    })

    const result = await runPendingNewsResearch({ store, hermes, options: { now, batchSize: 10 } })

    assert.equal(result.researchSucceeded, 1)
    assert.deepEqual(await store.fetchPendingResearchResults(10), [])
  })
})

test('research parse failure records bounded retry diagnostics', async () => {
  await withStore(async (store) => {
    const [storedCandidate] = await store.insertCandidateObservations([
      observationInput(testNewsCandidate()),
    ])
    const hermes = new FakeHermes()
    hermes.researchHandler = () => 'not json'

    const result = await runPendingNewsResearch({ store, hermes, options: { now, batchSize: 10 } })

    assert.equal(result.researchFailed, 1)
    assert.equal(result.jsonValidationFailures, 1)
    const failedCandidate = await store.fetchCandidateObservation(storedCandidate.id)
    assert.equal(failedCandidate?.status, 'failed_research')
    assert.equal(failedCandidate?.researchRawResponse, 'not json')
  })
})

test('stale research leases return to the pending queue', async () => {
  await withStore(async (store) => {
    const [storedCandidate] = await store.insertCandidateObservations([
      observationInput(testNewsCandidate()),
    ])
    await store.markCandidateResearchStarted(storedCandidate.id, 'stale-research')

    const recovered = await recoverStaleNewsWork(store, {
      now: new Date('2100-01-01T00:00:00.000Z'),
      staleWorkCutoffMs: 1,
    })

    assert.equal(recovered.candidatesRecovered, 1)
    assert.equal((await store.fetchCandidateObservation(storedCandidate.id))?.status, 'pending_research')
  })
})

test('research runner uses the default five-item batch and has no discovery task type', async () => {
  await withStore(async (store) => {
    await store.insertCandidateObservations(Array.from({ length: 6 }, (_, index) => (
      observationInput(testNewsCandidate({
        headline: `Article ${index + 1}`,
        article_url: `https://example.com/article-${index + 1}`,
      }))
    )))
    const hermes = new FakeHermes()

    const result = await runNewsResearchPipelineOnce({ store, hermes, options: { now } })

    assert.equal(result.researchCandidatesFetched, 5)
    assert.equal(result.researchSucceeded, 5)
    assert.equal((await store.fetchPendingCandidateObservations(10)).length, 1)
    assert.deepEqual(new Set(hermes.calls.map((call) => call.taskType)), new Set(['source_aware_research']))
  })
})
