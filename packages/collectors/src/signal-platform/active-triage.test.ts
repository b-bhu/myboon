import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import type { Signal } from './contracts'
import {
  buildNewsTriageFacts,
  buildPolymarketTriageFacts,
  createActiveSourceTriageIntake,
} from './active-triage'
import { SqliteLocalCapacitySnapshot } from './local-capacity'
import { SqliteSignalPlatformStore } from './sqlite-platform-store'
import { deliverCanonicalSignals } from './source-intake'
import type { TriageCapacitySnapshot } from './triage-contracts'

const NOW = '2026-08-26T12:00:00.000Z'

function news(): Extract<Signal, { sourceType: 'news' }> {
  return {
    schemaVersion: 'myboon.signal.v1', signalId: 'sig-active-news', sourceType: 'news',
    contentKind: 'article', content: {
      schemaVersion: 'myboon.signal_content.article.v1', materialChange: true,
    },
    sourceId: 'article:1', observedAt: NOW, publishedAt: NOW,
    canonicalUrl: 'https://example.com/report', title: 'Quarterly earnings guidance rises',
    visibleSummary: 'Revenue and earnings guidance changed materially.',
    media: { imageUrl: null, attribution: null },
    sourceHints: { entities: ['Example'], assets: [], eventId: null, deadline: null },
    provenance: { provider: 'wire', upstreamSource: 'Wire', rawPayloadRef: 'news:1' },
    idempotencyKey: 'news:material:1',
  }
}

function polymarket(): Extract<Signal, { sourceType: 'polymarket' }> {
  return {
    schemaVersion: 'myboon.signal.v1', signalId: 'sig-active-poly', sourceType: 'polymarket',
    contentKind: 'market_event', content: {
      schemaVersion: 'myboon.signal_content.market_event.v1', score: 0.81,
      candidateType: 'odds_spike',
    },
    sourceId: 'market:1', observedAt: NOW, publishedAt: null,
    canonicalUrl: 'https://polymarket.com/event/example', title: 'Example market',
    visibleSummary: 'Odds moved sharply.', media: { imageUrl: null, attribution: null },
    sourceHints: { entities: [], assets: [], eventId: '1', deadline: '2026-08-26T13:00:00.000Z' },
    provenance: { provider: 'polymarket', upstreamSource: 'markets', rawPayloadRef: 'market:1' },
    idempotencyKey: 'poly:1',
  }
}

function openCapacity(): TriageCapacitySnapshot {
  const bucket = { available: 100, reservedAvailable: 10, utilization: 0 }
  return {
    byPriority: { P0: { ...bucket }, P1: { ...bucket }, P2: { ...bucket }, P3: { ...bucket } },
    byDepth: { light: { ...bucket }, standard: { ...bucket }, deep: { ...bucket } },
  }
}

test('source fact builders are deterministic, conservative, and do not mutate Signals', () => {
  const newsSignal = news()
  const before = structuredClone(newsSignal)
  assert.deepEqual(buildNewsTriageFacts(newsSignal), buildNewsTriageFacts(newsSignal))
  assert.equal(buildNewsTriageFacts(newsSignal).dedupeOutcome, 'material_change')
  assert.ok(buildNewsTriageFacts(newsSignal).materialityTags.includes('earnings'))
  assert.deepEqual(newsSignal, before)

  const marketFacts = buildPolymarketTriageFacts(polymarket())
  assert.equal(marketFacts.officialSource, true)
  assert.deepEqual(marketFacts.materialityTags, ['market_material'])
  assert.equal('priorityClass' in marketFacts, false)
})

test('active rules-first composition admits work and local capacity observes it', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'active-triage-'))
  const store = new SqliteSignalPlatformStore(join(dir, 'news.sqlite'), 'news')
  try {
    const intake = createActiveSourceTriageIntake({
      store,
      capacity: { snapshot: () => openCapacity() },
      providerHealth: 'healthy',
      clock: () => NOW,
      allowedDepths: ['light', 'standard'],
    })
    const result = await intake.ingest(news())
    assert.equal(result.signalInserted, true)
    assert.equal(result.decision?.outcome, 'standard')
    assert.equal(result.workInserted, true)
    const snapshot = new SqliteLocalCapacitySnapshot(store).snapshot({ sourceType: 'news', now: NOW })
    assert.equal(snapshot.byPriority.P2.available, 99)
    assert.equal(snapshot.byDepth.standard.available, 49)
  } finally {
    store.close(); rmSync(dir, { recursive: true, force: true })
  }
})

