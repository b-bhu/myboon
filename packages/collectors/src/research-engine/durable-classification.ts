import { createHash } from 'node:crypto'
import { canonicalJson } from '../signal-platform/canonical-json'
import { stableContractId } from '../signal-platform/adapters/identity'
import type { ResearchWorkItem } from '../signal-platform/contracts'
import {
  ARTICLE_ENTITY_PLACEMENT_HERMES_FALLBACK_VERSION,
  ARTICLE_ENTITY_PROPOSAL_VALIDATION_HERMES_FALLBACK_VERSION,
  ARTICLE_NOVELTY_HERMES_FALLBACK_VERSION,
  ARTICLE_RELATED_MEMBERSHIP_HERMES_FALLBACK_VERSION,
  ARTICLE_STORY_RELATIONSHIP_HERMES_FALLBACK_VERSION,
  approvedClassificationDefinitions, type ClassificationGateway, type ClassificationResult,
} from '../inference-gateway'
import { InferenceGatewayError } from '../inference-gateway/errors'
import {
  claimReservation, recordDispatchIntent, recordUnknownOutcome, settleReservation,
  type D2AssignmentLimitsSnapshot, type D2Usage,
} from './assignment-budget'
import { researchRootAssignmentId, ResearchFollowupHold } from './bounded-followup'
import type { ResearchV4StorePort } from './v4-store'

