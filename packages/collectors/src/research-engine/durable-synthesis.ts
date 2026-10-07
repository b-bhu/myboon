import { createHash } from 'node:crypto'
import { canonicalJson } from '../signal-platform/canonical-json'
import { stableContractId } from '../signal-platform/adapters/identity'
import type { ResearchPacket, ResearchWorkItem } from '../signal-platform/contracts'
import { InferenceGatewayError } from '../inference-gateway'
import {
  claimReservation, recordDispatchIntent, recordUnknownOutcome, settleReservation, type D2Usage,
  type D2AssignmentLimitsSnapshot,
} from './assignment-budget'
import { researchRootAssignmentId, ResearchFollowupHold } from './bounded-followup'
import type { ResearchV4StorePort } from './v4-store'

export interface PrimarySynthesisPolicy {
  policyVersion: string
  maxInputTokens: number
  maxOutputTokens: number
  maxIncrementalCostUsdMicros: number | null
}

/** Baseline paid work is also saved and reserved before any transport dispatch. */
export async function durablePrimarySynthesis(input: {
  store: ResearchV4StorePort
  work: ResearchWorkItem
  policy: PrimarySynthesisPolicy
  assignmentPolicy: D2AssignmentLimitsSnapshot
  requestMaterial: unknown
  saved: ResearchPacket | null
  generate(work: ResearchWorkItem): Promise<ResearchPacket>
  transform(packet: ResearchPacket): ResearchPacket
  stillOwnsLease(): Promise<boolean>
  now(): string
}): Promise<ResearchPacket> {
  const { store, work, policy } = input
  const rootAssignmentId = researchRootAssignmentId(work)
  const allowanceId = 'research_primary_synthesis.v1'
  const attemptId = stableContractId('research_primary_attempt', rootAssignmentId, allowanceId)
  const key = { rootAssignmentId, allowanceId, attemptId }
  const proposedRequest = { rootAssignmentId, workId: work.workId,
    material: input.requestMaterial, policy, budget: work.budget, researchContractVersion: work.researchContractVersion }
  const savedRequest = store.getResearchV4Record<unknown>('baseline', work.workId, 'request')
    ?? store.putResearchV4Record('baseline', work.workId, 'request', proposedRequest)
  const requestDigest = digest(canonicalJson(savedRequest))
  const budget = store.researchBudgetStore()
  const claim = await claimReservation(budget, {
    ...key, requestDigest, providerRoute: 'research.synthesis:configured_gateway',
    approvedLimits: { ...policy, maxProviderCalls: work.budget.maxProviderCalls },
    assignmentLimits: input.assignmentPolicy, nowMs: Date.parse(input.now()),
  })
  if (!claim.ok) throw new ResearchFollowupHold(`Primary synthesis allowance refused: ${claim.code}.`)
  const record = claim.record
  const rejected = store.getResearchV4Record<{
    key: typeof key, requestDigest: string, status: string,
    telemetry: InferenceGatewayError['telemetry'] | null, response: ResearchPacket | null,
  }>('baseline', work.workId, 'rejected_response')
  if (rejected && rejected.status === 'received_response_rejected'
    && rejected.requestDigest === requestDigest
    && canonicalJson(rejected.key) === canonicalJson(key)) {
    const receiptRef = `baseline:${work.workId}:rejected_response`
    const receiptDigest = digest(canonicalJson(rejected))
    const settled = await settleReservation(budget, key, {
      requestDigest, providerResultDigest: receiptDigest, savedResultRef: receiptRef,
      usage: rejected.response ? usageFromPacket(rejected.response) : usageFromTelemetry(rejected.telemetry),
      savedResultSavedAtMs: Date.parse(input.now()),
      verification: { kind: 'durable_matching_response', savedResultRef: receiptRef, providerResultDigest: receiptDigest },
    })
    if (!settled.ok) throw new ResearchFollowupHold(`Persisted rejected primary receipt settlement refused: ${settled.code}.`)
    throw new ResearchFollowupHold('Primary synthesis response was received but rejected; the paid attempt is terminal and will not be redispatched.')
  }
  if (input.saved && (record.state === 'settled' || record.state === 'dispatch_intent')) {
    if (record.state !== 'settled') await settle(input.saved)
    return input.saved
  }
  if (record.state !== 'reserved_not_dispatched') {
    if (record.state === 'dispatch_intent') await recordUnknownOutcome(budget, key, {
      ownedEpoch: record.ownershipEpoch, nowMs: Date.parse(input.now()),
    })
    throw new ResearchFollowupHold('Primary paid synthesis outcome is unknown; retained work needs explicit reconciliation, not an automatic retry.')
  }
  if (!await input.stillOwnsLease()) throw new ResearchFollowupHold('Research lease lost before primary synthesis dispatch.')
  const intent = await recordDispatchIntent(budget, key, { ownedEpoch: record.ownershipEpoch, nowMs: Date.parse(input.now()) })
  if (!intent.ok) throw new ResearchFollowupHold(`Primary synthesis dispatch refused: ${intent.code}.`)
  let packet: ResearchPacket
  let generated: ResearchPacket | null = null
  try {
    generated = await input.generate({ ...work, budget: {
      ...work.budget, maxInputTokens: policy.maxInputTokens, maxOutputTokens: policy.maxOutputTokens,
      ...(policy.maxIncrementalCostUsdMicros === null ? {} : { maxCostUsdMicros: policy.maxIncrementalCostUsdMicros }),
    } })
    packet = store.putResearchV4Record('baseline', work.workId, 'packet', input.transform(generated))
  } catch (error) {
    const telemetry = error instanceof InferenceGatewayError ? error.telemetry : undefined
    // A provider response that the gateway or the code-owned contract
    // rejected is a confirmed paid attempt. Persist a compact receipt and
    // settle the reservation against that receipt so it is not misreported as
    // an execution-unknown hold or purchased again on the next worker run.
    if (generated !== null || hasReceivedProviderResponse(telemetry)) {
      const receiptRef = `baseline:${work.workId}:rejected_response`
      const receipt = {
        key, requestDigest, status: 'received_response_rejected' as const,
        observedAt: input.now(),
        failureCategory: telemetry?.failureCategory ?? (error instanceof InferenceGatewayError ? error.category : 'invalid_structured_output'),
        detail: String(error).slice(0, 400),
        telemetry: telemetry ?? null,
        response: generated,
      }
      const savedReceipt = store.getResearchV4Record<typeof receipt>('baseline', work.workId, 'rejected_response')
        ?? store.putResearchV4Record('baseline', work.workId, 'rejected_response', receipt)
      const receiptDigest = digest(canonicalJson(savedReceipt))
      const usage = generated ? usageFromPacket(generated) : usageFromTelemetry(telemetry)
      const settled = await settleReservation(budget, key, {
        requestDigest, providerResultDigest: receiptDigest, savedResultRef: receiptRef,
        usage, savedResultSavedAtMs: Date.parse(input.now()),
        verification: { kind: 'durable_matching_response', savedResultRef: receiptRef, providerResultDigest: receiptDigest },
      })
      if (!settled.ok) throw new ResearchFollowupHold(`Rejected primary response settlement refused: ${settled.code}.`)
      throw new ResearchFollowupHold(`Primary synthesis response was received but rejected: ${String(error).slice(0, 400)}.`)
    }
    await recordUnknownOutcome(budget, key, { ownedEpoch: record.ownershipEpoch, nowMs: Date.parse(input.now()) })
    if (!store.getResearchV4Record('baseline', work.workId, 'unknown_outcome')) {
      store.putResearchV4Record('baseline', work.workId, 'unknown_outcome', {
        key, requestDigest, status: 'execution_outcome_unknown', observedAt: input.now(),
        providerCalls: telemetry?.providerCalls ?? null, inputTokens: telemetry?.inputTokens ?? null,
        outputTokens: telemetry?.outputTokens ?? null, costUsdMicros: telemetry?.costUsdMicros ?? null,
        provider: telemetry?.actualProvider ?? null, model: telemetry?.actualModel ?? null,
        failureCategory: telemetry?.failureCategory ?? 'storage_or_transport_outcome_unknown',
      })
    }
    throw new ResearchFollowupHold(`Primary paid synthesis outcome unresolved: ${String(error).slice(0, 400)}.`)
  }
  await settle(packet)
  return packet

  async function settle(result: ResearchPacket): Promise<void> {
    const cost = result.budgetUsed.costUsdMicros
    const usage: D2Usage = typeof cost === 'number' && cost > 0
      ? { status: 'measured', costUsdMicros: cost, inputTokens: result.budgetUsed.inputTokens, outputTokens: result.budgetUsed.outputTokens, providerCalls: result.budgetUsed.providerCalls }
      : { status: 'unknown', costUsdMicros: null, inputTokens: result.budgetUsed.inputTokens, outputTokens: result.budgetUsed.outputTokens, providerCalls: result.budgetUsed.providerCalls }
    const settled = await settleReservation(budget, key, {
      requestDigest, providerResultDigest: digest(canonicalJson(result)), savedResultRef: `baseline:${work.workId}:packet`,
      usage, savedResultSavedAtMs: Date.parse(input.now()), verification: { kind: 'transport_response_saved' },
    })
    if (!settled.ok) throw new ResearchFollowupHold(`Primary saved result settlement refused: ${settled.code}.`)
  }
}
function digest(value: string): string { return createHash('sha256').update(value).digest('hex') }

