import { createHash, randomUUID } from 'node:crypto'
import {
  EXECUTION_EVENT_SCHEMA_VERSION,
  type ExecutionEventStatus,
  type ExecutionTraceEvent,
  type ResearchPacketV1,
  type ResearchWorkItem,
} from '../signal-platform/contracts'
import type { ExecutionLedger } from '../signal-platform/execution-ledger'
import { PlatformFailure } from '../signal-platform/failures'
import type {
  HeartbeatCommand,
  LeaseCommand,
  LeasedTransitionCommand,
  ReleaseLeaseCommand,
  ResearchWorkStoreAdapter,
  SchedulerQuery,
  WorkLease,
} from '../signal-platform/store-adapter'
import { validateExecutionTraceEvent, validateResearchPacket } from '../signal-platform/validation'
import { adaptCanonicalResearchPacket } from './canonical-packet-adapter'
import type { ResearchPacket } from './types'
import type { EntityWorkerSourceType, SharedEntityWorkerConfig } from './shared-worker-config'

export interface EntityPacketWorkPort extends Pick<
  ResearchWorkStoreAdapter,
  'sourceType' | 'peekSchedulable' | 'claimWithLease' | 'heartbeatLease' | 'transitionLeased' | 'releaseLease'
> {
  readResearchPacket(workId: string): Promise<unknown | null>
}

export interface CanonicalPacketProcessorInput {
  work: ResearchWorkItem
  canonicalPacket: ResearchPacketV1
  packet: ResearchPacket
  signal: AbortSignal
}

export interface CanonicalPacketProcessor {
  /** Availability/circuit checks only. Must not perform durable processing. */
  preflight?(input: CanonicalPacketProcessorInput): Promise<void>
  /** Later composition may invoke EntityService and its Supabase write port. */
  process(input: CanonicalPacketProcessorInput): Promise<void>
}

export interface ShadowEntityObservation {
  sourceType: EntityWorkerSourceType
  workId: string
  packetId: string | null
  outcome: 'accepted' | 'rejected'
  error: PlatformFailure | null
  /** Shadow-only skipped measurement. Never appended to the durable ledger. */
  executionEvent: ExecutionTraceEvent | null
}

export interface ShadowEntityObservationPort {
  observe(observation: ShadowEntityObservation): Promise<void>
}

export interface HeartbeatScheduler {
  schedule(task: () => void, intervalMs: number): () => void
}

export interface SharedEntityWorkerOptions {
  config: SharedEntityWorkerConfig
  ports: readonly EntityPacketWorkPort[]
  processor: CanonicalPacketProcessor
  shadowObservations: ShadowEntityObservationPort
  workerId: string
  activeLimitPerSource?: number
  shadowPeekLimitPerSource?: number
  shadowMaxObservationsPerCycle?: number
  leaseTtlMs?: number
  heartbeatIntervalMs?: number
  retryBackoffMs?: (attemptCount: number, failure: PlatformFailure) => number
  now?: () => Date
  leaseId?: () => string
  heartbeatScheduler?: HeartbeatScheduler
  /** Optional durable append-only ledger; no hidden global is consulted. */
  executionLedger?: Pick<ExecutionLedger, 'append'>
}

export interface ActiveCycleResult {
  claimed: number
  completed: number
  retryWait: number
  deadLettered: number
  released: number
  staleLeases: number
  sourceErrors: Partial<Record<EntityWorkerSourceType, PlatformFailure[]>>
}

export interface ShadowCycleResult {
  inspected: number
  sampled: number
  accepted: number
  rejected: number
}

interface LeaseEventOutcome {
  entityStatus: ExecutionEventStatus
  memoryStatus: ExecutionEventStatus
  failure: PlatformFailure | null
  entityStartedAt: string
  memoryStartedAt: string | null
  processingStarted: boolean
  stableSkipped?: boolean
}

const defaultHeartbeatScheduler: HeartbeatScheduler = {
  schedule(task, intervalMs) {
    const handle = setInterval(task, intervalMs)
    handle.unref?.()
    return () => clearInterval(handle)
  },
}

export class SharedEntityWorker {
  private readonly ports: ReadonlyMap<EntityWorkerSourceType, EntityPacketWorkPort>
  private readonly active = new Set<Promise<unknown>>()
  private readonly controllers = new Set<AbortController>()
  private stopping = false

