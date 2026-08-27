import type { PriorityClass, ResearchDepth, ResearchWorkItem, WorkStatus } from './contracts'
import { assertWorkTransition } from './state-machine'

export type SchedulerStage = 'retrieval' | 'deep' | 'synthesis' | 'entity'

export interface SchedulerQuery {
  now: string
  limit: number
  stages?: SchedulerStage[]
  /** Capability filter applied by the backend before its bounded LIMIT. */
  researchDepths?: ResearchDepth[]
  priorityClasses?: PriorityClass[]
}

export interface WorkLease {
  work: ResearchWorkItem
  leaseOwner: string
  leaseId: string
  leaseExpiresAt: string
  /** Pending-state timestamp captured atomically before claim updates work.updatedAt. */
  queuedAt: string
}

export interface LeaseCommand {
  workId: string
  expectedStatus: Extract<WorkStatus, 'research_pending' | 'deep_pending' | 'synthesis_pending' | 'entity_pending'>
  leaseOwner: string
  leaseId: string
  leaseExpiresAt: string
  now: string
}

export interface HeartbeatCommand {
  workId: string
  leaseOwner: string
  leaseId: string
  leaseExpiresAt: string
  now: string
}

export interface BeginAttemptCommand {
  workId: string
  leaseOwner: string
  leaseId: string
  expectedStatus: Extract<WorkStatus, 'retrieval_leased' | 'deep_leased' | 'synthesis_leased' | 'entity_leased'>
  now: string
}

export interface LeasedTransitionCommand {
  workId: string
  leaseOwner: string
  leaseId: string
  expectedStatus: Extract<WorkStatus, 'retrieval_leased' | 'deep_leased' | 'synthesis_leased' | 'entity_leased'>
  nextStatus: WorkStatus
  now: string
  attemptDelta?: 0 | 1
  failureCategory?: ResearchWorkItem['failureCategory']
  failureDetail?: string | null
  nextAttemptAt?: string | null
}

export interface ReleaseLeaseCommand {
  workId: string
  leaseOwner: string
  leaseId: string
  expectedStatus: Extract<WorkStatus, 'retrieval_leased' | 'deep_leased' | 'synthesis_leased' | 'entity_leased'>
  targetStatus: Extract<WorkStatus, 'research_pending' | 'deep_pending' | 'synthesis_pending' | 'entity_pending'>
  now: string
}

export interface RecoveryResult {
  recoveredWorkIds: string[]
}

export interface SchedulerAggregateStatus {
  total: number
  byStatus: Partial<Record<WorkStatus, number>>
  oldestReadyAt: string | null
  oldestLeaseExpiresAt: string | null
}

/**
 * Persistence boundary used by every scheduler implementation. Mutating
 * methods are compare-and-swap operations: `false`/`null` means another
 * worker won the race or the caller presented a stale lease fence.
 *
 * Claiming never increments `attemptCount`. An attempt is spent only when a
 * provider/retrieval execution actually starts, via `beginAttempt` (or an
 * atomic leased transition with `attemptDelta: 1`). A pre-call circuit-open
 * transition therefore uses `attemptDelta: 0`.
 */
export interface ResearchWorkStoreAdapter {
  readonly sourceType: ResearchWorkItem['sourceType']
  peekSchedulable(query: SchedulerQuery): Promise<ResearchWorkItem[]>
  claimWithLease(command: LeaseCommand): Promise<WorkLease | null>
  beginAttempt(command: BeginAttemptCommand): Promise<boolean>
  heartbeatLease(command: HeartbeatCommand): Promise<boolean>
  transitionLeased(command: LeasedTransitionCommand): Promise<boolean>
  releaseLease(command: ReleaseLeaseCommand): Promise<boolean>
  recoverExpiredLeases(input: { now: string; limit: number }): Promise<RecoveryResult>
  getSchedulerStatus(input: { now: string }): Promise<SchedulerAggregateStatus>
}

const PRIORITY_RANK: Readonly<Record<ResearchWorkItem['priorityClass'], number>> = {
  P0: 0,
  P1: 1,
  P2: 2,
  P3: 3,
}

/** Global, source-agnostic ordering used before every lease claim. */
export function compareResearchWorkPriority(a: ResearchWorkItem, b: ResearchWorkItem): number {
  return PRIORITY_RANK[a.priorityClass] - PRIORITY_RANK[b.priorityClass]
    || Date.parse(a.freshnessDeadline) - Date.parse(b.freshnessDeadline)
    || b.priorityScore - a.priorityScore
    || Date.parse(a.createdAt) - Date.parse(b.createdAt)
    || a.workId.localeCompare(b.workId)
}

export function leasedStatusFor(status: LeaseCommand['expectedStatus']): WorkLease['work']['status'] {
  if (status === 'research_pending') return 'retrieval_leased'
  if (status === 'deep_pending') return 'deep_leased'
  if (status === 'synthesis_pending') return 'synthesis_leased'
  return 'entity_leased'
}

export function pendingStatusFor(status: ReleaseLeaseCommand['expectedStatus']): ReleaseLeaseCommand['targetStatus'] {
  if (status === 'retrieval_leased') return 'research_pending'
  if (status === 'deep_leased') return 'deep_pending'
  if (status === 'synthesis_leased') return 'synthesis_pending'
  return 'entity_pending'
}

export function assertLeasedTransition(command: LeasedTransitionCommand): void {
  assertWorkTransition(command.expectedStatus, command.nextStatus)
}
