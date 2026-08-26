import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { InferenceGatewayError } from '../inference-gateway'
import {
  RESEARCH_PACKET_SCHEMA_VERSION,
  RESEARCH_WORK_SCHEMA_VERSION,
  RETRIEVED_EVIDENCE_SCHEMA_VERSION,
  SIGNAL_SCHEMA_VERSION,
  type ExecutionTraceEvent,
  type ResearchPacketV1,
  type ResearchWorkItem,
  type RetrievedEvidence,
  type Signal,
} from '../signal-platform/contracts'
import type { ExecutionEventAppendResult } from '../signal-platform/execution-ledger'
import { SqliteSignalPlatformStore } from '../signal-platform/sqlite-platform-store'
import { adaptRetrievedEvidenceArtifact } from '../signal-platform/retrieved-evidence-adapter'
import { DeterministicRetriever } from './deterministic-retrieval'
import type { EvidenceReusePolicyInput } from './evidence-reuse-policy'
import { BoundedStandardSearch, SearchConnectorRegistry } from './search-connector'
import {
  SharedResearchWorker,
  SharedResearchWorkerConfigurationError,
  type SharedResearchWorkPort,
  type SharedWorkerClock,
  type ResearchExecutionLedgerPort,
  type SharedResearchSchedulerPort,
} from './shared-worker'
import type { StructuredResearchSynthesizer } from './structured-synthesizer'

const NOW = '2026-08-26T12:10:00.000Z'

class FixedClock implements SharedWorkerClock {
  constructor(readonly instant = new Date(NOW)) {}
  now(): Date { return new Date(this.instant) }
  setInterval(): unknown { return 1 }
  clearInterval(): void {}
}

function signal(sourceType: Signal['sourceType'] = 'news', id = `signal-${sourceType}`): Signal {
  const variants = {
    news: ['article', 'myboon.signal_content.article.v1'],
    polymarket: ['market_event', 'myboon.signal_content.market_event.v1'],
    market_calendar: ['calendar_event', 'myboon.signal_content.calendar_event.v1'],
    x: ['social_thread', 'myboon.signal_content.social_thread.v1'],
  } as const
  const [contentKind, schemaVersion] = variants[sourceType]
  return {
    schemaVersion: SIGNAL_SCHEMA_VERSION, signalId: id, sourceType, sourceId: `${sourceType}:1`,
    contentKind, content: { schemaVersion }, observedAt: '2026-08-26T12:00:00.000Z',
    publishedAt: '2026-08-26T11:59:00.000Z', canonicalUrl: `https://${sourceType}.example/item`,
    title: `${sourceType} signal`, visibleSummary: null, media: { imageUrl: null, attribution: null },
    sourceHints: { entities: [], assets: [], eventId: null, deadline: null },
    provenance: { provider: 'fixture', upstreamSource: null, rawPayloadRef: `${sourceType}:raw:1` },
    idempotencyKey: `${sourceType}:key:1`,
  } as Signal
}

function work(input: {
  sourceType?: Signal['sourceType'], id?: string, status?: ResearchWorkItem['status'],
  depth?: ResearchWorkItem['researchDepth'], attemptCount?: number, priorityScore?: number,
} = {}): ResearchWorkItem {
  const sourceType = input.sourceType ?? 'news'
  const id = input.id ?? `work-${sourceType}`
  return {
    schemaVersion: RESEARCH_WORK_SCHEMA_VERSION, workId: id, signalId: `signal-${sourceType}`, sourceType,
    researchDepth: input.depth ?? 'standard',
    deepReason: input.depth === 'deep' ? 'insufficient_primary_evidence' : null,
    priorityClass: 'P1', priorityScore: input.priorityScore ?? 0.5,
    freshnessDeadline: '2026-08-26T13:00:00.000Z', policyVersion: 'policy.v1',
    researchContractVersion: RESEARCH_PACKET_SCHEMA_VERSION,
    retrievalPlan: {
      sourceUrl: `https://${sourceType}.example/item`, allowedDomains: [`${sourceType}.example`], maxExternalSources: 0,
    },
    budget: {
      maxProviderCalls: 2, maxRepairCalls: 1, maxInputTokens: 2_000, maxOutputTokens: 500,
      maxToolCalls: 0, maxWallTimeMs: 30_000,
    },
    status: input.status ?? 'research_pending', attemptCount: input.attemptCount ?? 0,
    nextAttemptAt: null, leaseOwner: null, leaseId: null, leaseExpiresAt: null,
    failureCategory: null, failureDetail: null, traceId: `trace-${sourceType}`,
    createdAt: '2026-08-26T12:00:00.000Z', updatedAt: '2026-08-26T12:00:00.000Z',
  }
}