  constructor(private readonly options: SharedEntityWorkerOptions) {
    const ports = new Map<EntityWorkerSourceType, EntityPacketWorkPort>()
    for (const port of options.ports) {
      if (ports.has(port.sourceType)) throw new Error(`Duplicate entity packet work port: ${port.sourceType}`)
      ports.set(port.sourceType, port)
    }
    this.ports = ports
  }

  async runShadowCycle(): Promise<ShadowCycleResult> {
    const result: ShadowCycleResult = { inspected: 0, sampled: 0, accepted: 0, rejected: 0 }
    if (this.stopping || this.options.config.shadowSampleBasisPoints === 0) return result
    const maxObservations = bounded(this.options.shadowMaxObservationsPerCycle ?? 10, 1, 100)
    const peekLimit = bounded(this.options.shadowPeekLimitPerSource ?? 50, 1, 500)

    for (const sourceType of this.options.config.shadowSources) {
      if (this.stopping || result.sampled >= maxObservations) break
      const port = this.ports.get(sourceType)
      if (!port) continue
      let work: ResearchWorkItem[]
      try {
        work = await port.peekSchedulable(this.query(peekLimit))
      } catch (error) {
        await this.observeShadowFailure(sourceType, 'peek', error)
        result.rejected += 1
        continue
      }
      for (const item of work) {
        if (this.stopping || result.sampled >= maxObservations) break
        if (item.sourceType !== sourceType || item.status !== 'entity_pending') continue
        result.inspected += 1
        if (!sampled(item.workId, sourceType, this.options.config.shadowSampleBasisPoints)) continue
        result.sampled += 1
        const shadowStartedAt = this.now()
        let canonicalPacket: ResearchPacketV1 | null = null
        try {
          const value = await port.readResearchPacket(item.workId)
          if (value === null) throw failure('storage_transient', `Research Packet not found for ${item.workId}`, true)
          canonicalPacket = canonicalPacketOrNull(value)
          const adapted = adaptCanonicalResearchPacket(value)
          canonicalPacket ??= value as ResearchPacketV1
          validateWorkPacketLinkage(item, canonicalPacket)
          await this.options.shadowObservations.observe({
            sourceType,
            workId: item.workId,
            packetId: adapted.sourceResearchId,
            outcome: 'accepted',
            error: null,
            executionEvent: executionEvent({
              mode: 'shadow',
              work: item,
              packet: canonicalPacket,
              stage: 'entity_manager',
              status: 'skipped',
              failure: null,
              attempt: item.attemptCount,
              startedAt: shadowStartedAt,
              finishedAt: this.now(),
              queueEnteredAt: item.updatedAt,
            }),
          })
          result.accepted += 1
        } catch (error) {
          const typed = typedFailure(error)
          await this.options.shadowObservations.observe({
            sourceType,
            workId: item.workId,
            packetId: null,
            outcome: 'rejected',
            error: redactedFailure(typed),
            executionEvent: executionEvent({
              mode: 'shadow',
              work: item,
              packet: canonicalPacket,
              stage: 'entity_manager',
              status: 'skipped',
              failure: typed,
              attempt: item.attemptCount,
              startedAt: shadowStartedAt,
              finishedAt: this.now(),
              queueEnteredAt: item.updatedAt,
            }),
          })
          result.rejected += 1
        }
      }
    }
    return result
  }

  async runActiveCycle(): Promise<ActiveCycleResult> {
    const result: ActiveCycleResult = {
      claimed: 0, completed: 0, retryWait: 0, deadLettered: 0, released: 0, staleLeases: 0, sourceErrors: {},
    }
    if (this.stopping) return result
    const limit = bounded(this.options.activeLimitPerSource ?? 10, 1, 100)

    for (const [sourceType, owner] of Object.entries(this.options.config.ownership) as Array<[EntityWorkerSourceType, string]>) {
      if (this.stopping) break
      if (owner !== 'shared') continue
      const port = this.ports.get(sourceType)
      if (!port) {
        this.recordSourceError(result, sourceType, failure('storage_permanent', `Missing work port for ${sourceType}`, false))
        continue
      }
      let items: ResearchWorkItem[]
      try {
        items = await port.peekSchedulable(this.query(limit))
      } catch (error) {
        this.recordSourceError(result, sourceType, typedFailure(error))
        continue
      }
      for (const item of items) {
        if (this.stopping) break
        if (item.sourceType !== sourceType || item.status !== 'entity_pending') continue
        try {
          const outcome = await this.claimAndProcess(port, item)
          if (outcome === 'not_claimed') continue
          result.claimed += 1
          result[outcome] += 1
        } catch (error) {
          this.recordSourceError(result, sourceType, typedFailure(error))
        }
      }
    }
    return result
  }