function hasReceivedProviderResponse(telemetry: InferenceGatewayError['telemetry']): boolean {
  if (!telemetry) return false
  return telemetry.calls.some((call) => call.status === 'succeeded')
    && (telemetry.failureCategory === 'budget_exceeded' || telemetry.failureCategory === 'invalid_structured_output')
}

function usageFromTelemetry(telemetry: InferenceGatewayError['telemetry'] | null): D2Usage {
  const cost = telemetry?.costUsdMicros
  return typeof cost === 'number' && cost > 0
    ? { status: 'measured', costUsdMicros: cost, inputTokens: telemetry!.inputTokens, outputTokens: telemetry!.outputTokens, providerCalls: telemetry!.providerCalls }
    : { status: 'unknown', costUsdMicros: null, inputTokens: telemetry?.inputTokens ?? null,
      outputTokens: telemetry?.outputTokens ?? null, providerCalls: telemetry?.providerCalls ?? null }
}

function usageFromPacket(packet: ResearchPacket): D2Usage {
  const cost = packet.budgetUsed.costUsdMicros
  return typeof cost === 'number' && cost > 0
    ? { status: 'measured', costUsdMicros: cost, inputTokens: packet.budgetUsed.inputTokens,
      outputTokens: packet.budgetUsed.outputTokens, providerCalls: packet.budgetUsed.providerCalls }
    : { status: 'unknown', costUsdMicros: null, inputTokens: packet.budgetUsed.inputTokens,
      outputTokens: packet.budgetUsed.outputTokens, providerCalls: packet.budgetUsed.providerCalls }
}
