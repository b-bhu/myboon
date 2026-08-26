import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  RESEARCH_PACKET_SCHEMA_VERSION,
  RESEARCH_WORK_SCHEMA_VERSION,
  RETRIEVED_EVIDENCE_SCHEMA_VERSION,
  SIGNAL_SCHEMA_VERSION,
  type ExecutionTraceEvent,
  type NewsSignal,
  type ResearchWorkItem,
  type RetrievedEvidence,
} from '../signal-platform/contracts'
import type { ExecutionEventAppendResult } from '../signal-platform/execution-ledger'
import { SqliteSignalPlatformStore } from '../signal-platform/sqlite-platform-store'
import { validateExecutionTraceEvent } from '../signal-platform/validation'
import { DeepResearchError } from './errors'
import { DEEP_RESEARCH_OUTPUT_SCHEMA_VERSION } from './packet-output'
import {
  DEEP_RESEARCH_RESULT_SCHEMA_VERSION,
  type DeepResearchJob,
  type DeepResearchResult,
} from './types'
import {
  DeepResearchSideQueueWorker,
  type ContainedDeepResearchExecutionPort,
  type DeepResearchJobPolicy,
  type DeepResearchWorkerClock,
  type DeepResearchWorkStore,
} from './worker'

const NOW = '2026-08-26T12:10:00.000Z'

class FixedClock implements DeepResearchWorkerClock {
  constructor(readonly instant = new Date(NOW)) {}
  now(): Date { return new Date(this.instant) }
  setInterval(): unknown { return 1 }
  clearInterval(): void {}
}

class MutableClock implements DeepResearchWorkerClock {
  constructor(private instant: Date) {}
  now(): Date { return new Date(this.instant) }
  advanceTo(value: string): void { this.instant = new Date(value) }
  setInterval(): unknown { return 1 }
  clearInterval(): void {}
}

class FakeExecutionLedger {
  readonly events = new Map<string, ExecutionTraceEvent>()
  appendAttempts = 0
  conflicts = 0
  append(input: ExecutionTraceEvent): ExecutionEventAppendResult {
    this.appendAttempts += 1
    const event = validateExecutionTraceEvent(input)
    const existing = this.events.get(event.eventId)
    if (existing !== undefined) {
      if (JSON.stringify(event) !== JSON.stringify(existing)) {
        this.conflicts += 1
        throw new Error('immutable execution event conflict')
      }
      return { inserted: false, event: existing }
    }
    this.events.set(event.eventId, structuredClone(event))
    return { inserted: true, event }
  }
}

function signal(): NewsSignal {
  return {
    schemaVersion: SIGNAL_SCHEMA_VERSION, signalId: 'signal-news', sourceType: 'news', sourceId: 'news:1',
    contentKind: 'article', content: { schemaVersion: 'myboon.signal_content.article.v1' },
    observedAt: '2026-08-26T12:00:00.000Z', publishedAt: '2026-08-26T11:59:00.000Z',
    canonicalUrl: 'https://news.example/item', title: 'Material unresolved event', visibleSummary: 'Summary',
    media: { imageUrl: null, attribution: null },
    sourceHints: { entities: ['Example'], assets: [], eventId: null, deadline: null },
    provenance: { provider: 'fixture', upstreamSource: null, rawPayloadRef: 'raw:1' },
    idempotencyKey: 'news:key:1',
  }
}