  stop(input: { abortActive?: boolean } = {}): void {
    this.stopping = true
    if (input.abortActive) for (const controller of this.controllers) controller.abort('shared_entity_worker_stopped')
  }

  async drain(): Promise<void> {
    await Promise.allSettled([...this.active])
  }

  private async claimAndProcess(
    port: EntityPacketWorkPort,
    work: ResearchWorkItem,
  ): Promise<'not_claimed' | 'completed' | 'retryWait' | 'deadLettered' | 'released' | 'staleLeases'> {
    const now = this.now()
    const leaseId = this.options.leaseId?.() ?? randomUUID()
    const lease = await port.claimWithLease({
      workId: work.workId,
      expectedStatus: 'entity_pending',
      leaseOwner: this.options.workerId,
      leaseId,
      leaseExpiresAt: addMs(now, this.options.leaseTtlMs ?? 60_000),
      now,
    })
    if (!lease) return 'not_claimed'
    const running = this.processLease(port, lease)
    this.active.add(running)
    try {
      return await running
    } finally {
      this.active.delete(running)
    }
  }

  private async processLease(
    port: EntityPacketWorkPort,
    lease: WorkLease,
  ): Promise<'completed' | 'retryWait' | 'deadLettered' | 'released' | 'staleLeases'> {
    const controller = new AbortController()
    this.controllers.add(controller)
    let leaseLost = false
    let processingStarted = false
    let canonicalPacket: ResearchPacketV1 | null = null
    const entityStartedAt = this.now()
    let memoryStartedAt: string | null = null
    const stopHeartbeat = (this.options.heartbeatScheduler ?? defaultHeartbeatScheduler).schedule(() => {
      void port.heartbeatLease(this.heartbeatCommand(lease)).then((accepted) => {
        if (!accepted) {
          leaseLost = true
          controller.abort('entity_work_lease_lost')
        }
      }).catch(() => {
        leaseLost = true
        controller.abort('entity_work_heartbeat_failed')
      })
    }, bounded(this.options.heartbeatIntervalMs ?? 20_000, 10, 60_000))

    try {
      const rawPacket = await port.readResearchPacket(lease.work.workId)
      if (rawPacket === null) throw failure('storage_transient', `Research Packet not found for ${lease.work.workId}`, true)
      canonicalPacket = canonicalPacketOrNull(rawPacket)
      const packet = adaptCanonicalResearchPacket(rawPacket)
      canonicalPacket ??= rawPacket as ResearchPacketV1
      validateWorkPacketLinkage(lease.work, canonicalPacket)
      const input = { work: lease.work, canonicalPacket, packet, signal: controller.signal }
      await this.options.processor.preflight?.(input)
      if (leaseLost) {
        return this.finishLease('staleLeases', lease, canonicalPacket, {
          entityStatus: 'failed', memoryStatus: 'skipped', failure: leaseFailure(),
          entityStartedAt, memoryStartedAt, processingStarted,
        })
      }
      processingStarted = true
      memoryStartedAt = this.now()
      await this.options.processor.process(input)
      if (leaseLost) {
        return this.finishLease('staleLeases', lease, canonicalPacket, {
          entityStatus: 'failed', memoryStatus: 'failed', failure: leaseFailure(),
          entityStartedAt, memoryStartedAt, processingStarted,
        })
      }
      if (controller.signal.aborted) {
        const outcome = await this.releasePending(port, lease)
        return this.finishLease(outcome, lease, canonicalPacket, {
          entityStatus: outcome === 'released' ? 'skipped' : 'failed',
          memoryStatus: outcome === 'released' ? 'skipped' : 'failed',
          failure: abortedFailure(), entityStartedAt, memoryStartedAt, processingStarted,
        })
      }
      const completed = await port.transitionLeased({
        ...this.fence(lease),
        expectedStatus: 'entity_leased',
        nextStatus: 'complete',
        now: this.now(),
        attemptDelta: 1,
      })
      if (!completed) {
        return this.finishLease('staleLeases', lease, canonicalPacket, {
          entityStatus: 'failed', memoryStatus: 'failed', failure: leaseFailure(),
          entityStartedAt, memoryStartedAt, processingStarted,
        })
      }
      return this.finishLease('completed', lease, canonicalPacket, {
        entityStatus: 'succeeded', memoryStatus: 'succeeded', failure: null,
        entityStartedAt, memoryStartedAt, processingStarted,
      })
    } catch (error) {
      if (leaseLost) {
        return this.finishLease('staleLeases', lease, canonicalPacket, {
          entityStatus: 'failed', memoryStatus: processingStarted ? 'failed' : 'skipped', failure: leaseFailure(),
          entityStartedAt, memoryStartedAt, processingStarted,
        })
      }
      if (controller.signal.aborted) {
        const outcome = await this.releasePending(port, lease)
        return this.finishLease(outcome, lease, canonicalPacket, {
          entityStatus: outcome === 'released' ? 'skipped' : 'failed',
          memoryStatus: outcome === 'released' ? 'skipped' : 'failed',
          failure: abortedFailure(), entityStartedAt, memoryStartedAt, processingStarted,
        })
      }
      const typed = typedFailure(error)
      if (!processingStarted && (typed.category === 'circuit_open' || typed.category === 'provider_unavailable')) {
        const outcome = await this.releasePending(port, lease)
        return this.finishLease(outcome, lease, canonicalPacket, {
          entityStatus: outcome === 'released' ? 'skipped' : 'failed',
          memoryStatus: outcome === 'released' ? 'skipped' : 'failed',
          failure: typed, entityStartedAt, memoryStartedAt, processingStarted,
          stableSkipped: outcome === 'released',
        })
      }
      const retryable = typed.retryable
      const transitioned = await port.transitionLeased({
        ...this.fence(lease),
        expectedStatus: 'entity_leased',
        nextStatus: retryable ? 'retry_wait' : 'dead_letter',
        now: this.now(),
        attemptDelta: processingStarted && typed.incrementsAttempt ? 1 : 0,
        failureCategory: typed.category,
        failureDetail: safeFailureDetail(typed),
        nextAttemptAt: retryable ? addMs(this.now(), this.retryDelay(lease.work.attemptCount, typed)) : null,
      })
      if (!transitioned) {
        return this.finishLease('staleLeases', lease, canonicalPacket, {
          entityStatus: 'failed', memoryStatus: processingStarted ? 'failed' : 'skipped', failure: leaseFailure(),
          entityStartedAt, memoryStartedAt, processingStarted,
        })
      }
      const outcome = retryable ? 'retryWait' : 'deadLettered'
      return this.finishLease(outcome, lease, canonicalPacket, {
        entityStatus: retryable ? 'retry_wait' : 'dead_letter',
        memoryStatus: processingStarted ? (retryable ? 'retry_wait' : 'dead_letter') : 'skipped',
        failure: typed, entityStartedAt, memoryStartedAt, processingStarted,
      })
    } finally {
      stopHeartbeat()
      this.controllers.delete(controller)
    }
  }

