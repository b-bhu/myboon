import assert from 'node:assert/strict'
import test from 'node:test'
import type { SupabaseClient } from '@supabase/supabase-js'
import { InMemoryEntityMemoryStore } from '../../entity-manager/test-helpers'
import { runNewsEntityManager } from '../../entity-manager/run-news'
import type { EntityMemoryExtraction, ExtractionProvider, ResearchPacket } from '../../entity-manager/types'
import { DEFAULT_NEWS_SOURCES } from '../config'
import { fingerprintScoutCandidate } from '../fingerprint'
import { SupabaseNewsStore } from '../supabase-store'
import type { NewsCandidateObservationInput, NewsCandidateObservationRow } from '../store'
import type { NewsDedupeOutcome, NewsResearchResponse, NewsScoutCandidate } from '../types'

const source = DEFAULT_NEWS_SOURCES[0]
const sourceUrl = source.urls[0]
const observedAt = '2026-07-04T12:00:00.000Z'

type FakeTableName = 'news_source_runs' | 'news_candidate_observations' | 'news_research_results'

interface FakeSupabaseError {
  code?: string
  message: string
}

interface FakeSupabaseResult {
  data: unknown
  error: FakeSupabaseError | null
  count: number | null
}

interface FakeFilter {
  column: string
  op: 'eq' | 'neq' | 'in' | 'lt'
  value: unknown
}

interface FakeOrder {
  column: string
  ascending: boolean
}

class FakeSupabaseClient {
  readonly tables: Record<FakeTableName, Array<Record<string, unknown>>> = {
    news_source_runs: [],
    news_candidate_observations: [],
    news_research_results: [],
  }

  from(table: string): FakeQueryBuilder {
    if (!isFakeTableName(table)) throw new Error(`Unexpected fake table ${table}`)
    return new FakeQueryBuilder(this, table)
  }
}

class FakeQueryBuilder {
  private operation: 'select' | 'insert' | 'update' | 'upsert' = 'select'
  private filters: FakeFilter[] = []
  private orders: FakeOrder[] = []
  private limitValue: number | null = null
  private payload: unknown
  private singleMode: 'single' | 'maybeSingle' | null = null
  private upsertOnConflict: string[] = []
  private upsertIgnoreDuplicates = false

  constructor(
    private readonly client: FakeSupabaseClient,
    private readonly table: FakeTableName
  ) {}

  select(_columns?: string): this {
    return this
  }

  insert(payload: unknown): this {
    this.operation = 'insert'
    this.payload = payload
    return this
  }

  update(payload: Record<string, unknown>): this {
    this.operation = 'update'
    this.payload = payload
    return this
  }

  upsert(payload: unknown, options?: { onConflict?: string, ignoreDuplicates?: boolean }): this {
    this.operation = 'upsert'
    this.payload = payload
    this.upsertOnConflict = options?.onConflict?.split(',').map((item) => item.trim()).filter(Boolean) ?? []
    this.upsertIgnoreDuplicates = options?.ignoreDuplicates ?? false
    return this
  }

  eq(column: string, value: unknown): this {
    this.filters.push({ column, op: 'eq', value })
    return this
  }

  neq(column: string, value: unknown): this {
    this.filters.push({ column, op: 'neq', value })
    return this
  }

  in(column: string, value: unknown[]): this {
    this.filters.push({ column, op: 'in', value })
    return this
  }

  lt(column: string, value: unknown): this {
    this.filters.push({ column, op: 'lt', value })
    return this
  }

  order(column: string, options: { ascending?: boolean } = {}): this {
    this.orders.push({ column, ascending: options.ascending ?? true })
    return this
  }

  limit(value: number): this {
    this.limitValue = value
    return this
  }

  single(): this {
    this.singleMode = 'single'
    return this
  }

  maybeSingle(): this {
    this.singleMode = 'maybeSingle'
    return this
  }

