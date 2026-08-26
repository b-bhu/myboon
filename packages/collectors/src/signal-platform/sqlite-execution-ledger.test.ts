import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { EXECUTION_EVENT_SCHEMA_VERSION, type ExecutionTraceEvent } from './contracts'
import { ExecutionEventConflictError } from './execution-ledger'
import { SqliteExecutionLedger } from './sqlite-execution-ledger'

function event(overrides: Partial<ExecutionTraceEvent> = {}): ExecutionTraceEvent {
  return {
    schemaVersion: EXECUTION_EVENT_SCHEMA_VERSION,
    eventId: 'event-1',
    traceId: 'trace-1',
    signalId: 'signal-1',
    workId: 'work-1',
    packetId: null,
    sourceType: 'news',
    stage: 'synthesis',
    attempt: 1,
    startedAt: '2026-08-26T12:00:00.000Z',
    finishedAt: '2026-08-26T12:00:01.000Z',
    status: 'succeeded',
    failureCategory: null,
    failureDetail: null,
    queueWaitMs: 50,
    wallTimeMs: 1000,
    provider: 'primary',
    model: 'model-a',
    fallbackProvider: null,
    fallbackModel: null,
    fallbackUsed: false,
    promptVersion: 'prompt-v1',
    policyVersion: 'policy-v1',
    researchContractVersion: 'myboon.research_packet.v1',
    providerCalls: 1,
    repairCalls: 0,
    inputTokens: 100,
    outputTokens: 50,
    toolCalls: 0,
    budgetExceeded: false,
    createdAt: '2026-08-26T12:00:01.000Z',
    ...overrides,
  }
}

test('SQLite ledger is append-only, idempotent, and detects event id collisions', () => {
  const dir = mkdtempSync(join(tmpdir(), 'signal-ledger-'))
  try {
    const ledger = new SqliteExecutionLedger(join(dir, 'news.sqlite'))
    const first = event({ futureField: 'retained' })
    assert.equal(ledger.append(first).inserted, true)
    assert.equal(ledger.append({ ...first }).inserted, false)
    assert.equal(ledger.get(first.eventId)?.futureField, 'retained')
    assert.throws(() => ledger.append({ ...first, providerCalls: 2 }), ExecutionEventConflictError)
    assert.equal(ledger.listTrace('trace-1').length, 1)
    ledger.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('SQLite ledger aggregates status, provider, fallback, schema and budget usage', () => {
  const dir = mkdtempSync(join(tmpdir(), 'signal-ledger-'))
  try {
    const ledger = new SqliteExecutionLedger(join(dir, 'pipeline.sqlite'))
    ledger.append(event())
    ledger.append(event({
      eventId: 'event-2', sourceType: 'polymarket', status: 'failed',
      failureCategory: 'budget_exceeded', provider: 'fallback', fallbackProvider: 'fallback',
      fallbackModel: 'model-b', fallbackUsed: true, providerCalls: 2, repairCalls: 1,
      budgetExceeded: true, startedAt: '2026-08-26T12:02:00.000Z', finishedAt: '2026-08-26T12:02:02.000Z',
    }))
    const aggregate = ledger.readAggregateStatus()
    assert.equal(aggregate.totalEvents, 2)
    assert.equal(aggregate.activeEvents, 0)
    const failed = aggregate.rows.find((row) => row.status === 'failed')
    assert.equal(failed?.fallbackUsed, true)
    assert.equal(failed?.failureCategory, 'budget_exceeded')
    assert.equal(failed?.budgetExceededCount, 1)
    assert.equal(failed?.providerCalls, 2)
    ledger.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