  private finishLease(
    outcome: 'completed' | 'retryWait' | 'deadLettered' | 'released' | 'staleLeases',
    lease: WorkLease,
    packet: ResearchPacketV1 | null,
    input: LeaseEventOutcome,
  ): typeof outcome {
    if (!this.options.executionLedger) return outcome
    const work = lease.work
    const finishedAt = input.stableSkipped ? work.createdAt : this.now()
    const entityStartedAt = input.stableSkipped ? work.createdAt : input.entityStartedAt
    const memoryStartedAt = input.stableSkipped ? work.createdAt : (input.memoryStartedAt ?? input.entityStartedAt)
    const attempt = work.attemptCount + (input.processingStarted ? 1 : 0)
    for (const [stage, status, startedAt] of [
      ['entity_manager', input.entityStatus, entityStartedAt],
      ['memory_write', input.memoryStatus, memoryStartedAt],
    ] as const) {
      const event = executionEvent({
        mode: 'active', work, packet, stage, status, failure: input.failure,
        attempt, startedAt, finishedAt, queueEnteredAt: lease.queuedAt,
      })
      try {
        this.options.executionLedger.append(event)
      } catch {
        // Instrumentation cannot undo a fenced queue transition or durable
        // Entity write. Immutable append conflicts remain contained here.
      }
    }
    return outcome
  }

