import assert from 'node:assert/strict'
import test from 'node:test'

import type { SignalPlatformControlPlaneStatus, SourceControlPlaneStatus } from './control-plane'
import { evaluateOperationalAlerts, parseOperationalAlertPolicy } from './runtime-alerts'
import type { FeedV3RuntimeStatusAvailability } from './runtime-status'

const NOW = '2026-08-26T13:00:00.000Z'

function source(): SourceControlPlaneStatus {
  return {
    sourceType: 'news', availability: 'available', error: null, total: 10,
    byStatus: { research_pending: 5, complete: 5 },
    byStage: {
      triage: { total: 0, byStatus: {} }, retrieval: { total: 5, byStatus: { research_pending: 5 } },
      deep: { total: 0, byStatus: {} }, synthesis: { total: 0, byStatus: {} },
      entity: { total: 5, byStatus: { complete: 5 } }, unassigned: { total: 0, byStatus: {} },
    },
    counts: { ready: 5, retry: 0, deadLetter: 0, expired: 0, leased: 0, unfinished: 5 },
    oldestReadyAt: '2026-08-26T12:00:00.000Z', oldestReadyAgeMs: 3_600_000,
    oldestLeaseExpiresAt: null, oldestLeaseExpiresInMs: null,
    intake: {
      availability: 'available', signals: 20, observations: 20, deduplicatedObservations: 2,
      deduplicationRate: 0.1, triageDecisions: 20, admittedWorkItems: 10, triageOutcomes: { light: 10 },
    },
    attempts: { availability: 'available', totalAttempts: 5, attemptedItems: 5, maxAttemptCount: 1 },
    recentFailures: [],
    activity: { windowStart: '2026-08-26T12:30:00.000Z', arrivals: 10, admissions: 10, completions: 2 },
    queueAge: [], deadLetters: { total: 0, oldestAt: null, oldestAgeMs: null, byFailureCategory: [] },
    artifacts: { researchPackets: 5, entityMemoryHandoffs: 5 }, endToEndLatency: null,
    sqliteSize: null, sqliteStoreId: null,
    sqliteWriteErrors: { availability: 'available', value: 2, measuredCount: 1, reason: null },
  }
}

function status(): SignalPlatformControlPlaneStatus {
  return {
    schemaVersion: 'myboon.control_plane_status.v1', generatedAt: NOW, availability: 'available', errors: [],
    totals: {
      signals: 20, observations: 20, deduplicatedObservations: 2, triageDecisions: 20,
      admittedWorkItems: 10, workItems: 10, ready: 5, retry: 0, deadLetter: 0, expired: 0,
      leased: 0, unfinished: 5, attempts: 5, arrivalsInWindow: 10, admissionsInWindow: 10,
      completionsInWindow: 2, researchPackets: 5, entityMemoryHandoffs: 5, sqliteBytes: null,
    },
    sources: { news: source() },
    execution: {
      availability: 'available', error: null, totalEvents: 0, activeEvents: 0, bySource: {},
      recentFailures: [], providerUsage: [], providerPerformance: [],
      perCompletedPacket: {
        executionTelemetryPackets: 0, canonicalPackets: 5, telemetryCoverageRate: 0,
        inputTokens: null, outputTokens: null,
        costUsdMicros: { availability: 'unavailable', value: null, measuredCount: 0, reason: 'none' },
      },
    },
    sqliteWriteErrors: { availability: 'available', value: 2, measuredCount: 1, reason: null },
    recentFailures: [], alerts: { availability: 'available', reason: null, items: [] },
  }
}

