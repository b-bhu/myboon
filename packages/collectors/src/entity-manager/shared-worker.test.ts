import assert from 'node:assert/strict'
import test from 'node:test'
import type { ExecutionTraceEvent, ResearchPacketV1, ResearchWorkItem, Signal } from '../signal-platform/contracts'
import { ExecutionEventConflictError, type ExecutionEventAppendResult } from '../signal-platform/execution-ledger'
import { PlatformFailure } from '../signal-platform/failures'
import type {
  HeartbeatCommand,
  LeaseCommand,
  LeasedTransitionCommand,
  ReleaseLeaseCommand,
  SchedulerQuery,
  WorkLease,
} from '../signal-platform/store-adapter'
import { validateExecutionTraceEvent } from '../signal-platform/validation'
import { sharedEntityWorkerConfig, type EntityWorkerSourceType } from './shared-worker-config'
import {
  SharedEntityWorker,
  __sharedEntityWorkerTesting,
  type CanonicalPacketProcessor,
  type EntityPacketWorkPort,
  type HeartbeatScheduler,
  type ShadowEntityObservation,
} from './shared-worker'

const NOW = '2026-08-26T12:00:00.000Z'

function work(sourceType: EntityWorkerSourceType, suffix = '1'): ResearchWorkItem {
  return {
    schemaVersion: 'myboon.research_work.v1',
    workId: `${sourceType}-work-${suffix}`,
    signalId: `${sourceType}-signal-${suffix}`,
    sourceType,
    researchDepth: 'standard',
    deepReason: null,
    priorityClass: 'P1',
    priorityScore: 0.8,
    freshnessDeadline: '2026-08-26T13:00:00.000Z',
    policyVersion: 'policy-v1',
    researchContractVersion: 'myboon.research_packet.v1',
    retrievalPlan: { sourceUrl: null, allowedDomains: [], maxExternalSources: 1 },
    budget: {
      maxProviderCalls: 1, maxRepairCalls: 1, maxInputTokens: 100, maxOutputTokens: 100,
      maxToolCalls: 0, maxWallTimeMs: 1000,
    },
    status: 'entity_pending',
    attemptCount: 0,
    nextAttemptAt: null,
    leaseOwner: null,
    leaseId: null,
    leaseExpiresAt: null,
    failureCategory: null,
    failureDetail: null,
    traceId: `trace-${suffix}`,
    createdAt: NOW,
    updatedAt: NOW,
  }
}

function packet(item: ResearchWorkItem, completion: ResearchPacketV1['completion'] = 'complete'): ResearchPacketV1 {
  const contentKind: Record<Signal['sourceType'], string> = {
    news: 'article', polymarket: 'market_event', market_calendar: 'calendar_event', x: 'social_thread',
  }
  return {
    schemaVersion: 'myboon.research_packet.v1',
    packetId: `${item.workId}-packet`,
    workId: item.workId,
    signalId: item.signalId,
    sourceType: item.sourceType,
    observedAt: NOW,
    sourceSignal: {
      title: `${item.sourceType} title`, canonicalUrl: 'https://example.com/item', publishedAt: NOW,
      provenance: { provider: 'test', upstreamSource: 'Test', rawPayloadRef: 'raw-1' },
      contentKind: contentKind[item.sourceType], content: {}, media: {}, sourceHints: {},
    },
    claims: [{ claimId: 'claim-1', claim: 'Claim', attributedTo: null, evidenceRefs: ['evidence-1'] }],
    verifiedFacts: [], unresolvedClaims: [],
    evidence: [{
      evidenceId: 'evidence-1', title: 'Evidence', url: 'https://example.com/evidence',
      sourceType: null, observedAt: NOW, note: null,
    }],
    entityHints: [{
      name: 'Entity', type: 'topic', role: 'subject', aliases: [], source: null,
      claimRefs: ['claim-1'], evidenceRefs: ['evidence-1'],
    }],
    limitations: [], openQuestions: [], completion,
    budgetUsed: {
      providerCalls: 1, repairCalls: 0, inputTokens: 1, outputTokens: 1,
      toolCalls: 0, wallTimeMs: 1, budgetExceeded: false,
    },
    execution: {
      provider: 'test', model: 'test', fallbackProvider: null, fallbackModel: null,
      fallbackUsed: false, promptVersion: 'prompt-v1', policyVersion: 'policy-v1',
      traceId: item.traceId, attempt: 0,
    },
    researchContractVersion: 'myboon.research_packet.v1', createdAt: NOW,
  }
}

