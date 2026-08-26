import type { FailureCategory, WorkStatus } from './contracts'
import { failureIncrementsAttempt, isRetryableFailure } from './failures'

const TERMINAL = new Set<WorkStatus>(['archived', 'complete', 'expired', 'dead_letter'])

const NORMAL_TRANSITIONS: Readonly<Record<WorkStatus, readonly WorkStatus[]>> = {
  signal_observed: ['triage_pending'],
  triage_pending: ['archived', 'deferred', 'research_pending'],
  archived: [],
  deferred: ['triage_pending', 'research_pending', 'expired'],
  research_pending: ['retrieval_leased', 'expired'],
  retrieval_leased: ['deep_pending', 'synthesis_pending', 'research_pending', 'retry_wait', 'expired', 'dead_letter'],
  deep_pending: ['deep_leased', 'expired'],
  deep_leased: ['research_ready', 'deep_pending', 'retry_wait', 'expired', 'dead_letter'],
  synthesis_pending: ['synthesis_leased', 'expired'],
  synthesis_leased: ['research_ready', 'synthesis_pending', 'retry_wait', 'expired', 'dead_letter'],
  research_ready: ['entity_pending'],
  entity_pending: ['entity_leased', 'expired'],
  entity_leased: ['complete', 'entity_pending', 'retry_wait', 'expired', 'dead_letter'],
  complete: [],
  retry_wait: ['research_pending', 'deep_pending', 'synthesis_pending', 'entity_pending', 'expired', 'dead_letter'],
  expired: ['triage_pending'],
  dead_letter: ['research_pending', 'deep_pending', 'synthesis_pending', 'entity_pending'],
}

export class InvalidWorkTransitionError extends Error {
  readonly code = 'INVALID_WORK_TRANSITION'

  constructor(readonly from: WorkStatus, readonly to: WorkStatus) {
    super(`Invalid research work transition ${from} -> ${to}`)
    this.name = 'InvalidWorkTransitionError'
  }
}

export interface FailureTransitionPlan {
  status: Extract<WorkStatus, 'retry_wait' | 'dead_letter'>
  failureCategory: FailureCategory
  attemptDelta: 0 | 1
  nextAttemptAt: string | null
}

export function canTransition(from: WorkStatus, to: WorkStatus): boolean {
  return NORMAL_TRANSITIONS[from].includes(to)
}

export function assertWorkTransition(from: WorkStatus, to: WorkStatus): void {
  if (!canTransition(from, to)) throw new InvalidWorkTransitionError(from, to)
}

export function planFailureTransition(input: {
  from: WorkStatus
  category: FailureCategory
  nextAttemptAt?: string | null
}): FailureTransitionPlan {
  if (TERMINAL.has(input.from)) throw new InvalidWorkTransitionError(input.from, 'retry_wait')
  const retryable = isRetryableFailure(input.category)
  const status = retryable ? 'retry_wait' : 'dead_letter'
  if (!canTransition(input.from, status)) throw new InvalidWorkTransitionError(input.from, status)
  if (retryable && input.category !== 'circuit_open' && !input.nextAttemptAt) {
    throw new Error(`Retryable failure ${input.category} requires nextAttemptAt`)
  }
  return {
    status,
    failureCategory: input.category,
    // A circuit-open decision proves no provider call began. It must never
    // spend an item attempt merely because a worker looked at the queue.
    attemptDelta: failureIncrementsAttempt(input.category) ? 1 : 0,
    nextAttemptAt: input.category === 'circuit_open'
      ? input.nextAttemptAt ?? null
      : retryable ? input.nextAttemptAt! : null,
  }
}

export const __stateMachineTesting = {
  NORMAL_TRANSITIONS,
  TERMINAL,
}