  then<TResult1 = FakeSupabaseResult, TResult2 = never>(
    onfulfilled?: ((value: FakeSupabaseResult) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null
  ): Promise<TResult1 | TResult2> {
    return Promise.resolve(this.execute()).then(onfulfilled, onrejected)
  }

  private execute(): FakeSupabaseResult {
    if (this.operation === 'insert') return this.executeInsert()
    if (this.operation === 'update') return this.executeUpdate()
    if (this.operation === 'upsert') return this.executeUpsert()
    return this.resultForRows(this.applySelect([...this.rows()]))
  }

  private executeInsert(): FakeSupabaseResult {
    const payloads = Array.isArray(this.payload) ? this.payload : [this.payload]
    const inserted: Array<Record<string, unknown>> = []
    for (const payload of payloads) {
      const record = withDefaults(this.table, payload as Record<string, unknown>)
      const duplicate = duplicateError(this.rows(), this.table, record)
      if (duplicate) return { data: null, error: duplicate, count: null }
      this.rows().push(record)
      inserted.push({ ...record })
    }
    return this.resultForRows(inserted)
  }

  private executeUpdate(): FakeSupabaseResult {
    const payload = this.payload as Record<string, unknown>
    const updated: Array<Record<string, unknown>> = []
    for (const row of this.rows()) {
      if (!this.matches(row)) continue
      Object.assign(row, payload)
      updated.push({ ...row })
    }
    return this.resultForRows(updated)
  }

  private executeUpsert(): FakeSupabaseResult {
    const payloads = Array.isArray(this.payload) ? this.payload : [this.payload]
    const changed: Array<Record<string, unknown>> = []
    for (const payload of payloads) {
      const record = withDefaults(this.table, payload as Record<string, unknown>)
      const existing = this.rows().find((row) => this.upsertOnConflict.every((column) => row[column] === record[column]))
      if (existing) {
        if (!this.upsertIgnoreDuplicates) Object.assign(existing, record)
        changed.push({ ...existing })
      } else {
        this.rows().push(record)
        changed.push({ ...record })
      }
    }
    return this.resultForRows(changed)
  }

  private resultForRows(rows: Array<Record<string, unknown>>): FakeSupabaseResult {
    if (this.singleMode === 'single') {
      if (rows.length !== 1) {
        return { data: null, error: { message: `Expected one row, found ${rows.length}` }, count: null }
      }
      return { data: rows[0], error: null, count: rows.length }
    }
    if (this.singleMode === 'maybeSingle') {
      if (rows.length > 1) {
        return { data: null, error: { message: `Expected zero or one row, found ${rows.length}` }, count: null }
      }
      return { data: rows[0] ?? null, error: null, count: rows.length }
    }
    return { data: rows, error: null, count: rows.length }
  }

  private applySelect(rows: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
    const filtered = rows.filter((row) => this.matches(row))
    for (const order of [...this.orders].reverse()) {
      filtered.sort((left, right) => compareValues(left[order.column], right[order.column], order.ascending))
    }
    return this.limitValue === null ? filtered : filtered.slice(0, Math.max(0, this.limitValue))
  }

  private matches(row: Record<string, unknown>): boolean {
    return this.filters.every((filter) => {
      const value = row[filter.column]
      if (filter.op === 'eq') return value === filter.value
      if (filter.op === 'neq') return value !== filter.value
      if (filter.op === 'in') return Array.isArray(filter.value) && filter.value.includes(value)
      return String(value) < String(filter.value)
    })
  }

  private rows(): Array<Record<string, unknown>> {
    return this.client.tables[this.table]
  }
}

class CapturingExtractionProvider implements ExtractionProvider {
  packets: ResearchPacket[] = []

  constructor(private readonly extraction: EntityMemoryExtraction) {}