function evidence(item: ResearchWorkItem, id = `evidence-${item.sourceType}`): RetrievedEvidence {
  return {
    schemaVersion: RETRIEVED_EVIDENCE_SCHEMA_VERSION, evidenceId: id, workId: item.workId,
    requestedUrl: item.retrievalPlan.sourceUrl!, finalUrl: item.retrievalPlan.sourceUrl!,
    authority: 'source_url', authorityId: item.signalId, contentHash: `hash-${item.sourceType}`,
    contentType: 'text/plain', httpStatus: 200, retrievalMethod: 'safe_http', retrievedAt: NOW,
    text: `${item.sourceType} evidence`, truncated: false, byteLength: 20,
  }
}

function packet(item: ResearchWorkItem, source: Signal, artifact: RetrievedEvidence): ResearchPacketV1 {
  return {
    schemaVersion: RESEARCH_PACKET_SCHEMA_VERSION, packetId: `packet-${item.workId}`,
    workId: item.workId, signalId: item.signalId, sourceType: item.sourceType, observedAt: source.observedAt,
    sourceSignal: {
      title: source.title, canonicalUrl: source.canonicalUrl, publishedAt: source.publishedAt,
      provenance: source.provenance,
    },
    claims: [{ claimId: `claim-${item.workId}`, claim: 'Claim', attributedTo: null, evidenceRefs: [artifact.evidenceId] }],
    verifiedFacts: [], unresolvedClaims: [],
    evidence: [{
      evidenceId: artifact.evidenceId, title: source.title, url: artifact.finalUrl,
      sourceType: artifact.authority, observedAt: artifact.retrievedAt, note: null,
    }],
    entityHints: [], limitations: [], openQuestions: [], completion: 'complete',
    budgetUsed: {
      providerCalls: 1, repairCalls: 0, inputTokens: 10, outputTokens: 10,
      toolCalls: 0, wallTimeMs: 10, budgetExceeded: false,
    },
    execution: {
      provider: 'fixture', model: 'fixture', fallbackProvider: null, fallbackModel: null,
      fallbackUsed: false, promptVersion: 'prompt.v1', policyVersion: item.policyVersion,
      traceId: item.traceId, attempt: item.attemptCount,
    },
    researchContractVersion: RESEARCH_PACKET_SCHEMA_VERSION, createdAt: NOW,
  }
}

function fixture(sourceType: Signal['sourceType'] = 'news'): {
  store: SqliteSignalPlatformStore, close(): void,
} {
  const dir = mkdtempSync(join(tmpdir(), `shared-worker-${sourceType}-`))
  const store = new SqliteSignalPlatformStore(join(dir, 'store.sqlite'), sourceType)
  return { store, close: () => { store.close(); rmSync(dir, { recursive: true, force: true }) } }
}

function retriever(onCall?: () => void): DeterministicRetriever {
  return new DeterministicRetriever({
    now: () => new Date(NOW),
    fetchDocument: async (url) => {
      onCall?.()
      return { body: Buffer.from('retrieved evidence'), finalUrl: url, contentType: 'text/plain', status: 200, visitedHosts: [] }
    },
  })
}

function synthesizer(onCall?: (work: ResearchWorkItem) => void): StructuredResearchSynthesizer {
  return {
    async synthesize(input) {
      onCall?.(input.workItem)
      return packet(input.workItem, input.signal, adaptRetrievedEvidenceArtifact(input.evidence[0]!))
    },
  } as StructuredResearchSynthesizer
}

function workerOptions(stores: SharedResearchWorkPort[], overrides: Record<string, unknown> = {}) {
  return {
    workerId: 'shared-worker-1', stores, retriever: retriever(), synthesizer: synthesizer(),
    standardSearch: {
      async discover() {
        return { policyVersion: 'test-search.v1', connectorId: 'test-search', queryCount: 0, urls: [] }
      },
    },
    mode: 'active' as const, ownership: 'shared' as const, legacyClaimersActive: false,
    clock: new FixedClock(), ...overrides,
  }
}

class CapturingExecutionLedger implements ResearchExecutionLedgerPort {
  readonly events = new Map<string, ExecutionTraceEvent>()
  appendCalls = 0

