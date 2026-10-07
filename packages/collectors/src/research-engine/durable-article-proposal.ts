import { createHash } from 'node:crypto'
import { canonicalJson } from '../signal-platform/canonical-json'
import { stableContractId } from '../signal-platform/adapters/identity'
import type { ResearchWorkItem } from '../signal-platform/contracts'
import {
  claimReservation, recordDispatchIntent, recordUnknownOutcome, settleReservation,
  type D2AssignmentLimitsSnapshot, type D2Usage,
} from './assignment-budget'
import { researchRootAssignmentId, ResearchFollowupHold } from './bounded-followup'
import type { ResearchV4StorePort } from './v4-store'
import type { ArticleEntityProposalResult } from './structured-synthesizer'
import { InferenceGatewayError } from '../inference-gateway'

export interface ArticleEntityProposalGenerationBudget {
  maxInputTokens: number
  maxOutputTokens: number
}

/** The proposal call needs room for the bounded source head plus its JSON response. */
export const ARTICLE_ENTITY_PROPOSAL_LIMITS: Readonly<ArticleEntityProposalGenerationBudget> = Object.freeze({
  maxInputTokens: 16_000,
  maxOutputTokens: 2_000,
})

/** Durable, one-call Hermes identity description for a Jev no-match outcome. */
export async function durableArticleEntityProposal(input: {
  store: ResearchV4StorePort
  work: ResearchWorkItem
  assignmentPolicy: D2AssignmentLimitsSnapshot
  requestMaterial: unknown
  stillOwnsLease(): Promise<boolean>
  now(): string
  generate(budget: ArticleEntityProposalGenerationBudget): Promise<ArticleEntityProposalResult>
}): Promise<ArticleEntityProposalResult> {
  const rootAssignmentId = researchRootAssignmentId(input.work)
  const allowanceId = 'research_article_entity_proposal.v1'
  const attemptId = stableContractId('research_article_entity_proposal_attempt', rootAssignmentId, allowanceId)
  const key = { rootAssignmentId, allowanceId, attemptId }
  const savedRequest = input.store.getResearchV4Record<unknown>('article_entity_proposal', input.work.workId, 'request')
    ?? input.store.putResearchV4Record('article_entity_proposal', input.work.workId, 'request', input.requestMaterial)
  const requestDigest = digest(canonicalJson(savedRequest))
  const budget = input.store.researchBudgetStore()
  const reservationInput = {
    ...key, requestDigest, providerRoute: 'research.article_entity_proposal:configured_gateway',
    approvedLimits: { maxProviderCalls: 1, ...ARTICLE_ENTITY_PROPOSAL_LIMITS, maxIncrementalCostUsdMicros: null },
    assignmentLimits: input.assignmentPolicy, nowMs: Date.parse(input.now()),
  }
  let reservation = await claimReservation(budget, reservationInput)
  // A reservation's approved limits are immutable. Replays of an older
  // attempt must use the limits recorded on that exact attempt rather than
  // changing its identity when the current policy is widened.
  if (!reservation.ok && reservation.code === 'attempt_identity_mismatch' && reservation.record
    && reservation.record.attemptId === attemptId
    && reservation.record.requestDigest === requestDigest
    && reservation.record.providerRoute === reservationInput.providerRoute) {
    reservation = await claimReservation(budget, {
      ...reservationInput,
      approvedLimits: reservation.record.approvedLimits,
      assignmentLimits: reservation.record.assignmentLimits ?? input.assignmentPolicy,
    })
  }
  if (!reservation.ok) throw new ResearchFollowupHold(`Article entity proposal allowance refused: ${reservation.code}.`)
  const record = reservation.record
  const rejected = input.store.getResearchV4Record<{
    key: typeof key, requestDigest: string, status: string,
    telemetry: InferenceGatewayError['telemetry'] | null, response: ArticleEntityProposalResult | null,
  }>('rejected_response', input.work.workId, attemptId)
  if (rejected && rejected.status === 'received_response_rejected'
    && rejected.requestDigest === requestDigest
    && canonicalJson(rejected.key) === canonicalJson(key)) {
    const receiptRef = `rejected_response:${input.work.workId}:${attemptId}`
    const receiptDigest = digest(canonicalJson(rejected))
    const settled = await settleReservation(budget, key, {
      requestDigest, providerResultDigest: receiptDigest, savedResultRef: receiptRef,
      usage: rejected.response ? usageFromProposal(rejected.response) : usageFromTelemetry(rejected.telemetry),
      savedResultSavedAtMs: Date.parse(input.now()),
      verification: { kind: 'durable_matching_response', savedResultRef: receiptRef, providerResultDigest: receiptDigest },
    })
    if (!settled.ok) throw new ResearchFollowupHold(`Persisted rejected article proposal receipt settlement refused: ${settled.code}.`)
    throw new ResearchFollowupHold('Article entity proposal response was received but rejected; the paid attempt is terminal and will not be redispatched.')
  }
  const saved = input.store.getResearchV4Record<ArticleEntityProposalResult>('article_entity_proposal', input.work.workId, 'result')
  if (saved && (record.state === 'settled' || record.state === 'dispatch_intent')) {
    if (record.state === 'dispatch_intent') await settle(saved)
    return saved
  }
  if (record.state !== 'reserved_not_dispatched') {
    if (record.state === 'dispatch_intent') await recordUnknownOutcome(budget, key, { ownedEpoch: record.ownershipEpoch, nowMs: Date.parse(input.now()) })
    throw new ResearchFollowupHold('Article entity proposal outcome is unresolved; automatic replacement is disallowed.')
  }
  if (!await input.stillOwnsLease()) throw new ResearchFollowupHold('Research lease lost before article entity proposal dispatch.')
  const intent = await recordDispatchIntent(budget, key, { ownedEpoch: record.ownershipEpoch, nowMs: Date.parse(input.now()) })
  if (!intent.ok) throw new ResearchFollowupHold(`Article entity proposal dispatch refused: ${intent.code}.`)
  let result: ArticleEntityProposalResult | null = null
  try {
    result = await input.generate({
      maxInputTokens: record.approvedLimits.maxInputTokens,
      maxOutputTokens: record.approvedLimits.maxOutputTokens,
    })
    result = input.store.putResearchV4Record('article_entity_proposal', input.work.workId, 'result', result)
  } catch (error) {
    const telemetry = error instanceof InferenceGatewayError ? error.telemetry : undefined
    if (result !== null || hasReceivedProviderResponse(telemetry)) {
      const receiptRef = `rejected_response:${input.work.workId}:${attemptId}`
      const receipt = {
        key, requestDigest, status: 'received_response_rejected' as const,
        observedAt: input.now(), failureCategory: telemetry?.failureCategory
          ?? (error instanceof InferenceGatewayError ? error.category : 'invalid_structured_output'),
        detail: String(error).slice(0, 400), telemetry: telemetry ?? null, response: result,
      }
      const savedReceipt = input.store.getResearchV4Record<typeof receipt>('rejected_response', input.work.workId, attemptId)
        ?? input.store.putResearchV4Record('rejected_response', input.work.workId, attemptId, receipt)
      const receiptDigest = digest(canonicalJson(savedReceipt))
      const settled = await settleReservation(budget, key, {
        requestDigest, providerResultDigest: receiptDigest, savedResultRef: receiptRef,
        usage: result ? usageFromProposal(result) : usageFromTelemetry(telemetry),
        savedResultSavedAtMs: Date.parse(input.now()),
        verification: { kind: 'durable_matching_response', savedResultRef: receiptRef, providerResultDigest: receiptDigest },
      })
      if (!settled.ok) throw new ResearchFollowupHold(`Rejected article proposal settlement refused: ${settled.code}.`)
      throw new ResearchFollowupHold(`Article entity proposal response was received but rejected: ${String(error).slice(0, 400)}.`)
    }
    await recordUnknownOutcome(budget, key, { ownedEpoch: record.ownershipEpoch, nowMs: Date.parse(input.now()) })
    throw new ResearchFollowupHold(`Article entity proposal outcome unresolved: ${String(error).slice(0, 400)}.`)
  }
  await settle(result)
  return result

  async function settle(value: ArticleEntityProposalResult): Promise<void> {
    const cost = value.budgetUsed.costUsdMicros
    const usage: D2Usage = typeof cost === 'number' && cost > 0
      ? { status: 'measured', costUsdMicros: cost, inputTokens: value.budgetUsed.inputTokens, outputTokens: value.budgetUsed.outputTokens, providerCalls: value.budgetUsed.providerCalls }
      : { status: 'unknown', costUsdMicros: null, inputTokens: value.budgetUsed.inputTokens, outputTokens: value.budgetUsed.outputTokens, providerCalls: value.budgetUsed.providerCalls }
    const settled = await settleReservation(budget, key, {
      requestDigest, providerResultDigest: digest(canonicalJson(value)),
      savedResultRef: `article_entity_proposal:${input.work.workId}:result`, usage,
      savedResultSavedAtMs: Date.parse(input.now()), verification: { kind: 'transport_response_saved' },
    })
    if (!settled.ok) throw new ResearchFollowupHold(`Saved article entity proposal settlement refused: ${settled.code}.`)
  }
}

