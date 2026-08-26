import { canonicalJson } from '../signal-platform/canonical-json'
import type {
  GenerateStructuredRequest,
  InferenceBudget,
  InferenceResult,
} from '../inference-gateway/types'
import { InferenceGatewayError } from '../inference-gateway/errors'
import { PlatformFailure } from '../signal-platform/failures'
import {
  CANONICAL_ENTITY_PLAN_SCHEMA_VERSION,
  type CanonicalEntityPlan,
  type CanonicalEntityPlanningInput,
  type CanonicalEntityPlanningPort,
} from './canonical-processor'

export const CANONICAL_ENTITY_PROMPT_VERSION = 'myboon.entity_planner_prompt.v1' as const
export const CANONICAL_ENTITY_WORKLOAD = 'entity.extract' as const

const MAX_PROMPT_CHARS = 160_000
const DEFAULT_ENTITY_BUDGET: InferenceBudget = Object.freeze({
  maxProviderCalls: 2,
  maxRepairCalls: 1,
  maxInputTokens: 32_000,
  maxOutputTokens: 4_000,
  maxWallTimeMs: 90_000,
  maxToolCalls: 0,
})

export interface CanonicalEntityPlanningGateway {
  resolveRoute?(workload: string, mode: 'generateStructured'): unknown
  generateStructured<T>(request: GenerateStructuredRequest<T>): Promise<InferenceResult<T>>
}

export interface GatewayCanonicalEntityPlannerOptions {
  gateway: CanonicalEntityPlanningGateway
  workload?: string
  promptVersion?: string
  budget?: InferenceBudget
}

/** Tool-less canonical Entity planner over the shared inference gateway. */
export class GatewayCanonicalEntityPlanner implements CanonicalEntityPlanningPort {
  private readonly workload: string
  private readonly promptVersion: string
  private readonly budget: InferenceBudget

  constructor(private readonly options: GatewayCanonicalEntityPlannerOptions) {
    this.workload = safeVersion(options.workload ?? CANONICAL_ENTITY_WORKLOAD, 'workload')
    this.promptVersion = safeVersion(options.promptVersion ?? CANONICAL_ENTITY_PROMPT_VERSION, 'promptVersion')
    this.budget = entityBudget(options.budget ?? DEFAULT_ENTITY_BUDGET)
  }

  async preflight(): Promise<void> {
    if (!this.options.gateway.resolveRoute) return
    try {
      this.options.gateway.resolveRoute(this.workload, 'generateStructured')
    } catch (error) {
      throw planningFailure(error)
    }
  }

  async plan(input: CanonicalEntityPlanningInput): Promise<CanonicalEntityPlan> {
    const prompt = entityPlanningPrompt(input)
    if (prompt.length > MAX_PROMPT_CHARS) {
      throw new PlatformFailure({
        category: 'budget_exceeded',
        message: 'Canonical Entity planning input exceeds the bounded prompt contract.',
        retryable: false,
      })
    }
    try {
      const result = await this.options.gateway.generateStructured<CanonicalEntityPlan>({
        workload: this.workload,
        purpose: 'entity.canonical-admission-and-memory-plan',
        prompt,
        promptVersion: this.promptVersion,
        policyVersion: input.admission.shortlistPolicyVersion,
        budget: this.budget,
        validate: validatePlanEnvelope,
      })
      return result.value
    } catch (error) {
      throw planningFailure(error)
    }
  }
}

export function entityPlanningPrompt(input: CanonicalEntityPlanningInput): string {
  return [
    'Create a canonical Entity admission decision and durable memory plan.',
    'Return only JSON matching myboon.canonical_entity_plan.v1.',
    'Select only an entityId in canonicalEntityShortlist, or use create_new.',
    'Every create_new decision and memory must cite supplied claim/evidence IDs.',
    'memoryRole is a stable semantic identifier; title and prose are presentation only.',
    'Do not use tools, browse, invent evidence, or expose internal reasoning.',
    '',
    canonicalJson({
      admission: input.admission,
      work: {
        workId: input.work.workId,
        signalId: input.work.signalId,
        sourceType: input.work.sourceType,
        priorityClass: input.work.priorityClass,
        researchDepth: input.work.researchDepth,
        freshnessDeadline: input.work.freshnessDeadline,
        policyVersion: input.work.policyVersion,
      },
      source: {
        title: input.packet.title,
        summary: input.packet.summary,
        body: input.packet.body,
        observedAt: input.packet.observedAt,
        eventAt: input.packet.eventAt ?? null,
      },
    }),
  ].join('\n')
}

function validatePlanEnvelope(value: unknown) {
  const issues: string[] = []
  if (!isRecord(value) || value.schemaVersion !== CANONICAL_ENTITY_PLAN_SCHEMA_VERSION) {
    issues.push(`schemaVersion must be ${CANONICAL_ENTITY_PLAN_SCHEMA_VERSION}`)
  }
  const decision = isRecord(value) && isRecord(value.decision) ? value.decision : null
  if (!decision || (decision.action !== 'select_existing' && decision.action !== 'create_new')) {
    issues.push('decision.action must be select_existing or create_new')
  }
  if (!isRecord(value) || !Array.isArray(value.memories) || value.memories.length === 0) {
    issues.push('memories must be a non-empty array')
  }
  return issues.length === 0
    ? { valid: true as const, value: value as unknown as CanonicalEntityPlan }
    : { valid: false as const, issues }
}

function planningFailure(error: unknown): PlatformFailure {
  if (error instanceof PlatformFailure) return error
  if (error instanceof InferenceGatewayError) {
    const noProviderCall = (error.telemetry?.providerCalls ?? 0) === 0
    return new PlatformFailure({
      category: error.category,
      message: error.message,
      retryable: error.retryable,
      retryAfterMs: error.retryAfterMs,
      incrementsAttempt: error.category === 'circuit_open'
        ? false
        : !(error.category === 'provider_unavailable' && noProviderCall),
    })
  }
  return new PlatformFailure({
    category: 'provider_unavailable',
    message: error instanceof Error ? error.message : 'Canonical Entity planning failed.',
    retryable: true,
  })
}

function entityBudget(value: InferenceBudget): InferenceBudget {
  const entries = Object.entries(value) as Array<[keyof InferenceBudget, number]>
  for (const [field, amount] of entries) {
    if (!Number.isInteger(amount) || amount < 0) throw new RangeError(`${field} must be a non-negative integer`)
  }
  if (value.maxProviderCalls < 1 || value.maxProviderCalls > 2) throw new RangeError('maxProviderCalls must be 1 or 2')
  if (value.maxRepairCalls > 1) throw new RangeError('maxRepairCalls must be at most 1')
  if (value.maxInputTokens > 32_000 || value.maxOutputTokens > 4_000 || value.maxWallTimeMs > 90_000) {
    throw new RangeError('Entity planning budget exceeds the v1 ceiling')
  }
  if (value.maxToolCalls !== 0) throw new RangeError('Entity planning must remain tool-less')
  return Object.freeze({ ...value })
}

function safeVersion(value: string, field: string): string {
  if (!value || value.length > 200 || !/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(value)) {
    throw new TypeError(`${field} must be a bounded safe identifier`)
  }
  return value
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

export const __canonicalPlannerTesting = { validatePlanEnvelope, planningFailure, DEFAULT_ENTITY_BUDGET }
