import assert from 'node:assert/strict'
import test from 'node:test'
import { deriveActionsFromMemories } from './actions'
import { buildPublication, runPublisher } from './runner'
import type {
  PublishedNarrativeInput,
  PublishedNarrativeRecord,
  PublisherDraftRecord,
  PublisherEntityRecord,
  PublisherMemoryRecord,
  PublisherStore,
  PublisherWriteResult,
} from './types'

function draft(overrides: Partial<PublisherDraftRecord> = {}): PublisherDraftRecord {
  return {
    id: 'draft-1',
    entity_id: 'entity-1',
    entity_slug: 'ethereum',
    entity_name: 'Ethereum',
    entity_type: 'asset',
    source_memory_ids: ['memory-1'],
    source_memory_hash: 'hash-1',
    source: 'polymarket',
    source_area: 'markets',
    action: 'draft_post',
    status: 'drafted',
    title: 'ETH repricing gets a clean catalyst',
    angle: 'Prediction markets moved after ETF flow context changed.',
    summary: 'Polymarket odds moved as traders repriced the Ethereum ETF timeline.',
    body: 'The editor draft body is already the final public narrative. Publisher should persist it without rewriting.',
    reasoning: 'Editor approved this draft from a new market memory.',
    evidence_quality: 'medium',
    priority: 72,
    confidence: 0.81,
    created_at: '2026-07-03T00:00:00.000Z',
    updated_at: '2026-07-03T00:00:00.000Z',
    ...overrides,
  }
}

function memory(overrides: Partial<PublisherMemoryRecord> = {}): PublisherMemoryRecord {
  return {
    id: 'memory-1',
    source: 'polymarket',
    source_area: 'markets',
    source_type: 'market_signal',
    source_ref_id: 'will-ethereum-etf-flows-top-10b-in-2026',
    source_research_id: 'research-1',
    title: 'ETH market moved',
    summary: 'Market summary',
    evidence: [{ url: 'https://polymarket.com/event/will-ethereum-etf-flows-top-10b-in-2026' }],
    context: { source_market_slug: 'will-ethereum-etf-flows-top-10b-in-2026' },
    ...overrides,
  }
}

function entity(overrides: Partial<PublisherEntityRecord> = {}): PublisherEntityRecord {
  return {
    id: 'entity-1',
    slug: 'ethereum',
    name: 'Ethereum',
    type: 'asset',
    metadata: {},
    ...overrides,
  }
}

class InMemoryPublisherStore implements PublisherStore {
  narratives = new Map<string, PublishedNarrativeRecord>()
  publications: PublishedNarrativeInput[] = []
  history: Array<{ published_narrative_id: string, title: string, content: string }> = []

  constructor(
    public drafts: PublisherDraftRecord[],
    private readonly memories: PublisherMemoryRecord[],
    private readonly entities: PublisherEntityRecord[] = [],
    private readonly markPublished = false
  ) {}

  async fetchEligibleDrafts(batchSize: number): Promise<PublisherDraftRecord[]> {
    return this.drafts.slice(0, batchSize)
  }

  async fetchMemories(memoryIds: string[]): Promise<PublisherMemoryRecord[]> {
    return this.memories.filter((item) => memoryIds.includes(item.id))
  }

  async fetchEntity(entityId: string): Promise<PublisherEntityRecord | null> {
    return this.entities.find((item) => item.id === entityId) ?? null
  }

  async publishDraft(publication: PublishedNarrativeInput): Promise<PublisherWriteResult> {
    const existing = this.narratives.get(publication.editor_draft_id)
    if (existing) {
      this.upsertHistory(existing.id, publication)
      return { narrative: existing, existing: true }
    }

    const narrative = { id: `narrative-${this.narratives.size + 1}`, editor_draft_id: publication.editor_draft_id, published_at: publication.published_at }
    this.narratives.set(publication.editor_draft_id, narrative)
    this.publications.push(publication)
    this.upsertHistory(narrative.id, publication)
    if (this.markPublished) {
      const row = this.drafts.find((item) => item.id === publication.editor_draft_id)
      if (row) row.status = 'published'
    }
    return { narrative, existing: false }
  }

  private upsertHistory(narrativeId: string, publication: PublishedNarrativeInput): void {
    const existing = this.history.find((item) => item.published_narrative_id === narrativeId)
    const row = {
      published_narrative_id: narrativeId,
      title: publication.title,
      content: publication.content_full,
    }
    if (existing) Object.assign(existing, row)
    else this.history.push(row)
  }
}

test('buildPublication maps editor draft content without rewriting', () => {
  const publication = buildPublication(
    draft(),
    entity({ metadata: { category: 'crypto' } }),
    [memory()],
    '2026-07-03T01:00:00.000Z'
  )

  assert.equal(publication.title, 'ETH repricing gets a clean catalyst')
  assert.equal(publication.content_small, 'Polymarket odds moved as traders repriced the Ethereum ETF timeline.')
  assert.equal(publication.content_full, 'The editor draft body is already the final public narrative. Publisher should persist it without rewriting.')
  assert.equal(publication.priority, 72)
  assert.deepEqual(publication.tags, ['crypto'])
  assert.equal(publication.entity_category, 'crypto')
  assert.equal(publication.status, 'published')
})

