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
  type CanonicalEntityPlanningResult,
  type CanonicalEntityPlanningInput,
  type CanonicalEntityPlanningPort,
  withCanonicalEntityTelemetry,
} from './canonical-processor'

export const CANONICAL_ENTITY_PROMPT_VERSION = 'myboon.entity_planner_prompt.v3' as const
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

  async plan(input: CanonicalEntityPlanningInput): Promise<CanonicalEntityPlanningResult> {
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
      return { plan: result.value, telemetry: result.telemetry }
    } catch (error) {
      throw planningFailure(error)
    }
  }
}

export function entityPlanningPrompt(input: CanonicalEntityPlanningInput): string {
  const hasReviewedKnowledge = input.admission.canonicalEntityShortlist.some((entity) => entity.knowledge !== undefined)
  return [
    'Create one canonical Entity admission decision and one explicit durable-memory decision.',
    'Return only one JSON object with exactly these top-level keys: schemaVersion, decision, memory.',
    `Set schemaVersion to ${CANONICAL_ENTITY_PLAN_SCHEMA_VERSION}.`,
    'Choose one evidence-backed primary subject, or explicitly choose no_relevant_subject.',
    'Select only an entityId in canonicalEntityShortlist, use create_new for a durable new subject, or return {"action":"no_relevant_subject","reasonCode":"<code>","reason":"<bounded explanation>"}.',
    'An Entity alias, source/publisher/venue role, broad category, lexical mention, or relationship alone is not authority to select that Entity.',
    'For select_existing, cite the exact supplied claim/evidence IDs that establish the selected Entity as the primary subject.',
    ...(hasReviewedKnowledge ? [
      'Some shortlisted entities include reviewed knowledge. Use it as structural context only.',
      'Shared classifications or relationships improve context but never make a broad parent the primary subject by themselves.',
      'Do not return or invent classification/relationship writes; this scoped contract only informs the existing Entity decision.',
    ] : []),
    'decision must be select_existing, create_new, or no_relevant_subject. no_relevant_subject reasonCode must be one of no_evidence_backed_subject, ambiguous_identity, source_only_subject, no_durable_subject.',
    'memory.action must be exactly one of keep, update, or drop. One packet cannot fan out into multiple durable memories.',
    'keep uses {"action":"keep","memory":{...}} for one new durable observation.',
    'update uses {"action":"update","subtype":"material_update|duplicate_source","existingMemoryId":"<supplied recent ID>","confidence":0.8,"reason":"...","memory":{...}}.',
    'drop uses {"action":"drop","reasonCode":"no_relevant_subject|no_material_change|duplicate_without_new_evidence|low_durable_value","reason":"..."} and never deletes an existing row.',
    'no_relevant_subject must pair with a no_relevant_subject drop. create_new cannot pair with drop or update.',
    'For news, a retained memory must be one news_event. Do not turn article sections, paragraphs, or claim chunks into separate memories.',
    'A retained memory uses: memoryType, memoryRole, representedClaimIds, representedEvidenceIds, title, and summary.',
    'The retained memory must concern the selected primary Entity and cite at least one claim ID from that Entity hint; shared article evidence alone is insufficient.',
    'Every create_new decision and retained memory must cite supplied claim/evidence IDs using the exact field names above.',
    'Use recentMemories only as bounded prior knowledge. update may target only an exact supplied recent memory ID and requires confidence >= 0.8.',
    'Use duplicate_source when another publisher covers the same underlying event without a material development; use material_update only for a real continuation.',
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
      recentMemories: input.recentMemories,
    }),
  ].join('\n')
}

function validatePlanEnvelope(value: unknown) {
  const issues: string[] = []
  if (!isRecord(value) || value.schemaVersion !== CANONICAL_ENTITY_PLAN_SCHEMA_VERSION) {
    issues.push(`schemaVersion must be ${CANONICAL_ENTITY_PLAN_SCHEMA_VERSION}`)
  }
  const decision = isRecord(value) && isRecord(value.decision) ? value.decision : null
  if (!decision || !['select_existing', 'create_new', 'no_relevant_subject'].includes(String(decision.action))) {
    issues.push('decision.action must be select_existing, create_new, or no_relevant_subject')
  }
  const memory = isRecord(value) && isRecord(value.memory) ? value.memory : null
  if (!memory || !['keep', 'update', 'drop'].includes(String(memory.action))) {
    issues.push('memory.action must be keep, update, or drop')
  }
  return issues.length === 0
    ? { valid: true as const, value: value as unknown as CanonicalEntityPlan }
    : { valid: false as const, issues }
}

function planningFailure(error: unknown): PlatformFailure {
  if (error instanceof PlatformFailure) return error
  if (error instanceof InferenceGatewayError) {
    const noProviderCall = (error.telemetry?.providerCalls ?? 0) === 0
    const failure = new PlatformFailure({
      category: error.category,
      message: error.message,
      retryable: error.retryable,
      retryAfterMs: error.retryAfterMs,
      incrementsAttempt: error.category === 'circuit_open'
        ? false
        : !(error.category === 'provider_unavailable' && noProviderCall),
    })
    return withCanonicalEntityTelemetry(failure, error.telemetry ?? null) as PlatformFailure
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