  append(event: ExecutionTraceEvent): ExecutionEventAppendResult {
    this.appendCalls += 1
    const existing = this.events.get(event.eventId)
    if (existing) {
      assert.deepEqual(event, existing)
      return { inserted: false, event }
    }
    this.events.set(event.eventId, structuredClone(event))
    return { inserted: true, event }
  }
}

test('retrieval and structured synthesis complete fenced happy stages and entity handoff', async () => {
  const fx = fixture()
  try {
    fx.store.appendSignal(signal())
    fx.store.admitResearchWork(work())
    const ledger = new CapturingExecutionLedger()
    const worker = new SharedResearchWorker(workerOptions([fx.store], { executionLedger: ledger }))
    assert.deepEqual(await worker.runOnce(), {
      kind: 'succeeded', stage: 'retrieval', sourceType: 'news', workId: 'work-news',
    })
    assert.equal(fx.store.getResearchWork('work-news')?.status, 'synthesis_pending')
    assert.equal(fx.store.listEvidenceByWork('work-news', 10).length, 1)
    assert.deepEqual(await worker.runOnce(), {
      kind: 'succeeded', stage: 'synthesis', sourceType: 'news', workId: 'work-news',
    })
    assert.equal(fx.store.getResearchWork('work-news')?.status, 'entity_pending')
    assert.equal(fx.store.getResearchWork('work-news')?.attemptCount, 2)
    assert.equal(fx.store.listResearchPacketsByWork('work-news', 10).length, 1)
    const events = [...ledger.events.values()].sort((left, right) => left.stage.localeCompare(right.stage))
    const retrievalEvent = events.find((event) => event.stage === 'retrieval')!
    const synthesisEvent = events.find((event) => event.stage === 'synthesis')!
    assert.equal(events.length, 2)
    assert.equal(retrievalEvent.status, 'succeeded')
    assert.equal(retrievalEvent.attempt, 1)
    assert.equal(retrievalEvent.queueWaitMs, 10 * 60_000)
    assert.deepEqual({
      provider: retrievalEvent.provider, model: retrievalEvent.model,
      providerCalls: retrievalEvent.providerCalls, inputTokens: retrievalEvent.inputTokens,
      outputTokens: retrievalEvent.outputTokens, toolCalls: retrievalEvent.toolCalls,
    }, { provider: null, model: null, providerCalls: 0, inputTokens: 0, outputTokens: 0, toolCalls: 0 })
    assert.equal(synthesisEvent.status, 'succeeded')
    assert.equal(synthesisEvent.packetId, 'packet-work-news')
    assert.equal(synthesisEvent.provider, 'fixture')
    assert.equal(synthesisEvent.model, 'fixture')
    assert.equal(synthesisEvent.providerCalls, 1)
    assert.equal(synthesisEvent.inputTokens, 10)
    assert.equal(synthesisEvent.outputTokens, 10)
    assert.equal(synthesisEvent.wallTimeMs, 10)
    assert.equal(synthesisEvent.promptVersion, 'prompt.v1')
  } finally { fx.close() }
})

test('deep work is routed only to the contained side port', async () => {
  const fx = fixture()
  try {
    const item = work({ status: 'research_pending', depth: 'deep' })
    fx.store.appendSignal(signal())
    fx.store.admitResearchWork(item)
    let deepCalls = 0
    let synthesisCalls = 0
    const worker = new SharedResearchWorker(workerOptions([fx.store], {
      synthesizer: synthesizer(() => { synthesisCalls += 1 }),
      deepResearch: { enqueue: async () => { deepCalls += 1 } },
    }))
    assert.equal((await worker.runOnce()).kind, 'deep_routed')
    assert.equal(deepCalls, 1)
    assert.equal(synthesisCalls, 0)
    assert.equal(fx.store.getResearchWork(item.workId)?.status, 'deep_pending')
    assert.equal(fx.store.listEvidenceByWork(item.workId, 10).length, 1)
    assert.equal(fx.store.listResearchPacketsByWork(item.workId, 10).length, 0)
    assert.equal((await worker.runOnce()).kind, 'idle')
  } finally { fx.close() }
})