function work(overrides: Partial<ResearchWorkItem> = {}): ResearchWorkItem {
  return {
    schemaVersion: RESEARCH_WORK_SCHEMA_VERSION, workId: 'work-deep', signalId: 'signal-news', sourceType: 'news',
    researchDepth: 'deep', deepReason: 'conflicting_primary_sources', priorityClass: 'P0', priorityScore: 0.9,
    freshnessDeadline: '2026-08-26T13:00:00.000Z', policyVersion: 'deep-policy.v1',
    researchContractVersion: RESEARCH_PACKET_SCHEMA_VERSION,
    retrievalPlan: { sourceUrl: 'https://news.example/item', allowedDomains: ['news.example', 'primary.example'], maxExternalSources: 2 },
    budget: {
      maxProviderCalls: 2, maxRepairCalls: 0, maxInputTokens: 5_000, maxOutputTokens: 2_000,
      maxToolCalls: 3, maxWallTimeMs: 30_000,
    },
    status: 'deep_pending', attemptCount: 0, nextAttemptAt: null,
    leaseOwner: null, leaseId: null, leaseExpiresAt: null,
    failureCategory: null, failureDetail: null, traceId: 'trace-deep',
    createdAt: '2026-08-26T12:00:00.000Z', updatedAt: '2026-08-26T12:00:00.000Z',
    ...overrides,
  }
}

function evidence(): RetrievedEvidence {
  return {
    schemaVersion: RETRIEVED_EVIDENCE_SCHEMA_VERSION, evidenceId: 'evidence-source', workId: 'work-deep',
    requestedUrl: 'https://news.example/item', finalUrl: 'https://news.example/item',
    authority: 'source_url', authorityId: 'signal-news', contentHash: 'hash', contentType: 'text/plain',
    httpStatus: 200, retrievalMethod: 'safe_http', retrievedAt: NOW, text: 'Conflicting source evidence',
    truncated: false, byteLength: 27,
  }
}

function output(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    schemaVersion: DEEP_RESEARCH_OUTPUT_SCHEMA_VERSION,
    claims: [{ claim: 'A source claims the event occurred.', attributedTo: 'Example', evidenceRefs: ['evidence-source'] }],
    verifiedFacts: [{ fact: 'An approved primary source confirms the event.', evidenceRefs: ['primary-result'] }],
    unresolvedClaims: [],
    entityHints: [{ name: 'Example', type: 'organization', role: 'subject', aliases: [], source: 'primary-result', evidenceRefs: ['primary-result'] }],
    approvedResults: [{
      resultRef: 'primary-result', title: 'Primary confirmation', url: 'https://primary.example/confirmation',
      observedAt: '2026-08-26T12:09:00.000Z', note: null,
    }],
    limitations: [], openQuestions: [], completion: 'complete', ...overrides,
  })
}

function result(job: DeepResearchJob, stdout = output()): DeepResearchResult {
  return {
    schemaVersion: DEEP_RESEARCH_RESULT_SCHEMA_VERSION, jobId: job.jobId, workId: job.workItem.workId,
    traceId: job.workItem.traceId, unitName: 'myboon-deep-work.service', status: 'succeeded',
    stdout, stderr: '', exitCode: 0, signal: null, startedAt: NOW,
    finishedAt: '2026-08-26T12:10:01.000Z', durationMs: 1_000,
    capabilities: [...job.capabilities],
    fetchedEvidence: [{
      resultRef: 'primary-result', title: 'Primary confirmation',
      url: 'https://primary.example/confirmation', observedAt: '2026-08-26T12:09:00.000Z',
      note: null, contentHash: 'sha256:primary', retrievalMethod: 'http_fetch',
    }],
    budgetUsed: {
      providerCalls: 2, inputTokens: 1_200, outputTokens: 300, toolCalls: 2,
      browserNavigations: 1, searchQueries: 0, httpFetches: 1,
      wallTimeMs: 1_000, outputBytes: Buffer.byteLength(stdout),
    },
  }
}

const POLICY: DeepResearchJobPolicy = {
  promptVersion: 'deep-prompt.v1', provider: 'contained-provider', model: 'contained-model',
  capabilities: ['browser_navigation', 'registered_search', 'http_fetch'],
  maxBrowserNavigations: 1, maxSearchQueries: 1, maxHttpFetches: 1,
  maxOutputBytes: 50_000, cpuQuotaPercent: 50, memoryMaxBytes: 256 * 1024 * 1024, tasksMax: 32,
  unresolvedQuestion: ({ workItem }) => `Resolve ${workItem.deepReason} using only approved public sources.`,
}

