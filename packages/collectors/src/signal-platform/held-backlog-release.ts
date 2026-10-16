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
  closeAll: boolean
  cutoff: string
  /** How each item's age was measured: article publish time, or when it was observed (no publish time). */
  ageBasis: { publishedAt: number, observedAt: number }
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
  /** Page size; every page is processed, so totals are not capped by it. */
  pageSize?: number
  /** Clean start (#339, Bucket): close every held item regardless of age; release none. */
  closeAll?: boolean
  providerHealth: ActiveSourceTriageOptions['providerHealth']
  allowedDepths?: ActiveSourceTriageOptions['allowedDepths']
}): Promise<HeldBacklogReport> {
  const nowMs = Date.parse(input.now)
  if (!Number.isFinite(nowMs)) throw new Error('now must be a timestamp')
  const cutoffMs = nowMs - HELD_BACKLOG_MAX_AGE_MS
  const pageSize = input.pageSize ?? 500
  const report: HeldBacklogReport = {
    sourceType: input.store.sourceType, mode: input.apply ? 'apply' : 'dry-run', closeAll: input.closeAll === true, cutoff: new Date(cutoffMs).toISOString(),
    ageBasis: { publishedAt: 0, observedAt: 0 },
    held: 0, toClose: 0, toRelease: 0, closed: 0, released: 0, failures: [],
  }
  const expired = new Set<string>()
  const intake = input.apply ? createActiveSourceTriageIntake({
    store: input.store, mode: 'active', capacity: { snapshot: () => openCapacity() },
    providerHealth: input.providerHealth, allowedDepths: input.allowedDepths, clock: () => input.now,
    budgetPolicyVersion: HELD_BACKLOG_RELEASE_BUDGET_POLICY_VERSION,
    transformDecision: (decision, signal) => expired.has(signal.signalId) ? closeDecision(decision, input.closeAll === true) : releaseDecision(decision),
  }) : null
  let after: { observedAt: string, signalId: string } | null = null
  for (;;) {
    const page = input.store.listHeldDepthDeferredSignals({
      releaseBudgetPolicyVersion: HELD_BACKLOG_RELEASE_BUDGET_POLICY_VERSION, limit: pageSize, after,
    })
    if (page.length === 0) break
    const last = page[page.length - 1]!
    after = { observedAt: last.observedAt, signalId: last.signalId }
    for (const signal of page) {
      report.held += 1
      if (signal.publishedAt) report.ageBasis.publishedAt += 1
      else report.ageBasis.observedAt += 1
      const close = input.closeAll === true || heldSignalIsExpired(signal, cutoffMs)
      if (close) { report.toClose += 1; expired.add(signal.signalId) } else report.toRelease += 1
      if (!intake) continue
      try {
        await intake.ingest(signal)
        // Count only what is verifiably saved under the release generation.
        const saved = input.store.listTriageDecisionsBySignal(signal.signalId, 50)
          .find((decision) => decision.budgetPolicyVersion === HELD_BACKLOG_RELEASE_BUDGET_POLICY_VERSION)
        const savedWork = saved !== undefined && saved.outcome !== 'archive' && saved.outcome !== 'defer'
          && input.store.listResearchWorkBySignal(signal.signalId, 10).length > 0
        if (close && saved?.outcome === 'archive' && saved.reasons.some((r) => r.code === closeReason(input.closeAll === true))) report.closed += 1
        else if (!close && savedWork) report.released += 1
        else report.failures.push({ signalId: signal.signalId, code: `RELEASE_NOT_VERIFIED_${String(saved?.outcome ?? 'missing').toUpperCase()}` })
      } catch {
        report.failures.push({ signalId: signal.signalId, code: 'HELD_BACKLOG_RELEASE_FAILED' })
      }
    }
    if (page.length < pageSize) break
  }
  return report
}

function closeReason(closeAll: boolean): 'held_backlog_closed_clean_start' | 'held_backlog_expired_closed' {
  return closeAll ? 'held_backlog_closed_clean_start' : 'held_backlog_expired_closed'
}

function closeDecision(decision: TriageDecisionV1, closeAll: boolean): TriageDecisionV1 {
  return validateTriageDecision({
    ...decision,
    decisionId: stableContractId('held_backlog_close', decision.decisionId),
    outcome: 'archive', budget: null, deepEscalationReason: null, deepEscalation: null,
    reasons: [...decision.reasons, {
      code: closeReason(closeAll),
      detail: closeAll
        ? 'Held by the retired unsupported-depth rule; closed for a clean start (#339, Bucket).'
        : 'Held by the retired unsupported-depth rule and older than 3 days; closed instead of researched (#339).',
    }],
  })
}

function releaseDecision(decision: TriageDecisionV1): TriageDecisionV1 {
  return validateTriageDecision({
    ...decision,
    reasons: [...decision.reasons, { code: 'held_backlog_released', detail: 'Released from the retired unsupported-depth hold (#339).' }],
  })
}