test('pre-spawn circuit-open releases the lease without spending an attempt', async () => {
  const fx = fixture()
  try {
    const item = work({ status: 'synthesis_pending' })
    fx.store.appendSignal(signal())
    fx.store.admitResearchWork(item)
    fx.store.appendEvidence(evidence(item))
    let calls = 0
    const ledger = new CapturingExecutionLedger()
    const worker = new SharedResearchWorker(workerOptions([fx.store], {
      stages: ['synthesis'], synthesizer: synthesizer(() => { calls += 1 }),
      executionLedger: ledger,
      readiness: { check: async () => ({ ready: false, category: 'circuit_open', detail: 'open' }) },
    }))
    assert.equal((await worker.runOnce()).kind, 'released')
    assert.equal(fx.store.getResearchWork(item.workId)?.status, 'synthesis_pending')
    assert.equal(fx.store.getResearchWork(item.workId)?.attemptCount, 0)
    assert.equal(calls, 0)
    const event = [...ledger.events.values()][0]!
    assert.equal(event.status, 'skipped')
    assert.equal(event.failureCategory, 'circuit_open')
    assert.equal(event.failureDetail, 'failure:circuit_open')
    assert.equal(event.attempt, 0)
    assert.equal(event.providerCalls, 0)
    assert.equal(event.provider, null)
  } finally { fx.close() }
})

test('workload circuit readiness prevents a scheduler claim entirely', async () => {
  const fx = fixture()
  try {
    const item = work({ status: 'synthesis_pending' })
    fx.store.appendSignal(signal())
    fx.store.admitResearchWork(item)
    fx.store.appendEvidence(evidence(item))
    let claimCalls = 0
    let providerCalls = 0
    const scheduler: SharedResearchSchedulerPort = {
      peekGlobal: async () => [],
      claimNext: async () => { claimCalls += 1; return null },
    }
    const worker = new SharedResearchWorker(workerOptions([fx.store], {
      stages: ['synthesis'], scheduler,
      synthesizer: synthesizer(() => { providerCalls += 1 }),
      readiness: {
        checkStage: async () => ({ ready: false, category: 'circuit_open', detail: 'all routes open' }),
        check: async () => ({ ready: false, category: 'circuit_open', detail: 'all routes open' }),
      },
    }))

    assert.deepEqual(await worker.runOnce(), { kind: 'idle' })
    assert.equal(claimCalls, 0)
    assert.equal(providerCalls, 0)
    assert.equal(fx.store.getResearchWork(item.workId)?.status, 'synthesis_pending')
  } finally { fx.close() }
})

test('priority partition is passed to the scheduler for a dedicated urgent worker pool', async () => {
  const fx = fixture()
  try {
    const seen: unknown[] = []
    const scheduler: SharedResearchSchedulerPort = {
      peekGlobal: async () => [],
      claimNext: async (command) => { seen.push(command.priorityClasses); return null },
    }
    const worker = new SharedResearchWorker(workerOptions([fx.store], {
      scheduler, priorityClasses: ['P0', 'P1', 'P1'],
    }))
    assert.deepEqual(await worker.runOnce(), { kind: 'idle' })
    assert.deepEqual(seen, [['P0', 'P1']])
    assert.throws(() => new SharedResearchWorker(workerOptions([fx.store], {
      priorityClasses: [],
    })), /priorityClasses/)
  } finally { fx.close() }
})

test('standard retrieval discovers bounded corroboration URLs before deterministic fetch', async () => {
  const fx = fixture()
  try {
    const source = signal()
    const item = work()
    item.retrievalPlan = {
      sourceUrl: source.canonicalUrl,
      allowedDomains: ['news.example', 'corroboration.example'],
      maxExternalSources: 1,
    }
    fx.store.appendSignal(source)
    fx.store.admitResearchWork(item)
    const searchCalls: Array<{ query: string, limit: number }> = []
    const standardSearch = new BoundedStandardSearch(new SearchConnectorRegistry([{
      connectorId: 'fixture-search',
      async search(input) {
        searchCalls.push({ query: input.query, limit: input.limit })
        return [{
          url: 'https://corroboration.example/report', title: 'Report', providerResultId: 'result-1',
        }]
      },
    }]), {
      policyVersion: 'fixture-search.v1', connectorId: 'fixture-search',
      maxQueries: 1, maxResultsPerQuery: 2, maxQueryChars: 120, timeoutMs: 1_000,
    })
    const fetched: string[] = []
    const capturingRetriever = new DeterministicRetriever({
      now: () => new Date(NOW),
      fetchDocument: async (url) => {
        fetched.push(url)
        return { body: Buffer.from('evidence'), finalUrl: url, contentType: 'text/plain', status: 200, visitedHosts: [] }
      },
    })
    const subject = new SharedResearchWorker(workerOptions([fx.store], {
      stages: ['retrieval'], standardSearch, retriever: capturingRetriever,
    }))
    assert.equal((await subject.runOnce()).kind, 'succeeded')
    assert.equal(searchCalls.length, 1)
    assert.match(searchCalls[0]!.query, /news signal/)
    assert.equal(searchCalls[0]!.limit, 1)
    assert.deepEqual(fetched, [
      'https://news.example/item', 'https://corroboration.example/report',
    ])
    assert.equal(fx.store.listEvidenceByWork(item.workId, 10).length, 2)
    assert.equal(fx.store.getResearchWork(item.workId)?.attemptCount, 1)
  } finally { fx.close() }
})