  async extract(packet: ResearchPacket): Promise<EntityMemoryExtraction> {
    this.packets.push(packet)
    return this.extraction
  }
}

function isFakeTableName(value: string): value is FakeTableName {
  return value === 'news_source_runs'
    || value === 'news_candidate_observations'
    || value === 'news_research_results'
}

function compareValues(left: unknown, right: unknown, ascending: boolean): number {
  const direction = ascending ? 1 : -1
  if (left === right) return 0
  if (left === null || left === undefined) return direction
  if (right === null || right === undefined) return -direction
  return String(left) < String(right) ? -direction : direction
}

function duplicateError(
  rows: Array<Record<string, unknown>>,
  table: FakeTableName,
  record: Record<string, unknown>
): FakeSupabaseError | null {
  const duplicate = rows.some((row) => {
    if (row.id === record.id) return true
    if (table === 'news_source_runs') return row.job_id === record.job_id
    if (table === 'news_candidate_observations') return row.observation_dedupe_key === record.observation_dedupe_key
    return row.candidate_observation_id === record.candidate_observation_id
      || row.research_job_id === record.research_job_id
  })
  return duplicate ? { code: '23505', message: 'duplicate key value violates unique constraint' } : null
}

function withDefaults(table: FakeTableName, payload: Record<string, unknown>): Record<string, unknown> {
  const timestamp = '2026-07-04T12:00:00.000Z'
  const record = {
    ...payload,
    created_at: payload.created_at ?? timestamp,
    updated_at: payload.updated_at ?? timestamp,
  }
  if (table === 'news_source_runs') {
    return {
      source_type: 'curated_news',
      task_type: 'source_scout',
      status: 'queued',
      observed_at: null,
      started_at: null,
      finished_at: null,
      candidates_found: 0,
      candidates_new: 0,
      candidates_unchanged: 0,
      candidates_materially_changed: 0,
      candidates_invalid: 0,
      raw_response: null,
      validated_payload: null,
      error: null,
      attempt_count: 0,
      next_retry_at: null,
      ...record,
    }
  }
  if (table === 'news_candidate_observations') {
    return {
      source_run_id: null,
      visible_summary: null,
      published_at: null,
      status: 'pending_research',
      last_research_job_id: null,
      research_worker_status: null,
      research_error: null,
      research_raw_response: null,
      research_stderr: null,
      raw_candidate: {},
      ...record,
    }
  }
  return {
    status: 'pending_entity_memory',
    ...record,
  }
}

function fakeStore(): { fake: FakeSupabaseClient, store: SupabaseNewsStore } {
  const fake = new FakeSupabaseClient()
  return {
    fake,
    store: new SupabaseNewsStore(fake as unknown as SupabaseClient),
  }
}

function candidate(overrides: Partial<NewsScoutCandidate> = {}): NewsScoutCandidate {
  return {
    headline: 'CoinDesk observes BTC treasury flows',
    article_url: 'https://www.coindesk.com/markets/2026/07/04/btc-treasury-flows?utm_source=x',
    summary: 'Observed article summary.',
    published_at: '2026-07-04T11:00:00.000Z',
    author: 'CoinDesk Staff',
    evidence: ['visible article card'],
    ...overrides,
  }
}

function observationInput(
  overrides: {
    sourceRunId?: string | null
    inputCandidate?: NewsScoutCandidate
    sourceId?: string
    outcome?: NewsDedupeOutcome
    urlId?: string
  } = {}
): NewsCandidateObservationInput {
  const inputCandidate = overrides.inputCandidate ?? candidate()
  const inputSource = overrides.sourceId ? { ...source, sourceId: overrides.sourceId } : source
  const inputSourceUrl = overrides.urlId ? { ...sourceUrl, urlId: overrides.urlId } : sourceUrl
  return {
    sourceRunId: overrides.sourceRunId ?? null,
    source: inputSource,
    sourceUrl: inputSourceUrl,
    candidate: inputCandidate,
    fingerprint: fingerprintScoutCandidate(inputSource.sourceId, inputSourceUrl.urlId, inputCandidate),
    dedupeOutcome: overrides.outcome ?? 'new_candidate',
    observedAt,
  }
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
      one_liner: 'Research summary.',
      what_was_checked: ['Article', 'Evidence'],
      requires_followup: false,
    },
    article_claims: [{ claim_id: 'claim_1', claim: 'Article claim.' }],
    verified_facts: [{ fact: 'Verified fact.', evidence_refs: ['evidence_1'] }],
    unresolved_claims: [],
    entity_hints: [{ name: 'Bitcoin', source: 'article' }],
    evidence: [{
      evidence_id: 'evidence_1',
      title: 'Evidence',
      url: 'https://example.com/evidence',
    }],
    open_questions: [],
    limitations: [],
    errors: [],
    ...overrides,
  }
}

