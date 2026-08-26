import assert from 'node:assert/strict'
import test from 'node:test'
import { InferenceGatewayError } from '../inference-gateway/errors'
import type { GenerateStructuredRequest, InferenceResult, InferenceTelemetry } from '../inference-gateway/types'
import { operatorPacket, operatorWork } from '../signal-platform/operator-fixtures.test-support'
import { PlatformFailure } from '../signal-platform/failures'
import { buildEntityAdmissionInput } from './admission'
import { adaptCanonicalResearchPacket } from './canonical-packet-adapter'
import {
  CANONICAL_ENTITY_PLAN_SCHEMA_VERSION,
  type CanonicalEntityPlan,
} from './canonical-processor'
import {
  CANONICAL_ENTITY_PROMPT_VERSION,
  GatewayCanonicalEntityPlanner,
} from './canonical-planner'

function planningInput() {
  const canonicalPacket = operatorPacket('news', 'planner')
  const work = operatorWork('news', 'planner', {
    status: 'entity_leased', priorityClass: 'P1', researchDepth: 'standard',
  })
  return {
    admission: buildEntityAdmissionInput({
      packet: canonicalPacket,
      canonicalEntityShortlist: [],
      evidenceSpans: [{
        spanId: 'span-1', evidenceId: 'evidence-planner', claimRefs: ['claim-planner'], text: 'Evidence',
      }],
      shortlistPolicyVersion: 'myboon.entity_shortlist.v1',
      canonAvailability: { state: 'loaded' as const, complete: true as const },
    }),
    packet: adaptCanonicalResearchPacket(canonicalPacket),
    work,
    signal: new AbortController().signal,
  }
}

function plan(): CanonicalEntityPlan {
  return {
    schemaVersion: CANONICAL_ENTITY_PLAN_SCHEMA_VERSION,
    decision: {
      action: 'create_new',
      proposal: { slug: 'example', name: 'Example', type: 'organization' },
      supportingClaimIds: ['claim-planner'], supportingEvidenceIds: ['evidence-planner'],
    },
    memories: [{
      memoryType: 'news_event', memoryRole: 'primary_event', title: 'Example update', summary: 'Example changed.',
      representedClaimIds: ['claim-planner'], representedEvidenceIds: ['evidence-planner'],
    }],
  }
}

test('gateway planner sends a bounded tool-less Entity request and returns its validated envelope', async () => {
  const captured: GenerateStructuredRequest<CanonicalEntityPlan>[] = []
  const gateway = {
    resolveRoute(workload: string, mode: string) {
      assert.equal(workload, 'entity.extract')
      assert.equal(mode, 'generateStructured')
    },
    async generateStructured<T>(request: GenerateStructuredRequest<T>): Promise<InferenceResult<T>> {
      captured.push(request as unknown as GenerateStructuredRequest<CanonicalEntityPlan>)
      const value = plan()
      assert.deepEqual(request.validate(value), { valid: true, value })
      return { value: value as T, telemetry: telemetry() } as InferenceResult<T>
    },
  }
  const planner = new GatewayCanonicalEntityPlanner({ gateway })

  await planner.preflight()
  assert.deepEqual(await planner.plan(planningInput()), { plan: plan(), telemetry: telemetry() })
  const request = captured[0]
  assert.ok(request)
  assert.equal(request.promptVersion, CANONICAL_ENTITY_PROMPT_VERSION)
  assert.equal(request.budget.maxToolCalls, 0)
  assert.equal(request.budget.maxProviderCalls, 2)
  assert.match(request.prompt, /select only an entityId/i)
  assert.equal('tools' in request, false)
  assert.equal('toolsets' in request, false)
})

function telemetry(): InferenceTelemetry {
  return {
    workload: 'entity.extract', purpose: 'entity.canonical-admission-and-memory-plan', mode: 'generateStructured',
    promptVersion: CANONICAL_ENTITY_PROMPT_VERSION, policyVersion: 'myboon.entity_shortlist.v1',
    configuredPrimaryProvider: 'primary', configuredPrimaryModel: 'primary-model',
    actualProvider: 'fallback', actualModel: 'fallback-model', fallbackInvoked: true,
    fallbackReason: 'provider_timeout', schemaValid: true, providerCalls: 2, repairCalls: 0,
    inputTokens: 40, outputTokens: 20, toolCalls: 0, costUsdMicros: 17,
    configuredReasoningEffort: 'high', actualReasoningEffort: 'medium',
    durationMs: 42, budgetExceeded: false, failureCategory: null, calls: [],
  }
}

test('gateway circuit and zero-call unavailability preserve typed zero-attempt semantics', async () => {
  for (const category of ['circuit_open', 'provider_unavailable'] as const) {
    const planner = new GatewayCanonicalEntityPlanner({
      gateway: {
        async generateStructured() {
          throw new InferenceGatewayError('unavailable', {
            category, retryable: true,
            telemetry: entityFailureTelemetry(category),
          })
        },
      },
    })
    await assert.rejects(planner.plan(planningInput()), (error: unknown) => (
      error instanceof PlatformFailure
      && error.category === category
      && error.retryable
      && error.incrementsAttempt === false
      && (error as PlatformFailure & { entityTelemetry?: InferenceTelemetry }).entityTelemetry?.providerCalls === 0
    ))
  }
})

function entityFailureTelemetry(category: 'circuit_open' | 'provider_unavailable'): InferenceTelemetry {
  return {
    ...telemetry(), actualProvider: null, actualModel: null, fallbackInvoked: false,
    fallbackReason: null, schemaValid: null, providerCalls: 0, inputTokens: 0, outputTokens: 0,
    costUsdMicros: null, durationMs: 0, failureCategory: category,
  }
}

test('planner rejects tool-bearing or oversized stage budgets at construction', () => {
  const gateway = { async generateStructured() { throw new Error('not used') } }
  assert.throws(() => new GatewayCanonicalEntityPlanner({
    gateway,
    budget: {
      maxProviderCalls: 1, maxRepairCalls: 0, maxInputTokens: 100,
      maxOutputTokens: 100, maxWallTimeMs: 1_000, maxToolCalls: 1 as never,
    },
  }), /tool-less/)
})