test('standard work without a registered search connector fails closed before spending an attempt', async () => {
  const fx = fixture()
  try {
    const item = work()
    fx.store.appendSignal(signal())
    fx.store.admitResearchWork(item)
    let retrievalCalls = 0
    const ledger = new CapturingExecutionLedger()
    const worker = new SharedResearchWorker(workerOptions([fx.store], {
      stages: ['retrieval'], standardSearch: undefined, executionLedger: ledger,
      retriever: retriever(() => { retrievalCalls += 1 }),
    }))
    assert.equal((await worker.runOnce()).kind, 'dead_letter')
    const stored = fx.store.getResearchWork(item.workId)!
    assert.equal(stored.failureCategory, 'retrieval_blocked')
    assert.equal(stored.attemptCount, 0)
    assert.equal(retrievalCalls, 0)
    const event = [...ledger.events.values()][0]!
    assert.equal(event.status, 'dead_letter')
    assert.equal(event.attempt, 0)
    assert.equal(event.providerCalls, 0)
  } finally { fx.close() }
})

test('light work never invokes standard search', async () => {
  const fx = fixture()
  try {
    const item = work({ depth: 'light' })
    fx.store.appendSignal(signal())
    fx.store.admitResearchWork(item)
    let searchCalls = 0
    const worker = new SharedResearchWorker(workerOptions([fx.store], {
      stages: ['retrieval'],
      standardSearch: { async discover() { searchCalls += 1; throw new Error('must not run') } },
    }))
    assert.equal((await worker.runOnce()).kind, 'succeeded')
    assert.equal(searchCalls, 0)
  } finally { fx.close() }
})

test('an existing canonical packet replays only the entity handoff without provider readiness or another attempt', async () => {
  const fx = fixture()
  try {
    const item = work({ status: 'synthesis_pending' })
    const source = signal()
    const artifact = evidence(item)
    fx.store.appendSignal(source)
    fx.store.admitResearchWork(item)
    fx.store.appendEvidence(artifact)
    fx.store.appendResearchPacket(packet(item, source, artifact))
    let readinessCalls = 0
    let synthesisCalls = 0
    const worker = new SharedResearchWorker(workerOptions([fx.store], {
      stages: ['synthesis'],
      synthesizer: synthesizer(() => { synthesisCalls += 1 }),
      readiness: {
        check: async () => {
          readinessCalls += 1
          return { ready: false, category: 'circuit_open', detail: 'must not be consulted during replay' }
        },
      },
      evidenceReusePolicy: {
        evaluate() { throw new Error('completed packet replay must not re-evaluate evidence freshness') },
      },
    }))

    assert.deepEqual(await worker.runOnce(), {
      kind: 'succeeded', stage: 'synthesis', sourceType: 'news', workId: item.workId,
    })
    assert.equal(fx.store.getResearchWork(item.workId)?.status, 'entity_pending')
    assert.equal(fx.store.getResearchWork(item.workId)?.attemptCount, 0)
    assert.equal(fx.store.listResearchPacketsByWork(item.workId, 10).length, 1)
    assert.equal(readinessCalls, 0)
    assert.equal(synthesisCalls, 0)
  } finally { fx.close() }
})