function extraction(): EntityMemoryExtraction {
  return {
    primaryEntities: [{
      name: 'Bitcoin',
      type: 'asset',
      slug: 'bitcoin',
      aliases: ['BTC'],
      summary: 'Bitcoin asset.',
      createIfMissing: true,
    }],
    memories: [{
      entitySlug: 'bitcoin',
      memoryType: 'news_event',
      title: 'Bitcoin treasury article observed',
      summary: 'CoinDesk article context was gathered for Bitcoin.',
      body: 'Neutral source context.',
      observedAt,
      evidence: [{ url: 'https://example.com/evidence' }],
      mentions: ['CoinDesk'],
      metrics: { articleClaimCount: 1 },
      context: { source: 'news' },
    }],
  }
}

test('SupabaseNewsStore supports source runs, candidate dedupe, research, and handoff status', async () => {
  const { store } = fakeStore()
  const run = await store.createSourceRun({
    jobId: 'job-create-run',
    source,
    sourceUrl,
    status: 'running',
    startedAt: observedAt,
  })

  await store.markSourceRun({
    id: run.id,
    status: 'candidates_classified',
    observedAt,
    counters: {
      candidatesFound: 2,
      candidatesNew: 1,
      candidatesUnchanged: 1,
      candidatesMateriallyChanged: 0,
      candidatesInvalid: 0,
    },
    rawResponse: { raw: true },
    validatedPayload: { schema_version: 'myboon.hermes.scout_response.v1', candidates: [] },
  })

  const input = observationInput({ sourceRunId: run.id })
  const ignoredInput = observationInput({
    outcome: 'known_unchanged',
    inputCandidate: candidate({ article_url: 'https://www.coindesk.com/unchanged' }),
  })
  const first = await store.insertCandidateObservations([input, ignoredInput])
  const duplicate = await store.insertCandidateObservations([input])

  assert.equal(first.length, 1)
  assert.equal(duplicate.length, 1)
  assert.equal(duplicate[0].id, first[0].id)
  assert.equal(first[0].sourceRunId, run.id)
  assert.equal(first[0].rawCandidate.headline, 'CoinDesk observes BTC treasury flows')

  const prior = await store.fetchPriorObservations(source.sourceId, [input.fingerprint.canonicalArticleUrl])
  assert.equal(prior.length, 1)
  assert.equal(prior[0].observationDedupeKey, input.fingerprint.observationDedupeKey)

  await store.markCandidateResearchStarted(first[0].id, 'research-job-1')
  assert.equal((await store.fetchCandidateObservation(first[0].id))?.status, 'researching')

  const result = await store.insertResearchResult({
    candidate: first[0],
    response: researchResponse(first[0]),
    researchedAt: '2026-07-04T13:00:00.000Z',
  })

  assert.equal(result.candidateObservationId, first[0].id)
  assert.equal(result.status, 'pending_entity_memory')
  assert.equal((await store.fetchCandidateObservation(first[0].id))?.status, 'researched')

  const pending = await store.fetchPendingResearchResults(10)
  assert.equal(pending.length, 1)
  assert.equal(pending[0].result.id, result.id)
  assert.equal(pending[0].candidate.id, first[0].id)

  await store.markResearchResultStatus(result.id, 'handed_to_entity_memory')
  assert.equal((await store.fetchResearchResult(result.id))?.status, 'handed_to_entity_memory')
  assert.equal((await store.fetchCandidateObservation(first[0].id))?.status, 'handed_to_entity_memory')
  assert.deepEqual(await store.fetchPendingResearchResults(10), [])
})