function runtime(): FeedV3RuntimeStatusAvailability {
  return {
    researchRuntime: {
      availability: 'current',
      snapshot: {
        schemaVersion: 'myboon.shared_research_runtime_snapshot.v1', capturedAt: NOW, processId: 1,
        lifecycleState: 'running', recovery: { lastRunAt: NOW, recoveredBySource: {} },
        runtime: {
          schemaVersion: 'myboon.shared_research_runtime_status.v1', mode: 'active', sources: ['news'],
          supportedDepths: ['light'], priorityPools: [],
          sourceFairness: { maxConsecutiveClaimsPerSource: 2 },
          standardSearch: {
            schemaVersion: 'myboon.standard_search_status.v1', enabled: false, connectorId: null, policyVersion: null,
          },
          gateway: {
            schemaVersion: 'myboon.inference_gateway_status.v1', hermesProfileConfigured: false,
            investigate: { enabled: false, fallbackEnabled: false }, routes: [],
          },
          circuits: {
            schemaVersion: 'myboon.inference_circuit_status.v1', capturedAt: NOW,
            workloads: [{
              workload: 'research.synthesize', ready: false,
              targets: [{ provider: 'provider-a', model: 'model-a', circuitOpen: true, retryAfterMs: 60_000 }],
            }],
          },
          circuitNextProbes: [{
            workload: 'research.synthesize', provider: 'provider-a', model: 'model-a',
            nextProbeAt: '2026-08-26T13:01:00.000Z',
          }],
          providerObservation: {
            lastCompletedAt: null, lastSucceededAt: null, workload: null, provider: null, model: null,
            succeeded: null, durationMs: null, providerCalls: 0, repairCalls: 0, failureCategory: null,
          },
          deepEnabled: true,
          deep: {
            schemaVersion: 'myboon.deep_research_runtime_snapshot.v1', capturedAt: NOW, enabled: true,
            activeExecutions: 0, lastAuditAt: NOW, suspectedOrphans: 1,
            unregisteredArtifacts: 0, incomplete: false, errors: [],
          },
        },
      },
    },
    entityRuntime: {
      availability: 'current',
      snapshot: {
        schemaVersion: 'myboon.shared_entity_runtime_health.v1', capturedAt: NOW, processId: 2,
        mode: 'active', lifecycleState: 'running', desiredState: 'running', controlStatus: 'ok',
        route: {
          workload: 'entity.extract', lastCompletedAt: null, lastSucceededAt: null,
          provider: null, model: null, succeeded: null, durationMs: null,
        },
        circuit: {
          capturedAt: NOW, workload: 'entity.extract', ready: false,
          targets: [{
            provider: 'provider-b', model: 'model-b', circuitOpen: true,
            nextProbeAt: '2026-08-26T13:02:00.000Z',
          }],
        },
      },
    },
  }
}

test('emits the missing initial circuit, throughput, containment, and storage alerts with runbook hints', () => {
  const report = evaluateOperationalAlerts({
    status: status(), runtime: runtime(),
    policy: {
      minimumThroughputWindowMs: 30 * 60_000,
      minimumCompletionAdmissionRatio: 1,
      sqliteWriteErrorCountThreshold: 0,
    },
  })
  assert.equal(report.availability, 'available')
  assert.deepEqual(new Set(report.items.map((item) => item.code)), new Set([
    'PROVIDER_CIRCUIT_OPEN', 'RESEARCH_COMPLETION_BELOW_ADMISSION',
    'CONTAINED_JOB_SURVIVED_DEADLINE', 'SQLITE_WRITE_ERROR_THRESHOLD',
  ]))
  assert.ok(report.items.every((item) => item.sourceType === 'news' && item.suggestedCommand.startsWith('pnpm ')))
  assert.equal(report.items.filter((item) => item.code === 'PROVIDER_CIRCUIT_OPEN').length, 2)
  assert.equal(report.items.find((item) => item.provider === 'provider-a')?.nextProbeAt, '2026-08-26T13:01:00.000Z')
})

test('reports missing policy, stale runtime, short throughput, and write-error gaps instead of guessing health', () => {
  const current = status()
  current.sources.news!.activity.windowStart = '2026-08-26T12:50:00.000Z'
  current.sqliteWriteErrors = { availability: 'unavailable', value: null, measuredCount: 0, reason: 'collector absent' }
  const missingRuntime: FeedV3RuntimeStatusAvailability = {
    researchRuntime: {
      availability: 'stale',
      snapshot: runtime().researchRuntime.snapshot!,
    },
    entityRuntime: { availability: 'missing', snapshot: null },
  }
  const withoutPolicy = evaluateOperationalAlerts({ status: current, runtime: missingRuntime, policy: null })
  assert.equal(withoutPolicy.availability, 'unavailable')
  assert.ok(withoutPolicy.unavailableChecks.some((item) => item.check === 'policy'))
  const withPolicy = evaluateOperationalAlerts({
    status: current, runtime: missingRuntime,
    policy: { minimumThroughputWindowMs: 1_800_000, minimumCompletionAdmissionRatio: 1, sqliteWriteErrorCountThreshold: 0 },
  })
  assert.equal(withPolicy.availability, 'partial')
  assert.ok(withPolicy.unavailableChecks.some((item) => item.check === 'throughput_window'))
  assert.ok(withPolicy.unavailableChecks.some((item) => item.check === 'sqlite_write_errors'))
})

test('operational policy parsing is strict and never invents reviewed thresholds', () => {
  assert.deepEqual(parseOperationalAlertPolicy({
    minimumThroughputWindowMs: 1_800_000,
    minimumCompletionAdmissionRatio: 1,
    sqliteWriteErrorCountThreshold: 0,
  }), {
    minimumThroughputWindowMs: 1_800_000,
    minimumCompletionAdmissionRatio: 1,
    sqliteWriteErrorCountThreshold: 0,
  })
  assert.throws(() => parseOperationalAlertPolicy({
    minimumThroughputWindowMs: 1_800_000, minimumCompletionAdmissionRatio: 1,
    sqliteWriteErrorCountThreshold: 0, invented: 1,
  }), /unknown/)
})
