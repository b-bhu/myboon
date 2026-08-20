import assert from 'node:assert/strict'
import test from 'node:test'
import type { SupabaseClient } from '@supabase/supabase-js'
import { SqlitePipelineStore } from '../pipeline-store/sqlite-store'
import { InMemoryEntityMemoryStore } from './test-helpers'
import type { ExtractionProvider } from './types'
import { polymarketEntityManagerCliConfig, runPolymarketEntityManager } from './run-polymarket'

test('polymarketEntityManagerCliConfig reads batch, interval, and run-once env', () => {
  const config = polymarketEntityManagerCliConfig({
    ENTITY_MANAGER_POLYMARKET_BATCH_SIZE: '7',
    ENTITY_MANAGER_POLYMARKET_INTERVAL_MS: '30000',
    ENTITY_MANAGER_POLYMARKET_RUN_ONCE: '1',
    ENTITY_MANAGER_HERMES_TIMEOUT_MS: '180000',
    ENTITY_MANAGER_POLYMARKET_MAX_AGE_MS: '86400000',
    ENTITY_MANAGER_POLYMARKET_LEASE_MS: '4000000',
    ENTITY_MANAGER_POLYMARKET_MAX_ATTEMPTS: '4',
    ENTITY_MANAGER_POLYMARKET_RETRY_BASE_MS: '45000',
  })

  assert.equal(config.batchSize, 7)
  assert.equal(config.intervalMs, 30_000)
  assert.equal(config.runOnce, true)
  assert.equal(config.hermesTimeoutMs, 180_000)
  assert.equal(config.maxAgeMs, 86_400_000)
  assert.equal(config.leaseMs, 4_000_000)
  assert.equal(config.maxAttempts, 4)
  assert.equal(config.retryBaseMs, 45_000)
})

test('polymarketEntityManagerCliConfig falls back on invalid numeric env', () => {
  const config = polymarketEntityManagerCliConfig({
    ENTITY_MANAGER_POLYMARKET_BATCH_SIZE: '0',
    ENTITY_MANAGER_POLYMARKET_INTERVAL_MS: 'abc',
  })

  assert.equal(config.batchSize, 20)
  assert.equal(config.intervalMs, 300_000)
  assert.equal(config.runOnce, false)
  assert.equal(config.hermesTimeoutMs, 60_000)
  assert.equal(config.maxAgeMs, 172_800_000)
  assert.equal(config.leaseMs, 7_200_000)
  assert.equal(config.maxAttempts, 3)
  assert.equal(config.retryBaseMs, 300_000)
})

test('Polymarket Entity Manager retries a temporary extraction failure after backoff', async () => {
  const store = new SqlitePipelineStore(':memory:')
  try {
    const researchId = await seedPolymarketResearch(store, 'entity-manager-retry')
    const entityStore = new InMemoryEntityMemoryStore()
    let calls = 0
    const extractionProvider: ExtractionProvider = {
      async extract() {
        calls += 1
        if (calls === 1) throw new Error('Hermes temporarily unavailable')
        return {
          primaryEntities: [{ name: 'Federal Reserve', type: 'organization', slug: 'federal-reserve' }],
          memories: [{
            entitySlug: 'federal-reserve',
            memoryType: 'market_signal',
            title: 'Rate-cut odds moved',
            summary: 'Polymarket odds materially repriced.',
          }],
        }
      },
    }

    const first = await runPolymarketEntityManager(store, {} as SupabaseClient, {
      entityStore,
      extractionProvider,
      now: new Date('2026-08-19T03:00:00.000Z'),
      leaseOwner: 'retry-worker-1',
      retryBaseMs: 60_000,
      maxAttempts: 3,
    })
    const beforeBackoff = await runPolymarketEntityManager(store, {} as SupabaseClient, {
      entityStore,
      extractionProvider,
      now: new Date('2026-08-19T03:00:30.000Z'),
      leaseOwner: 'retry-worker-2',
      retryBaseMs: 60_000,
      maxAttempts: 3,
    })
    const afterBackoff = await runPolymarketEntityManager(store, {} as SupabaseClient, {
      entityStore,
      extractionProvider,
      now: new Date('2026-08-19T03:01:01.000Z'),
      leaseOwner: 'retry-worker-3',
      retryBaseMs: 60_000,
      maxAttempts: 3,
    })

    assert.deepEqual(
      { fetched: first.fetched, failed: first.failed, retried: first.retried, terminal: first.terminalFailed },
      { fetched: 1, failed: 1, retried: 1, terminal: 0 },
    )
    assert.equal(beforeBackoff.fetched, 0)
    assert.equal(afterBackoff.processed, 1)
    const row = (await store.getResearchByIds([researchId]))[0]
    assert.equal(row.entityManagerStatus, 'processed')
    assert.equal(row.entityManagerAttemptCount, 2)
  } finally {
    store.close()
  }
})