class FakePort implements EntityPacketWorkPort {
  readonly calls = { peek: 0, claim: 0, read: 0, heartbeat: 0, transition: 0, release: 0 }
  readonly transitions: LeasedTransitionCommand[] = []
  readonly releases: ReleaseLeaseCommand[] = []
  claimAccepted = true
  heartbeatAccepted = true
  transitionAccepted = true
  peekError: unknown = null
  packetOverride: unknown | undefined
  afterPeek?: () => void

  constructor(readonly sourceType: EntityWorkerSourceType, readonly items: ResearchWorkItem[]) {}

  async peekSchedulable(_query: SchedulerQuery): Promise<ResearchWorkItem[]> {
    this.calls.peek += 1
    if (this.peekError) throw this.peekError
    this.afterPeek?.()
    return this.items
  }
  async claimWithLease(command: LeaseCommand): Promise<WorkLease | null> {
    this.calls.claim += 1
    if (!this.claimAccepted) return null
    const item = this.items.find((candidate) => candidate.workId === command.workId)!
    return {
      work: { ...item, status: 'entity_leased', updatedAt: command.now },
      leaseOwner: command.leaseOwner,
      leaseId: command.leaseId,
      leaseExpiresAt: command.leaseExpiresAt,
      queuedAt: item.updatedAt,
    }
  }
  async heartbeatLease(_command: HeartbeatCommand): Promise<boolean> {
    this.calls.heartbeat += 1
    return this.heartbeatAccepted
  }
  async transitionLeased(command: LeasedTransitionCommand): Promise<boolean> {
    this.calls.transition += 1
    this.transitions.push(command)
    return this.transitionAccepted
  }
  async releaseLease(command: ReleaseLeaseCommand): Promise<boolean> {
    this.calls.release += 1
    this.releases.push(command)
    return this.transitionAccepted
  }
  async readResearchPacket(workId: string): Promise<unknown | null> {
    this.calls.read += 1
    if (this.packetOverride !== undefined) return this.packetOverride
    const item = this.items.find((candidate) => candidate.workId === workId)
    return item ? packet(item) : null
  }
}

function fixture(input: {
  ports: FakePort[]
  ownership?: Partial<Record<EntityWorkerSourceType, 'legacy' | 'shared'>>
  shadowSources?: EntityWorkerSourceType[]
  sampleBasisPoints?: number
  processor?: CanonicalPacketProcessor
  scheduler?: HeartbeatScheduler
  maxShadow?: number
  executionLedger?: { append(event: ExecutionTraceEvent): ExecutionEventAppendResult }
  now?: () => Date
  claimsEnabled?: () => boolean
}) {
  const observations: ShadowEntityObservation[] = []
  let processed = 0
  const processor = input.processor ?? { async process() { processed += 1 } }
  const worker = new SharedEntityWorker({
    config: sharedEntityWorkerConfig({
      ownership: input.ownership,
      shadowSources: input.shadowSources,
      shadowSampleBasisPoints: input.sampleBasisPoints,
    }),
    ports: input.ports,
    processor,
    shadowObservations: { async observe(observation) { observations.push(observation) } },
    workerId: 'worker-1',
    now: input.now ?? (() => new Date(NOW)),
    leaseId: () => 'lease-1',
    heartbeatScheduler: input.scheduler ?? { schedule: () => () => {} },
    shadowMaxObservationsPerCycle: input.maxShadow,
    executionLedger: input.executionLedger,
    claimsEnabled: input.claimsEnabled,
  })
  return { worker, observations, processed: () => processed }
}