  private query(limit: number): SchedulerQuery {
    return { now: this.now(), limit, stages: ['entity'] }
  }

  private heartbeatCommand(lease: WorkLease): HeartbeatCommand {
    const now = this.now()
    return { ...this.fence(lease), now, leaseExpiresAt: addMs(now, this.options.leaseTtlMs ?? 60_000) }
  }

  private fence(lease: WorkLease): Pick<LeaseCommand, 'workId' | 'leaseOwner' | 'leaseId'> {
    return { workId: lease.work.workId, leaseOwner: lease.leaseOwner, leaseId: lease.leaseId }
  }

  private retryDelay(attemptCount: number, error: PlatformFailure): number {
    return error.retryAfterMs ?? this.options.retryBackoffMs?.(attemptCount, error) ?? Math.min(300_000, 1_000 * 2 ** attemptCount)
  }

  private async releasePending(
    port: EntityPacketWorkPort,
    lease: WorkLease,
  ): Promise<'released' | 'staleLeases'> {
    const released = await port.releaseLease({
      ...this.fence(lease),
      expectedStatus: 'entity_leased',
      targetStatus: 'entity_pending',
      now: this.now(),
    })
    return released ? 'released' : 'staleLeases'
  }

  private now(): string {
    return (this.options.now?.() ?? new Date()).toISOString()
  }

  private recordSourceError(result: ActiveCycleResult, source: EntityWorkerSourceType, error: PlatformFailure): void {
    ;(result.sourceErrors[source] ??= []).push(error)
  }

  private async observeShadowFailure(source: EntityWorkerSourceType, workId: string, error: unknown): Promise<void> {
    const typed = typedFailure(error)
    await this.options.shadowObservations.observe({
      sourceType: source,
      workId,
      packetId: null,
      outcome: 'rejected',
      error: redactedFailure(typed),
      executionEvent: null,
    })
  }
}

interface ExecutionEventInput {
  mode: 'active' | 'shadow'
  work: ResearchWorkItem
  packet: ResearchPacketV1 | null
  stage: 'entity_manager' | 'memory_write'
  status: ExecutionEventStatus
  failure: PlatformFailure | null
  attempt: number
  startedAt: string
  finishedAt: string
  queueEnteredAt: string
}

function executionEvent(input: ExecutionEventInput): ExecutionTraceEvent {
  const execution = input.packet?.execution
  const event = validateExecutionTraceEvent({
    schemaVersion: EXECUTION_EVENT_SCHEMA_VERSION,
    eventId: executionEventId(input),
    traceId: execution?.traceId ?? input.work.traceId,
    signalId: input.work.signalId,
    workId: input.work.workId,
    packetId: input.packet?.packetId ?? null,
    sourceType: input.work.sourceType,
    stage: input.stage,
    attempt: input.attempt,
    startedAt: input.startedAt,
    finishedAt: input.finishedAt,
    status: input.status,
    failureCategory: input.failure?.category ?? null,
    failureDetail: safeFailureDetail(input.failure),
    queueWaitMs: input.stage === 'entity_manager' ? elapsedMs(input.queueEnteredAt, input.startedAt) : 0,
    wallTimeMs: elapsedMs(input.startedAt, input.finishedAt),
    // CanonicalPacketProcessor currently returns no stage-local inference
    // telemetry. Research Packet provider/model/budget describe the upstream
    // research stage and must not be charged again to Entity stages.
    provider: null,
    model: null,
    fallbackProvider: null,
    fallbackModel: null,
    fallbackUsed: false,
    promptVersion: execution?.promptVersion ?? null,
    policyVersion: execution?.policyVersion ?? input.work.policyVersion,
    researchContractVersion: input.packet?.researchContractVersion ?? input.work.researchContractVersion,
    providerCalls: 0,
    repairCalls: 0,
    inputTokens: 0,
    outputTokens: 0,
    toolCalls: 0,
    budgetExceeded: false,
    createdAt: input.finishedAt,
  })
  return Object.freeze(event)
}