function fixture(): { store: SqliteSignalPlatformStore, close(): void } {
  const dir = mkdtempSync(join(tmpdir(), 'deep-worker-'))
  const store = new SqliteSignalPlatformStore(join(dir, 'store.sqlite'), 'news')
  store.appendSignal(signal())
  store.admitResearchWork(work())
  store.appendEvidence(evidence())
  return { store, close: () => { store.close(); rmSync(dir, { recursive: true, force: true }) } }
}

function options(
  store: DeepResearchWorkStore,
  executor: ContainedDeepResearchExecutionPort,
  overrides: Record<string, unknown> = {},
) {
  return {
    workerId: 'deep-worker-1', stores: [store], executor, policy: POLICY,
    preflight: { check: async () => ({ ready: true as const }) }, clock: new FixedClock(), ...overrides,
  }
}

test('contained success assembles code-owned packet and promotes the fenced work', async () => {
  const fx = fixture()
  try {
    const ledger = new FakeExecutionLedger()
    let captured: DeepResearchJob | null = null
    const worker = new DeepResearchSideQueueWorker(options(fx.store, {
      execute: async (job) => { captured = job; return result(job) },
    }, { executionLedger: ledger }))
    assert.equal((await worker.runOnce()).kind, 'succeeded')
    assert.equal(fx.store.getResearchWork('work-deep')?.status, 'entity_pending')
    assert.equal(fx.store.getResearchWork('work-deep')?.attemptCount, 1)
    assert.ok(captured)
    const job = captured as DeepResearchJob
    assert.equal(job.escalation.reason, 'conflicting_primary_sources')
    assert.deepEqual(job.approvedDomains, ['news.example', 'primary.example'])
    assert.deepEqual(job.escalation.supportingEvidenceRefs, ['evidence-source'])
    const packet = fx.store.listResearchPacketsByWork('work-deep', 10)[0]!
    assert.equal(packet.packetId.startsWith('deep_research_'), true)
    assert.equal(packet.execution.policyVersion, 'deep-policy.v1')
    assert.equal(packet.execution.traceId, 'trace-deep')
    assert.equal(packet.verifiedFacts[0]?.evidenceRefs[0]?.startsWith('deep_evidence_'), true)
    assert.equal(packet.evidence[1]?.url, 'https://primary.example/confirmation')
    assert.deepEqual({
      providerCalls: packet.budgetUsed.providerCalls,
      inputTokens: packet.budgetUsed.inputTokens,
      outputTokens: packet.budgetUsed.outputTokens,
      toolCalls: packet.budgetUsed.toolCalls,
    }, { providerCalls: 2, inputTokens: 1_200, outputTokens: 300, toolCalls: 2 })
    const event = [...ledger.events.values()][0]!
    assert.equal(event.stage, 'deep_research')
    assert.equal(event.status, 'succeeded')
    assert.equal(event.packetId, packet.packetId)
    assert.equal(event.provider, 'contained-provider')
    assert.equal(event.model, 'contained-model')
    assert.equal(event.providerCalls, 2)
    assert.equal(event.inputTokens, 1_200)
    assert.equal(event.outputTokens, 300)
    assert.equal(event.toolCalls, 2)
    assert.equal(event.usageObserved, true)
    assert.equal(event.wallTimeMs, 1_000)
    assert.equal(event.queueWaitMs, 10 * 60_000)
    assert.equal(event.startedAt, NOW)
    assert.equal(event.finishedAt, '2026-08-26T12:10:01.000Z')
    assert.equal(JSON.stringify(event).includes('Conflicting source evidence'), false)
    assert.equal(JSON.stringify(event).includes(output()), false)
  } finally { fx.close() }
})