function digest(value: string): string { return createHash('sha256').update(value).digest('hex') }

function hasReceivedProviderResponse(telemetry: InferenceGatewayError['telemetry']): boolean {
  return telemetry?.calls.some((call) => call.status === 'succeeded') === true
    && (telemetry?.failureCategory === 'budget_exceeded' || telemetry?.failureCategory === 'invalid_structured_output')
}

function usageFromTelemetry(telemetry: InferenceGatewayError['telemetry'] | null): D2Usage {
  return { status: 'unknown', costUsdMicros: null, inputTokens: telemetry?.inputTokens ?? null,
    outputTokens: telemetry?.outputTokens ?? null, providerCalls: telemetry?.providerCalls ?? null }
}

function usageFromProposal(result: ArticleEntityProposalResult): D2Usage {
  const cost = result.budgetUsed.costUsdMicros
  return typeof cost === 'number' && cost > 0
    ? { status: 'measured', costUsdMicros: cost, inputTokens: result.budgetUsed.inputTokens,
      outputTokens: result.budgetUsed.outputTokens, providerCalls: result.budgetUsed.providerCalls }
    : { status: 'unknown', costUsdMicros: null, inputTokens: result.budgetUsed.inputTokens,
      outputTokens: result.budgetUsed.outputTokens, providerCalls: result.budgetUsed.providerCalls }
}