test('Signal remains durable when capacity/triage composition fails after observation', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'active-triage-failure-'))
  const store = new SqliteSignalPlatformStore(join(dir, 'news.sqlite'), 'news')
  try {
    const intake = createActiveSourceTriageIntake({
      store, providerHealth: 'healthy', clock: () => NOW,
      allowedDepths: ['light', 'standard'],
      capacity: { snapshot: () => { throw new Error('capacity unavailable') } },
    })
    await assert.rejects(() => intake.ingest(news()), /capacity unavailable/)
    assert.ok(store.getSignal(news().signalId))
    assert.equal(store.listTriageDecisionsBySignal(news().signalId, 10).length, 0)
    assert.equal((await store.getSchedulerStatus({ now: NOW })).total, 0)
  } finally {
    store.close(); rmSync(dir, { recursive: true, force: true })
  }
})

test('unsupported standard depth defers without losing P0/P1 priority semantics', async () => {
  const cases: Array<{ item: Signal; expected: 'P0' | 'P1' }> = [
    {
      item: {
        ...news(), signalId: 'sig-official-p0', idempotencyKey: 'official-p0',
        provenance: { ...news().provenance, provider: 'government_official' },
        sourceHints: { ...news().sourceHints, deadline: '2026-08-26T12:10:00.000Z' },
      },
      expected: 'P0',
    },
    { item: polymarket(), expected: 'P1' },
  ]
  for (const { item, expected } of cases) {
    const dir = mkdtempSync(join(tmpdir(), `active-depth-${expected}-`))
    const store = new SqliteSignalPlatformStore(join(dir, 'source.sqlite'), item.sourceType)
    try {
      const intake = createActiveSourceTriageIntake({
        store, capacity: { snapshot: () => openCapacity() }, providerHealth: 'healthy', clock: () => NOW,
      })
      const result = await intake.ingest(item)
      assert.equal(result.decision?.priorityClass, expected)
      assert.equal(result.decision?.outcome, 'defer')
      assert.equal(result.decision?.budget, null)
      assert.ok(result.decision?.reasons.some((reason) => reason.code === 'unsupported_research_depth_defer'))
      assert.equal(result.workInserted, false)
    } finally {
      store.close(); rmSync(dir, { recursive: true, force: true })
    }
  }
})

test('a later bounded cycle retries retained untriaged Signals without a source re-observation', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'active-triage-retry-'))
  const store = new SqliteSignalPlatformStore(join(dir, 'news.sqlite'), 'news')
  let capacityCalls = 0
  try {
    const intake = createActiveSourceTriageIntake({
      store, providerHealth: 'healthy', clock: () => NOW,
      allowedDepths: ['light', 'standard'],
      capacity: { snapshot: () => {
        capacityCalls += 1
        if (capacityCalls <= 2) throw new Error('transient capacity failure')
        return openCapacity()
      } },
    })
    const first = await deliverCanonicalSignals(intake, [news()])
    assert.equal(first.failures.length, 2)
    assert.ok(store.getSignal(news().signalId))
    assert.equal(store.listTriageDecisionsBySignal(news().signalId, 10).length, 0)

    const retryCycle = await deliverCanonicalSignals(intake, [])
    assert.equal(retryCycle.attempted, 1)
    assert.equal(retryCycle.insertedDecisions, 1)
    assert.equal(retryCycle.admittedWorkItems, 1)
    assert.equal(store.listTriageDecisionsBySignal(news().signalId, 10).length, 1)
  } finally {
    store.close(); rmSync(dir, { recursive: true, force: true })
  }
})

test('classifier is ignored unless explicitly enabled and enabled-without-port fails closed', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'active-triage-classifier-'))
  const store = new SqliteSignalPlatformStore(join(dir, 'news.sqlite'), 'news')
  let calls = 0
  const classifier = { classify: async () => {
    calls += 1
    return {
      schemaVersion: 'myboon.triage_classifier_result.v1' as const,
      suggestedOutcome: 'light' as const, scoreAdjustment: 0,
      reason: 'insufficient_rules' as const, explanation: 'bounded ambiguity',
    }
  } }
  try {
    assert.throws(() => createActiveSourceTriageIntake({
      store, capacity: { snapshot: () => openCapacity() }, providerHealth: 'healthy', classifierEnabled: true,
    }), /no classifier port/)
    const intake = createActiveSourceTriageIntake({
      store, capacity: { snapshot: () => openCapacity() }, providerHealth: 'healthy',
      classifier, classifierEnabled: false, clock: () => NOW,
    })
    await intake.ingest(news())
    assert.equal(calls, 0)
  } finally {
    store.close(); rmSync(dir, { recursive: true, force: true })
  }
})
