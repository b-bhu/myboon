import { createHash } from 'node:crypto'
import { stableContractId } from '../signal-platform/adapters/identity'
import { canonicalJson } from '../signal-platform/canonical-json'
import { isArticleResearchPacket, type ResearchPacketV1, type ResearchWorkItem, type RetrievedEvidence, type Signal } from '../signal-platform/contracts'
import {
  InferenceGatewayError, RESEARCH_FOLLOWUP_VALUE_VERSION, RESEARCH_FOLLOWUP_VALUE_WORKLOAD,
  type ClassificationGateway, type ResearchFollowupValueDecision,
} from '../inference-gateway'
import type { GateEntityContext, GateSignal } from '../research-gate/types'
import { isAllowedHostname, parseHttpUrl } from '../news/safe-public-http'
import {
  claimReservation, recordDispatchIntent, recordUnknownOutcome, settleReservation,
  type D2FollowupLimitsSnapshot, type D2Usage,
  type D2AssignmentLimitsSnapshot,
} from './assignment-budget'
import { DeterministicRetriever, type RetrievedEvidenceArtifact } from './deterministic-retrieval'
import { adaptRetrievedEvidenceArtifact } from '../signal-platform/retrieved-evidence-adapter'
import { withEvidenceReuseContext } from './evidence-reuse-policy'
import { StructuredResearchSynthesizer } from './structured-synthesizer'
import type { ResearchV4StorePort } from './v4-store'

export interface BoundedFollowupPolicy extends D2FollowupLimitsSnapshot {
  policyVersion: string
  maxSources: number
  maxTotalBytes: number
  maxBytesPerSource: number
  maxWallTimeMs: number
}

export class ResearchFollowupHold extends Error {
  constructor(readonly detail: string) { super(detail); this.name = 'ResearchFollowupHold' }
}

export interface BoundedFollowupStore extends ResearchV4StorePort {
  appendEvidence(evidence: RetrievedEvidence): unknown
  listEvidenceByWork(workId: string, limit: number): RetrievedEvidence[]
}

/** A retry/continuation never gets a fresh allowance by virtue of a new work ID. */
export function researchRootAssignmentId(work: ResearchWorkItem): string {
  const root = work.retrievalPlan.rootAssignmentId
  return typeof root === 'string' && root.trim() ? root
    : stableContractId('research_assignment', work.sourceType, work.signalId)
}

