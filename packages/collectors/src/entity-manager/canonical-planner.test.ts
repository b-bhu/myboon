import assert from 'node:assert/strict'
import test from 'node:test'
import { InferenceGatewayError } from '../inference-gateway/errors'
import type { GenerateStructuredRequest, InferenceResult, InferenceTelemetry } from '../inference-gateway/types'
import { operatorPacket, operatorWork } from '../signal-platform/operator-fixtures.test-support'
import { PlatformFailure } from '../signal-platform/failures'
import { buildEntityAdmissionInput, type CanonicalEntityRef } from './admission'
import { adaptCanonicalResearchPacket } from './canonical-packet-adapter'
import {
  CANONICAL_ENTITY_PLAN_SCHEMA_VERSION,
  type CanonicalEntityPlan,
  type CanonicalRecentMemoryContext,
} from './canonical-processor'
import {
  CANONICAL_ENTITY_PROMPT_VERSION,
  GatewayCanonicalEntityPlanner,
} from './canonical-planner'

function planningInput(
  canonicalEntityShortlist: CanonicalEntityRef[] = [],
  recentMemories: CanonicalRecentMemoryContext[] = [],
) {
  const canonicalPacket = operatorPacket('news', 'planner')
  const work = operatorWork('news', 'planner', {
    status: 'entity_leased', priorityClass: 'P1', researchDepth: 'standard',
  })
  return {
    admission: buildEntityAdmissionInput({
      packet: canonicalPacket,
      canonicalEntityShortlist,
      evidenceSpans: [{
        spanId: 'span-1', evidenceId: 'evidence-planner', claimRefs: ['claim-planner'], text: 'Evidence',
      }],
      shortlistPolicyVersion: 'myboon.entity_shortlist.v2',
      canonAvailability: { state: 'loaded' as const, complete: true as const },
    }),
    packet: adaptCanonicalResearchPacket(canonicalPacket),
    recentMemories,
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
    memory: {
      action: 'keep',
      memory: {
        memoryType: 'news_event', memoryRole: 'primary_event', title: 'Example update', summary: 'Example changed.',
        representedClaimIds: ['claim-planner'], representedEvidenceIds: ['evidence-planner'],
      },
    },
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
  assert.match(request.prompt, /exactly these top-level keys: schemaVersion, decision, memory/i)
  assert.match(request.prompt, /representedClaimIds, representedEvidenceIds/i)
  assert.match(request.prompt, /no_relevant_subject/i)
  assert.match(request.prompt, /keep, update, or drop/i)
  assert.equal('tools' in request, false)
  assert.equal('toolsets' in request, false)
})

test('planner prompt treats reviewed entity knowledge as context rather than filing authority or write output', async () => {
  let prompt = ''
  const planner = new GatewayCanonicalEntityPlanner({
    gateway: {
      async generateStructured<T>(request: GenerateStructuredRequest<T>): Promise<InferenceResult<T>> {
        prompt = request.prompt
        return { value: plan() as T, telemetry: telemetry() } as InferenceResult<T>
      },
    },
  })
  const provenance = { kind: 'reviewed_record' as const, reference: 'reviewed-jupiter-fixture-v1' }

  await planner.plan(planningInput([{
    entityId: 'entity-jupiter',
    slug: 'jupiter',
    name: 'Jupiter',
    type: 'project',
    aliases: ['Jupiter'],
    summary: 'A Solana trading protocol.',
    rank: 0,
    knowledge: {
      schemaVersion: 'myboon.entity_admission_knowledge.v1',
      entityId: 'entity-jupiter',
      kind: 'protocol',
      classifications: [{
        conceptId: 'ecosystem:solana', scheme: 'ecosystem', slug: 'solana', name: 'Solana ecosystem',
        path: ['solana'], verificationStatus: 'reviewed', provenance,
      }],
      relationships: [{
        predicate: 'operates_on', direction: 'outgoing',
        relatedEntity: { id: 'entity-solana', slug: 'solana', name: 'Solana', kind: 'network' },
        verificationStatus: 'reviewed', provenance,
      }],
    },
  }]))

  assert.match(prompt, /reviewed knowledge/i)
  assert.match(prompt, /never make a broad parent the primary subject/i)
  assert.match(prompt, /do not return or invent classification\/relationship writes/i)
  assert.match(prompt, /"kind":"protocol"/)
  assert.match(prompt, /"predicate":"operates_on"/)
})

test('planner prompt receives only the bounded recent-memory IDs it may update', async () => {
  let prompt = ''
  const planner = new GatewayCanonicalEntityPlanner({
    gateway: {
      async generateStructured<T>(request: GenerateStructuredRequest<T>): Promise<InferenceResult<T>> {
        prompt = request.prompt
        return { value: plan() as T, telemetry: telemetry() } as InferenceResult<T>
      },
    },
  })
  await planner.plan(planningInput([], [{
    id: 'memory-recent-1', entityId: 'entity-1', entitySlug: 'example', entityName: 'Example',
    memoryType: 'news_event', title: 'Earlier event', summary: 'Earlier durable fact.',
    eventAt: null, observedAt: '2026-08-26T11:00:00.000Z', sourceResearchId: 'packet-earlier',
    sourceItemId: 'article-example', sourceUrl: 'https://example.com/earlier', sourceContentHash: 'hash-example',
  }]))

  assert.match(prompt, /"recentMemories":\[/)
  assert.match(prompt, /"id":"memory-recent-1"/)
  assert.match(prompt, /update may target only an exact supplied recent memory ID/i)
})

function telemetry(): InferenceTelemetry {
  return {
    workload: 'entity.extract', purpose: 'entity.canonical-admission-and-memory-plan', mode: 'generateStructured',
    promptVersion: CANONICAL_ENTITY_PROMPT_VERSION, policyVersion: 'myboon.entity_shortlist.v2',
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
