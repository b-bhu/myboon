import type { ResearchWorkItem, Signal } from './contracts'
import { canonicalJson } from './canonical-json'
import type { CanonicalPlatformStore, IntakeUnit } from './platform-store'
import {
  SignalIntakeCoordinator,
  type SignalIntakeResult,
  type SignalTriagePort,
} from './signal-intake'
import { isActiveAdmissionIntake, type AdmissionDispositionV1 } from './intake-admission'
import type { RulesFirstTriageInput, TriageDecisionV1 } from './triage-contracts'
import type { ResearchWorkCreationPolicy } from './triage-engine'
import { validateSignal } from './validation'
import { stableContractId } from './adapters/identity'

export type SourceIntakeMode = 'off' | 'observe' | 'active'

export interface SourceSignalIntakeResult {
  mode: SourceIntakeMode
  signalId: string
  signalInserted: boolean
  decisionInserted: boolean
  workInserted: boolean
  decision: TriageDecisionV1 | null
  /** The admitted work item; null whenever no work was admitted. */
  work: ResearchWorkItem | null
  /** True when the decision/disposition/work came from the store, not from triage. */
  recovered: boolean
  /** Set when a saved record was deliberately not turned into work. */
  held: string | null
}

export interface SourceSignalIntakePort {
  readonly mode: SourceIntakeMode
  ingest(signal: Signal): Promise<SourceSignalIntakeResult>
  /** Pure decision preview; implementations must not append Signal/work state. */
  preview?(signal: Signal): Promise<TriageDecisionV1>
  retryUntriaged?(limit: number): Promise<SourceIntakeBatchReport>
  repairAdmissions?(limit: number): Promise<AdmissionRepairReport>
}

export interface SourceIntakeFailure {
  signalId: string
  sourceType: Signal['sourceType']
  code: 'CANONICAL_SIGNAL_INTAKE_FAILED'
}

/**
 * Redacted marker for a repair pass that could not complete. The underlying
 * storage error stays out of the source batch report, which legacy collection
 * hooks log verbatim.
 */
export interface SourceIntakeRepairFailure {
  code: 'CANONICAL_ADMISSION_REPAIR_FAILED'
}

/** A decision whose admission intent cannot be proven from the record. */
export interface HeldAdmissionRecord {
  decisionId: string
  signalId: string
  sourceType: Signal['sourceType']
  reason: string
}

export interface AdmissionRepairReport {
  /** Work rows created from an already frozen, proven active-admission payload. */
  repairedWorkIds: string[]
  /** Proven active admissions whose work row already existed; left untouched. */
  alreadyPresentWorkIds: string[]
  /** Research-shaped decisions with no provable admission intent. */
  held: HeldAdmissionRecord[]
}

export interface SourceIntakeBatchReport {
  mode: SourceIntakeMode
  attempted: number
  insertedSignals: number
  duplicateSignals: number
  insertedDecisions: number
  admittedWorkItems: number
  /** Work rows re-created from a proven active disposition's frozen payload. */
  repairedWorkIds: string[]
  /** Proven active admissions whose work row already existed; left untouched. */
  alreadyPresentWorkIds: string[]
  /** Research-shaped decisions with no provable admission intent. */
  heldAdmissions: HeldAdmissionRecord[]
  /** Set when the repair pass failed; the raw storage error is not reported. */
  repairFailure: SourceIntakeRepairFailure | null
  failures: SourceIntakeFailure[]
}

export interface CanonicalSourceSignalIntakeOptions {
  mode: SourceIntakeMode
  store: CanonicalPlatformStore
  /** Evaluate and persist triage in observe mode without admitting queue work. */
  evaluate?: boolean
  triage?: SignalTriagePort
  retrievalPolicy?: ResearchWorkCreationPolicy | ((signal: Signal) => ResearchWorkCreationPolicy)
  buildTriageInput?: (signal: Signal) => RulesFirstTriageInput | Promise<RulesFirstTriageInput>
  decisionPolicy?: { priorityPolicyVersion: string; budgetPolicyVersion: string }
  mayAdmit?: () => boolean
}

