import type { InferenceFailureCategory, InferenceProviderTarget, InferenceUsage } from './types'

export type ClassificationLifecycleMode = 'disabled' | 'shadow' | 'canary' | 'active'
export type ClassificationExecutionMode = 'authoritative' | 'shadow'

export interface ClassificationRequest {
  workload: string
  decisionVersion: string
  state: unknown
  trace: {
    stableDecisionKey: string
    correlationIds?: Readonly<Record<string, string>>
  }
  /** May only make the registry deadline smaller. */
  tighterDeadlineMs?: number
}

export type JevQuestion =
  | { type: 'choice', instructions: unknown, criteria: Readonly<Record<string, unknown>> }
  | { type: 'noul', instructions: unknown, criteria?: Readonly<{ true: unknown, false: unknown }> }
  | { type: 'score', instructions: unknown, criteria: readonly unknown[] }

export interface JevChoiceAnswer {
  type: 'choice'
  choice: string
  probabilities: Readonly<Record<string, number>>
  confidence: number
}

export interface JevNoulAnswer {
  type: 'noul'
  /** TypeSafe's native yes-probability field. */
  noul: number
}

export interface JevScoreAnswer {
  type: 'score'
  score: number
  legend: Readonly<Record<string, unknown>>
  probabilities: Readonly<Record<string, number>>
  confidence: number
}

export type JevAnswer = JevChoiceAnswer | JevNoulAnswer | JevScoreAnswer

export interface ClassificationProviderUsage extends InferenceUsage {
  costUsdMicros?: number
}

export interface JevClassificationCall {
  workload: string
  decisionVersion: string
  state: unknown
  questions: Readonly<Record<string, JevQuestion>>
  target: InferenceProviderTarget
  deadlineMs: number
  signal: AbortSignal
}

export interface JevClassificationResponse {
  actualProvider: string
  actualModel: string
  answers: Readonly<Record<string, JevAnswer>>
  usage: ClassificationProviderUsage
  durationMs: number
}

export interface HermesClassificationCall {
  workload: string
  decisionVersion: string
  prompt: string
  target: InferenceProviderTarget
  deadlineMs: number
  signal: AbortSignal
}

export interface HermesClassificationResponse {
  actualProvider: string
  actualModel: string
  value: unknown
  usage: ClassificationProviderUsage
  durationMs: number
}

export interface JevClassificationAdapter {
  classify(request: JevClassificationCall): Promise<JevClassificationResponse>
}

export interface HermesClassificationAdapter {
  classify(request: HermesClassificationCall): Promise<HermesClassificationResponse>
}

export type ClassificationStateValidation<TState> =
  | { valid: true, value: TState }
  | { valid: false, issues: readonly string[] }

export type ClassificationDecisionValidation<TDecision> =
  | { valid: true, value: TDecision }
  | { valid: false, issues: readonly string[] }

export interface ClassificationBudget {
  deadlineMs: number
  maxStateBytes: number
  maxOutputTokens: number
  maxInputTokens: number
  maxCostUsdMicros?: number
}

export interface ClassificationCapacityPolicy {
  liveConcurrency: number
  shadowConcurrency: number
  maxCalls: number
  windowMs: number
  circuitFailureThreshold: number
  circuitCooldownMs: number
  leaseMs: number
}

export interface ClassificationDefinition<TState = unknown, TDecision = unknown> {
  workload: string
  decisionVersion: string
  maximumLifecycleMode: ClassificationLifecycleMode
  defaultLifecycleMode: ClassificationLifecycleMode
  shadowPercent: number
  canaryPercent: number
  jevTarget: InferenceProviderTarget
  hermesTarget: InferenceProviderTarget
  budget: ClassificationBudget
  capacity: ClassificationCapacityPolicy
  questions(state: TState): Readonly<Record<string, JevQuestion>>
  validateState(value: unknown): ClassificationStateValidation<TState>
  decodeJev(
    answers: Readonly<Record<string, JevAnswer>>,
    state: TState,
  ): ClassificationDecisionValidation<TDecision>
  acceptJev(
    answers: Readonly<Record<string, JevAnswer>>,
    decision: TDecision,
    state: TState,
  ): { accepted: boolean, reason: string }
  renderHermes(state: TState): string
  validateHermes(value: unknown, state: TState): ClassificationDecisionValidation<TDecision>
}

export interface ClassificationRegistry {
  resolve(workload: string, decisionVersion: string): ClassificationDefinition
}

export interface ClassificationAttemptCall {
  provider: string
  model: string
  status: 'succeeded' | 'failed' | 'not_accepted'
  failureCategory: InferenceFailureCategory | null
  durationMs: number
  inputTokens: number
  outputTokens: number
  costUsdMicros: number | null
}

export interface ClassificationAttemptRecord {
  schemaVersion: 'myboon.classification_attempt.v1'
  decisionId: string
  executionMode: ClassificationExecutionMode
  workload: string
  decisionVersion: string
  stateDigest: string
  stableDecisionKey: string
  configuredPrimary: InferenceProviderTarget
  configuredFallback: InferenceProviderTarget | null
  actualProvider: string | null
  actualModel: string | null
  fallbackUsed: boolean
  fallbackReason: string | null
  status: 'succeeded' | 'failed'
  failureCategory: InferenceFailureCategory | null
  decision: unknown | null
  answers: Readonly<Record<string, JevAnswer>> | null
  calls: readonly ClassificationAttemptCall[]
  startedAt: string
  finishedAt: string
  durationMs: number
}

export interface ClassificationPolicyOutcomeRecord {
  schemaVersion: 'myboon.classification_policy_outcome.v1'
  decisionId: string
  consumer: string
  policyVersion: string
  outcome: string
  reasonCode: string
  recordedAt: string
}

export interface ClassificationAuditSink {
  recordAttempt(record: ClassificationAttemptRecord): void | Promise<void>
  recordPolicyOutcome(record: ClassificationPolicyOutcomeRecord): void | Promise<void>
}

export interface ClassificationResult<TDecision = unknown> {
  decisionId: string
  workload: string
  decisionVersion: string
  value: TDecision
  configuredPrimary: InferenceProviderTarget
  configuredFallback: InferenceProviderTarget | null
  actualProvider: string
  actualModel: string
  fallbackUsed: boolean
  fallbackReason: string | null
  answers: Readonly<Record<string, JevAnswer>> | null
  usage: ClassificationProviderUsage
  durationMs: number
}

export interface ClassificationLease {
  token: string
  release(input: { success: boolean, retryableFailure: boolean }): void
}

export interface ClassificationCapacityCoordinator {
  acquire(input: {
    workload: string
    target: InferenceProviderTarget
    mode: 'live' | 'shadow'
    policy: ClassificationCapacityPolicy
  }): ClassificationLease
}

export interface ClassificationShadowEnvelope {
  decisionId: string
  workload: string
  decisionVersion: string
  state: unknown
  stateDigest: string
  stableDecisionKey: string
  correlationIds: Readonly<Record<string, string>>
  deadlineMs: number
  createdAt: string
}

export interface ClassificationShadowOutbox {
  enqueue(value: ClassificationShadowEnvelope): void
}
