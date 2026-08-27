import type { FailureCategory } from './contracts'

const RETRYABLE_FAILURES = new Set<FailureCategory>([
  'provider_unavailable',
  'provider_rate_limited',
  'provider_timeout',
  'circuit_open',
  'retrieval_timeout',
  'storage_transient',
])

const NO_ATTEMPT_FAILURES = new Set<FailureCategory>(['circuit_open'])

export class PlatformFailure extends Error {
  readonly category: FailureCategory
  readonly retryable: boolean
  readonly incrementsAttempt: boolean
  readonly retryAfterMs: number | null

  constructor(input: {
    category: FailureCategory
    message: string
    retryable?: boolean
    incrementsAttempt?: boolean
    retryAfterMs?: number | null
  }) {
    super(input.message)
    this.name = 'PlatformFailure'
    this.category = input.category
    this.retryable = input.retryable ?? RETRYABLE_FAILURES.has(input.category)
    this.incrementsAttempt = input.incrementsAttempt ?? !NO_ATTEMPT_FAILURES.has(input.category)
    this.retryAfterMs = input.retryAfterMs ?? null
  }
}

export function isRetryableFailure(category: FailureCategory): boolean {
  return RETRYABLE_FAILURES.has(category)
}

export function failureIncrementsAttempt(category: FailureCategory): boolean {
  return !NO_ATTEMPT_FAILURES.has(category)
}

export const __failureTesting = {
  NO_ATTEMPT_FAILURES,
  RETRYABLE_FAILURES,
}
