import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { EXECUTION_EVENT_SCHEMA_VERSION, type ExecutionTraceEvent } from './contracts'
import { ExecutionEventConflictError } from './execution-ledger'
import { SqliteExecutionLedger } from './sqlite-execution-ledger'

const nodeRequire = createRequire(__filename)
const { DatabaseSync } = nodeRequire('node:sqlite') as {
  DatabaseSync: new(path: string) => { prepare(sql: string): { run(...params: unknown[]): unknown }; close(): void }
}

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
    configuredPrimaryProvider: 'primary',
    configuredPrimaryModel: 'model-a',
    fallbackReason: null,
    outputSchemaValid: true,
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
    const legacy = event({ eventId: 'legacy-event' }) as Record<string, unknown>
    delete legacy.configuredPrimaryProvider
    delete legacy.configuredPrimaryModel
    delete legacy.fallbackReason
    delete legacy.outputSchemaValid
    assert.equal(ledger.append(legacy as unknown as ExecutionTraceEvent).event.configuredPrimaryProvider, null)
    assert.equal(ledger.get('legacy-event')?.configuredPrimaryModel, null)
    assert.equal(ledger.get('legacy-event')?.fallbackReason, null)
    assert.equal(ledger.get('legacy-event')?.outputSchemaValid, null)
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
      fallbackReason: 'provider_timeout', outputSchemaValid: false,
      budgetExceeded: true, startedAt: '2026-08-26T12:02:00.000Z', finishedAt: '2026-08-26T12:02:02.000Z',
    }))
    const aggregate = ledger.readAggregateStatus()
    assert.equal(aggregate.totalEvents, 2)
    assert.equal(aggregate.activeEvents, 0)
    const failed = aggregate.rows.find((row) => row.status === 'failed')
    assert.equal(failed?.fallbackUsed, true)
    assert.equal(failed?.configuredPrimaryProvider, 'primary')
    assert.equal(failed?.configuredPrimaryModel, 'model-a')
    assert.equal(failed?.fallbackReason, 'provider_timeout')
    assert.equal(failed?.outputSchemaValid, false)
    assert.equal(failed?.failureCategory, 'budget_exceeded')
    assert.equal(failed?.budgetExceededCount, 1)
    assert.equal(failed?.providerCalls, 2)
    ledger.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('activeEvents counts distinct stage attempts without historical started rows', () => {
  const dir = mkdtempSync(join(tmpdir(), 'signal-ledger-active-'))
  try {
    const ledger = new SqliteExecutionLedger(join(dir, 'pipeline.sqlite'))
    ledger.append(event({
      eventId: 'started-1', status: 'started', finishedAt: null,
      provider: null, model: null, providerCalls: 0, inputTokens: 0, outputTokens: 0,
      outputSchemaValid: null,
    }))
    ledger.append(event({
      eventId: 'started-duplicate-identity', status: 'started', finishedAt: null,
      provider: null, model: null, providerCalls: 0, inputTokens: 0, outputTokens: 0,
      outputSchemaValid: null,
    }))
    assert.equal(ledger.readAggregateStatus().activeEvents, 1)

    ledger.append(event({
      eventId: 'terminal-other-attempt', attempt: 2, status: 'failed', failureCategory: 'provider_timeout',
    }))
    assert.equal(ledger.readAggregateStatus().activeEvents, 1)

    ledger.append(event({ eventId: 'terminal-1', status: 'succeeded' }))
    assert.equal(ledger.readAggregateStatus().activeEvents, 0)
    assert.equal(ledger.readAggregateStatus({ since: '2026-08-26T11:00:00.000Z' }).activeEvents, 0)
    ledger.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('ledger rejects incomplete or invalid additive provenance', () => {
  const dir = mkdtempSync(join(tmpdir(), 'signal-ledger-provenance-'))
  try {
    const ledger = new SqliteExecutionLedger(join(dir, 'news.sqlite'))
    assert.throws(() => ledger.append(event({ configuredPrimaryModel: undefined })), /present together/)
    assert.throws(() => ledger.append({ ...event(), fallbackReason: 'made_up' } as unknown as ExecutionTraceEvent), /known failure/)
    assert.throws(() => ledger.append({ ...event(), outputSchemaValid: 'yes' } as unknown as ExecutionTraceEvent), /must be boolean/)
    ledger.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('replay of a pre-AC20 event remains idempotent after null provenance normalization', () => {
  const dir = mkdtempSync(join(tmpdir(), 'signal-ledger-legacy-'))
  const path = join(dir, 'news.sqlite')
  try {
    const legacy = event({ eventId: 'legacy-replay' }) as Record<string, unknown>
    delete legacy.configuredPrimaryProvider
    delete legacy.configuredPrimaryModel
    delete legacy.fallbackReason
    delete legacy.outputSchemaValid
    const first = new SqliteExecutionLedger(path)
    first.append(legacy as unknown as ExecutionTraceEvent)
    first.close()
    const raw = new DatabaseSync(path)
    raw.prepare('UPDATE signal_execution_events SET event_json = ? WHERE event_id = ?')
      .run(JSON.stringify(legacy), 'legacy-replay')
    raw.close()
    const reopened = new SqliteExecutionLedger(path)
    assert.equal(reopened.append(legacy as unknown as ExecutionTraceEvent).inserted, false)
    reopened.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
