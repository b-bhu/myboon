import assert from 'node:assert/strict'
import test from 'node:test'

import type { SignalPlatformControlPlaneStatus } from './control-plane'
import { evaluateOperationalAlerts } from './runtime-alerts'
import {
  parseStatusArgs,
  validateStatusPolicy,
  verifyStrictStatus,
} from './status-verification'

const NOW = '2026-08-27T12:00:00.000Z'

test('status CLI accepts the documented pnpm-normalized strict policy form', () => {
  assert.deepEqual(parseStatusArgs(['--strict', '--policy', '/tmp/policy.json']), {
    strict: true, policyPath: '/tmp/policy.json',
  })
  assert.throws(() => parseStatusArgs(['--strict']), /requires.*--policy/)
  assert.throws(() => parseStatusArgs(['--unknown']), /Unknown status argument/)
})

test('status policy rejects unknown fields and strict verification fails closed on every coverage gap', () => {
  assert.throws(() => validateStatusPolicy({ ...policy(), surprise: true }), /unknown status policy key/)
  const parsed = validateStatusPolicy(policy())
  const status = unavailableStatus()
  const runtime = {
    researchRuntime: { availability: 'missing' as const, snapshot: null },
    entityRuntime: { availability: 'missing' as const, snapshot: null },
  }
  const operationalAlerts = evaluateOperationalAlerts({ status, runtime, policy: parsed.operationalAlerts })
  const result = verifyStrictStatus({ status, runtime, operationalAlerts, policy: parsed, policySha256: 'a'.repeat(64) })
  assert.equal(result.passed, false)
  assert.deepEqual(new Set(result.failures), new Set([
    'CONTROL_PLANE_UNAVAILABLE', 'CONTROL_PLANE_ERRORS_PRESENT',
    'CONTROL_PLANE_ALERT_COVERAGE_UNAVAILABLE', 'OPERATIONAL_ALERT_COVERAGE_GAPS',
    'RESEARCH_RUNTIME_NOT_CURRENT', 'ENTITY_RUNTIME_NOT_CURRENT',
    'SQLITE_WRITE_ERROR_COVERAGE_UNAVAILABLE',
  ]))
})

function policy() {
  return {
    schemaVersion: 'myboon.feed_v3_status_policy.v1', policyId: 'reviewed-feed-v3-slo',
    reviewedAt: '2026-08-26T00:00:00.000Z', expiresAt: '2026-09-26T00:00:00.000Z', reviewedBy: 'operations-review',
    controlPlaneAlerts: {
      queueAgeSloMs: { news: { P0: 60_000, P1: 120_000 } },
      providerErrorRateThreshold: 0.1, deadLetterCountThreshold: 0,
    },
    operationalAlerts: {
      minimumThroughputWindowMs: 30 * 60_000, minimumCompletionAdmissionRatio: 0.9,
      sqliteWriteErrorCountThreshold: 0,
    },
  }
}

function unavailableStatus(): SignalPlatformControlPlaneStatus {
  return {
    schemaVersion: 'myboon.control_plane_status.v1', generatedAt: NOW, availability: 'unavailable',
    errors: [{ code: 'STORE_STATUS_UNAVAILABLE', component: 'news', message: 'unavailable' }],
    totals: {
      signals: null, observations: null, deduplicatedObservations: null, triageDecisions: null,
      admittedWorkItems: 0, workItems: 0, ready: 0, retry: 0, deadLetter: 0, expired: 0,
      leased: 0, unfinished: 0, attempts: null, arrivalsInWindow: null, admissionsInWindow: null,
      completionsInWindow: null, researchPackets: null, entityMemoryHandoffs: null, sqliteBytes: null,
    },
    sources: {},
    execution: {
      availability: 'unavailable', error: { code: 'EXECUTION_READER_UNAVAILABLE', component: 'execution', message: 'unavailable' },
      totalEvents: null, activeEvents: null, bySource: {}, recentFailures: [], providerUsage: [], providerPerformance: [],
      perCompletedPacket: { executionTelemetryPackets: 0, canonicalPackets: 0, telemetryCoverageRate: 1,
        inputTokens: null, outputTokens: null,
        costUsdMicros: { availability: 'unavailable', value: null, measuredCount: 0, reason: 'unavailable' } },
    },
    sqliteWriteErrors: { availability: 'unavailable', value: null, measuredCount: 0, reason: 'unavailable' },
    recentFailures: [], alerts: { availability: 'unavailable', reason: 'policy unavailable', items: [] },
  }
}
