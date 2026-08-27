import type { Signal } from './contracts'
import { canonicalJson } from './canonical-json'
import type { CanonicalPlatformStore } from './platform-store'
import {
  SignalIntakeCoordinator,
  type SignalIntakeResult,
  type SignalTriagePort,
} from './signal-intake'
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
}

export interface SourceSignalIntakePort {
  readonly mode: SourceIntakeMode
  ingest(signal: Signal): Promise<SourceSignalIntakeResult>
  /** Pure decision preview; implementations must not append Signal/work state. */
  preview?(signal: Signal): Promise<TriageDecisionV1>
  retryUntriaged?(limit: number): Promise<SourceIntakeBatchReport>
}

export interface SourceIntakeFailure {
  signalId: string
  sourceType: Signal['sourceType']
  code: 'CANONICAL_SIGNAL_INTAKE_FAILED'
}

export interface SourceIntakeBatchReport {
  mode: SourceIntakeMode
  attempted: number
  insertedSignals: number
  duplicateSignals: number
  insertedDecisions: number
  admittedWorkItems: number
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
    return report
  }
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
  }
}