/** Every classified paid dispatch holds a durable reservation: one call, or three for Hermes fallback versions (Jev, one Jev billing retry, Hermes fallback). */
// Decision versions that only exist in the Hermes fallback definition registry.
const ARTICLE_HERMES_FALLBACK_VERSIONS = new Set<string>([
  ARTICLE_ENTITY_PLACEMENT_HERMES_FALLBACK_VERSION,
  ARTICLE_ENTITY_PROPOSAL_VALIDATION_HERMES_FALLBACK_VERSION,
  ARTICLE_RELATED_MEMBERSHIP_HERMES_FALLBACK_VERSION,
  ARTICLE_STORY_RELATIONSHIP_HERMES_FALLBACK_VERSION,
  ARTICLE_NOVELTY_HERMES_FALLBACK_VERSION,
])
export function durableResearchClassification(input: {
  gateway: Pick<ClassificationGateway, 'classify' | 'recordPolicyOutcome'> & {
    /** Optional on test/dumb ports; the real gateway exposes paid-call preflight. */
    preflight?: (request: Parameters<ClassificationGateway['classify']>[0]) => void
  }
  store: ResearchV4StorePort
  work: ResearchWorkItem
  assignmentPolicy: D2AssignmentLimitsSnapshot
  stillOwnsLease?(): Promise<boolean>
  now(): string
}): Pick<ClassificationGateway, 'classify' | 'recordPolicyOutcome'> {
  const port: Pick<ClassificationGateway, 'classify' | 'recordPolicyOutcome'> = {
    recordPolicyOutcome: (outcome) => input.gateway.recordPolicyOutcome(outcome),
    async classify<Value>(request: Parameters<ClassificationGateway['classify']>[0]) {
      // Local validation must happen before a reservation or dispatch intent.
      // Otherwise a caller-owned malformed state is indistinguishable from a
      // provider timeout and leaves an unjustified paid-outcome hold.
      input.gateway.preflight?.(request)
      // Flag-gated Hermes fallback versions are defined only in the fallback
      // registry, while retired base versions must keep resolving without it.
      // Match by workload AND decisionVersion so a base version never resolves
      // to the fallback definition's budget and route.
      const fallbackDefinitions = ARTICLE_HERMES_FALLBACK_VERSIONS.has(request.decisionVersion)
        ? approvedClassificationDefinitions(undefined, { articleHermesFallback: true })
          .filter((item) => item.workload === request.workload
            && item.decisionVersion === request.decisionVersion)
        : []
      const definition = (fallbackDefinitions.length > 0 ? fallbackDefinitions : approvedClassificationDefinitions()
        .filter((item) => item.workload === request.workload && item.decisionVersion === request.decisionVersion))[0]
      if (!definition) throw new ResearchFollowupHold('Research classification workload has no approved budget definition.')
      const rootAssignmentId = researchRootAssignmentId(input.work)
      const allowanceId = stableContractId('research_classification', request.workload, request.trace.stableDecisionKey)
      const attemptId = stableContractId('research_classification_attempt', rootAssignmentId, allowanceId)
      const key = { rootAssignmentId, allowanceId, attemptId }
      const requestDigest = createHash('sha256').update(canonicalJson({
        workload: request.workload, decisionVersion: request.decisionVersion, state: request.state,
      })).digest('hex')
      const store = input.store.researchBudgetStore()
      // Fallback versions allow Jev, one Jev billing (HTTP 402) retry inside
      // the same dispatch, and one Hermes fallback; every other version keeps
      // the strict one-call exposure.
      const hermesFallback = ARTICLE_HERMES_FALLBACK_VERSIONS.has(request.decisionVersion)
      const reservation = await claimReservation(store, {
        ...key, requestDigest, providerRoute: `classification:${request.workload}:${request.decisionVersion}`,
        // Registry policy supplies approved classifier token ceilings. Cost is
        // explicitly unknown because the classifier has no measured-cost port.
        approvedLimits: { maxProviderCalls: hermesFallback ? 3 : 1, maxInputTokens: definition.budget.maxInputTokens,
          maxOutputTokens: definition.budget.maxOutputTokens, maxIncrementalCostUsdMicros: null },
        assignmentLimits: input.assignmentPolicy,
        nowMs: Date.parse(input.now()),
      })
      if (!reservation.ok) throw new ResearchFollowupHold(`Classification allowance refused: ${reservation.code}.`)
      const saved = input.store.getResearchV4Record<ClassificationResult<Value>>(
        'classification_result', input.work.workId, attemptId,
      )
      const record = reservation.record
      const rejected = input.store.getResearchV4Record<{
        key: typeof key, requestDigest: string, status: string,
        usage?: D2Usage,
      }>('rejected_response', input.work.workId, attemptId)
      if (rejected && rejected.status === 'received_response_rejected'
        && rejected.requestDigest === requestDigest
        && canonicalJson(rejected.key) === canonicalJson(key)) {
        const receiptRef = `rejected_response:${input.work.workId}:${attemptId}`
        const receiptDigest = createHash('sha256').update(canonicalJson(rejected)).digest('hex')
        const settled = await settleReservation(store, key, {
          requestDigest, providerResultDigest: receiptDigest, savedResultRef: receiptRef,
          usage: rejected.usage ?? { status: 'unknown', costUsdMicros: null, inputTokens: null, outputTokens: null, providerCalls: 1 },
          savedResultSavedAtMs: Date.parse(input.now()),
          verification: { kind: 'durable_matching_response', savedResultRef: receiptRef, providerResultDigest: receiptDigest },
        })
        if (!settled.ok) throw new ResearchFollowupHold(`Persisted rejected classification receipt settlement refused: ${settled.code}.`)
        throw new ResearchFollowupHold('Classification response was received but rejected; the paid attempt is terminal and will not be redispatched.')
      }
      if (saved && (record.state === 'settled' || record.state === 'dispatch_intent')) {
        if (record.state === 'dispatch_intent') await settle(saved)
        return saved
      }
      if (record.state !== 'reserved_not_dispatched') {
        if (record.state === 'dispatch_intent') await recordUnknownOutcome(store, key, {
          ownedEpoch: record.ownershipEpoch, nowMs: Date.parse(input.now()),
        })
        throw new ResearchFollowupHold('Classification outcome is unresolved; no automatic replacement is allowed.')
      }
      if (input.stillOwnsLease && !await input.stillOwnsLease()) throw new ResearchFollowupHold('Research lease/source ownership lost before classification dispatch.')
      const intent = await recordDispatchIntent(store, key, {
        ownedEpoch: record.ownershipEpoch, nowMs: Date.parse(input.now()),
      })
      if (!intent.ok) throw new ResearchFollowupHold(`Classification dispatch refused: ${intent.code}.`)
      try {
        // The gateway's request contract tightens only its one-or-two-provider
        // path. Two calls give the 402-billing retry plus the Hermes fallback;
        // the reserved three-call allowance above covers both.
        const result = await input.gateway.classify<Value>({
          ...request, maxProviderCalls: hermesFallback ? 2 : 1, holdOnUnknownOutcome: true,
        })
        input.store.putResearchV4Record('classification_result', input.work.workId, attemptId, result)
        await settle(result)
        return result
      } catch (error) {
        if (hasReceivedClassificationResponse(error)) {
          const receiptRef = `rejected_response:${input.work.workId}:${attemptId}`
          const receipt = {
            key, requestDigest, status: 'received_response_rejected' as const,
            observedAt: input.now(), failureCategory: error.category,
            provider: error.provider ?? null, model: error.model ?? null,
            detail: String(error).slice(0, 400), providerResponseReceived: true,
            usage: classificationRejectedUsage(error),
          }
          const savedReceipt = input.store.getResearchV4Record<typeof receipt>('rejected_response', input.work.workId, attemptId)
            ?? input.store.putResearchV4Record('rejected_response', input.work.workId, attemptId, receipt)
          const receiptDigest = createHash('sha256').update(canonicalJson(savedReceipt)).digest('hex')
          const settled = await settleReservation(store, key, {
            requestDigest, providerResultDigest: receiptDigest, savedResultRef: receiptRef,
            usage: savedReceipt.usage,
            savedResultSavedAtMs: Date.parse(input.now()),
            verification: { kind: 'durable_matching_response', savedResultRef: receiptRef, providerResultDigest: receiptDigest },
          })
          if (!settled.ok) throw new ResearchFollowupHold(`Rejected classification response settlement refused: ${settled.code}.`)
          throw new ResearchFollowupHold(`Classification response was received but rejected: ${String(error).slice(0, 400)}.`)
        }
        await recordUnknownOutcome(store, key, { ownedEpoch: record.ownershipEpoch, nowMs: Date.parse(input.now()) })
        throw error
      }

      async function settle(result: ClassificationResult<Value>) {
        const settled = await settleReservation(store, key, {
          requestDigest, providerResultDigest: createHash('sha256').update(canonicalJson(result)).digest('hex'),
          savedResultRef: `classification_result:${input.work.workId}:${attemptId}`,
          usage: typeof result.usage.costUsdMicros === 'number' && result.usage.costUsdMicros > 0
            ? { status: 'measured', costUsdMicros: result.usage.costUsdMicros,
              inputTokens: result.usage.inputTokens, outputTokens: result.usage.outputTokens, providerCalls: 1 }
            : { status: 'unknown', costUsdMicros: null,
              inputTokens: result.usage.inputTokens, outputTokens: result.usage.outputTokens, providerCalls: 1 },
          savedResultSavedAtMs: Date.parse(input.now()), verification: { kind: 'transport_response_saved' },
        })
        if (!settled.ok) throw new ResearchFollowupHold(`Saved classification result settlement refused: ${settled.code}.`)
      }
    },
  }
  return port
}

function hasReceivedClassificationResponse(error: unknown): error is InferenceGatewayError {
  return error instanceof InferenceGatewayError && error.providerResponseReceived
}

function classificationRejectedUsage(error: InferenceGatewayError): D2Usage {
  const telemetry = error.telemetry
  const cost = telemetry?.costUsdMicros
  return telemetry && typeof cost === 'number' && cost > 0
    ? { status: 'measured', costUsdMicros: cost, inputTokens: telemetry.inputTokens,
      outputTokens: telemetry.outputTokens, providerCalls: telemetry.providerCalls }
    : { status: 'unknown', costUsdMicros: null, inputTokens: telemetry?.inputTokens ?? null,
      outputTokens: telemetry?.outputTokens ?? null, providerCalls: telemetry?.providerCalls ?? 1 }
}
