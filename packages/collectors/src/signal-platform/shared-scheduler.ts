import { randomUUID } from 'node:crypto'

import type { PriorityClass, ResearchWorkItem } from './contracts'
import {
  compareResearchWorkPriority,
  type ResearchWorkStoreAdapter,
  type SchedulerStage,
  type WorkLease,
} from './store-adapter'

const PENDING_STATUS = {
  retrieval: 'research_pending',
  deep: 'deep_pending',
  synthesis: 'synthesis_pending',
  entity: 'entity_pending',
} as const

export interface SharedSchedulerOptions {
  /** Maximum eligible head requested from each physical store per pass. */
  perStorePeekLimit?: number
  /** Prevents an unbounded retry loop while claims are being won elsewhere. */
  maxClaimPasses?: number
  createLeaseId?: () => string
}

export interface GlobalSchedulerQuery {
  now: string
  limit: number
  stages?: SchedulerStage[]
  priorityClasses?: PriorityClass[]
}

export interface ClaimNextCommand extends Omit<GlobalSchedulerQuery, 'limit'> {
  leaseOwner: string
  leaseTtlMs: number
}

export interface SharedSchedulerStatus {
  total: number
  bySource: Record<string, Awaited<ReturnType<ResearchWorkStoreAdapter['getSchedulerStatus']>>>
  oldestReadyAt: string | null
  oldestLeaseExpiresAt: string | null
}

/**
 * Source-neutral scheduler over independently transactional stores.
 *
 * It never assumes a cross-database transaction. Each pass reads only a
 * bounded head from each registered store, orders those candidates globally,
 * and then lets the owning store arbitrate the claim with compare-and-set.
 */
export class SharedResearchScheduler {
  private readonly adapters: ReadonlyMap<ResearchWorkItem['sourceType'], ResearchWorkStoreAdapter>
  private readonly perStorePeekLimit: number
  private readonly maxClaimPasses: number
  private readonly createLeaseId: () => string

  constructor(adapters: ResearchWorkStoreAdapter[], options: SharedSchedulerOptions = {}) {
    if (adapters.length === 0) throw new Error('SharedResearchScheduler requires at least one store adapter')

    const registered = new Map<ResearchWorkItem['sourceType'], ResearchWorkStoreAdapter>()
    for (const adapter of adapters) {
      if (registered.has(adapter.sourceType)) {
        throw new Error(`Duplicate research store adapter for source ${adapter.sourceType}`)
      }
      registered.set(adapter.sourceType, adapter)
    }

    this.adapters = registered
    this.perStorePeekLimit = boundedInteger(options.perStorePeekLimit ?? 25, 'perStorePeekLimit', 1, 250)
    this.maxClaimPasses = boundedInteger(options.maxClaimPasses ?? 3, 'maxClaimPasses', 1, 20)
    this.createLeaseId = options.createLeaseId ?? (() => `lease_${randomUUID()}`)
  }

  async peekGlobal(query: GlobalSchedulerQuery): Promise<ResearchWorkItem[]> {
    const limit = boundedInteger(query.limit, 'limit', 1, 250)
    const perStoreLimit = Math.min(this.perStorePeekLimit, limit)
    const heads = await Promise.all([...this.adapters.values()].map((adapter) =>
      adapter.peekSchedulable({ now: query.now, limit: perStoreLimit, stages: query.stages }),
    ))
    const acceptedPriorities = query.priorityClasses === undefined
      ? null
      : new Set(query.priorityClasses)

    return heads
      .flat()
      .filter((work) => this.adapters.has(work.sourceType))
      .filter((work) => acceptedPriorities === null || acceptedPriorities.has(work.priorityClass))
      .sort(compareResearchWorkPriority)
      .slice(0, limit)
  }

  async claimNext(command: ClaimNextCommand): Promise<WorkLease | null> {
    if (!command.leaseOwner.trim()) throw new Error('leaseOwner must not be empty')
    if (!Number.isFinite(command.leaseTtlMs) || command.leaseTtlMs <= 0) {
      throw new Error('leaseTtlMs must be a positive number')
    }

    const attempted = new Set<string>()
    for (let pass = 0; pass < this.maxClaimPasses; pass += 1) {
      const candidates = await this.peekGlobal({
        now: command.now,
        limit: Math.min(250, this.perStorePeekLimit * this.adapters.size),
        stages: command.stages,
        priorityClasses: command.priorityClasses,
      })

      let attemptedThisPass = false
      for (const work of candidates) {
        const attemptKey = `${work.sourceType}:${work.workId}`
        if (attempted.has(attemptKey)) continue
        attempted.add(attemptKey)
        attemptedThisPass = true

        const adapter = this.adapters.get(work.sourceType)
        if (adapter === undefined) continue
        const stage = pendingStage(work)
        if (stage === null) continue

        const lease = await adapter.claimWithLease({
          workId: work.workId,
          expectedStatus: PENDING_STATUS[stage],
          leaseOwner: command.leaseOwner,
          leaseId: this.createLeaseId(),
          leaseExpiresAt: new Date(Date.parse(command.now) + command.leaseTtlMs).toISOString(),
          now: command.now,
        })
        if (lease !== null) return lease
      }

      if (!attemptedThisPass || candidates.length === 0) return null
    }
    return null
  }

  async recoverExpiredLeases(input: { now: string; limitPerStore: number }): Promise<Record<string, string[]>> {
    const limit = boundedInteger(input.limitPerStore, 'limitPerStore', 1, 1_000)
    const recovered = await Promise.all([...this.adapters.values()].map(async (adapter) => ({
      sourceType: adapter.sourceType,
      result: await adapter.recoverExpiredLeases({ now: input.now, limit }),
    })))
    return Object.fromEntries(recovered.map(({ sourceType, result }) => [sourceType, result.recoveredWorkIds]))
  }

  async getStatus(input: { now: string }): Promise<SharedSchedulerStatus> {
    const entries = await Promise.all([...this.adapters.values()].map(async (adapter) => [
      adapter.sourceType,
      await adapter.getSchedulerStatus(input),
    ] as const))
    const timestamps = (value: 'oldestReadyAt' | 'oldestLeaseExpiresAt') => entries
      .map(([, status]) => status[value])
      .filter((timestamp): timestamp is string => timestamp !== null)
      .sort((a, b) => Date.parse(a) - Date.parse(b))

    return {
      total: entries.reduce((sum, [, status]) => sum + status.total, 0),
      bySource: Object.fromEntries(entries),
      oldestReadyAt: timestamps('oldestReadyAt')[0] ?? null,
      oldestLeaseExpiresAt: timestamps('oldestLeaseExpiresAt')[0] ?? null,
    }
  }
}

function pendingStage(work: ResearchWorkItem): SchedulerStage | null {
  if (work.status === 'research_pending') return 'retrieval'
  if (work.status === 'deep_pending') return 'deep'
  if (work.status === 'synthesis_pending') return 'synthesis'
  if (work.status === 'entity_pending') return 'entity'
  return null
}

function boundedInteger(value: number, name: string, minimum: number, maximum: number): number {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`)
  }
  return value
}
