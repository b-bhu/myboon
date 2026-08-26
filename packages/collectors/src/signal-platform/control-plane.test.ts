import assert from 'node:assert/strict'
import test from 'node:test'
import {
  CONTROL_PLANE_STATUS_SCHEMA_VERSION,
  SignalPlatformControlPlane,
  type ExecutionObservabilityReadPort,
  type WorkObservabilityReadPort,
} from './control-plane'
import { formatControlPlaneStatusJson } from './control-plane-format'
import { EXECUTION_EVENT_SCHEMA_VERSION, type Signal, type WorkStatus } from './contracts'
import type { ExecutionAggregateRow } from './execution-ledger'
import type { ResearchWorkStoreAdapter, SchedulerAggregateStatus } from './store-adapter'

function store(
  sourceType: Signal['sourceType'],
  status: SchedulerAggregateStatus | Error,
): ResearchWorkStoreAdapter {
  const unused = async () => { throw new Error('unused mutation method') }
  return {
    sourceType,
    peekSchedulable: async () => [],
    claimWithLease: unused,
    beginAttempt: unused,
    heartbeatLease: unused,
    transitionLeased: unused,
    releaseLease: unused,
    recoverExpiredLeases: unused,
    getSchedulerStatus: async () => {
      if (status instanceof Error) throw status
      return status
    },
  } as ResearchWorkStoreAdapter
}

function workReader(
  sourceType: Signal['sourceType'],
  values: Awaited<ReturnType<WorkObservabilityReadPort['readWorkObservability']>> | Error,
): WorkObservabilityReadPort {
  return {
    sourceType,
    readWorkObservability: async () => {
      if (values instanceof Error) throw values
      return values
    },
  }
}

function executionRow(overrides: Partial<ExecutionAggregateRow> = {}): ExecutionAggregateRow {
  return {
    eventSchemaVersion: EXECUTION_EVENT_SCHEMA_VERSION,
    sourceType: 'news',
    stage: 'synthesis',
    status: 'succeeded',
    failureCategory: null,
    provider: 'primary-provider',
    model: 'model-a',
    fallbackProvider: null,
    fallbackModel: null,
    fallbackUsed: false,
    promptVersion: 'prompt-v1',
    policyVersion: 'policy-v1',
    researchContractVersion: 'myboon.research_packet.v1',
    eventCount: 1,
    providerCalls: 1,
    repairCalls: 0,
    inputTokens: 100,
    outputTokens: 40,
    toolCalls: 0,
    budgetExceededCount: 0,
    totalWallTimeMs: 800,
    ...overrides,
  }
}

function executionReader(rows: ExecutionAggregateRow[]): ExecutionObservabilityReadPort {
  return {
    readAggregateStatus: () => ({
      totalEvents: rows.reduce((sum, row) => sum + row.eventCount, 0),
      activeEvents: rows.filter((row) => row.status === 'started').reduce((sum, row) => sum + row.eventCount, 0),
      rows,
    }),
  }
}

function schedulerStatus(
  total: number,
  byStatus: Partial<Record<WorkStatus, number>>,
  oldestReadyAt: string | null,
  oldestLeaseExpiresAt: string | null = null,
): SchedulerAggregateStatus {
  return { total, byStatus, oldestReadyAt, oldestLeaseExpiresAt }
}