test('packet replay emits one idempotent skipped event and never charges packet provider usage', async () => {
  const fx = fixture()
  try {
    const item = work({ status: 'synthesis_pending' })
    const source = signal()
    const artifact = evidence(item)
    fx.store.appendSignal(source)
    fx.store.admitResearchWork(item)
    fx.store.appendEvidence(artifact)
    fx.store.appendResearchPacket(packet(item, source, artifact))
    const ledger = new CapturingExecutionLedger()
    const port = new Proxy(fx.store, {
      get(target, property, receiver) {
        if (property === 'transitionLeased') {
          return async (command: Parameters<SharedResearchWorkPort['transitionLeased']>[0]) => (
            command.nextStatus === 'research_ready' ? false : target.transitionLeased(command)
          )
        }
        const value = Reflect.get(target, property, receiver) as unknown
        return typeof value === 'function' ? (value as Function).bind(target) : value
      },
    }) as SharedResearchWorkPort
    const first = new SharedResearchWorker(workerOptions([port], {
      stages: ['synthesis'], executionLedger: ledger,
    }))
    assert.equal((await first.runOnce()).kind, 'lease_lost')
    await fx.store.recoverExpiredLeases({ now: '2026-08-26T12:12:00.000Z', limit: 10 })
    const second = new SharedResearchWorker(workerOptions([port], {
      stages: ['synthesis'], executionLedger: ledger,
      clock: new FixedClock(new Date('2026-08-26T12:12:00.000Z')),
    }))
    assert.equal((await second.runOnce()).kind, 'lease_lost')
    assert.equal(ledger.appendCalls, 2)
    assert.equal(ledger.events.size, 1)
    const event = [...ledger.events.values()][0]!
    assert.equal(event.status, 'skipped')
    assert.equal(event.packetId, `packet-${item.workId}`)
    assert.equal(event.provider, null)
    assert.equal(event.model, null)
    assert.equal(event.providerCalls, 0)
    assert.equal(event.inputTokens, 0)
    assert.equal(event.outputTokens, 0)
  } finally { fx.close() }
})

test('failed execution records only typed redacted failure data', async () => {
  const fx = fixture()
  try {
    const item = work({ status: 'synthesis_pending' })
    fx.store.appendSignal(signal())
    fx.store.admitResearchWork(item)
    fx.store.appendEvidence(evidence(item))
    const ledger = new CapturingExecutionLedger()
    const secret = 'sk-this-must-not-enter-the-ledger'
    const failing = {
      synthesize: async () => {
        throw new InferenceGatewayError(`prompt and evidence ${secret}`, {
          category: 'provider_timeout', retryable: true,
        })
      },
    } as unknown as StructuredResearchSynthesizer
    const worker = new SharedResearchWorker(workerOptions([fx.store], {
      stages: ['synthesis'], synthesizer: failing, executionLedger: ledger,
    }))
    assert.equal((await worker.runOnce()).kind, 'retry_wait')
    const event = [...ledger.events.values()][0]!
    assert.equal(event.status, 'retry_wait')
    assert.equal(event.failureCategory, 'provider_timeout')
    assert.equal(event.failureDetail, 'failure:provider_timeout')
    assert.doesNotMatch(JSON.stringify(event), /prompt and evidence|sk-this/)
    assert.equal(event.providerCalls, 0)
  } finally { fx.close() }
})

test('ledger failure cannot change a successful fenced queue outcome', async () => {
  const fx = fixture()
  try {
    fx.store.appendSignal(signal())
    fx.store.admitResearchWork(work())
    const worker = new SharedResearchWorker(workerOptions([fx.store], {
      stages: ['retrieval'],
      executionLedger: { append() { throw new Error('ledger offline') } },
    }))
    assert.equal((await worker.runOnce()).kind, 'succeeded')
    assert.equal(fx.store.getResearchWork('work-news')?.status, 'synthesis_pending')
    assert.equal(fx.store.listEvidenceByWork('work-news', 10).length, 1)
  } finally { fx.close() }
})

test('provider failures after execution spend attempts and follow bounded retry/dead-letter policy', async () => {
  for (const [maxAttempts, expected] of [[3, 'retry_wait'], [1, 'dead_letter']] as const) {
    const fx = fixture()
    try {
      const item = work({ status: 'synthesis_pending' })
      fx.store.appendSignal(signal())
      fx.store.admitResearchWork(item)
      fx.store.appendEvidence(evidence(item))
      const failing = {
        synthesize: async () => { throw new InferenceGatewayError('timed out', { category: 'provider_timeout', retryable: true }) },
      } as unknown as StructuredResearchSynthesizer
      const worker = new SharedResearchWorker(workerOptions([fx.store], {
        stages: ['synthesis'], synthesizer: failing, maxAttempts, maxBackoffMs: 2_000,
      }))
      assert.equal((await worker.runOnce()).kind, expected)
      const stored = fx.store.getResearchWork(item.workId)!
      assert.equal(stored.status, expected)
      assert.equal(stored.attemptCount, 1)
      if (expected === 'retry_wait') assert.equal(stored.nextAttemptAt, '2026-08-26T12:10:01.000Z')
    } finally { fx.close() }
  }
})

