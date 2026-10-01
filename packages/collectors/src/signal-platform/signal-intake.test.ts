import assert from 'node:assert/strict'
import test from 'node:test'

import type { NewsSignal, ResearchWorkItem, Signal } from './contracts'
import type { ImmutableAppendResult, IntakeUnit, IntakeUnitAppendResult } from './platform-store'
import type { AdmissionDispositionV1 } from './intake-admission'
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

/**
 * In-memory stand-in for the transactional store. `appendIntakeUnit` records the
 * whole unit as one write so an in-test failure can be injected between the
 * decision, disposition, and work rows.
 */
class FakeStore implements SignalIntakeStore {
  readonly writes: string[] = []
  readonly signals = new Map<string, Signal>()
  readonly units = new Map<string, IntakeUnit>()
  failUnitWrite = false
  private work = new Map<string, ResearchWorkItem>()

  constructor(readonly sourceType: Signal['sourceType'] = 'news') {}

  appendSignal(value: Signal): ImmutableAppendResult<Signal> {
    const inserted = !this.signals.has(value.signalId)
    this.signals.set(value.signalId, value)
    this.writes.push('signal')
    return { inserted, value }
  }

  appendIntakeUnit(unit: IntakeUnit): IntakeUnitAppendResult {
    if (this.failUnitWrite) {
      this.failUnitWrite = false
      throw new Error('injected intake unit failure')
    }
    const known = this.units.get(unit.decision.decisionId)
    if (known) {
      if (known.disposition.dispositionId !== unit.disposition.dispositionId) {
        throw new Error('immutable admission conflict')
      }
      return {
        decision: { inserted: false, value: known.decision },
        disposition: { inserted: false, value: known.disposition },
        work: known.work ? { inserted: false, value: known.work } : null,
      }
    }
    this.writes.push('decision', 'disposition')
    if (unit.work) {
      this.writes.push('work')
      this.work.set(unit.work.workId, unit.work)
    }
    this.units.set(unit.decision.decisionId, unit)
    return {
      decision: { inserted: true, value: unit.decision },
      disposition: { inserted: true, value: unit.disposition },
      work: unit.work ? { inserted: true, value: unit.work } : null,
    }
  }

  findIntakeUnit(input: { signalId: string }): {
    decision: TriageDecisionV1
    disposition: AdmissionDispositionV1 | null
    work: ResearchWorkItem | null
  } | null {
    const unit = [...this.units.values()].find((item) => item.decision.signalId === input.signalId)
    if (!unit) return null
    return {
      decision: unit.decision,
      disposition: unit.disposition,
      work: unit.work && this.work.has(unit.work.workId) ? unit.work : null,
    }
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
  assert.equal(result.disposition, null)
  assert.deepEqual(store.writes, [])
  assert.deepEqual(result.persisted, {
    signalInserted: false, decisionInserted: false, dispositionInserted: false, workInserted: false,
  })
})

test('active persists signal, decision, admission disposition, and work as one unit', async () => {
  const store = new FakeStore()
  const coordinator = new SignalIntakeCoordinator({ store, triage: engine(), retrievalPolicy, mode: 'active' })
  const first = await coordinator.process(input())
  assert.deepEqual(store.writes, ['signal', 'decision', 'disposition', 'work'])
  assert.deepEqual(first.persisted, {
    signalInserted: true, decisionInserted: true, dispositionInserted: true, workInserted: true,
  })
  assert.equal(first.disposition?.authorization, 'active_intake')
  assert.equal(first.disposition?.requiresWork, true)
  assert.equal(first.disposition?.workPayloadDigest !== null, true)
  assert.equal(first.disposition?.retrievalPolicyVersion, 'retrieval-v1')
  assert.equal(first.work?.signalId, first.signal.signalId)
})

test('repeated active delivery returns the saved unit without repeating triage', async () => {
  const store = new FakeStore()
  let decisions = 0
  const triage = { async decide(value: RulesFirstTriageInput) { decisions += 1; return engine().decide(value) } }
  const coordinator = new SignalIntakeCoordinator({ store, triage, retrievalPolicy, mode: 'active' })
  const first = await coordinator.process(input())
  const second = await coordinator.process(input())
  assert.equal(decisions, 1)
  assert.equal(second.recovered, true)
  assert.equal(second.work?.workId, first.work?.workId)
  assert.equal(second.disposition?.dispositionId, first.disposition?.dispositionId)
  assert.deepEqual(second.persisted, {
    signalInserted: false, decisionInserted: false, dispositionInserted: false, workInserted: false,
  })
})

test('observe mode persists Signal and decision but records a no-admission disposition', async () => {
  const store = new FakeStore()
  const result = await new SignalIntakeCoordinator({ store, triage: engine(), retrievalPolicy, mode: 'observe' })
    .process(input())
  assert.ok(result.work)
  assert.deepEqual(store.writes, ['signal', 'decision', 'disposition'])
  assert.equal(result.disposition?.authorization, 'observe_evaluation')
  assert.equal(result.disposition?.requiresWork, false)
  assert.deepEqual(result.persisted, {
    signalInserted: true, decisionInserted: true, dispositionInserted: true, workInserted: false,
  })
})

test('deferred pressure preserves signal and decision without creating work', async () => {
  const store = new FakeStore()
  const result = await new SignalIntakeCoordinator({ store, triage: engine(), retrievalPolicy, mode: 'active' })
    .process(input({ providerHealth: 'circuit_open', officialSource: false, sourceAuthorityScore: 0.3 }))
  assert.equal(result.decision.outcome, 'defer')
  assert.equal(result.work, null)
  assert.equal(result.disposition?.authorization, 'no_work_outcome')
  assert.equal(result.disposition?.requiresWork, false)
  assert.deepEqual(store.writes, ['signal', 'decision', 'disposition'])
})

test('observe mode records no-admission for a deferred outcome too', async () => {
  const store = new FakeStore()
  // Zero capacity defers, so there is no research work to withhold admission for.
  const empty = { available: 0, reservedAvailable: 0, utilization: 1 }
  const result = await new SignalIntakeCoordinator({ store, triage: engine(), retrievalPolicy, mode: 'observe' })
    .process(input({
      providerHealth: 'unavailable',
      capacity: {
        byPriority: { P0: { ...empty }, P1: { ...empty }, P2: { ...empty }, P3: { ...empty } },
        byDepth: { light: { ...empty }, standard: { ...empty }, deep: { ...empty } },
      },
    }))
  assert.equal(result.decision.outcome, 'defer')
  assert.equal(result.work, null)
  // Observe mode always records observe_evaluation, never an active no-work outcome.
  assert.equal(result.disposition?.authorization, 'observe_evaluation')
  assert.equal(result.disposition?.mode, 'observe')
  assert.equal(result.disposition?.requiresWork, false)
  assert.deepEqual(store.writes, ['signal', 'decision', 'disposition'])
})

test('a failed intake unit write leaves the already saved signal in place', async () => {
  const store = new FakeStore()
  const coordinator = new SignalIntakeCoordinator({ store, triage: engine(), retrievalPolicy, mode: 'active' })
  store.failUnitWrite = true
  await assert.rejects(coordinator.process(input()), /injected intake unit failure/)
  assert.equal(store.signals.has('signal-1'), true)
  assert.equal(store.units.size, 0)
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