class FakeExecutionLedger {
  readonly events = new Map<string, ExecutionTraceEvent>()
  appendCalls = 0
  conflictIds = new Set<string>()

  append(input: ExecutionTraceEvent): ExecutionEventAppendResult {
    this.appendCalls += 1
    const event = validateExecutionTraceEvent(input)
    if (this.conflictIds.has(event.eventId)) throw new ExecutionEventConflictError(event.eventId)
    const existing = this.events.get(event.eventId)
    if (existing) {
      if (JSON.stringify(existing) !== JSON.stringify(event)) throw new ExecutionEventConflictError(event.eventId)
      return { inserted: false, event }
    }
    this.events.set(event.eventId, event)
    return { inserted: true, event }
  }
}

test('shadow cycle is bounded and performs no claims, transitions, processing, or writes', async () => {
  const port = new FakePort('news', [work('news', '1'), work('news', '2'), work('news', '3')])
  const ledger = new FakeExecutionLedger()
  const f = fixture({
    ports: [port], shadowSources: ['news'], sampleBasisPoints: 10_000, maxShadow: 2,
    executionLedger: ledger,
  })

  const result = await f.worker.runShadowCycle()
  assert.deepEqual(result, { inspected: 2, sampled: 2, accepted: 2, rejected: 0 })
  assert.equal(port.calls.peek, 1)
  assert.equal(port.calls.read, 2)
  assert.equal(port.calls.claim, 0)
  assert.equal(port.calls.heartbeat, 0)
  assert.equal(port.calls.transition, 0)
  assert.equal(port.calls.release, 0)
  assert.equal(f.processed(), 0)
  assert.equal(f.observations.length, 2)
  assert.equal(ledger.events.size, 0)
  assert.equal(f.observations.every((item) => item.executionEvent?.status === 'skipped'), true)
  assert.equal(f.observations.every((item) => item.executionEvent?.stage === 'entity_manager'), true)
})

test('sampling is deterministic and respects zero/full basis-point boundaries', () => {
  const sample = __sharedEntityWorkerTesting.sampled('work-1', 'news', 4321)
  assert.equal(__sharedEntityWorkerTesting.sampled('work-1', 'news', 4321), sample)
  assert.equal(__sharedEntityWorkerTesting.sampled('work-1', 'news', 0), false)
  assert.equal(__sharedEntityWorkerTesting.sampled('work-1', 'news', 10_000), true)
})

test('active cycle claims only sources owned by shared worker', async () => {
  const news = new FakePort('news', [work('news')])
  const polymarket = new FakePort('polymarket', [work('polymarket')])
  const f = fixture({ ports: [news, polymarket], ownership: { news: 'shared', polymarket: 'legacy' } })

  const result = await f.worker.runActiveCycle()
  assert.equal(result.completed, 1)
  assert.equal(news.calls.claim, 1)
  assert.equal(polymarket.calls.peek, 0)
  assert.equal(polymarket.calls.claim, 0)
})

test('active claim gate is rechecked after peek so a mid-cycle drain prevents the CAS claim', async () => {
  let enabled = true
  const port = new FakePort('news', [work('news')])
  port.afterPeek = () => { enabled = false }
  const f = fixture({
    ports: [port],
    ownership: { news: 'shared' },
    claimsEnabled: () => enabled,
  })

  const result = await f.worker.runActiveCycle()
  assert.equal(port.calls.peek, 1)
  assert.equal(port.calls.claim, 0)
  assert.equal(result.claimed, 0)
  assert.equal(f.processed(), 0)
})

test('a throwing active claim gate fails closed before peeking', async () => {
  const port = new FakePort('news', [work('news')])
  const f = fixture({
    ports: [port],
    ownership: { news: 'shared' },
    claimsEnabled() { throw new Error('malformed durable runtime control') },
  })

  const result = await f.worker.runActiveCycle()
  assert.equal(port.calls.peek, 0)
  assert.equal(port.calls.claim, 0)
  assert.equal(result.claimed, 0)
})