test('Polymarket Entity Manager makes only classified permanent failures terminal', async () => {
  const store = new SqlitePipelineStore(':memory:')
  try {
    const researchId = await seedPolymarketResearch(store, 'entity-manager-permanent')
    const permanentError = Object.assign(new Error('packet cannot be processed'), { retryable: false })
    const result = await runPolymarketEntityManager(store, {} as SupabaseClient, {
      entityStore: new InMemoryEntityMemoryStore(),
      extractionProvider: { async extract() { throw permanentError } },
      now: new Date('2026-08-19T03:00:00.000Z'),
      leaseOwner: 'permanent-worker',
      maxAttempts: 3,
    })

    assert.equal(result.retried, 0)
    assert.equal(result.terminalFailed, 1)
    assert.equal((await store.getResearchByIds([researchId]))[0].entityManagerStatus, 'failed')
  } finally {
    store.close()
  }
})

async function seedPolymarketResearch(store: SqlitePipelineStore, dedupeKey: string): Promise<string> {
  const [candidate] = await store.insertCandidates([{
    source: 'polymarket',
    area: 'markets',
    candidateType: 'odds_moved',
    marketId: `market-${dedupeKey}`,
    slug: `will-fed-cut-rates-${dedupeKey}`,
    title: 'Will the Fed cut rates?',
    tagSlug: 'economics',
    tagLabel: 'Economics',
    observedAt: '2026-08-19T01:00:00.000Z',
    whatChanged: 'Odds moved ten points.',
    whyFlagged: 'Material repricing.',
    score: 0.8,
    scoreBreakdown: {},
    metrics: { currentYes: 0.6 },
    evidenceRefs: [],
    dedupeKey,
  }])
  const [researchId] = await store.upsertResearchRows([{
    candidateId: candidate.id,
    source: 'polymarket',
    area: 'markets',
    slug: candidate.slug,
    title: candidate.title,
    candidateType: candidate.candidateType,
    researchMode: 'deep_web',
    summary: 'Fresh macro research.',
    notes: 'Evidence checked.',
    keyFindings: ['The market repriced.'],
    evidenceLinks: [{ url: 'https://example.com/evidence' }],
    relatedContext: [],
    uncertainty: 'Low.',
    editorNotes: '',
    status: 'pending_editor',
    researchedAt: '2026-08-19T02:00:00.000Z',
    researchFamilyKey: `fed-rates-${dedupeKey}`,
    researchClusterKey: `polymarket:markets:${dedupeKey}`,
    researchDepth: 'deep_web',
    evidenceQuality: 'strong',
    catalystFound: true,
    recommendedEditorAction: 'publish_candidate',
    researchBackend: 'hermes_cli',
  }])
  return researchId
}

test('Polymarket Entity Manager consumes a fresh SQLite research row only once', async () => {
  const store = new SqlitePipelineStore(':memory:')
  try {
    const [candidate] = await store.insertCandidates([{
      source: 'polymarket',
      area: 'markets',
      candidateType: 'odds_moved',
      marketId: 'market-1',
      slug: 'will-fed-cut-rates',
      title: 'Will the Fed cut rates?',
      tagSlug: 'economics',
      tagLabel: 'Economics',
      observedAt: '2026-08-19T01:00:00.000Z',
      whatChanged: 'Odds moved ten points.',
      whyFlagged: 'Material repricing.',
      score: 0.8,
      scoreBreakdown: {},
      metrics: { currentYes: 0.6 },
      evidenceRefs: [],
      dedupeKey: 'entity-manager-once',
    }])
    const [researchId] = await store.upsertResearchRows([{
      candidateId: candidate.id,
      source: 'polymarket',
      area: 'markets',
      slug: candidate.slug,
      title: candidate.title,
      candidateType: candidate.candidateType,
      researchMode: 'deep_web',
      summary: 'Fresh macro research.',
      notes: 'Evidence checked.',
      keyFindings: ['The market repriced.'],
      evidenceLinks: [{ url: 'https://example.com/evidence' }],
      relatedContext: [],
      uncertainty: 'Low.',
      editorNotes: '',
      status: 'pending_editor',
      researchedAt: '2026-08-19T02:00:00.000Z',
      researchFamilyKey: 'fed-rates',
      researchClusterKey: 'polymarket:markets:fed-rates',
      researchDepth: 'deep_web',
      evidenceQuality: 'strong',
      catalystFound: true,
      recommendedEditorAction: 'publish_candidate',
      researchBackend: 'hermes_cli',
    }])
    const entityStore = new InMemoryEntityMemoryStore()
    const extractionProvider: ExtractionProvider = {
      async extract() {
        return {
          primaryEntities: [{ name: 'Federal Reserve', type: 'organization', slug: 'federal-reserve' }],
          memories: [{
            entitySlug: 'federal-reserve',
            memoryType: 'market_signal',
            title: 'Rate-cut odds moved',
            summary: 'Polymarket odds materially repriced.',
          }],
        }
      },
    }

    const first = await runPolymarketEntityManager(store, {} as SupabaseClient, {
      entityStore,
      extractionProvider,
      now: new Date('2026-08-19T03:00:00.000Z'),
      leaseOwner: 'test-worker-1',
    })
    const second = await runPolymarketEntityManager(store, {} as SupabaseClient, {
      entityStore,
      extractionProvider,
      now: new Date('2026-08-19T04:00:00.000Z'),
      leaseOwner: 'test-worker-2',
    })

    assert.equal(first.fetched, 1)
    assert.equal(first.processed, 1)
    assert.equal(second.fetched, 0)
    assert.equal(entityStore.memories.length, 1)
    assert.equal((await store.getResearchByIds([researchId]))[0].status, 'pending_editor')
  } finally {
    store.close()
  }
})