/**
 * Source-facing canonical write boundary. Observe mode is append-only and
 * cannot mutate queue state. Active mode deliberately requires the complete
 * triage/admission composition rather than silently applying placeholder
 * source policy.
 */
export class CanonicalSourceSignalIntake implements SourceSignalIntakePort {
  readonly mode: SourceIntakeMode
  private readonly evaluates: boolean

  constructor(private readonly options: CanonicalSourceSignalIntakeOptions) {
    this.mode = options.mode
    this.evaluates = this.mode === 'active' || (this.mode === 'observe' && options.evaluate === true)
    if (this.evaluates) {
      if (!options.triage || !options.retrievalPolicy || !options.buildTriageInput) {
        throw new Error('Evaluated source intake requires triage, retrieval policy, and a source triage-input builder')
      }
    }
  }

  async ingest(input: Signal): Promise<SourceSignalIntakeResult> {
    let signal = validateSignal(input)
    const deliveredSignal = signal
    if (signal.sourceType !== this.options.store.sourceType) {
      throw new Error(`Source intake store ${this.options.store.sourceType} cannot process ${signal.sourceType}`)
    }
    if (this.mode === 'off') return outcome(this.mode, signal.signalId)
    const existing = this.options.store.findSignalByIdempotencyKey(signal.idempotencyKey)
    const duplicateObservation = existing !== null && equivalentSourceObservation(existing, signal)
    if (existing !== null && duplicateObservation) signal = existing
    if (this.mode === 'observe' && !this.evaluates) {
      const appended = this.persistObservation(signal, deliveredSignal, duplicateObservation)
      return { ...outcome(this.mode, signal.signalId), signalInserted: appended.inserted }
    }

    // The durable observation boundary is deliberately before capacity reads,
    // classifiers, or policy evaluation. A failure in any of those components
    // can prevent admission, but can never erase the observed Signal.
    const appended = this.persistObservation(signal, deliveredSignal, duplicateObservation)
    if (this.options.mayAdmit && !this.options.mayAdmit()) {
      return {...outcome(this.mode,signal.signalId),signalInserted:appended.inserted,held:'source_ownership_fenced'}
    }
    const triageInput = await this.options.buildTriageInput!(signal)
    const configuredPolicy = this.options.retrievalPolicy!
    const retrievalPolicy = typeof configuredPolicy === 'function'
      ? configuredPolicy(signal)
      : configuredPolicy
    const coordinator = new SignalIntakeCoordinator({
      store: this.options.store,
      triage: this.options.triage!,
      retrievalPolicy,
      mode: this.mode === 'active' ? 'active' : 'observe',
      decisionPolicy: this.options.decisionPolicy,
    })
    const result = await coordinator.process({ ...triageInput, signal })
    return fromCoordinator(result, this.mode, appended.inserted)
  }

  private persistObservation(
    canonical: Signal,
    delivered: Signal,
    deduplicated: boolean,
  ): { inserted: boolean; value: Signal } {
    const observation = {
      observationId: stableContractId(
        'signal_observation', delivered.sourceType, delivered.signalId, delivered.observedAt,
      ),
      signalId: canonical.signalId,
      sourceType: delivered.sourceType,
      observedAt: delivered.observedAt,
      deduplicated,
    }
    if (this.options.store.appendSignalObservation) {
      return this.options.store.appendSignalObservation(canonical, observation).signal
    }
    const appended = deduplicated
      ? { inserted: false, value: canonical }
      : this.options.store.appendSignal(canonical)
    this.options.store.recordSignalObservation?.(observation)
    return appended
  }