function executionEventId(input: Pick<ExecutionEventInput, 'mode' | 'work' | 'packet' | 'stage' | 'attempt'>): string {
  const canonical = [
    EXECUTION_EVENT_SCHEMA_VERSION,
    'shared_entity_worker',
    input.mode,
    input.work.workId,
    input.packet?.packetId ?? '',
    input.stage,
    String(input.attempt),
  ].join('\u001f')
  return `entity-execution:${createHash('sha256').update(canonical, 'utf8').digest('hex')}`
}

function safeFailureDetail(failureValue: PlatformFailure | null): string | null {
  if (!failureValue) return null
  const labels: Record<PlatformFailure['category'], string> = {
    provider_unavailable: 'provider unavailable; details redacted',
    provider_rate_limited: 'provider rate limited; details redacted',
    provider_timeout: 'provider timeout; details redacted',
    provider_authentication: 'provider authentication failed; details redacted',
    circuit_open: 'provider circuit open; details redacted',
    retrieval_timeout: 'retrieval timeout; details redacted',
    retrieval_blocked: 'retrieval blocked; details redacted',
    retrieval_unsafe_url: 'retrieval URL rejected; details redacted',
    budget_exceeded: 'execution budget exceeded; details redacted',
    invalid_structured_output: 'structured output rejected; details redacted',
    schema_version_mismatch: 'schema version mismatch; details redacted',
    permanent_source_error: 'permanent source error; details redacted',
    entity_resolution_failed: 'entity resolution failed; details redacted',
    storage_transient: 'transient storage failure; details redacted',
    storage_permanent: 'permanent storage failure; details redacted',
  }
  return labels[failureValue.category].slice(0, 160)
}

function redactedFailure(value: PlatformFailure): PlatformFailure {
  return new PlatformFailure({
    category: value.category,
    message: safeFailureDetail(value) ?? 'execution failure; details redacted',
    retryable: value.retryable,
    incrementsAttempt: value.incrementsAttempt,
    retryAfterMs: value.retryAfterMs,
  })
}

function elapsedMs(start: string, finish: string): number {
  const elapsed = Date.parse(finish) - Date.parse(start)
  return Number.isFinite(elapsed) ? Math.max(0, Math.round(elapsed)) : 0
}

function leaseFailure(): PlatformFailure {
  return failure('storage_transient', 'Entity work lease was lost.', true)
}

function abortedFailure(): PlatformFailure {
  return new PlatformFailure({
    category: 'provider_unavailable',
    message: 'Entity processing was aborted.',
    retryable: true,
    incrementsAttempt: false,
  })
}

function canonicalPacketOrNull(value: unknown): ResearchPacketV1 | null {
  try {
    return validateResearchPacket(value)
  } catch {
    return null
  }
}

function sampled(workId: string, source: EntityWorkerSourceType, basisPoints: number): boolean {
  const digest = createHash('sha256').update(`${source}\0${workId}`).digest()
  return digest.readUInt32BE(0) % 10_000 < basisPoints
}

function validateWorkPacketLinkage(work: ResearchWorkItem, packet: ResearchPacketV1): void {
  if (packet.workId !== work.workId || packet.signalId !== work.signalId || packet.sourceType !== work.sourceType) {
    throw failure('invalid_structured_output', `Research Packet linkage does not match work item ${work.workId}.`, false)
  }
}

function typedFailure(error: unknown): PlatformFailure {
  return error instanceof PlatformFailure
    ? error
    : failure('invalid_structured_output', error instanceof Error ? error.message : 'Unknown Entity Manager failure.', false)
}

function failure(category: PlatformFailure['category'], message: string, retryable: boolean): PlatformFailure {
  return new PlatformFailure({ category, message, retryable })
}

function addMs(iso: string, milliseconds: number): string {
  return new Date(Date.parse(iso) + milliseconds).toISOString()
}

function bounded(value: number, minimum: number, maximum: number): number {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(`Expected integer between ${minimum} and ${maximum}.`)
  }
  return value
}

export const __sharedEntityWorkerTesting = { sampled }