export async function runBoundedFollowup(input: {
  store: BoundedFollowupStore
  signal: Signal
  work: ResearchWorkItem
  baseline: ResearchPacketV1
  gateSignal: GateSignal
  entityContext: GateEntityContext | null
  classification: Pick<ClassificationGateway, 'classify' | 'recordPolicyOutcome'>
  policy: BoundedFollowupPolicy
  assignmentPolicy: D2AssignmentLimitsSnapshot
  retriever: DeterministicRetriever
  synthesizer: StructuredResearchSynthesizer
  stillOwnsLease(): Promise<boolean>
  now(): string
}): Promise<ResearchPacketV1> {
  const { store, work, baseline, policy } = input
  const final = store.getResearchV4Record<ResearchPacketV1>('followup_resolution', work.workId, 'final_packet')
  if (final) return final
  const baselineIds = new Set(baseline.evidence.map((ref) => ref.evidenceId))
  const baselineEvidence = store.listEvidenceByWork(work.workId, 1_000).filter((artifact) => baselineIds.has(artifact.evidenceId))
  const urls = approvedFollowupUrls(work, baselineEvidence).slice(0, policy.maxSources)
  if (urls.length === 0) {
    store.putResearchV4Record('followup_decision', work.workId, 'admission', {
      rootAssignmentId: researchRootAssignmentId(work), policyVersion: policy.policyVersion,
      admittedUrls: [], decisionSkipped: true, reason: 'No newly admitted supported public URL exists for a bounded investigation.',
      assessedAt: input.now(),
    })
    return saveFinal(store, work.workId, baseline)
  }
  let saved = store.getResearchV4Record<{ decision: ResearchFollowupValueDecision, decisionId: string | null }>(
    'followup_decision', work.workId, 'decision',
  )
  const decisionIntent = store.getResearchV4Record('followup_decision', work.workId, 'intent')
  if (!saved && decisionIntent) {
    // Classification may have run before the crash. It is not re-purchased.
    throw new ResearchFollowupHold('Follow-up value classification has an unresolved dispatched outcome; intervention required.')
  }
  if (!saved) {
    if (!await input.stillOwnsLease()) throw new ResearchFollowupHold('Research lease lost before follow-up decision dispatch.')
    store.putResearchV4Record('followup_decision', work.workId, 'intent', {
      rootAssignmentId: researchRootAssignmentId(work), policyVersion: policy.policyVersion,
      workId: work.workId, dispatchedAt: input.now(), maxProviderCalls: 1,
    })
    try {
      const contextText = canonicalJson({
        followupAdmission: { admittedUrls: urls, allowedDomains: work.retrievalPlan.allowedDomains,
          maxSources: policy.maxSources, maxTotalBytes: policy.maxTotalBytes, maxBytesPerSource: policy.maxBytesPerSource,
          maxWallTimeMs: policy.maxWallTimeMs, maxProviderCalls: policy.maxProviderCalls,
          maxInputTokens: policy.maxInputTokens, maxOutputTokens: policy.maxOutputTokens },
        assignment: work.retrievalPlan.researchReuseContract ?? null,
        baseline: { claims: baseline.claims, verifiedFacts: baseline.verifiedFacts,
          unresolvedClaims: baseline.unresolvedClaims, limitations: baseline.limitations, openQuestions: baseline.openQuestions },
        source: input.gateSignal.sourceMaterial ?? input.signal.content,
      })
      const decisionMaterial = contextText.slice(0, 12_000)
      const result = await input.classification.classify<ResearchFollowupValueDecision>({
        workload: RESEARCH_FOLLOWUP_VALUE_WORKLOAD, decisionVersion: RESEARCH_FOLLOWUP_VALUE_VERSION,
        state: {
          signal: { ...input.gateSignal, sourceMaterial: decisionMaterial,
            sourceMaterialDigest: digest(decisionMaterial), sourceMaterialComplete: contextText.length <= 12_000 },
          context: input.entityContext ?? { entities: [], recentMemories: [] },
        },
        trace: { stableDecisionKey: stableContractId('followup_value', researchRootAssignmentId(work), policy.policyVersion),
          correlationIds: { workId: work.workId, signalId: work.signalId } },
        maxProviderCalls: 1, holdOnUnknownOutcome: true,
      })
      saved = store.putResearchV4Record('followup_decision', work.workId, 'decision', {
        decision: result.value, decisionId: result.decisionId,
      })
      await input.classification.recordPolicyOutcome({
        decisionId: result.decisionId, consumer: 'shared-research-followup', policyVersion: policy.policyVersion,
        outcome: result.value.direction === 'worthwhile' ? 'proceed' : 'hold', reasonCode: result.value.direction,
      }).catch(() => undefined)
    } catch (error) {
      // Ambiguous classification is retained, never rerun. An unavailable value
      // policy cannot authorize an additional paid research investigation.
      saved = store.putResearchV4Record('followup_decision', work.workId, 'decision', {
        decision: { direction: 'uncertain' as const, reason: `Follow-up policy unavailable: ${String(error).slice(0, 300)}` },
        decisionId: null,
      })
    }
  }
  if (saved.decision.direction !== 'worthwhile') {
    return saveFinal(store, work.workId, baseline)
  }

  let additions = store.getResearchV4Record<RetrievedEvidence[]>('followup_evidence', work.workId, 'captures')
  if (!additions) {
    if (!await input.stillOwnsLease()) throw new ResearchFollowupHold('Research lease lost before bounded follow-up retrieval.')
    const batch = await input.retriever.retrieve({
      workId: work.workId, urls: urls.map((url) => ({ url, authority: 'source_hint' as const,
        authorityId: stableContractId('followup_source', work.workId, url) })),
      allowedDomains: work.retrievalPlan.allowedDomains,
      maxSources: policy.maxSources, maxBytesPerSource: policy.maxBytesPerSource,
      maxTotalBytes: policy.maxTotalBytes, maxTextCharsPerSource: policy.maxBytesPerSource,
      maxRedirects: 3, timeoutMs: policy.maxWallTimeMs, freshnessDeadline: work.freshnessDeadline,
    })
    additions = batch.artifacts.filter((artifact) => !artifact.truncated
      && !baselineEvidence.some((original) => original.contentHash === artifact.contentHash))
      .map((artifact) => withEvidenceReuseContext(adaptRetrievedEvidenceArtifact(artifact), { signal: input.signal, workItem: work }))
    additions = store.putResearchV4Record('followup_evidence', work.workId, 'captures', additions)
  }
  for (const artifact of additions) store.appendEvidence(artifact)
  if (additions.length === 0) return saveFinal(store, work.workId, baseline)

  const rootAssignmentId = researchRootAssignmentId(work)
  // A root assignment has one investigation allowance across policy changes too.
  const allowanceId = 'research_followup_investigation.v1'
  const attemptId = stableContractId('research_followup_attempt', rootAssignmentId, allowanceId)
  const key = { rootAssignmentId, allowanceId, attemptId }
  const requestDigest = digest(canonicalJson({ rootAssignmentId, workId: work.workId,
    baseline, additions, policy, promptVersion: baseline.execution.promptVersion }))
  const budgetStore = store.researchBudgetStore()
  const claimed = await claimReservation(budgetStore, {
    ...key, requestDigest, providerRoute: `research.synthesis:${baseline.execution.configuredPrimaryProvider ?? baseline.execution.provider}/${baseline.execution.configuredPrimaryModel ?? baseline.execution.model}`,
    approvedLimits: policy, assignmentLimits: input.assignmentPolicy, nowMs: Date.parse(input.now()),
  })
  if (!claimed.ok) throw new ResearchFollowupHold(`Follow-up allowance is held: ${claimed.code}.`)
  let record = claimed.record
  const result = store.getResearchV4Record<ResearchPacketV1>('followup_result', work.workId, attemptId)
  if (result && (record.state === 'settled' || record.state === 'dispatch_intent')) {
    if (record.state !== 'settled') await settleSaved(result)
    return resolveResult(result)
  }
  if (record.state !== 'reserved_not_dispatched') {
    if (record.state === 'dispatch_intent') await recordUnknownOutcome(budgetStore, key, {
      ownedEpoch: record.ownershipEpoch, nowMs: Date.parse(input.now()),
    })
    throw new ResearchFollowupHold('Paid follow-up outcome is unknown; no automatic replacement or allowance reset is permitted.')
  }
  if (!await input.stillOwnsLease()) throw new ResearchFollowupHold('Research lease lost before follow-up dispatch.')
  const intent = await recordDispatchIntent(budgetStore, key, { ownedEpoch: record.ownershipEpoch, nowMs: Date.parse(input.now()) })
  if (!intent.ok) throw new ResearchFollowupHold(`Follow-up dispatch fence refused: ${intent.code}.`)
  record = intent.record
  let generated: ResearchPacketV1
  try {
    const synthesized = await input.synthesizer.synthesize({
      signal: input.signal,
      holdOnUnknownOutcome: true,
      workItem: { ...work, budget: {
        ...work.budget, maxProviderCalls: 1, maxRepairCalls: 0, maxToolCalls: 0,
        maxWallTimeMs: Math.min(policy.maxWallTimeMs, Math.max(1, Date.parse(work.freshnessDeadline) - Date.parse(input.now()))),
        maxInputTokens: policy.maxInputTokens, maxOutputTokens: policy.maxOutputTokens,
        ...(policy.maxIncrementalCostUsdMicros === null ? {} : { maxCostUsdMicros: policy.maxIncrementalCostUsdMicros }),
      } },
      evidence: [...baselineEvidence, ...additions] as RetrievedEvidenceArtifact[],
    })
    if (isArticleResearchPacket(synthesized)) {
      throw new ResearchFollowupHold('Legacy follow-up cannot accept an article synthesis result; prepared article work requires its own workflow.')
    }
    generated = synthesized
    // Save the response before budget settlement and before handing anything off.
    generated = store.putResearchV4Record('followup_result', work.workId, attemptId, generated)
  } catch (error) {
    await recordUnknownOutcome(budgetStore, key, { ownedEpoch: record.ownershipEpoch, nowMs: Date.parse(input.now()) })
    const telemetry = error instanceof InferenceGatewayError ? error.telemetry : undefined
    if (!store.getResearchV4Record('followup_result', work.workId, `${attemptId}:unknown_outcome`)) {
      store.putResearchV4Record('followup_result', work.workId, `${attemptId}:unknown_outcome`, {
        key, requestDigest, status: 'execution_outcome_unknown', observedAt: input.now(),
        providerCalls: telemetry?.providerCalls ?? null, inputTokens: telemetry?.inputTokens ?? null,
        outputTokens: telemetry?.outputTokens ?? null, costUsdMicros: telemetry?.costUsdMicros ?? null,
        provider: telemetry?.actualProvider ?? null, model: telemetry?.actualModel ?? null,
        failureCategory: telemetry?.failureCategory ?? 'storage_or_transport_outcome_unknown',
      })
    }
    const detail = error instanceof InferenceGatewayError ? `${error.category}: ${error.message}` : String(error)
    throw new ResearchFollowupHold(`Paid follow-up outcome unresolved: ${detail.slice(0, 400)}. Original Research is retained.`)
  }
  await settleSaved(generated)
  return resolveResult(generated)

  async function settleSaved(packet: ResearchPacketV1): Promise<void> {
    const cost = packet.budgetUsed.costUsdMicros
    const usage: D2Usage = typeof cost === 'number' && cost > 0
      ? { status: 'measured', costUsdMicros: cost, inputTokens: packet.budgetUsed.inputTokens, outputTokens: packet.budgetUsed.outputTokens, providerCalls: packet.budgetUsed.providerCalls }
      : { status: 'unknown', costUsdMicros: null, inputTokens: packet.budgetUsed.inputTokens, outputTokens: packet.budgetUsed.outputTokens, providerCalls: packet.budgetUsed.providerCalls }
    const settled = await settleReservation(budgetStore, key, {
      requestDigest, providerResultDigest: digest(canonicalJson(packet)), savedResultRef: `followup_result:${work.workId}:${attemptId}`,
      usage, settlementEpoch: record.ownershipEpoch, savedResultSavedAtMs: Date.parse(input.now()),
      verification: { kind: 'transport_response_saved' },
    })
    if (!settled.ok) throw new ResearchFollowupHold(`Saved paid result could not settle its allowance: ${settled.code}.`)
  }

  function resolveResult(packet: ResearchPacketV1): ResearchPacketV1 {
    const baselineText = new Set([...baseline.claims.map((claim) => claim.claim), ...baseline.verifiedFacts.map((fact) => fact.fact)])
    const newIds = new Set(additions!.map((artifact) => artifact.evidenceId))
    const added = [...packet.claims.map((claim) => ({ text: claim.claim, refs: claim.evidenceRefs })),
      ...packet.verifiedFacts.map((fact) => ({ text: fact.fact, refs: fact.evidenceRefs }))]
      .some((entry) => !baselineText.has(entry.text) && entry.refs.some((ref) => newIds.has(ref)))
    const selected = added ? packet : baseline
    const combined: ResearchPacketV1 = {
      ...selected,
      budgetUsed: {
        ...selected.budgetUsed, providerCalls: baseline.budgetUsed.providerCalls + packet.budgetUsed.providerCalls,
        repairCalls: baseline.budgetUsed.repairCalls + packet.budgetUsed.repairCalls,
        inputTokens: baseline.budgetUsed.inputTokens + packet.budgetUsed.inputTokens,
        outputTokens: baseline.budgetUsed.outputTokens + packet.budgetUsed.outputTokens,
        wallTimeMs: baseline.budgetUsed.wallTimeMs + packet.budgetUsed.wallTimeMs,
        costUsdMicros: typeof baseline.budgetUsed.costUsdMicros === 'number' && typeof packet.budgetUsed.costUsdMicros === 'number'
          ? baseline.budgetUsed.costUsdMicros + packet.budgetUsed.costUsdMicros : null,
      },
      followup: { rootAssignmentId, allowanceId, attemptId, addedInformation: added,
        originalPacketDigest: digest(canonicalJson(baseline)), policyVersion: policy.policyVersion,
        limitations: added ? [] : ['Bounded follow-up added no grounded contribution; original Research readiness is preserved.'] },
    }
    return saveFinal(store, work.workId, combined)
  }
}

function approvedFollowupUrls(work: ResearchWorkItem, evidence: readonly RetrievedEvidence[]): string[] {
  const value = work.retrievalPlan.followupUrls
  if (!Array.isArray(value)) return []
  const canonical = (raw: string): string | null => {
    try {
      const url = parseHttpUrl(raw)
      if (!isAllowedHostname(url.hostname, work.retrievalPlan.allowedDomains)) return null
      url.hash = ''
      return url.toString()
    } catch { return null }
  }
  const captured = new Set(evidence.flatMap((item) => [item.requestedUrl, item.finalUrl]
    .filter((url): url is string => typeof url === 'string').map(canonical).filter((url): url is string => url !== null)))
  return [...new Set(value.filter((url): url is string => typeof url === 'string').map(canonical)
    .filter((url): url is string => url !== null && !captured.has(url)))]
}
function saveFinal(store: ResearchV4StorePort, workId: string, packet: ResearchPacketV1): ResearchPacketV1 {
  return store.putResearchV4Record('followup_resolution', workId, 'final_packet', packet)
}
function digest(value: string): string { return createHash('sha256').update(value).digest('hex') }