test('aggregates mixed News/Polymarket work, stage/status, attempts, failures, and provider usage', async () => {
  const controlPlane = new SignalPlatformControlPlane({
    stores: [
      store('news', schedulerStatus(6, {
        research_pending: 2, retry_wait: 1, dead_letter: 1, retrieval_leased: 1, complete: 1,
      }, '2026-08-26T12:00:00.000Z', '2026-08-26T13:05:00.000Z')),
      store('polymarket', schedulerStatus(4, {
        synthesis_leased: 1, expired: 2, entity_pending: 1,
      }, '2026-08-26T12:30:00.000Z', '2026-08-26T13:02:00.000Z')),
    ],
    workReaders: [
      workReader('news', {
        signalCount: 9, triageDecisionCount: 8,
        totalAttempts: 5, attemptedItems: 3, maxAttemptCount: 2,
        recentFailures: [{ category: 'provider_timeout', count: 2, lastOccurredAt: '2026-08-26T12:55:00.000Z' }],
      }),
      workReader('polymarket', {
        signalCount: 6, triageDecisionCount: 5,
        totalAttempts: 2, attemptedItems: 1, maxAttemptCount: 2,
        recentFailures: [{ category: 'retrieval_blocked', count: 1, lastOccurredAt: '2026-08-26T12:50:00.000Z' }],
      }),
    ],
    executionReader: executionReader([
      executionRow({ failureCategory: 'provider_timeout', status: 'failed', eventCount: 1 }),
      executionRow({
        sourceType: 'polymarket', stage: 'retrieval', status: 'failed',
        failureCategory: 'budget_exceeded', provider: 'fallback-provider', model: 'model-b',
        fallbackProvider: 'fallback-provider', fallbackModel: 'model-b', fallbackUsed: true,
        providerCalls: 2, repairCalls: 1, budgetExceededCount: 1, totalWallTimeMs: 1200,
      }),
    ]),
  })
  const status = await controlPlane.readStatus({ now: '2026-08-26T13:00:00.000Z' })
  assert.equal(status.schemaVersion, CONTROL_PLANE_STATUS_SCHEMA_VERSION)
  assert.equal(status.availability, 'available')
  assert.equal(status.totals.signals, 15)
  assert.equal(status.totals.triageDecisions, 13)
  assert.equal(status.totals.admittedWorkItems, 10)
  assert.equal(status.totals.workItems, 10)
  assert.equal(status.totals.ready, 3)
  assert.equal(status.totals.retry, 1)
  assert.equal(status.totals.deadLetter, 1)
  assert.equal(status.totals.expired, 2)
  assert.equal(status.totals.leased, 2)
  assert.equal(status.totals.attempts, 7)
  assert.equal(status.sources.news?.byStage.retrieval.byStatus.research_pending, 2)
  assert.equal(status.sources.polymarket?.byStage.synthesis.byStatus.synthesis_leased, 1)
  assert.equal(status.sources.news?.oldestReadyAgeMs, 60 * 60_000)
  assert.equal(status.execution.bySource.news?.byStage.synthesis?.byStatus.failed, 1)
  assert.equal(status.execution.bySource.polymarket?.byStage.retrieval?.byStatus.failed, 1)
  assert.equal(status.execution.providerUsage.find((row) => row.sourceType === 'polymarket')?.fallbackUsed, true)
  assert.equal(status.execution.providerUsage.find((row) => row.sourceType === 'polymarket')?.budgetExceededCount, 1)
  assert.equal(status.recentFailures.find((failure) => failure.category === 'provider_timeout')?.count, 3)
})

test('one broken store is isolated and reported as partial without hiding healthy state', async () => {
  const controlPlane = new SignalPlatformControlPlane({
    stores: [
      store('news', schedulerStatus(2, { research_pending: 2 }, '2026-08-26T12:30:00.000Z')),
      store('polymarket', new Error('API_KEY=do-not-leak database unavailable')),
    ],
    executionReader: executionReader([]),
  })
  const status = await controlPlane.readStatus({ now: '2026-08-26T13:00:00.000Z' })
  assert.equal(status.availability, 'partial')
  assert.equal(status.totals.workItems, 2)
  assert.equal(status.sources.news?.availability, 'available')
  assert.equal(status.sources.polymarket?.availability, 'unavailable')
  assert.equal(status.sources.polymarket?.error?.code, 'STORE_STATUS_UNAVAILABLE')
  assert.equal(JSON.stringify(status).includes('do-not-leak'), false)
})

test('empty registered state returns a complete zero snapshot', async () => {
  const controlPlane = new SignalPlatformControlPlane({
    stores: [store('news', schedulerStatus(0, {}, null))],
    executionReader: executionReader([]),
  })
  const status = await controlPlane.readStatus({ now: '2026-08-26T13:00:00.000Z' })
  assert.equal(status.availability, 'available')
  assert.deepEqual(status.totals, {
    signals: null, triageDecisions: null, admittedWorkItems: 0,
    workItems: 0, ready: 0, retry: 0, deadLetter: 0,
    expired: 0, leased: 0, unfinished: 0, attempts: null,
  })
  assert.equal(status.execution.totalEvents, 0)
  assert.deepEqual(status.recentFailures, [])
})

test('CLI formatter removes sensitive keys and redacts credential-shaped values', async () => {
  const controlPlane = new SignalPlatformControlPlane({
    stores: [store('news', schedulerStatus(0, {}, null))],
    executionReader: executionReader([]),
  })
  const status = await controlPlane.readStatus({ now: '2026-08-26T13:00:00.000Z' })
  const hostile = {
    ...status,
    apiKey: 'sk-live-secret',
    nested: { password: 'hunter2', safe: 'keep', url: 'https://user:pass@example.com/path' },
    errors: [{
      code: 'STORE_STATUS_UNAVAILABLE', component: 'news',
      message: 'Bearer abc.def token=raw-secret',
    }],
  } as unknown as typeof status
  const formatted = formatControlPlaneStatusJson(hostile)
  const parsed = JSON.parse(formatted) as Record<string, unknown>
  assert.equal('apiKey' in parsed, false)
  assert.equal(formatted.includes('sk-live-secret'), false)
  assert.equal(formatted.includes('hunter2'), false)
  assert.equal(formatted.includes('user:pass'), false)
  assert.equal(formatted.includes('abc.def'), false)
  assert.equal(formatted.includes('raw-secret'), false)
  assert.equal(formatted.includes('"safe": "keep"'), true)
})