test('lease loss after execution prevents immutable evidence append and completion', async () => {
  const fx = fixture()
  try {
    fx.store.appendSignal(signal())
    fx.store.admitResearchWork(work())
    let beats = 0
    const port = new Proxy(fx.store, {
      get(target, property, receiver) {
        if (property === 'heartbeatLease') return async () => { beats += 1; return beats < 2 }
        const value = Reflect.get(target, property, receiver) as unknown
        return typeof value === 'function' ? (value as Function).bind(target) : value
      },
    }) as SharedResearchWorkPort
    const worker = new SharedResearchWorker(workerOptions([port], { stages: ['retrieval'] }))
    assert.equal((await worker.runOnce()).kind, 'lease_lost')
    assert.equal(fx.store.listEvidenceByWork('work-news', 10).length, 0)
    assert.equal(fx.store.getResearchWork('work-news')?.status, 'retrieval_leased')
  } finally { fx.close() }
})

test('a source failure does not block another source in the bounded global batch', async () => {
  const news = fixture('news')
  const x = fixture('x')
  try {
    for (const [fx, sourceType, score] of [[news, 'news', 0.9], [x, 'x', 0.8]] as const) {
      const item = work({ sourceType, status: 'synthesis_pending', priorityScore: score })
      fx.store.appendSignal(signal(sourceType))
      fx.store.admitResearchWork(item)
      fx.store.appendEvidence(evidence(item))
    }
    const mixed = {
      async synthesize(input: Parameters<StructuredResearchSynthesizer['synthesize']>[0]) {
        if (input.workItem.sourceType === 'news') {
          throw new InferenceGatewayError('rate', { category: 'provider_rate_limited', retryable: true })
        }
        return packet(input.workItem, input.signal, adaptRetrievedEvidenceArtifact(input.evidence[0]!))
      },
    } as StructuredResearchSynthesizer
    const worker = new SharedResearchWorker(workerOptions([news.store, x.store], { stages: ['synthesis'], synthesizer: mixed }))
    assert.deepEqual((await worker.runBatch(2)).map((outcome) => outcome.kind), ['retry_wait', 'succeeded'])
    assert.equal(news.store.getResearchWork('work-news')?.status, 'retry_wait')
    assert.equal(x.store.getResearchWork('work-x')?.status, 'entity_pending')
  } finally { news.close(); x.close() }
})

test('shadow mode samples readiness without claims, mutation, retrieval, or synthesis', async () => {
  const fx = fixture()
  try {
    fx.store.appendSignal(signal())
    fx.store.admitResearchWork(work())
    let retrievalCalls = 0
    let synthesisCalls = 0
    const worker = new SharedResearchWorker({
      ...workerOptions([fx.store]), mode: 'shadow', ownership: 'legacy', legacyClaimersActive: true,
      retriever: retriever(() => { retrievalCalls += 1 }), synthesizer: synthesizer(() => { synthesisCalls += 1 }),
    })
    assert.deepEqual(await worker.runOnce(), { kind: 'shadow', sampled: 1, ready: 1, issues: [] })
    assert.equal(fx.store.getResearchWork('work-news')?.status, 'research_pending')
    assert.equal(fx.store.getResearchWork('work-news')?.attemptCount, 0)
    assert.equal(retrievalCalls, 0)
    assert.equal(synthesisCalls, 0)
  } finally { fx.close() }
})

test('immutable synthesis and handoff are replay-safe, and active topology fails closed', async () => {
  const fx = fixture()
  try {
    const item = work({ status: 'synthesis_pending' })
    fx.store.appendSignal(signal())
    fx.store.admitResearchWork(item)
    fx.store.appendEvidence(evidence(item))
    let promoteCalls = 0
    const port = new Proxy(fx.store, {
      get(target, property, receiver) {
        if (property === 'promoteResearchReady') return () => { promoteCalls += 1; return false }
        const value = Reflect.get(target, property, receiver) as unknown
        return typeof value === 'function' ? (value as Function).bind(target) : value
      },
    }) as SharedResearchWorkPort
    const worker = new SharedResearchWorker(workerOptions([port], { stages: ['synthesis'] }))
    assert.equal((await worker.runOnce()).kind, 'handoff_pending')
    assert.equal(fx.store.listResearchPacketsByWork(item.workId, 10).length, 1)
    assert.equal((await worker.runOnce()).kind, 'idle')
    assert.equal(fx.store.listResearchPacketsByWork(item.workId, 10).length, 1)
    assert.equal(promoteCalls, 1)

    assert.throws(() => new SharedResearchWorker({
      ...workerOptions([fx.store]), ownership: 'legacy', legacyClaimersActive: false,
    }), SharedResearchWorkerConfigurationError)
    assert.throws(() => new SharedResearchWorker({
      ...workerOptions([fx.store]), legacyClaimersActive: true,
    }), SharedResearchWorkerConfigurationError)
  } finally { fx.close() }
})

