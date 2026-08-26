import assert from 'node:assert/strict'
import test from 'node:test'

import type { NewsSignal, ResearchWorkItem, Signal } from './contracts'
import type { ImmutableAppendResult } from './platform-store'
import { SignalIntakeCoordinator, type SignalIntakeStore } from './signal-intake'
import {
  createPriorityPolicyV1,
  RulesFirstTriageEngine,
  type ResearchWorkCreationPolicy,
} from './triage-engine'
import type { RulesFirstTriageInput, TriageDecisionV1 } from './triage-contracts'

const NOW = '2026-08-26T12:00:00.000Z'

function signal(): NewsSignal {
  return {
    schemaVersion: 'myboon.signal.v1', signalId: 'signal-1', sourceType: 'news', sourceId: 'news-1',
    contentKind: 'article', content: { schemaVersion: 'myboon.signal_content.article.v1' },
    observedAt: NOW, publishedAt: NOW, canonicalUrl: 'https://example.com/news', title: 'News',
    visibleSummary: null, media: { imageUrl: null, attribution: null },
    sourceHints: { entities: [], assets: [], eventId: null, deadline: null },
    provenance: { provider: 'test', upstreamSource: null, rawPayloadRef: 'raw-1' }, idempotencyKey: 'key-1',
  }
}

function capacity() {
  const bucket = { available: 10, reservedAvailable: 2, utilization: 0 }
  return {
    byPriority: { P0: { ...bucket }, P1: { ...bucket }, P2: { ...bucket }, P3: { ...bucket } },
    byDepth: { light: { ...bucket }, standard: { ...bucket }, deep: { ...bucket } },
  }
}

function input(overrides: Partial<RulesFirstTriageInput> = {}): RulesFirstTriageInput {
  return {
    signal: signal(), dedupeOutcome: 'new_observation', sourceAuthorityScore: 0.9, officialSource: true,
    entityCanonOverlap: true, novelty: 'material', materialityTags: ['market_material'], eventDeadline: null,
    capacity: capacity(), providerHealth: 'healthy', ambiguity: { isAmbiguous: false, reasons: [] },
    deepEscalation: null, now: NOW, ...overrides,
  }
}

class FakeStore implements SignalIntakeStore {
  readonly writes: string[] = []
  private readonly values = new Map<string, unknown>()

  constructor(readonly sourceType: Signal['sourceType'] = 'news') {}

  appendSignal(value: Signal): ImmutableAppendResult<Signal> { return this.append('signal', value.signalId, value) }
  appendTriageDecision(value: TriageDecisionV1): ImmutableAppendResult<TriageDecisionV1> {
    return this.append('decision', value.decisionId, value)
  }
  admitResearchWork(value: ResearchWorkItem): ImmutableAppendResult<ResearchWorkItem> {
    return this.append('work', value.workId, value)
  }
  private append<T>(kind: string, id: string, value: T): ImmutableAppendResult<T> {
    const inserted = !this.values.has(id)
    this.values.set(id, value)
    this.writes.push(kind)
    return { inserted, value }
  }
}

const retrievalPolicy: ResearchWorkCreationPolicy = {
  policyVersion: 'retrieval-v1', allowedDomains: ['example.com'],
  maxExternalSourcesByDepth: { light: 1, standard: 3, deep: 5 },
}

function engine() {
  return new RulesFirstTriageEngine({
    policy: createPriorityPolicyV1({ policyVersion: 'triage-v1', budgetPolicyVersion: 'budget-v1' }),
  })
}

test('shadow is the default and computes without mutating the store', async () => {
  const store = new FakeStore()
  const result = await new SignalIntakeCoordinator({ store, triage: engine(), retrievalPolicy }).process(input())
  assert.equal(result.mode, 'shadow')
  assert.ok(result.work)
  assert.deepEqual(result.persisted, { signalInserted: false, decisionInserted: false, workInserted: false })
  assert.deepEqual(store.writes, [])
})

test('active persists signal then immutable decision then admitted work and is replay-safe', async () => {
  const store = new FakeStore()
  const coordinator = new SignalIntakeCoordinator({ store, triage: engine(), retrievalPolicy, mode: 'active' })
  const first = await coordinator.process(input())
  const second = await coordinator.process(input())
  assert.deepEqual(store.writes.slice(0, 3), ['signal', 'decision', 'work'])
  assert.deepEqual(first.persisted, { signalInserted: true, decisionInserted: true, workInserted: true })
  assert.deepEqual(second.persisted, { signalInserted: false, decisionInserted: false, workInserted: false })
  assert.equal(first.work?.signalId, first.signal.signalId)
})

test('observe mode persists Signal and triage decision but cannot admit research work', async () => {
  const store = new FakeStore()
  const result = await new SignalIntakeCoordinator({ store, triage: engine(), retrievalPolicy, mode: 'observe' })
    .process(input())
  assert.ok(result.work)
  assert.deepEqual(store.writes, ['signal', 'decision'])
  assert.deepEqual(result.persisted, { signalInserted: true, decisionInserted: true, workInserted: false })
})

test('deferred pressure preserves signal and decision without creating work', async () => {
  const store = new FakeStore()
  const result = await new SignalIntakeCoordinator({ store, triage: engine(), retrievalPolicy, mode: 'active' })
    .process(input({ providerHealth: 'circuit_open', officialSource: false, sourceAuthorityScore: 0.3 }))
  assert.equal(result.decision.outcome, 'defer')
  assert.equal(result.work, null)
  assert.deepEqual(store.writes, ['signal', 'decision'])
  assert.deepEqual(result.persisted, { signalInserted: true, decisionInserted: true, workInserted: false })
})

test('mismatched store or triage identity fails closed', async () => {
  const store = new FakeStore()
  await assert.rejects(
    new SignalIntakeCoordinator({ store: new FakeStore('polymarket'), triage: engine(), retrievalPolicy }).process(input()),
    /cannot process/,
  )
  await assert.rejects(
    new SignalIntakeCoordinator({
      store, retrievalPolicy,
      triage: { async decide(value) { return { ...(await engine().decide(value)), signalId: 'wrong' } } },
    }).process(input()),
    /identity/,
  )
})