test('malformed or policy-escaping stdout is terminal and writes no packet', async () => {
  for (const stdout of [
    '{not-json',
    output({ approvedResults: [{ resultRef: 'outside', title: 'Bad', url: 'https://evil.example/x', observedAt: null, note: null }] }),
    output({ claims: [{ claim: 'bad ref', attributedTo: null, evidenceRefs: ['unknown'] }] }),
    output({ packetId: 'model-controlled' }),
  ]) {
    const fx = fixture()
    try {
      const ledger = new FakeExecutionLedger()
      const worker = new DeepResearchSideQueueWorker(options(
        fx.store, { execute: async (job) => result(job, stdout) }, { executionLedger: ledger },
      ))
      const outcome = await worker.runOnce()
      assert.equal(outcome.kind, 'dead_letter')
      assert.equal(outcome.kind === 'dead_letter' ? outcome.category : null, 'invalid_structured_output')
      assert.equal(fx.store.listResearchPacketsByWork('work-deep', 10).length, 0)
      const event = [...ledger.events.values()][0]!
      assert.equal(event.failureDetail, 'contained structured output rejected; details redacted')
      assert.equal(JSON.stringify(event).includes(stdout), false)
    } finally { fx.close() }
  }
})

test('contained timeout retries after spending one execution attempt', async () => {
  const fx = fixture()
  try {
    const ledger = new FakeExecutionLedger()
    const worker = new DeepResearchSideQueueWorker(options(fx.store, {
      execute: async () => { throw new DeepResearchError('timeout', { category: 'timed_out', retryable: true }) },
    }, { executionLedger: ledger }))
    const outcome = await worker.runOnce()
    assert.equal(outcome.kind, 'retry_wait')
    assert.equal(outcome.kind === 'retry_wait' ? outcome.category : null, 'provider_timeout')
    assert.equal(fx.store.getResearchWork('work-deep')?.attemptCount, 1)
    assert.equal(fx.store.getResearchWork('work-deep')?.nextAttemptAt, '2026-08-26T12:10:01.000Z')
    const event = [...ledger.events.values()][0]!
    assert.equal(event.providerCalls, 0)
    assert.equal(event.inputTokens, 0)
    assert.equal(event.outputTokens, 0)
    assert.equal(event.toolCalls, 0)
    assert.equal(event.usageObserved, false)
  } finally { fx.close() }
})

test('execution-port success with missing or over-budget measured usage is rejected before packet write', async () => {
  for (const budgetUsed of [
    { providerCalls: 3, inputTokens: 1, outputTokens: 1, toolCalls: 1, wallTimeMs: 1_000, outputBytes: 10 },
    { providerCalls: 1, inputTokens: 1, outputTokens: 1, toolCalls: 4, wallTimeMs: 1_000, outputBytes: 10 },
    { providerCalls: undefined, inputTokens: 1, outputTokens: 1, toolCalls: 1, wallTimeMs: 1_000, outputBytes: 10 },
  ]) {
    const fx = fixture()
    try {
      const worker = new DeepResearchSideQueueWorker(options(fx.store, {
        execute: async (job) => ({ ...result(job), budgetUsed }) as DeepResearchResult,
      }))
      const outcome = await worker.runOnce()
      assert.equal(outcome.kind, 'dead_letter')
      assert.equal(outcome.kind === 'dead_letter' ? outcome.category : null,
        budgetUsed.providerCalls === undefined ? 'invalid_structured_output' : 'budget_exceeded')
      assert.equal(fx.store.listResearchPacketsByWork('work-deep', 10).length, 0)
    } finally { fx.close() }
  }
})

test('containment cleanup failure is terminal and remains visible on work', async () => {
  const fx = fixture()
  try {
    const worker = new DeepResearchSideQueueWorker(options(fx.store, {
      execute: async () => { throw new DeepResearchError('unit survived cleanup', { category: 'containment_cleanup_failed', retryable: false }) },
    }))
    const outcome = await worker.runOnce()
    assert.equal(outcome.kind, 'dead_letter')
    assert.equal(fx.store.getResearchWork('work-deep')?.failureCategory, 'storage_permanent')
    assert.match(fx.store.getResearchWork('work-deep')?.failureDetail ?? '', /survived cleanup/)
  } finally { fx.close() }
})