test('graceful stop drains an in-flight provider call and prevents new claims', async () => {
  const fx = fixture()
  try {
    const item = work({ status: 'synthesis_pending' })
    fx.store.appendSignal(signal())
    fx.store.admitResearchWork(item)
    fx.store.appendEvidence(evidence(item))
    let release!: () => void
    let entered!: () => void
    const started = new Promise<void>((resolve) => { entered = resolve })
    const gate = new Promise<void>((resolve) => { release = resolve })
    const slow = {
      async synthesize(input: Parameters<StructuredResearchSynthesizer['synthesize']>[0]) {
        entered()
        await gate
        return packet(input.workItem, input.signal, adaptRetrievedEvidenceArtifact(input.evidence[0]!))
      },
    } as StructuredResearchSynthesizer
    const worker = new SharedResearchWorker(workerOptions([fx.store], { stages: ['synthesis'], synthesizer: slow }))
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

test('retrieval replay reuses immutable evidence after a lost completion fence', async () => {
  const fx = fixture()
  try {
    fx.store.appendSignal(signal())
    fx.store.admitResearchWork(work())
    let retrievalCalls = 0
    let loseCompletion = true
    const port = new Proxy(fx.store, {
      get(target, property, receiver) {
        if (property === 'transitionLeased') {
          return async (command: Parameters<SharedResearchWorkPort['transitionLeased']>[0]) => {
            if (loseCompletion && command.nextStatus === 'synthesis_pending') {
              loseCompletion = false
              return false
            }
            return target.transitionLeased(command)
          }
        }
        const value = Reflect.get(target, property, receiver) as unknown
        return typeof value === 'function' ? (value as Function).bind(target) : value
      },
    }) as SharedResearchWorkPort
    const first = new SharedResearchWorker(workerOptions([port], {
      stages: ['retrieval'], retriever: retriever(() => { retrievalCalls += 1 }),
    }))
    assert.equal((await first.runOnce()).kind, 'lease_lost')
    assert.equal(fx.store.listEvidenceByWork('work-news', 10).length, 1)
    await fx.store.recoverExpiredLeases({ now: '2026-08-26T12:12:00.000Z', limit: 10 })

    const secondClock = new FixedClock(new Date('2026-08-26T12:12:00.000Z'))
    const policyCalls: string[] = []
    const second = new SharedResearchWorker(workerOptions([port], {
      stages: ['retrieval'], clock: secondClock,
      retriever: retriever(() => { retrievalCalls += 1 }),
      evidenceReusePolicy: {
        evaluate(input: EvidenceReusePolicyInput) {
          policyCalls.push(input.artifact.evidenceId)
          return { reusable: true, policyVersion: 'test.evidence_reuse.v1', reason: 'reusable' }
        },
      },
    }))
    assert.equal((await second.runOnce()).kind, 'succeeded')
    assert.equal(retrievalCalls, 1)
    assert.equal(policyCalls.length, 1)
    assert.equal(fx.store.listEvidenceByWork('work-news', 10).length, 1)
    assert.equal(fx.store.getResearchWork('work-news')?.attemptCount, 1)
  } finally { fx.close() }
})

test('stale evidence is never replayed and immutable revalidation creates a new artifact', async () => {
  const fx = fixture()
  try {
    const item = work()
    const stale = { ...evidence(item), retrievedAt: '2026-08-26T11:59:00.000Z' }
    fx.store.appendSignal(signal())
    fx.store.admitResearchWork(item)
    fx.store.appendEvidence(stale)
    let retrievalCalls = 0
    const worker = new SharedResearchWorker(workerOptions([fx.store], {
      stages: ['retrieval'], retriever: retriever(() => { retrievalCalls += 1 }),
    }))

    assert.equal((await worker.runOnce()).kind, 'succeeded')
    assert.equal(retrievalCalls, 1)
    const stored = fx.store.listEvidenceByWork(item.workId, 10)
    assert.equal(stored.length, 2)
    assert.ok(stored.some((artifact) => artifact.retrievedAt === NOW))
  } finally { fx.close() }
})