test('successful processing appends immutable entity and memory execution events', async () => {
  const ledger = new FakeExecutionLedger()
  const queued = work('news')
  queued.updatedAt = '2026-08-26T11:59:00.000Z'
  const port = new FakePort('news', [queued])
  const result = await fixture({
    ports: [port], ownership: { news: 'shared' }, executionLedger: ledger,
  }).worker.runActiveCycle()

  assert.equal(result.completed, 1)
  assert.equal(ledger.events.size, 2)
  const events = [...ledger.events.values()].sort((left, right) => left.stage.localeCompare(right.stage))
  assert.deepEqual(events.map((event) => event.stage), ['entity_manager', 'memory_write'])
  for (const event of events) {
    assert.equal(event.status, 'succeeded')
    assert.equal(event.signalId, 'news-signal-1')
    assert.equal(event.workId, 'news-work-1')
    assert.equal(event.packetId, 'news-work-1-packet')
    assert.equal(event.attempt, 1)
    assert.equal(event.provider, null)
    assert.equal(event.model, null)
    assert.equal(event.promptVersion, 'prompt-v1')
    assert.equal(event.policyVersion, 'policy-v1')
    assert.equal(event.researchContractVersion, 'myboon.research_packet.v1')
    assert.equal(event.providerCalls, 0)
    assert.equal(event.repairCalls, 0)
    assert.equal(event.inputTokens, 0)
    assert.equal(event.outputTokens, 0)
    assert.equal(event.toolCalls, 0)
    assert.equal(event.budgetExceeded, false)
    assert.equal(event.queueWaitMs >= 0, true)
    assert.equal(event.wallTimeMs >= 0, true)
    assert.equal(Object.isFrozen(event), true)
    assert.equal(validateExecutionTraceEvent(event), event)
  }
  assert.equal(events.find((event) => event.stage === 'entity_manager')?.queueWaitMs, 60_000)
  assert.equal(events.find((event) => event.stage === 'memory_write')?.queueWaitMs, 0)
})

test('execution event appends are replay-idempotent and conflicts cannot corrupt queue outcome', async () => {
  const ledger = new FakeExecutionLedger()
  const port = new FakePort('news', [work('news')])
  const first = fixture({ ports: [port], ownership: { news: 'shared' }, executionLedger: ledger })
  assert.equal((await first.worker.runActiveCycle()).completed, 1)
  const firstIds = [...ledger.events.keys()].sort()

  const replay = fixture({ ports: [port], ownership: { news: 'shared' }, executionLedger: ledger })
  assert.equal((await replay.worker.runActiveCycle()).completed, 1)
  assert.deepEqual([...ledger.events.keys()].sort(), firstIds)
  assert.equal(ledger.appendCalls, 4)

  ledger.conflictIds.add(firstIds[0])
  const conflictReplay = fixture({ ports: [port], ownership: { news: 'shared' }, executionLedger: ledger })
  assert.equal((await conflictReplay.worker.runActiveCycle()).completed, 1)
  assert.equal(port.transitions.at(-1)?.nextStatus, 'complete')
  assert.equal(ledger.events.size, 2)
})

test('ledger-disabled execution preserves the original active-cycle behavior', async () => {
  const port = new FakePort('news', [work('news')])
  const result = await fixture({ ports: [port], ownership: { news: 'shared' } }).worker.runActiveCycle()
  assert.equal(result.completed, 1)
  assert.equal(port.transitions[0].nextStatus, 'complete')
})

test('stale transition fencing is reported without claiming success', async () => {
  const port = new FakePort('news', [work('news')])
  const ledger = new FakeExecutionLedger()
  port.transitionAccepted = false
  const result = await fixture({
    ports: [port], ownership: { news: 'shared' }, executionLedger: ledger,
  }).worker.runActiveCycle()
  assert.equal(result.staleLeases, 1)
  assert.equal(result.completed, 0)
  assert.equal([...ledger.events.values()].some((event) => event.status === 'succeeded'), false)
})