test('buildPublication normalizes a fractional draft priority for the integer public feed', () => {
  const publication = buildPublication(
    draft({ priority: 0.7 }),
    entity(),
    [memory()],
    '2026-07-03T01:00:00.000Z'
  )

  assert.equal(publication.priority, 1)
})

test('runPublisher skips non-draft actions and invalid drafted rows', async () => {
  const store = new InMemoryPublisherStore([
    draft({ id: 'watch-1', action: 'watch', status: 'watching' }),
    draft({ id: 'invalid-1', title: null }),
  ], [memory()])

  const result = await runPublisher({
    store,
    now: '2026-07-03T01:00:00.000Z',
  })

  assert.equal(result.publicationsWritten, 0)
  assert.equal(result.skipped, 2)
  assert.deepEqual(store.publications, [])
})

test('deriveActionsFromMemories creates Polymarket predict actions from source evidence and context', () => {
  const actions = deriveActionsFromMemories([
    memory({
      source_ref_id: 'will-arc-launch-a-token-by-december-31-2026',
      context: {
        source_market_slug: 'will-arc-launch-a-token-by-december-31-2026',
        nested: { url: 'https://polymarket.com/event/will-arc-launch-a-token-by-december-31-2026?tid=abc' },
      },
      evidence: [{ source_url: 'https://polymarket.com/market/will-ethereum-hit-5000-in-2026' }],
    }),
  ])

  assert.deepEqual(actions, [
    { type: 'predict', label: 'Open market', slug: 'will-arc-launch-a-token-by-december-31-2026' },
    { type: 'predict', label: 'Open market', slug: 'will-ethereum-hit-5000-in-2026' },
  ])
})

test('deriveActionsFromMemories ignores generic slug fields like tag_slug', () => {
  const actions = deriveActionsFromMemories([
    memory({
      source: 'news',
      source_ref_id: 'article-1',
      evidence: [],
      context: {
        tag_slug: 'crypto',
        research_cluster_key: 'market:crypto',
        source_market_slug: 'will-ethereum-hit-5000-in-2026',
      },
    }),
  ])

  assert.deepEqual(actions, [
    { type: 'predict', label: 'Open market', slug: 'will-ethereum-hit-5000-in-2026' },
  ])
})

test('deriveActionsFromMemories caps actions and prioritizes primary source slug first', () => {
  const actions = deriveActionsFromMemories([
    memory({
      source: 'polymarket',
      source_ref_id: 'primary-market-slug',
      context: {
        source_market_slug: 'context-market-slug',
      },
      evidence: [
        { url: 'https://polymarket.com/event/evidence-market-one' },
        { url: 'https://polymarket.com/event/evidence-market-two' },
        { url: 'https://polymarket.com/event/evidence-market-three' },
        { url: 'https://polymarket.com/event/evidence-market-four' },
      ],
    }),
  ])

  assert.deepEqual(actions, [
    { type: 'predict', label: 'Open market', slug: 'primary-market-slug' },
    { type: 'predict', label: 'Open market', slug: 'context-market-slug' },
    { type: 'predict', label: 'Open market', slug: 'evidence-market-one' },
  ])
})

test('buildPublication keeps actions empty when no inspectable source exists', () => {
  const publication = buildPublication(
    draft({ source: 'news', source_area: 'articles' }),
    entity(),
    [memory({ source: 'news', source_ref_id: 'article-1', evidence: [{ url: 'https://example.com/story' }], context: {} })],
    '2026-07-03T01:00:00.000Z'
  )

  assert.deepEqual(publication.actions, [])
  assert.deepEqual(publication.tags, [])
  assert.equal(publication.entity_category, 'asset')
})

test('runPublisher is idempotent by editor draft id', async () => {
  const store = new InMemoryPublisherStore([draft()], [memory()], [entity()])

  const first = await runPublisher({ store, now: '2026-07-03T01:00:00.000Z' })
  const second = await runPublisher({ store, now: '2026-07-03T01:01:00.000Z' })

  assert.equal(first.publicationsWritten, 1)
  assert.equal(second.publicationsExisting, 1)
  assert.equal(store.narratives.size, 1)
  assert.equal(store.publications.length, 1)
})

test('runPublisher writes entity history and marks drafts published through the store', async () => {
  const row = draft()
  const store = new InMemoryPublisherStore([row], [memory()], [entity()], true)

  const result = await runPublisher({ store, now: '2026-07-03T01:00:00.000Z' })

  assert.equal(result.publicationsWritten, 1)
  assert.equal(row.status, 'published')
  assert.equal(store.history.length, 1)
  assert.equal(store.history[0].title, row.title)
  assert.equal(store.history[0].content, row.body)
})

test('runPublisher preview does not write', async () => {
  const store = new InMemoryPublisherStore([draft()], [memory()], [entity()])

  const result = await runPublisher({
    store,
    now: '2026-07-03T01:00:00.000Z',
    dryRun: true,
  })

  assert.equal(result.dryRun, true)
  assert.equal(result.publications.length, 1)
  assert.equal(result.publicationsWritten, 0)
  assert.equal(store.narratives.size, 0)
})
