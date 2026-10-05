import { createHash } from 'node:crypto'
import { loadDotenvChain } from '../pipeline-store/cli-env'
import { canonicalJson } from '../signal-platform/canonical-json'
import { stableContractId } from '../signal-platform/adapters/identity'
import type { ResearchPacket } from '../signal-platform/contracts'
import type { ArticleEntityProposalResult } from './structured-synthesizer'
import {
  acquireLeaseFence, releaseNoDispatch, settleReservation, type D2Usage,
} from './assignment-budget'
import { researchRootAssignmentId } from './bounded-followup'
import { openResearchOperatorStore, researchOperatorArguments, requirePausedResearchSource } from './research-operator-cli'

export async function runReconcileResearchReservation(args: readonly string[] = process.argv.slice(2)): Promise<unknown> {
  const options = researchOperatorArguments(args, ['source', 'database', 'work', 'root', 'allowance', 'attempt', 'action', 'admission', 'operator'])
  for (const key of ['source', 'database', 'work', 'root', 'allowance', 'attempt', 'action', 'admission', 'operator']) {
    if (!options[key]?.trim()) throw new Error(`--${key} is required`)
  }
  if (!['inspect', 'release-before-dispatch', 'settle-saved-response'].includes(options.action)) {
    throw new Error('--action must be inspect, release-before-dispatch, or settle-saved-response; current transports have no authoritative remote outcome lookup')
  }
  if (options.action !== 'inspect') requirePausedResearchSource({ source: options.source, databasePath: options.database })
  const store = openResearchOperatorStore({ source: options.source, databasePath: options.database, readOnly: options.action === 'inspect' })
  try {
    const work = store.getResearchWork(options.work)
    if (!work || researchRootAssignmentId(work) !== options.root) throw new Error('Named work does not own the specified root assignment')
    const key = { rootAssignmentId: options.root, allowanceId: options.allowance, attemptId: options.attempt }
    const budget = store.researchBudgetStore()
    const record = await budget.get(key)
    if (!record) throw new Error('Named source/root/allowance/attempt reservation is unavailable')
    if (options.action === 'inspect') return { record, disposition: 'retained_hold_no_mutation' }
    const admissionId = stableContractId('research_reconciliation', options.admission, options.operator,
      work.workId, options.root, options.allowance, options.attempt, options.action)
    const existing = store.getResearchV4Record('reservation_reconciliation', work.workId, admissionId)
    if (existing) return existing
    if (!store.getResearchV4Record('reservation_reconciliation', work.workId, `${admissionId}:intent`)) store.putResearchV4Record('reservation_reconciliation', work.workId, `${admissionId}:intent`, {
      admissionId, authority: options.admission, operator: options.operator, key, action: options.action,
      ownershipEpoch: record.ownershipEpoch, admittedAt: new Date().toISOString(),
    })
    let result: unknown
    if (options.action === 'release-before-dispatch') {
      if (record.state !== 'reserved_not_dispatched') throw new Error('Only a never-dispatched reservation can be released; unknown paid outcomes remain held')
      const fenced = await acquireLeaseFence(budget, key, { newOwnershipEpoch: record.ownershipEpoch + 1, nowMs: Date.now() })
      if (!fenced.ok) throw new Error(`Could not acquire exclusive reconciliation epoch: ${fenced.code}`)
      result = await releaseNoDispatch(budget, key, { ownedEpoch: fenced.record.ownershipEpoch,
        fact: { kind: 'no_dispatch', evidence: `durable reserved_not_dispatched row fenced by operator admission ${admissionId}` }, nowMs: Date.now() })
    } else {
      const primary = options.allowance === 'research_primary_synthesis.v1'
      const followup = options.allowance === 'research_followup_investigation.v1'
      const proposal = options.allowance === 'research_article_entity_proposal.v1'
      if (!primary && !followup && !proposal) throw new Error('This allowance has no supported saved Research response reconciliation; retain its hold')
      const packet = proposal ? null : store.getResearchV4Record<ResearchPacket>(primary ? 'baseline' : 'followup_result', work.workId,
        primary ? 'packet' : options.attempt)
      const savedProposal = proposal ? store.getResearchV4Record<ArticleEntityProposalResult>('article_entity_proposal', work.workId, 'result') : null
      const response = savedProposal ?? packet
      if (!response || (!proposal && (!packet || packet.workId !== work.workId || packet.signalId !== work.signalId))) {
        throw new Error('No matching code-owned saved response exists; no provider outcome is inferred and the reservation remains held')
      }
      const providerResultDigest = createHash('sha256').update(canonicalJson(response)).digest('hex')
      const savedResultRef = proposal ? `article_entity_proposal:${work.workId}:result`
        : primary ? `baseline:${work.workId}:packet` : `followup_result:${work.workId}:${options.attempt}`
      const cost = response.budgetUsed.costUsdMicros
      const usage: D2Usage = typeof cost === 'number' && cost > 0
        ? { status: 'measured', costUsdMicros: cost, inputTokens: response.budgetUsed.inputTokens,
          outputTokens: response.budgetUsed.outputTokens, providerCalls: response.budgetUsed.providerCalls }
        : { status: 'unknown', costUsdMicros: null, inputTokens: response.budgetUsed.inputTokens,
          outputTokens: response.budgetUsed.outputTokens, providerCalls: response.budgetUsed.providerCalls }
      result = await settleReservation(budget, key, {
        requestDigest: record.requestDigest, providerResultDigest, savedResultRef, usage,
        savedResultSavedAtMs: Date.now(), verification: { kind: 'durable_matching_response', savedResultRef, providerResultDigest },
      })
    }
    return store.putResearchV4Record('reservation_reconciliation', work.workId, admissionId, {
      admissionId, operator: options.operator, authority: options.admission, action: options.action,
      key, result, disposition: 'no_work_replay_or_promotion', reconciledAt: new Date().toISOString(),
    })
  } finally { store.close() }
}

if (require.main === module) {
  loadDotenvChain()
  void runReconcileResearchReservation().then((result) => console.log(JSON.stringify(result, null, 2)))
    .catch((error) => { console.error(error instanceof Error ? error.message : 'Research reconciliation failed'); process.exitCode = 1 })
}