test('circuit-open and provider-unavailable preflight release to entity_pending with zero attempts', async () => {
  for (const category of ['circuit_open', 'provider_unavailable'] as const) {
    const port = new FakePort('news', [work('news')])
    const ledger = new FakeExecutionLedger()
    const processor: CanonicalPacketProcessor = {
      async preflight() { throw new PlatformFailure({ category, message: category }) },
      async process() { assert.fail('processing must not start') },
    }
    const result = await fixture({
      ports: [port], ownership: { news: 'shared' }, processor, executionLedger: ledger,
    }).worker.runActiveCycle()
    assert.equal(result.released, 1)
    assert.equal(port.transitions.length, 0)
    assert.equal(port.releases[0].targetStatus, 'entity_pending')
    assert.equal(ledger.events.size, 2)
    for (const event of ledger.events.values()) {
      assert.equal(event.status, 'skipped')
      assert.equal(event.attempt, 0)
      assert.equal(event.providerCalls, 0)
      assert.equal(event.repairCalls, 0)
      assert.equal(event.inputTokens, 0)
      assert.equal(event.outputTokens, 0)
      assert.equal(event.failureCategory, category)
    }
  }
})

test('zero-call planner outage discovered during processing still releases without an attempt', async () => {
  const port = new FakePort('news', [work('news')])
  const processor: CanonicalPacketProcessor = {
    async process() {
      throw new PlatformFailure({
        category: 'provider_unavailable',
        message: 'route became unavailable before a provider call',
        retryable: true,
        incrementsAttempt: false,
      })
    },
  }

  const result = await fixture({
    ports: [port], ownership: { news: 'shared' }, processor,
  }).worker.runActiveCycle()

  assert.equal(result.released, 1)
  assert.equal(port.transitions.length, 0)
  assert.equal(port.releases[0].targetStatus, 'entity_pending')
})

test('typed retryable and permanent processing failures map to retry_wait and dead_letter', async () => {
  for (const [failure, expected] of [
    [new PlatformFailure({ category: 'storage_transient', message: 'retry' }), 'retry_wait'],
    [new PlatformFailure({ category: 'invalid_structured_output', message: 'permanent' }), 'dead_letter'],
  ] as const) {
    const port = new FakePort('news', [work('news')])
    const processor: CanonicalPacketProcessor = { async process() { throw failure } }
    await fixture({ ports: [port], ownership: { news: 'shared' }, processor }).worker.runActiveCycle()
    assert.equal(port.transitions[0].nextStatus, expected)
    assert.equal(port.transitions[0].attemptDelta, 1)
    assert.equal(port.transitions[0].failureCategory, failure.category)
  }
})

test('failure events and durable transition details redact raw provider errors and secrets', async () => {
  const secret = 'sk-live-super-secret'
  const failure = new PlatformFailure({
    category: 'provider_timeout',
    message: `upstream timeout Authorization: Bearer ${secret} prompt=<full prompt>`,
  })
  const ledger = new FakeExecutionLedger()
  const port = new FakePort('news', [work('news')])
  const processor: CanonicalPacketProcessor = { async process() { throw failure } }

  const result = await fixture({
    ports: [port], ownership: { news: 'shared' }, processor, executionLedger: ledger,
  }).worker.runActiveCycle()

  assert.equal(result.retryWait, 1)
  assert.equal(ledger.events.size, 2)
  for (const event of ledger.events.values()) {
    assert.equal(event.status, 'retry_wait')
    assert.equal(event.failureCategory, 'provider_timeout')
    assert.equal((event.failureDetail?.length ?? 0) <= 160, true)
    assert.doesNotMatch(event.failureDetail ?? '', /sk-live|Bearer|full prompt|Authorization/i)
  }
  assert.doesNotMatch(port.transitions[0].failureDetail ?? '', /sk-live|Bearer|full prompt|Authorization/i)
})

