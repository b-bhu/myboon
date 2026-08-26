import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  operatorEvidence,
  operatorExecutionEvent,
  operatorPacket,
  operatorSignal,
  operatorWork,
} from './operator-fixtures.test-support'
import { SqliteBoundedExecutionTraceReader } from './operator-trace-sqlite'
import { CanonicalTraceInspector, formatTraceInspectionJson } from './operator-trace'
import { SqliteExecutionLedger } from './sqlite-execution-ledger'
import { SqliteSignalPlatformStore } from './sqlite-platform-store'
import { TRIAGE_DECISION_SCHEMA_VERSION, type TriageDecisionV1 } from './triage-contracts'

function decision(signalId: string): TriageDecisionV1 {
  return {
    schemaVersion: TRIAGE_DECISION_SCHEMA_VERSION,
    decisionId: `decision-${signalId}`,
    signalId,
    sourceType: 'news',
    outcome: 'standard',
    priorityClass: 'P2',
    priorityScore: 0.5,
    reasons: [{ code: 'rules_default', detail: 'fixture' }],
    freshnessDeadline: '2026-08-27T10:00:00.000Z',
    budgetPolicyVersion: 'budget-v1',
    budget: {
      maxProviderCalls: 1, maxRepairCalls: 1, maxInputTokens: 1000,
      maxOutputTokens: 500, maxToolCalls: 0, maxWallTimeMs: 60_000,
    },
    deepEscalationReason: null,
    priorityPolicyVersion: 'policy-v1',
    classifierUsed: false,
    decidedAt: '2026-08-26T10:01:00.000Z',
  }
}

test('trace inspection links canonical artifacts by signal, work and packet with strict bounds', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'signal-trace-'))
  const path = join(dir, 'news.sqlite')
  const store = new SqliteSignalPlatformStore(path, 'news')
  const ledger = new SqliteExecutionLedger(path)
  let reader: SqliteBoundedExecutionTraceReader | null = null
  try {
    const signal = operatorSignal('news', 'trace')
    const work = operatorWork('news', 'trace')
    store.appendSignal(signal)
    store.appendTriageDecision(decision(signal.signalId))
    store.admitResearchWork(work)
    store.appendEvidence(operatorEvidence('trace'))
    store.appendEvidence(operatorEvidence('trace', {
      evidenceId: 'evidence-trace-2', contentHash: 'hash-trace-2',
    }))
    store.appendResearchPacket(operatorPacket('news', 'trace'))
    ledger.append(operatorExecutionEvent('news', 'trace'))
    ledger.append(operatorExecutionEvent('news', 'trace', {
      eventId: 'event-trace-2', startedAt: '2026-08-26T10:42:00.000Z',
      finishedAt: '2026-08-26T10:43:00.000Z',
    }))
    reader = new SqliteBoundedExecutionTraceReader(path, 'news')
    const inspector = new CanonicalTraceInspector({
      stores: [store], executionReaders: [reader],
      limits: { decisions: 1, workItems: 1, evidencePerWork: 1, packetsPerWork: 1, events: 1 },
    })
    for (const query of [
      { signalId: signal.signalId }, { workId: work.workId }, { packetId: 'packet-trace' },
    ] as const) {
      const result = await inspector.inspect(query, { now: '2026-08-26T13:00:00.000Z' })
      assert.equal(result.found, true)
      assert.equal(result.signal?.signalId, signal.signalId)
      assert.equal(result.workItems[0]?.workId, work.workId)
      assert.equal(result.packets[0]?.packetId, 'packet-trace')
      assert.equal(result.evidence.length, 1)
      assert.equal(result.executionEvents.length, 1)
      assert.equal(result.truncated.evidence, true)
      assert.equal(result.truncated.executionEvents, true)
    }
    const missing = await inspector.inspect({ workId: 'does-not-exist' }, { now: '2026-08-26T13:00:00.000Z' })
    assert.equal(missing.found, false)
    assert.deepEqual(missing.workItems, [])
  } finally {
    reader?.close(); ledger.close(); store.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('trace formatter redacts credentials and failure detail without mutating stored artifacts', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'signal-trace-redact-'))
  const path = join(dir, 'news.sqlite')
  const store = new SqliteSignalPlatformStore(path, 'news')
  const ledger = new SqliteExecutionLedger(path)
  let reader: SqliteBoundedExecutionTraceReader | null = null
  try {
    store.appendSignal(operatorSignal('news', 'secret', {
      apiKey: 'sk-abcdefghijklmnop', visibleSummary: 'token=do-not-print-this',
    }))
    store.admitResearchWork(operatorWork('news', 'secret'))
    store.appendEvidence(operatorEvidence('secret', {
      text: 'Authorization: Bearer very-secret-token', byteLength: 39,
    }))
    ledger.append(operatorExecutionEvent('news', 'secret', {
      packetId: null, status: 'failed', failureCategory: 'provider_authentication',
      failureDetail: 'provider said sk-abcdefghijklmnop',
    }))
    reader = new SqliteBoundedExecutionTraceReader(path, 'news')
    const inspector = new CanonicalTraceInspector({ stores: [store], executionReaders: [reader] })
    const result = await inspector.inspect({ signalId: 'signal-secret' }, { now: '2026-08-26T13:00:00.000Z' })
    const formatted = formatTraceInspectionJson(result, { pretty: false })
    assert.doesNotMatch(formatted, /sk-abcdefghijklmnop|very-secret-token|do-not-print-this|apiKey/)
    assert.match(formatted, /\[REDACTED\]/)
    assert.equal(store.getEvidence('evidence-secret')?.text, 'Authorization: Bearer very-secret-token')
    assert.equal(store.getResearchWork('work-secret')?.status, 'research_pending')
  } finally {
    reader?.close(); ledger.close(); store.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('trace lookup isolates a failed store and validates identity and bounds', async () => {
  const healthy = {
    sourceType: 'news' as const,
    getSignal: () => null,
    findSignalByIdempotencyKey: () => null,
    listTriageDecisionsBySignal: () => [],
    getResearchWork: () => null,
    listResearchWorkBySignal: () => [],
    getEvidence: () => null,
    listEvidenceByWork: () => [],
    getResearchPacket: () => null,
    listResearchPacketsByWork: () => [],
  }
  const broken = { ...healthy, sourceType: 'polymarket' as const, getSignal: () => { throw new Error('offline') } }
  const inspector = new CanonicalTraceInspector({ stores: [healthy, broken] })
  const result = await inspector.inspect({ signalId: 'missing' }, { now: '2026-08-26T13:00:00.000Z' })
  assert.deepEqual(result.unavailableSources, ['polymarket'])
  assert.throws(() => new CanonicalTraceInspector({ stores: [healthy], limits: { events: 251 } }), /between 1 and 250/)
  await assert.rejects(
    inspector.inspect({ signalId: 'y', workId: 'x' } as never, { now: '2026-08-26T13:00:00.000Z' }),
    /exactly one/,
  )
})
