import assert from 'node:assert/strict'
import test from 'node:test'

import type { SignalPlatformControlPlaneStatus, SourceControlPlaneStatus } from './control-plane'
import { parseDrainVerificationArgs, verifyDrainState } from './drain-verification'
import { defaultRuntimeControl, type FeedV3RuntimeControlV1 } from './runtime-control'

const NOW = '2026-08-27T12:00:00.000Z'
const OPERATION = 'runtime_control_test'

test('drain verifier requires exact operation, sources, and bounded polling', () => {
  assert.deepEqual(parseDrainVerificationArgs([
    '--stage', 'research', '--operation-id', OPERATION, '--sources', 'news,polymarket',
    '--timeout-ms', '5000', '--poll-ms', '500',
  ]), {
    stage: 'research', operationId: OPERATION, sources: ['news', 'polymarket'], timeoutMs: 5000, pollMs: 500,
  })
  assert.throws(() => parseDrainVerificationArgs(['--stage', 'research']), /operation-id/)
})

test('drain verification passes only for current drained runtime and zero source leases', () => {
  const result = verifyDrainState({
    generatedAt: NOW, stage: 'research', operationId: OPERATION, sources: ['news'],
    control: drainingControl(), status: status(source(0)), runtime: runtime('draining'),
  })
  assert.equal(result.passed, true)
  assert.equal(result.sources[0]?.leased, 0)

  const unsafe = verifyDrainState({
    generatedAt: NOW, stage: 'research', operationId: OPERATION, sources: ['news'],
    control: drainingControl(), status: status(source(1)), runtime: runtime('running'),
  })
  assert.equal(unsafe.passed, false)
  assert.ok(unsafe.failures.includes('RUNTIME_NOT_DRAINED'))
  assert.ok(unsafe.failures.includes('LEASED_WORK_REMAINS'))
})

function drainingControl(): FeedV3RuntimeControlV1 {
  const base = defaultRuntimeControl()
  return {
    ...base, revision: 1, updatedAt: NOW,
    stages: { ...base.stages, research: { desiredState: 'draining', changedAt: NOW, operationId: OPERATION } },
  }
}

function runtime(lifecycleState: 'running' | 'draining') {
  return {
    researchRuntime: {
      availability: 'current' as const,
      snapshot: {
        schemaVersion: 'myboon.shared_research_runtime_snapshot.v1' as const, capturedAt: NOW, processId: 1,
        lifecycleState,
        runtime: { schemaVersion: 'myboon.shared_research_runtime_status.v1' as const } as never,
        recovery: { lastRunAt: null, recoveredBySource: {} },
      },
    },
    entityRuntime: { availability: 'missing' as const, snapshot: null },
  }
}

function status(news: SourceControlPlaneStatus): SignalPlatformControlPlaneStatus {
  return {
    schemaVersion: 'myboon.control_plane_status.v1', generatedAt: NOW, availability: 'available', errors: [],
    totals: {
      signals: 1, observations: 1, deduplicatedObservations: 0, triageDecisions: 1, admittedWorkItems: 1,
      workItems: 1, ready: 0, retry: 0, deadLetter: 0, expired: 0, leased: news.counts.leased,
      unfinished: news.counts.leased, attempts: 0, arrivalsInWindow: 0, admissionsInWindow: 0,
      completionsInWindow: 0, researchPackets: 0, entityMemoryHandoffs: 0, sqliteBytes: 1,
    }, sources: { news }, execution: unavailableExecution(),
    sqliteWriteErrors: { availability: 'unavailable', value: null, measuredCount: 0, reason: 'not needed for drain' },
    recentFailures: [], alerts: { availability: 'unavailable', reason: 'not needed for drain', items: [] },
  }
}

function source(leased: number): SourceControlPlaneStatus {
  const emptyStage = { total: 0, byStatus: {} }
  return {
    sourceType: 'news', availability: 'available', error: null, total: 1, byStatus: {},
    byStage: { triage: emptyStage, retrieval: emptyStage, deep: emptyStage, synthesis: emptyStage, entity: emptyStage, unassigned: emptyStage },
    counts: { ready: 0, retry: 0, deadLetter: 0, expired: 0, leased, unfinished: leased },
    oldestReadyAt: null, oldestReadyAgeMs: null, oldestLeaseExpiresAt: null, oldestLeaseExpiresInMs: null,
    intake: { availability: 'available', signals: 1, observations: 1, deduplicatedObservations: 0,
      deduplicationRate: 0, triageDecisions: 1, admittedWorkItems: 1, triageOutcomes: {} },
    attempts: { availability: 'available', totalAttempts: 0, attemptedItems: 0, maxAttemptCount: 0 },
    recentFailures: [], activity: { windowStart: NOW, arrivals: 0, admissions: 0, completions: 0 }, queueAge: [],
    deadLetters: { total: 0, oldestAt: null, oldestAgeMs: null, byFailureCategory: [] },
    artifacts: { researchPackets: 0, entityMemoryHandoffs: 0 }, endToEndLatency: null,
    sqliteSize: null, sqliteStoreId: 'news',
    sqliteWriteErrors: { availability: 'unavailable', value: null, measuredCount: 0, reason: 'not needed' },
  }
}

function unavailableExecution(): SignalPlatformControlPlaneStatus['execution'] {
  return {
    availability: 'unavailable', error: { code: 'EXECUTION_READER_UNAVAILABLE', component: 'execution', message: 'not needed' },
    totalEvents: null, activeEvents: null, bySource: {}, recentFailures: [], providerUsage: [], providerPerformance: [],
    perCompletedPacket: { executionTelemetryPackets: 0, canonicalPackets: 0, telemetryCoverageRate: 1,
      inputTokens: null, outputTokens: null,
      costUsdMicros: { availability: 'unavailable', value: null, measuredCount: 0, reason: 'not needed' } },
  }
}