test('lease loss after contained execution prevents packet persistence', async () => {
  const fx = fixture()
  try {
    let beats = 0
    const port = new Proxy(fx.store, {
      get(target, property, receiver) {
        if (property === 'heartbeatLease') return async () => { beats += 1; return beats < 2 }
        const value = Reflect.get(target, property, receiver) as unknown
        return typeof value === 'function' ? (value as Function).bind(target) : value
      },
    }) as DeepResearchWorkStore
    const worker = new DeepResearchSideQueueWorker(options(port, { execute: async (job) => result(job) }))
    assert.equal((await worker.runOnce()).kind, 'lease_lost')
    assert.equal(fx.store.listResearchPacketsByWork('work-deep', 10).length, 0)
  } finally { fx.close() }
})

test('stale entity promotion reports handoff pending without rerunning contained work', async () => {
  const fx = fixture()
  try {
    let calls = 0
    const port = new Proxy(fx.store, {
      get(target, property, receiver) {
        if (property === 'promoteResearchReady') return () => false
        const value = Reflect.get(target, property, receiver) as unknown
        return typeof value === 'function' ? (value as Function).bind(target) : value
      },
    }) as DeepResearchWorkStore
    const worker = new DeepResearchSideQueueWorker(options(port, {
      execute: async (job) => { calls += 1; return result(job) },
    }))
    assert.equal((await worker.runOnce()).kind, 'handoff_pending')
    assert.equal(fx.store.getResearchWork('work-deep')?.status, 'research_ready')
    assert.equal((await worker.runOnce()).kind, 'idle')
    assert.equal(calls, 1)
  } finally { fx.close() }
})

test('disabled or unavailable containment releases deep work with zero attempts', async () => {
  for (const reason of ['containment_disabled', 'systemd_unavailable', 'circuit_open'] as const) {
    const fx = fixture()
    try {
      const ledger = new FakeExecutionLedger()
      let calls = 0
      const worker = new DeepResearchSideQueueWorker(options(fx.store, {
        execute: async (job) => { calls += 1; return result(job) },
      }, {
        preflight: { check: async () => ({ ready: false, reason, detail: reason }) },
        executionLedger: ledger,
      }))
      const outcome = await worker.runOnce()
      assert.equal(outcome.kind, 'released')
      assert.equal(fx.store.getResearchWork('work-deep')?.status, 'deep_pending')
      assert.equal(fx.store.getResearchWork('work-deep')?.attemptCount, 0)
      assert.equal(calls, 0)
      const event = [...ledger.events.values()][0]!
      assert.equal(event.status, 'skipped')
      assert.equal(event.attempt, 0)
      assert.equal(event.providerCalls, 0)
      assert.equal(event.wallTimeMs, 0)
      assert.equal(event.queueWaitMs, 10 * 60_000)
      assert.equal(event.failureCategory, reason === 'circuit_open' ? 'circuit_open' : 'provider_unavailable')
    } finally { fx.close() }
  }
})

test('completion replay reuses the immutable packet and does not execute twice', async () => {
  const fx = fixture()
  try {
    let executions = 0
    const ledger = new FakeExecutionLedger()
    let loseTransition = true
    const port = new Proxy(fx.store, {
      get(target, property, receiver) {
        if (property === 'transitionLeased') {
          return async (command: Parameters<DeepResearchWorkStore['transitionLeased']>[0]) => {
            if (loseTransition && command.nextStatus === 'research_ready') {
              loseTransition = false
              return false
            }
            return target.transitionLeased(command)
          }
        }
        const value = Reflect.get(target, property, receiver) as unknown
        return typeof value === 'function' ? (value as Function).bind(target) : value
      },
    }) as DeepResearchWorkStore
    const executor = { execute: async (job: DeepResearchJob) => { executions += 1; return result(job) } }
    const first = new DeepResearchSideQueueWorker(options(port, executor, { executionLedger: ledger }))
    assert.equal((await first.runOnce()).kind, 'lease_lost')
    assert.equal(fx.store.listResearchPacketsByWork('work-deep', 10).length, 1)
    await fx.store.recoverExpiredLeases({ now: '2026-08-26T12:12:00.000Z', limit: 10 })
    const second = new DeepResearchSideQueueWorker(options(port, executor, {
      clock: new FixedClock(new Date('2026-08-26T12:12:00.000Z')),
      executionLedger: ledger,
    }))
    assert.equal((await second.runOnce()).kind, 'succeeded')
    assert.equal(executions, 1)
    assert.equal(fx.store.listResearchPacketsByWork('work-deep', 10).length, 1)
    assert.equal(fx.store.getResearchWork('work-deep')?.attemptCount, 1)
    assert.equal(ledger.events.size, 1)
    assert.equal(ledger.appendAttempts, 2)
    assert.equal(ledger.conflicts, 0)
    assert.equal([...ledger.events.values()][0]?.providerCalls, 2)
  } finally { fx.close() }
})

