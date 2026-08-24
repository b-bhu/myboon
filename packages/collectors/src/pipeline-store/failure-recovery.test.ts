import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fingerprintNewsCandidate } from '../news/fingerprint'
import { SqliteNewsStore } from '../news/sqlite-store'
import type { NewsCandidateObservationRow } from '../news/store'
import type { NewsCandidate, NewsResearchResponse } from '../news/types'
import { TEST_NEWS_SOURCE, TEST_NEWS_SOURCE_URL } from '../news/tests/fixtures'
import { SqlitePipelineStore } from './sqlite-store'
import type { PipelineCandidateInsertInput, PipelineResearchUpsertInput } from './store'
import {
  readAllDeadLetterCounts,
  recoverFailedBacklog,
  type RecoveryBackupInput,
} from './failure-recovery'

const nodeRequire = createRequire(__filename)
const { DatabaseSync } = nodeRequire('node:sqlite') as {
  DatabaseSync: new (path: string, options?: { readOnly?: boolean }) => {
    close(): void
    prepare(sql: string): { get(...params: unknown[]): Record<string, unknown> | undefined }
  }
}

const SINCE = '2000-01-01T00:00:00.000Z'

async function withStores(
  fn: (paths: { dir: string; news: string; pipeline: string }) => Promise<void>
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'myboon-recovery-'))
  const paths = { dir, news: join(dir, 'news.sqlite'), pipeline: join(dir, 'pipeline.sqlite') }
  const news = new SqliteNewsStore(paths.news)
  const pipeline = new SqlitePipelineStore(paths.pipeline)
  news.close()
  pipeline.close()
  try {
    await fn(paths)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

function newsCandidate(overrides: Partial<NewsCandidate> = {}): NewsCandidate {
  return {
    headline: 'Provider outage candidate',
    article_url: `https://example.com/${randomUUID()}`,
    summary: 'Visible summary',
    published_at: '2026-08-23T01:00:00.000Z',
    author: 'Test',
    evidence: ['card'],
    ...overrides,
  }
}

async function insertNewsCandidate(store: SqliteNewsStore): Promise<NewsCandidateObservationRow> {
  const candidate = newsCandidate()
  const [row] = await store.insertCandidateObservations([{
    source: TEST_NEWS_SOURCE,
    sourceUrl: TEST_NEWS_SOURCE_URL,
    candidate,
    fingerprint: fingerprintNewsCandidate(TEST_NEWS_SOURCE.sourceId, TEST_NEWS_SOURCE_URL.urlId, candidate),
    dedupeOutcome: 'new_candidate',
    observedAt: '2026-08-23T01:00:00.000Z',
  }])
  return row
}

function newsResearchResponse(candidate: NewsCandidateObservationRow): NewsResearchResponse {
  return {
    schema_version: 'myboon.hermes.research_response.v1',
    job_id: `job-${candidate.id}`,
    candidate_id: candidate.id,
    source_id: candidate.sourceId,
    url_id: candidate.urlId,
    status: 'ready_for_entity_memory',
    source_signal: {
      source_name: candidate.sourceName,
      source_url: candidate.sourceUrl,
      article_url: candidate.canonicalArticleUrl,
      canonical_article_url: candidate.canonicalArticleUrl,
      headline: candidate.headline,
      visible_summary: candidate.visibleSummary,
      published_at: candidate.publishedAt,
      observed_at: candidate.observedAt,
    },
    research_summary: { one_liner: 'Summary', what_was_checked: ['article'], requires_followup: false },
    article_claims: [],
    verified_facts: [],
    unresolved_claims: [],
    entity_hints: [],
    evidence: [],
    open_questions: [],
    limitations: [],
    errors: [],
  }
}

function pipelineCandidate(overrides: Partial<PipelineCandidateInsertInput> = {}): PipelineCandidateInsertInput {
  const id = randomUUID()
  return {
    source: 'polymarket',
    area: 'markets',
    candidateType: 'market_shift',
    marketId: `market-${id}`,
    slug: `slug-${id}`,
    title: `Title ${id}`,
    tagSlug: 'test',
    tagLabel: 'Test',
    observedAt: '2026-08-23T01:00:00.000Z',
    whatChanged: 'Price moved',
    whyFlagged: 'Volume',
    score: 0.8,
    scoreBreakdown: {},
    metrics: {},
    evidenceRefs: [],
    dedupeKey: `dedupe-${id}`,
    ...overrides,
  }
}

function pipelineResearch(candidateId: string): PipelineResearchUpsertInput {
  return {
    candidateId,
    source: 'polymarket',
    area: 'markets',
    slug: `slug-${candidateId}`,
    title: 'Research title',
    candidateType: 'market_shift',
    researchMode: 'web',
    summary: 'Summary',
    notes: 'Notes',
    keyFindings: [],
    evidenceLinks: [],
    relatedContext: [],
    uncertainty: 'low',
    editorNotes: '',
    researchedAt: '2026-08-23T01:00:00.000Z',
    researchFamilyKey: `family-${candidateId}`,
    researchClusterKey: `cluster-${candidateId}`,
    researchDepth: 'deep_web',
    evidenceQuality: 'medium',
    catalystFound: true,
    recommendedEditorAction: 'publish_candidate',
    researchBackend: 'hermes_cli',
  }
}

test('news research recovery is dry-run first, backs up before apply, and clears failure markers', async () => {
  await withStores(async (paths) => {
    const store = new SqliteNewsStore(paths.news)
    const candidate = await insertNewsCandidate(store)
    await store.recordCandidateResearchFailure({
      id: candidate.id,
      jobId: 'failed-job',
      workerStatus: 'timed_out',
      error: 'Hermes research timed_out',
      stderr: 'timeout',
    })
    store.close()

    const dryRun = await recoverFailedBacklog({
      source: 'news', stage: 'research', since: SINCE,
      failureCategory: 'provider_outage', pipelineSqlitePath: paths.pipeline, newsSqlitePath: paths.news,
    })
    assert.equal(dryRun.mode, 'dry-run')
    assert.equal(dryRun.touched, 0)
    assert.equal(dryRun.audit[0]?.outcome, 'would_requeue')

    let backedUp: RecoveryBackupInput | null = null
    const applied = await recoverFailedBacklog({
      source: 'news', stage: 'research', since: SINCE, apply: true,
      pipelineSqlitePath: paths.pipeline, newsSqlitePath: paths.news,
      backupBeforeWrite: async (input) => { backedUp = input; return null },
    })
    assert.ok(backedUp)
    assert.equal(applied.touched, 1)

    const db = new DatabaseSync(paths.news, { readOnly: true })
    const row = db.prepare(`SELECT status, research_error, research_worker_status, research_failure_status
      FROM news_candidate_observations WHERE id = ?`).get(candidate.id)!
    db.close()
    assert.deepEqual({ ...row }, {
      status: 'pending_research', research_error: null, research_worker_status: null, research_failure_status: null,
    })
  })
})

test('research identity guard reconciles a failed candidate that already has a result without replay', async () => {
  await withStores(async (paths) => {
    const store = new SqliteNewsStore(paths.news)
    const candidate = await insertNewsCandidate(store)
    const result = await store.insertResearchResult({
      candidate,
      response: newsResearchResponse(candidate),
      researchedAt: '2026-08-23T02:00:00.000Z',
    })
    await store.recordCandidateResearchFailure({ id: candidate.id, jobId: 'replayed', error: 'timeout' })
    store.close()

    const report = await recoverFailedBacklog({
      source: 'news', stage: 'research', since: SINCE, apply: true,
      pipelineSqlitePath: paths.pipeline, newsSqlitePath: paths.news,
      backupBeforeWrite: async () => null,
    })
    assert.equal(report.touched, 1)
    assert.equal(report.skipped, 0)
    assert.equal(report.audit[0]?.existingResultId, result.id)
    assert.match(report.audit[0]?.reason ?? '', /already exists/)
    assert.equal(report.audit[0]?.outcome, 'reconciled_existing_result')
    const reconciled = new SqliteNewsStore(paths.news)
    assert.equal((await reconciled.fetchCandidateObservation(candidate.id))?.status, 'researched')
    reconciled.close()
  })
})

test('entity-manager replay resets news and Polymarket checkpoints without touching research data', async () => {
  await withStores(async (paths) => {
    const news = new SqliteNewsStore(paths.news)
    const newsCandidateRow = await insertNewsCandidate(news)
    const newsResult = await news.insertResearchResult({
      candidate: newsCandidateRow,
      response: newsResearchResponse(newsCandidateRow),
      researchedAt: '2026-08-23T02:00:00.000Z',
    })
    await news.markResearchResultStatus(newsResult.id, 'failed_entity_memory', {
      error: "No usable credentials found for provider 'ollama-cloud'",
      category: 'authentication',
    })
    news.close()

    const pipeline = new SqlitePipelineStore(paths.pipeline)
    const [candidate] = await pipeline.insertCandidates([pipelineCandidate()])
    const [researchId] = await pipeline.upsertResearchRows([pipelineResearch(candidate.id)])
    await pipeline.claimResearchForEntityManager({
      source: 'polymarket', area: 'markets', limit: 1, leaseOwner: 'test-owner',
      now: '2026-08-23T03:00:00.000Z', leaseExpiresAt: '2026-08-23T03:05:00.000Z',
    })
    await pipeline.finishResearchForEntityManager({
      id: researchId, leaseOwner: 'test-owner', status: 'failed',
      observedAt: '2026-08-23T03:00:01.000Z', error: 'Hermes entity extraction timed_out',
    })
    pipeline.close()

    for (const source of ['news', 'polymarket'] as const) {
      const report = await recoverFailedBacklog({
        source, stage: 'entity-manager', since: SINCE, apply: true,
        pipelineSqlitePath: paths.pipeline, newsSqlitePath: paths.news,
        backupBeforeWrite: async () => null,
      })
      assert.equal(report.touched, 1)
    }

    const newsDb = new DatabaseSync(paths.news, { readOnly: true })
    const newsRow = newsDb.prepare('SELECT status, entity_manager_error FROM news_research_results WHERE id = ?').get(newsResult.id)!
    newsDb.close()
    assert.deepEqual({ ...newsRow }, { status: 'pending_entity_memory', entity_manager_error: null })

    const pipelineDb = new DatabaseSync(paths.pipeline, { readOnly: true })
    const pipelineRow = pipelineDb.prepare(`SELECT entity_manager_status, entity_manager_error,
      entity_manager_attempt_count FROM pipeline_research WHERE id = ?`).get(researchId)!
    pipelineDb.close()
    assert.deepEqual({ ...pipelineRow }, { entity_manager_status: 'pending', entity_manager_error: null, entity_manager_attempt_count: 0 })
  })
})

test('dead-letter action is distinct, counted, and excluded from later recovery', async () => {
  await withStores(async (paths) => {
    const store = new SqlitePipelineStore(paths.pipeline)
    const [candidate] = await store.insertCandidates([pipelineCandidate()])
    await store.setCandidateStatus({
      ids: [candidate.id], status: 'research_failed', observedAt: '2026-08-23T01:00:00.000Z',
      researchError: 'No Polymarket market found for slug',
    })
    store.close()

    const marked = await recoverFailedBacklog({
      source: 'polymarket', stage: 'research', since: SINCE, action: 'dead-letter', apply: true,
      pipelineSqlitePath: paths.pipeline, newsSqlitePath: paths.news,
      backupBeforeWrite: async () => null,
    })
    assert.equal(marked.audit[0]?.outcome, 'dead_lettered')
    assert.equal(marked.deadLetters.count, 1)

    const replay = await recoverFailedBacklog({
      source: 'polymarket', stage: 'research', since: SINCE,
      pipelineSqlitePath: paths.pipeline, newsSqlitePath: paths.news,
    })
    assert.equal(replay.matched, 0)

    const counts = readAllDeadLetterCounts({ pipelineSqlitePath: paths.pipeline, newsSqlitePath: paths.news })
    assert.equal(counts.find((row) => row.source === 'polymarket' && row.stage === 'research')?.count, 1)
  })
})

test('apply refuses an unbounded recovery write', async () => {
  await withStores(async (paths) => {
    await assert.rejects(
      recoverFailedBacklog({
        source: 'news', stage: 'research', apply: true,
        pipelineSqlitePath: paths.pipeline, newsSqlitePath: paths.news,
      }),
      /Refusing unbounded write/
    )
  })
})

test('a failed backup aborts recovery before any row changes', async () => {
  await withStores(async (paths) => {
    const store = new SqliteNewsStore(paths.news)
    const candidate = await insertNewsCandidate(store)
    await store.recordCandidateResearchFailure({ id: candidate.id, jobId: 'failed-job', error: 'timeout' })
    store.close()

    await assert.rejects(
      recoverFailedBacklog({
        source: 'news', stage: 'research', since: SINCE, apply: true,
        pipelineSqlitePath: paths.pipeline, newsSqlitePath: paths.news,
        backupBeforeWrite: async () => { throw new Error('verification failed') },
      }),
      /verification failed/
    )

    const db = new DatabaseSync(paths.news, { readOnly: true })
    const row = db.prepare('SELECT status, research_error FROM news_candidate_observations WHERE id = ?').get(candidate.id)!
    db.close()
    assert.equal(row.status, 'failed_research')
    assert.equal(row.research_error, 'timeout')
  })
})

test('recovery batch limit is bounded and reports truncation', async () => {
  await withStores(async (paths) => {
    const store = new SqliteNewsStore(paths.news)
    for (let i = 0; i < 3; i += 1) {
      const candidate = await insertNewsCandidate(store)
      await store.recordCandidateResearchFailure({ id: candidate.id, jobId: `failed-${i}`, error: 'timeout' })
    }
    store.close()

    const report = await recoverFailedBacklog({
      source: 'news', stage: 'research', since: SINCE, limit: 2,
      pipelineSqlitePath: paths.pipeline, newsSqlitePath: paths.news,
    })
    assert.equal(report.matched, 2)
    assert.equal(report.truncated, true)
    assert.equal(report.audit.length, 2)
  })
})
