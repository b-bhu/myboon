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

/** Durable, one-call Hermes identity description for a Jev no-match outcome. */
export async function durableArticleEntityProposal(input: {
  store: ResearchV4StorePort
  work: ResearchWorkItem
  assignmentPolicy: D2AssignmentLimitsSnapshot
  requestMaterial: unknown
  stillOwnsLease(): Promise<boolean>
  now(): string
  generate(): Promise<ArticleEntityProposalResult>
}): Promise<ArticleEntityProposalResult> {
  const rootAssignmentId = researchRootAssignmentId(input.work)
  const allowanceId = 'research_article_entity_proposal.v1'
  const attemptId = stableContractId('research_article_entity_proposal_attempt', rootAssignmentId, allowanceId)
  const key = { rootAssignmentId, allowanceId, attemptId }
  const savedRequest = input.store.getResearchV4Record<unknown>('article_entity_proposal', input.work.workId, 'request')
    ?? input.store.putResearchV4Record('article_entity_proposal', input.work.workId, 'request', input.requestMaterial)
  const requestDigest = digest(canonicalJson(savedRequest))
  const budget = input.store.researchBudgetStore()
  const reservation = await claimReservation(budget, {
    ...key, requestDigest, providerRoute: 'research.article_entity_proposal:configured_gateway',
    approvedLimits: { maxProviderCalls: 1, maxInputTokens: 4_000, maxOutputTokens: 500, maxIncrementalCostUsdMicros: null },
    assignmentLimits: input.assignmentPolicy, nowMs: Date.parse(input.now()),
  })
  if (!reservation.ok) throw new ResearchFollowupHold(`Article entity proposal allowance refused: ${reservation.code}.`)
  const record = reservation.record
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
  let result: ArticleEntityProposalResult
  try {
    result = await input.generate()
    result = input.store.putResearchV4Record('article_entity_proposal', input.work.workId, 'result', result)
  } catch (error) {
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