  async preview(input: Signal): Promise<TriageDecisionV1> {
    const signal = validateSignal(input)
    if (signal.sourceType !== this.options.store.sourceType) {
      throw new Error(`Source intake store ${this.options.store.sourceType} cannot preview ${signal.sourceType}`)
    }
    if (!this.evaluates) throw new Error('Source intake is not configured for triage evaluation')
    if (this.options.mayAdmit && !this.options.mayAdmit()) throw new Error('Source ownership fences intake preview')
    const triageInput = await this.options.buildTriageInput!(signal)
    return this.options.triage!.decide({ ...triageInput, signal })
  }

  /** Bounded source-local repair for append-before-triage partial failures. */
  async retryUntriaged(limit: number): Promise<SourceIntakeBatchReport> {
    if (!this.evaluates) return emptySourceIntakeReport(this.mode)
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw new Error('retryUntriaged limit must be 1-500')
    const signals = this.options.store.listSignalsMissingDecision({
      priorityPolicyVersion: this.options.decisionPolicy?.priorityPolicyVersion,
      budgetPolicyVersion: this.options.decisionPolicy?.budgetPolicyVersion,
      limit,
    })
    const report = emptySourceIntakeReport(this.mode)
    for (const signal of signals) {
      report.attempted += 1
      try {
        const result = await this.ingest(signal)
        if (result.signalInserted) report.insertedSignals += 1
        else report.duplicateSignals += 1
        if (result.decisionInserted) report.insertedDecisions += 1
        if (result.workInserted) report.admittedWorkItems += 1
      } catch {
        report.failures.push({
          signalId: signal.signalId,
          sourceType: signal.sourceType,
          code: 'CANONICAL_SIGNAL_INTAKE_FAILED',
        })
      }
    }
    // The bounded retry cycle also settles admissions that were owed a work row.
    // Only active mode repairs; observe and off never touch queue state.
    if (this.mode === 'active') {
      try {
        const repair = await this.repairAdmissions(limit)
        report.repairedWorkIds.push(...repair.repairedWorkIds)
        report.alreadyPresentWorkIds.push(...repair.alreadyPresentWorkIds)
        report.heldAdmissions.push(...repair.held)
      } catch {
        // Best-effort source hook: report a redacted code, never the raw error.
        report.repairFailure = { code: 'CANONICAL_ADMISSION_REPAIR_FAILED' }
      }
    }
    return report
  }

  /**
   * Proven-admission-only repair. A work row is re-created solely from the
   * payload already frozen in an active-admission disposition, so no triage,
   * clock, capacity, or current retrieval policy is consulted. Research-shaped
   * decisions with no disposition are reported as held, never guessed into work.
   */
  async repairAdmissions(limit: number): Promise<AdmissionRepairReport> {
    if (this.mode !== 'active') throw new Error('Admission repair requires an active intake mode')
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw new Error('repairAdmissions limit must be 1-500')
    const report: AdmissionRepairReport = { repairedWorkIds: [], alreadyPresentWorkIds: [], held: [] }
    for (const owed of this.options.store.listOwedActiveAdmissions({ limit })) {
      if (this.options.mayAdmit && !this.options.mayAdmit()) {
        report.held.push({decisionId:owed.decision.decisionId,signalId:owed.decision.signalId,sourceType:owed.decision.sourceType,reason:'Source ownership fences admission repair.'})
        continue
      }
      const result = this.options.store.appendIntakeUnit(owedIntakeUnit(owed.decision, owed.disposition))
      const admitted = result.work
      if (!admitted) continue
      // A concurrent writer may have admitted the same frozen payload first.
      if (admitted.inserted) report.repairedWorkIds.push(admitted.value.workId)
      else report.alreadyPresentWorkIds.push(admitted.value.workId)
    }
    for (const decision of this.options.store.listAmbiguousAdmissionCandidates({ limit })) {
      report.held.push({
        decisionId: decision.decisionId,
        signalId: decision.signalId,
        sourceType: decision.sourceType,
        reason: 'No admission disposition proves whether this decision was an active admission or a deliberate no-work outcome.',
      })
    }
    return report
  }
}

/**
 * Rebuild the intake unit for an owed admission from its own saved record only.
 * The decision and the frozen work payload are replayed verbatim; nothing is
 * re-derived from the current clock, capacity, or retrieval policy.
 */