test('SupabaseNewsStore stores non-ready research without pending entity handoff', async () => {
  const { store } = fakeStore()
  const [needsFollowupCandidate, failedCandidate] = await store.insertCandidateObservations([
    observationInput({ inputCandidate: candidate({ article_url: 'https://www.coindesk.com/needs-followup' }) }),
    observationInput({ inputCandidate: candidate({ article_url: 'https://www.coindesk.com/failed-research' }) }),
  ])

  const needsFollowup = await store.insertResearchResult({
    candidate: needsFollowupCandidate,
    response: researchResponse(needsFollowupCandidate, {
      status: 'needs_followup',
      research_summary: {
        one_liner: 'Research needs followup.',
        what_was_checked: ['Article'],
        requires_followup: true,
      },
      open_questions: ['Need original filing.'],
    }),
    researchedAt: '2026-07-04T13:00:00.000Z',
  })
  const failed = await store.insertResearchResult({
    candidate: failedCandidate,
    response: researchResponse(failedCandidate, {
      status: 'failed',
      research_summary: {
        one_liner: 'Research failed cleanly.',
        what_was_checked: ['Article'],
        requires_followup: true,
      },
      errors: ['Article unavailable.'],
    }),
    researchedAt: '2026-07-04T13:05:00.000Z',
  })

  assert.equal(needsFollowup.status, 'not_ready_for_entity_memory')
  assert.equal(failed.status, 'not_ready_for_entity_memory')
  assert.equal((await store.fetchResearchResult(needsFollowup.id))?.responseStatus, 'needs_followup')
  assert.equal((await store.fetchResearchResult(failed.id))?.responseStatus, 'failed')
  assert.deepEqual(await store.fetchPendingResearchResults(10), [])
})

test('SupabaseNewsStore reconciles legacy pending non-ready research rows', async () => {
  const { store } = fakeStore()
  const [storedCandidate] = await store.insertCandidateObservations([
    observationInput({ inputCandidate: candidate({ article_url: 'https://www.coindesk.com/legacy-needs-followup' }) }),
  ])
  const row = await store.insertResearchResult({
    candidate: storedCandidate,
    response: researchResponse(storedCandidate, {
      status: 'needs_followup',
      research_summary: {
        one_liner: 'Legacy pending row needs followup.',
        what_was_checked: ['Article'],
        requires_followup: true,
      },
    }),
    researchedAt: '2026-07-04T13:00:00.000Z',
    status: 'pending_entity_memory',
  })

  assert.equal(row.status, 'pending_entity_memory')
  assert.deepEqual(await store.fetchPendingResearchResults(10), [])
  assert.equal((await store.fetchResearchResult(row.id))?.status, 'not_ready_for_entity_memory')
})

test('SupabaseNewsStore records research failure metadata with bounded debug fields', async () => {
  const { store } = fakeStore()
  const [storedCandidate] = await store.insertCandidateObservations([observationInput()])
  await store.recordCandidateResearchFailure({
    id: storedCandidate.id,
    jobId: 'research-job-1',
    workerStatus: 'failed',
    error: 'x'.repeat(5000),
    rawResponse: 'r'.repeat(17000),
    stderr: 's'.repeat(9000),
  })

  const failed = await store.fetchCandidateObservation(storedCandidate.id)
  assert.equal(failed?.status, 'failed_research')
  assert.equal(failed?.lastResearchJobId, 'research-job-1')
  assert.equal(failed?.researchWorkerStatus, 'failed')
  assert.equal(failed?.researchError?.length, 4000)
  assert.equal(failed?.researchRawResponse?.length, 16000)
  assert.equal(failed?.researchStderr?.length, 8000)
})

