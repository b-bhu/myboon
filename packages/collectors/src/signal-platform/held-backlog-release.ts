import { stableContractId } from './adapters/identity'
import { ACTIVE_BUDGET_POLICY_VERSION, createActiveSourceTriageIntake, type ActiveSourceTriageOptions } from './active-triage'
import type { Signal } from './contracts'
import type { SqliteSignalPlatformStore } from './sqlite-platform-store'
import type { TriageCapacitySnapshot, TriageDecisionV1 } from './triage-contracts'
import { validateTriageDecision } from './triage-validation'

/** Separate budget generation: live intake never retries or collides with it, and the policy version is unchanged. */
export const HELD_BACKLOG_RELEASE_BUDGET_POLICY_VERSION = `${ACTIVE_BUDGET_POLICY_VERSION}+release-339` as const
export const HELD_BACKLOG_MAX_AGE_MS = 3 * 24 * 60 * 60_000

export interface HeldBacklogReport {
  sourceType: Signal['sourceType']
  mode: 'dry-run' | 'apply'
  cutoff: string
  held: number
  toClose: number
  toRelease: number
  closed: number
  released: number
  failures: Array<{ signalId: string, code: string }>
}

/** Age is measured from the article's publish time, falling back to when it was observed. */
export function heldSignalIsExpired(signal: Signal, cutoffMs: number): boolean {
  const at = Date.parse(signal.publishedAt ?? signal.observedAt)
  return Number.isFinite(at) ? at < cutoffMs : true
}

function openCapacity(): TriageCapacitySnapshot {
  const bucket = { available: Number.MAX_SAFE_INTEGER, reservedAvailable: 0, utilization: 0 }
  return {
    byPriority: { P0: { ...bucket }, P1: { ...bucket }, P2: { ...bucket }, P3: { ...bucket } },
    byDepth: { light: { ...bucket }, standard: { ...bucket }, deep: { ...bucket } },
  }
}

/**
 * #339 one-shot. Dry-run (default) only reads. Apply closes held items older
 * than 3 days (archive, `held_backlog_expired_closed`) and re-triages the rest
 * under the release generation. Each signal gets at most one release-generation
 * decision, so reruns skip anything already handled.
 */
export async function releaseHeldBacklog(input: {
  store: SqliteSignalPlatformStore
  apply: boolean
  now: string
  limit?: number
  providerHealth: ActiveSourceTriageOptions['providerHealth']
  allowedDepths?: ActiveSourceTriageOptions['allowedDepths']
}): Promise<HeldBacklogReport> {
  const nowMs = Date.parse(input.now)
  if (!Number.isFinite(nowMs)) throw new Error('now must be a timestamp')
  const cutoffMs = nowMs - HELD_BACKLOG_MAX_AGE_MS
  const held = input.store.listHeldDepthDeferredSignals({
    releaseBudgetPolicyVersion: HELD_BACKLOG_RELEASE_BUDGET_POLICY_VERSION, limit: input.limit ?? 1000,
  })
  const expired = new Set(held.filter((signal) => heldSignalIsExpired(signal, cutoffMs)).map((signal) => signal.signalId))
  const report: HeldBacklogReport = {
    sourceType: input.store.sourceType, mode: input.apply ? 'apply' : 'dry-run', cutoff: new Date(cutoffMs).toISOString(),
    held: held.length, toClose: expired.size, toRelease: held.length - expired.size, closed: 0, released: 0, failures: [],
  }
  if (!input.apply) return report
  const intake = createActiveSourceTriageIntake({
    store: input.store, mode: 'active', capacity: { snapshot: () => openCapacity() },
    providerHealth: input.providerHealth, allowedDepths: input.allowedDepths, clock: () => input.now,
    budgetPolicyVersion: HELD_BACKLOG_RELEASE_BUDGET_POLICY_VERSION,
    transformDecision: (decision, signal) => expired.has(signal.signalId) ? closeDecision(decision) : releaseDecision(decision),
  })
  for (const signal of held) {
    try {
      const result = await intake.ingest(signal)
      if (expired.has(signal.signalId)) report.closed += 1
      else if (result.workInserted) report.released += 1
      else report.failures.push({ signalId: signal.signalId, code: `RELEASE_NOT_ADMITTED_${String(result.decision?.outcome ?? 'none').toUpperCase()}` })
    } catch {
      report.failures.push({ signalId: signal.signalId, code: 'HELD_BACKLOG_RELEASE_FAILED' })
    }
  }
  return report
}

function closeDecision(decision: TriageDecisionV1): TriageDecisionV1 {
  return validateTriageDecision({
    ...decision,
    decisionId: stableContractId('held_backlog_close', decision.decisionId),
    outcome: 'archive', budget: null, deepEscalationReason: null, deepEscalation: null,
    reasons: [...decision.reasons, {
      code: 'held_backlog_expired_closed',
      detail: 'Held by the retired unsupported-depth rule and older than 3 days; closed instead of researched (#339).',
    }],
  })
}

function releaseDecision(decision: TriageDecisionV1): TriageDecisionV1 {
  return validateTriageDecision({
    ...decision,
    reasons: [...decision.reasons, { code: 'held_backlog_released', detail: 'Released from the retired unsupported-depth hold (#339).' }],
  })
}
