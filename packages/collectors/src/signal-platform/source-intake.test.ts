import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import type { Signal } from './contracts'
import {
  CanonicalSourceSignalIntake,
  deliverCanonicalSignals,
  type SourceSignalIntakePort,
} from './source-intake'
import { SqliteSignalPlatformStore } from './sqlite-platform-store'
import { createPriorityPolicyV1, RulesFirstTriageEngine } from './triage-engine'
import type { RulesFirstTriageInput } from './triage-contracts'

const NOW = '2026-08-26T12:00:00.000Z'

function signal(): Signal {
  return {
    schemaVersion: 'myboon.signal.v1', signalId: 'signal-source-live', sourceType: 'news',
    sourceId: 'news:live', contentKind: 'article',
    content: { schemaVersion: 'myboon.signal_content.article.v1' },
    observedAt: NOW, publishedAt: null, canonicalUrl: 'https://example.com/live',
    title: 'Live observation', visibleSummary: null,
    media: { imageUrl: null, attribution: null },
    sourceHints: { entities: [], assets: [], eventId: null, deadline: null },
    provenance: { provider: 'test', upstreamSource: null, rawPayloadRef: 'raw-live' },
    idempotencyKey: 'news:live:1',
  }
}

function triageInput(item: Signal): RulesFirstTriageInput {
  const bucket = { available: 0, reservedAvailable: 0, utilization: 1 }
  return {
    signal: item, dedupeOutcome: 'new_observation', sourceAuthorityScore: 0.2,
    officialSource: false, entityCanonOverlap: false, novelty: 'low',
    materialityTags: ['background'], eventDeadline: null,
    capacity: {
      byPriority: { P0: { ...bucket }, P1: { ...bucket }, P2: { ...bucket }, P3: { ...bucket } },
      byDepth: { light: { ...bucket }, standard: { ...bucket }, deep: { ...bucket } },
    },
    providerHealth: 'unavailable', ambiguity: { isAmbiguous: false, reasons: [] },
    deepEscalation: null, now: NOW,
  }
}

test('observe mode appends a Signal idempotently and cannot create queue work', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'source-intake-observe-'))
  const store = new SqliteSignalPlatformStore(join(dir, 'news.sqlite'), 'news')
  try {
    const intake = new CanonicalSourceSignalIntake({ mode: 'observe', store })
    const report = await deliverCanonicalSignals(intake, [signal(), structuredClone(signal())])
    assert.deepEqual(report, {
      mode: 'observe', attempted: 2, insertedSignals: 1, duplicateSignals: 1,
      insertedDecisions: 0, admittedWorkItems: 0, failures: [],
    })
    assert.equal((await store.getSchedulerStatus({ now: NOW })).total, 0)
    const laterPoll = { ...signal(), observedAt: '2026-08-26T12:01:00.000Z' }
    const later = await intake.ingest(laterPoll)
    assert.equal(later.signalInserted, false)
    const status = await store.readWorkObservability({
      now: '2026-08-26T13:00:00.000Z', recentFailureSince: NOW, failureLimit: 10,
    })
    assert.equal(status.observationCount, 2)
    assert.equal(status.deduplicatedObservationCount, 1)
  } finally {
    store.close(); rmSync(dir, { recursive: true, force: true })
  }
})

test('active mode retains deferred Signal and decision without admitting work', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'source-intake-active-'))
  const store = new SqliteSignalPlatformStore(join(dir, 'news.sqlite'), 'news')
  try {
    const intake = new CanonicalSourceSignalIntake({
      mode: 'active', store,
      triage: new RulesFirstTriageEngine({
        policy: createPriorityPolicyV1({ policyVersion: 'source-live.v1', budgetPolicyVersion: 'source-budget.v1' }),
      }),
      retrievalPolicy: {
        policyVersion: 'source-retrieval.v1', allowedDomains: ['example.com'],
        maxExternalSourcesByDepth: { light: 0, standard: 2, deep: 5 },
      },
      buildTriageInput: triageInput,
    })
    const result = await intake.ingest(signal())
    assert.equal(result.decision?.outcome, 'defer')
    assert.equal(result.signalInserted, true)
    assert.equal(result.decisionInserted, true)
    assert.equal(result.workInserted, false)
    assert.ok(store.getSignal(signal().signalId))
    assert.equal((await store.getSchedulerStatus({ now: NOW })).total, 0)
  } finally {
    store.close(); rmSync(dir, { recursive: true, force: true })
  }
})

test('batch delivery isolates and redacts a failed canonical shadow write', async () => {
  const broken: SourceSignalIntakePort = {
    mode: 'observe',
    async ingest() { throw new Error('SUPABASE_SERVICE_ROLE_KEY=never-report') },
  }
  const report = await deliverCanonicalSignals(broken, [signal()])
  assert.deepEqual(report.failures, [{
    signalId: signal().signalId, sourceType: 'news', code: 'CANONICAL_SIGNAL_INTAKE_FAILED',
  }])
  assert.doesNotMatch(JSON.stringify(report), /never-report|SERVICE_ROLE/)
})