test('policy-disallowed partial packet dead-letters without invoking processor', async () => {
  const item = work('news')
  const port = new FakePort('news', [item])
  const ledger = new FakeExecutionLedger()
  port.packetOverride = packet(item, 'partial')
  const f = fixture({ ports: [port], ownership: { news: 'shared' }, executionLedger: ledger })

  const result = await f.worker.runActiveCycle()
  assert.equal(result.deadLettered, 1)
  assert.equal(f.processed(), 0)
  assert.equal(port.transitions[0].attemptDelta, 0)
  assert.equal(ledger.events.size, 2)
  assert.equal([...ledger.events.values()].every((event) => event.packetId === `${item.workId}-packet`), true)
  assert.equal([...ledger.events.values()].find((event) => event.stage === 'entity_manager')?.status, 'dead_letter')
  assert.equal([...ledger.events.values()].find((event) => event.stage === 'memory_write')?.status, 'skipped')
})

test('one source failure does not prevent another owned source from completing', async () => {
  const news = new FakePort('news', [work('news')])
  news.peekError = new PlatformFailure({ category: 'storage_transient', message: 'news unavailable' })
  const polymarket = new FakePort('polymarket', [work('polymarket')])
  const result = await fixture({
    ports: [news, polymarket], ownership: { news: 'shared', polymarket: 'shared' },
  }).worker.runActiveCycle()

  assert.equal(result.sourceErrors.news?.[0].category, 'storage_transient')
  assert.equal(result.completed, 1)
  assert.equal(polymarket.calls.claim, 1)
})

test('heartbeat lease loss aborts long processing and fences completion', async () => {
  const pulse: { current: (() => void) | null } = { current: null }
  const scheduler: HeartbeatScheduler = {
    schedule(task) { pulse.current = task; return () => { pulse.current = null } },
  }
  let finish!: () => void
  const receivedSignal: { current: AbortSignal | null } = { current: null }
  const processor: CanonicalPacketProcessor = {
    async process(input) {
      receivedSignal.current = input.signal
      await new Promise<void>((resolve) => { finish = resolve })
    },
  }
  const port = new FakePort('news', [work('news')])
  const ledger = new FakeExecutionLedger()
  port.heartbeatAccepted = false
  const f = fixture({
    ports: [port], ownership: { news: 'shared' }, processor, scheduler, executionLedger: ledger,
  })
  const cycle = f.worker.runActiveCycle()
  await new Promise((resolve) => setImmediate(resolve))
  assert.ok(pulse.current)
  pulse.current()
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(receivedSignal.current?.aborted, true)
  finish()
  const result = await cycle
  assert.equal(result.staleLeases, 1)
  assert.equal(port.calls.transition, 0)
  assert.equal(ledger.events.size, 2)
  assert.equal([...ledger.events.values()].some((event) => event.status === 'succeeded'), false)
  assert.equal([...ledger.events.values()].every((event) => event.failureCategory === 'storage_transient'), true)
})

test('stop prevents new claims, abort option signals active work, and drain awaits completion', async () => {
  let finish!: () => void
  const signal: { current: AbortSignal | null } = { current: null }
  const processor: CanonicalPacketProcessor = {
    async process(input) {
      signal.current = input.signal
      await new Promise<void>((resolve) => { finish = resolve })
    },
  }
  const port = new FakePort('news', [work('news')])
  const f = fixture({ ports: [port], ownership: { news: 'shared' }, processor })
  const cycle = f.worker.runActiveCycle()
  await new Promise((resolve) => setImmediate(resolve))
  f.worker.stop({ abortActive: true })
  assert.equal(signal.current?.aborted, true)
  const afterStop = await f.worker.runActiveCycle()
  assert.equal(afterStop.claimed, 0)

  let drained = false
  const drain = f.worker.drain().then(() => { drained = true })
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(drained, false)
  finish()
  const [cycleResult] = await Promise.all([cycle, drain])
  assert.equal(drained, true)
  assert.equal(cycleResult.released, 1)
  assert.equal(port.releases[0].targetStatus, 'entity_pending')
})