test('source linkage mismatch fails closed before contained execution', async () => {
  const fx = fixture()
  try {
    let calls = 0
    const otherSignal = { ...signal(), sourceType: 'x' as const } as unknown as NewsSignal
    const port = new Proxy(fx.store, {
      get(target, property, receiver) {
        if (property === 'getSignal') return () => otherSignal
        const value = Reflect.get(target, property, receiver) as unknown
        return typeof value === 'function' ? (value as Function).bind(target) : value
      },
    }) as DeepResearchWorkStore
    const worker = new DeepResearchSideQueueWorker(options(port, {
      execute: async (job) => { calls += 1; return result(job) },
    }))
    assert.equal((await worker.runOnce()).kind, 'dead_letter')
    assert.equal(calls, 0)
    assert.equal(fx.store.getResearchWork('work-deep')?.attemptCount, 0)
  } finally { fx.close() }
})

test('an execution crossing freshness is expired after spending its attempt', async () => {
  const fx = fixture()
  try {
    const clock = new MutableClock(new Date(NOW))
    const worker = new DeepResearchSideQueueWorker(options(fx.store, {
      execute: async () => {
        clock.advanceTo('2026-08-26T13:00:01.000Z')
        throw new DeepResearchError('timeout after freshness', { category: 'timed_out', retryable: true })
      },
    }, { clock, leaseTtlMs: 60 * 60_000, heartbeatIntervalMs: 1_000 }))
    const outcome = await worker.runOnce()
    assert.equal(outcome.kind, 'expired')
    assert.equal(fx.store.getResearchWork('work-deep')?.attemptCount, 1)
    assert.equal(fx.store.getResearchWork('work-deep')?.failureCategory, 'provider_timeout')
  } finally { fx.close() }
})

test('graceful stop drains the active contained unit and prevents another claim', async () => {
  const fx = fixture()
  try {
    let entered!: () => void
    let release!: () => void
    const started = new Promise<void>((resolve) => { entered = resolve })
    const gate = new Promise<void>((resolve) => { release = resolve })
    const worker = new DeepResearchSideQueueWorker(options(fx.store, {
      execute: async (job) => { entered(); await gate; return result(job) },
    }))
    const running = worker.runOnce()
    await started
    let drained = false
    const stopping = worker.stop().then(() => { drained = true })
    await Promise.resolve()
    assert.equal(drained, false)
    release()
    assert.equal((await running).kind, 'succeeded')
    await stopping
    assert.equal(drained, true)
    assert.equal((await worker.runOnce()).kind, 'idle')
  } finally { fx.close() }
})

test('ledger append failure cannot change successful fencing or packet persistence', async () => {
  const fx = fixture()
  try {
    const worker = new DeepResearchSideQueueWorker(options(fx.store, {
      execute: async (job) => result(job),
    }, {
      executionLedger: { append: () => { throw new Error('ledger unavailable') } },
    }))
    assert.equal((await worker.runOnce()).kind, 'succeeded')
    assert.equal(fx.store.getResearchWork('work-deep')?.status, 'entity_pending')
    assert.equal(fx.store.listResearchPacketsByWork('work-deep', 10).length, 1)
  } finally { fx.close() }
})