function owedIntakeUnit(
  decision: TriageDecisionV1,
  disposition: AdmissionDispositionV1,
): IntakeUnit {
  if (!isActiveAdmissionIntake(disposition) || !disposition.workPayload || !disposition.workId) {
    throw new Error(`Admission ${disposition.dispositionId} is not a proven active admission with a frozen payload`)
  }
  if (disposition.workPayload.workId !== disposition.workId) {
    throw new Error(`Admission ${disposition.dispositionId} has a conflicting frozen work identity`)
  }
  return { decision, disposition, work: disposition.workPayload }
}

function equivalentSourceObservation(existing: Signal, incoming: Signal): boolean {
  const withoutPollTime = (signal: Signal): Record<string, unknown> => {
    const { observedAt: _observedAt, ...rest } = signal
    return rest
  }
  return canonicalJson(withoutPollTime(existing)) === canonicalJson(withoutPollTime(incoming))
}

/** Best-effort source hook: canonical shadow failures never fail legacy collection. */
export async function deliverCanonicalSignals(
  intake: SourceSignalIntakePort | undefined,
  signals: readonly Signal[],
): Promise<SourceIntakeBatchReport> {
  if (!intake || intake.mode === 'off') return emptySourceIntakeReport('off')
  const report = emptySourceIntakeReport(intake.mode)
  for (const unvalidated of signals) {
    report.attempted += 1
    try {
      const result = await intake.ingest(unvalidated)
      if (result.signalInserted) report.insertedSignals += 1
      else report.duplicateSignals += 1
      if (result.decisionInserted) report.insertedDecisions += 1
      if (result.workInserted) report.admittedWorkItems += 1
    } catch {
      report.failures.push({
        signalId: unvalidated.signalId,
        sourceType: unvalidated.sourceType,
        code: 'CANONICAL_SIGNAL_INTAKE_FAILED',
      })
    }
  }
  if (intake.retryUntriaged) mergeReport(report, await intake.retryUntriaged(25))
  return report
}

function mergeReport(target: SourceIntakeBatchReport, source: SourceIntakeBatchReport): void {
  target.attempted += source.attempted
  target.insertedSignals += source.insertedSignals
  target.duplicateSignals += source.duplicateSignals
  target.insertedDecisions += source.insertedDecisions
  target.admittedWorkItems += source.admittedWorkItems
  target.repairedWorkIds.push(...source.repairedWorkIds)
  target.alreadyPresentWorkIds.push(...source.alreadyPresentWorkIds)
  target.heldAdmissions.push(...source.heldAdmissions)
  target.repairFailure = source.repairFailure ?? target.repairFailure
  target.failures.push(...source.failures)
}

export function emptySourceIntakeReport(mode: SourceIntakeMode = 'off'): SourceIntakeBatchReport {
  return {
    mode,
    attempted: 0,
    insertedSignals: 0,
    duplicateSignals: 0,
    insertedDecisions: 0,
    admittedWorkItems: 0,
    repairedWorkIds: [],
    alreadyPresentWorkIds: [],
    heldAdmissions: [],
    repairFailure: null,
    failures: [],
  }
}

function outcome(mode: SourceIntakeMode, signalId: string): SourceSignalIntakeResult {
  return {
    mode,
    signalId,
    signalInserted: false,
    decisionInserted: false,
    workInserted: false,
    decision: null,
    work: null,
    recovered: false,
    held: null,
  }
}

function fromCoordinator(
  result: SignalIntakeResult,
  mode: SourceIntakeMode,
  signalInserted: boolean,
): SourceSignalIntakeResult {
  return {
    mode,
    signalId: result.signal.signalId,
    signalInserted,
    decisionInserted: result.persisted.decisionInserted,
    workInserted: result.persisted.workInserted,
    decision: result.decision,
    work: result.work,
    recovered: result.recovered,
    held: result.held,
  }
}