test('SupabaseNewsStore duplicate research inserts return the existing result', async () => {
  const { store } = fakeStore()
  const [storedCandidate] = await store.insertCandidateObservations([observationInput()])
  const response = researchResponse(storedCandidate)
  const first = await store.insertResearchResult({
    candidate: storedCandidate,
    response,
    researchedAt: '2026-07-04T13:00:00.000Z',
  })
  const second = await store.insertResearchResult({
    candidate: storedCandidate,
    response,
    researchedAt: '2026-07-04T13:05:00.000Z',
  })

  assert.equal(second.id, first.id)
  assert.equal(second.candidateObservationId, first.candidateObservationId)
  assert.equal(second.researchJobId, first.researchJobId)
})

test('SupabaseNewsStore recovers stale source and research work', async () => {
  const { fake, store } = fakeStore()
  const sourceRun = await store.createSourceRun({
    jobId: 'stale-source-run',
    source,
    sourceUrl,
    status: 'running',
    startedAt: '2026-07-04T10:00:00.000Z',
  })
  const [storedCandidate] = await store.insertCandidateObservations([observationInput()])
  await store.markCandidateResearchStarted(storedCandidate.id, 'research-job-stale')

  fake.tables.news_source_runs.find((row) => row.id === sourceRun.id)!.updated_at = '2026-07-04T10:00:00.000Z'
  fake.tables.news_candidate_observations.find((row) => row.id === storedCandidate.id)!.updated_at = '2026-07-04T10:00:00.000Z'

  const recovered = await store.recoverStaleWork({
    sourceRunCutoffIso: '2026-07-04T11:00:00.000Z',
    candidateCutoffIso: '2026-07-04T11:00:00.000Z',
  })

  assert.deepEqual(recovered, {
    sourceRunsRecovered: 1,
    candidatesRecovered: 1,
  })
  assert.equal(fake.tables.news_source_runs.find((row) => row.id === sourceRun.id)!.status, 'failed_transient')
  assert.equal(fake.tables.news_candidate_observations.find((row) => row.id === storedCandidate.id)!.status, 'pending_research')
})

test('Supabase-backed News Entity Manager intake uses the shared resolver handoff', async () => {
  const { store } = fakeStore()
  const [storedCandidate] = await store.insertCandidateObservations([observationInput()])
  const resultRow = await store.insertResearchResult({
    candidate: storedCandidate,
    response: researchResponse(storedCandidate),
    researchedAt: '2026-07-04T13:00:00.000Z',
  })
  const entityStore = new InMemoryEntityMemoryStore()
  const provider = new CapturingExtractionProvider(extraction())

  const result = await runNewsEntityManager({
    newsStore: store,
    entityStore,
    extractionProvider: provider,
    batchSize: 10,
  })

  assert.equal(result.fetched, 1)
  assert.equal(result.processed, 1)
  assert.equal(result.failed, 0)
  assert.equal(provider.packets.length, 1)
  assert.equal(provider.packets[0].source, 'news')
  assert.equal(provider.packets[0].sourceResearchId, resultRow.id)
  assert.equal((await store.fetchResearchResult(resultRow.id))?.status, 'handed_to_entity_memory')
  assert.equal((await store.fetchCandidateObservation(storedCandidate.id))?.status, 'handed_to_entity_memory')

  const memory = entityStore.memories.find((item) => item.title === 'Bitcoin treasury article observed')
  assert.equal(memory?.memory_type, 'news_event')
  // entity_memories forbids memory_type = 'source_marker' post-migration:
  // the processed outcome is reported via result.results[0].markerStatus and
  // the news lane's own local status (asserted above), not a persisted marker row.
  assert.equal(result.results[0].markerStatus, 'processed')
  assert.equal(entityStore.memories.some((item) => item.memory_type === 'source_marker'), false)
})
