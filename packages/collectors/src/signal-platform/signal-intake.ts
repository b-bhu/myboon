import type { ResearchWorkItem, Signal } from './contracts'
import type { CanonicalPlatformStore, ImmutableAppendResult, IntakeUnit } from './platform-store'
import type { RulesFirstTriageInput, TriageDecisionV1 } from './triage-contracts'
import {
  createResearchWorkItemFromDecision,
  type ResearchWorkCreationPolicy,
} from './triage-engine'
import {
  createActiveIntakeDisposition,
  createNoAdmissionDisposition,
  isActiveAdmissionIntake,
  type AdmissionDispositionV1,
  type IntakeMode,
} from './intake-admission'
import { validateTriageDecision } from './triage-validation'
import { validateSignal } from './validation'

export type SignalIntakeMode = IntakeMode

export interface SignalIntakeStore extends Pick<
  CanonicalPlatformStore,
  'sourceType' | 'appendSignal' | 'appendIntakeUnit' | 'findIntakeUnit'
> {}

export interface SignalTriagePort {
  decide(input: RulesFirstTriageInput): Promise<TriageDecisionV1>
}

export interface SignalIntakeResult {
  mode: SignalIntakeMode
  signal: Signal
  decision: TriageDecisionV1
  work: ResearchWorkItem | null
  /** Explicit admission fact; null only in shadow mode, which writes nothing. */
  disposition: AdmissionDispositionV1 | null
  /** True when the decision/disposition/work came from the store, not from triage. */
  recovered: boolean
  /** Set when a saved unit could not be promoted into work and was left alone. */
  held: string | null
  persisted: {
    signalInserted: boolean
    decisionInserted: boolean
    dispositionInserted: boolean
    workInserted: boolean
  }
}

export interface SignalIntakeCoordinatorOptions {
  store: SignalIntakeStore
  triage: SignalTriagePort
  retrievalPolicy: ResearchWorkCreationPolicy
  mode?: SignalIntakeMode
  /** Narrows re-entry lookup to one decision policy generation. */
  decisionPolicy?: { priorityPolicyVersion: string; budgetPolicyVersion: string }
}

/**
 * Durable normalization/triage boundary. Signals are written before triage,
 * so a classifier or admission failure cannot erase the source observation.
 *
 * Active intake persists the decision, the admission disposition with its mode
 * provenance, and the frozen canonical work payload as one atomic unit. Re-entry
 * loads that saved unit instead of rerunning triage or re-deriving the payload
 * from the current clock, capacity, or retrieval policy.
 */
export class SignalIntakeCoordinator {
  private readonly mode: SignalIntakeMode

  constructor(private readonly options: SignalIntakeCoordinatorOptions) {
    this.mode = options.mode ?? 'shadow'
    if (this.mode !== 'shadow' && this.mode !== 'observe' && this.mode !== 'active') {
      throw new Error(`Unsupported intake mode: ${String(this.mode)}`)
    }
  }

  async process(input: RulesFirstTriageInput): Promise<SignalIntakeResult> {
    const signal = validateSignal(input.signal)
    if (signal.sourceType !== this.options.store.sourceType) {
      throw new Error(`Intake store ${this.options.store.sourceType} cannot process ${signal.sourceType}`)
    }

    const signalResult = this.mode !== 'shadow'
      ? this.options.store.appendSignal(signal)
      : notInserted(signal)
    const saved = this.mode !== 'shadow' ? this.loadSavedUnit(signal) : null
    if (saved) return this.resume(signalResult, saved)
    if (this.mode === 'shadow') return this.evaluateOnly(signal, input)

    const decision = validateTriageDecision(await this.options.triage.decide({ ...input, signal }))
    assertDecisionIdentity(signal, decision)
    const work = isResearchOutcome(decision.outcome)
      ? createResearchWorkItemFromDecision({ signal, decision, retrievalPolicy: this.options.retrievalPolicy })
      : null
    const disposition = work && this.mode === 'active'
      ? createActiveIntakeDisposition({
        signal, decision, work, retrievalPolicy: this.options.retrievalPolicy, recordedAt: decision.decidedAt,
      })
      : createNoAdmissionDisposition({
        signal,
        decision,
        mode: this.mode,
        // Observe mode withholds admission for every outcome; only an active-mode
        // decision with no research outcome is a deliberate active-mode no-work.
        authorization: this.mode === 'observe' ? 'observe_evaluation' : 'no_work_outcome',
        reason: this.mode === 'observe'
          ? 'Observe mode recorded the decision and deliberately withheld admission.'
          : 'The triage outcome admits no research work.',
        recordedAt: decision.decidedAt,
      })
    // Only an active admission carries work; the derived item is reported, not persisted.
    return this.commit(signalResult, { decision, disposition, work: disposition.requiresWork ? work : null }, work)
  }

  /** Shadow mode computes a decision for preview only and writes nothing. */
  private async evaluateOnly(
    signal: Signal,
    input: RulesFirstTriageInput,
  ): Promise<SignalIntakeResult> {
    const decision = validateTriageDecision(await this.options.triage.decide({ ...input, signal }))
    assertDecisionIdentity(signal, decision)
    const work = isResearchOutcome(decision.outcome)
      ? createResearchWorkItemFromDecision({ signal, decision, retrievalPolicy: this.options.retrievalPolicy })
      : null
    return {
      mode: this.mode,
      signal,
      decision,
      work,
      disposition: null,
      recovered: false,
      held: null,
      persisted: { signalInserted: false, decisionInserted: false, dispositionInserted: false, workInserted: false },
    }
  }

  /**
   * Load an already accepted unit for this signal. Only a decision saved under
   * the same policy generation can be resumed; anything else is left for triage.
   */
  private loadSavedUnit(signal: Signal): ReturnType<SignalIntakeStore['findIntakeUnit']> | null {
    return this.options.store.findIntakeUnit({
      signalId: signal.signalId,
      priorityPolicyVersion: this.options.decisionPolicy?.priorityPolicyVersion,
      budgetPolicyVersion: this.options.decisionPolicy?.budgetPolicyVersion,
    })
  }

  /**
   * Re-entry. A saved active admission is returned as-is; a saved active
   * disposition whose work row is still owed is repaired from its own frozen
   * payload with no new triage call. An observe-only or unattributed decision is
   * never promoted into work here.
   */
  private resume(
    signalResult: ImmutableAppendResult<Signal>,
    saved: Exclude<ReturnType<SignalIntakeStore['findIntakeUnit']>, null>,
  ): SignalIntakeResult {
    const { decision, disposition, work } = saved
    if (this.mode === 'observe') {
      return {
        mode: this.mode,
        signal: signalResult.value,
        decision,
        work: null,
        disposition,
        recovered: true,
        held: null,
        persisted: {
          signalInserted: signalResult.inserted,
          decisionInserted: false,
          dispositionInserted: false,
          workInserted: false,
        },
      }
    }
    if (!disposition) {
      return this.heldResult(signalResult, decision, null,
        'A saved decision has no admission disposition; its originating mode and intent are unproven.')
    }
    if (!disposition.requiresWork) {
      return {
        mode: this.mode,
        signal: signalResult.value,
        decision,
        work: null,
        disposition,
        recovered: true,
        held: null,
        persisted: {
          signalInserted: signalResult.inserted,
          decisionInserted: false,
          dispositionInserted: false,
          workInserted: false,
        },
      }
    }
    if (disposition.mode !== 'active' || !isActiveAdmissionIntake(disposition)) {
      return this.heldResult(signalResult, decision, disposition,
        'The saved admission disposition is not an active admission and cannot be resumed as work.')
    }
    if (work) {
      return {
        mode: this.mode,
        signal: signalResult.value,
        decision,
        work,
        disposition,
        recovered: true,
        held: null,
        persisted: {
          signalInserted: signalResult.inserted,
          decisionInserted: false,
          dispositionInserted: false,
          workInserted: false,
        },
      }
    }
    const owed = validateAdmissionWork(disposition)
    return this.commit(signalResult, { decision, disposition, work: owed })
  }

  private commit(
    signalResult: ImmutableAppendResult<Signal>,
    unit: IntakeUnit,
    derivedWork: ResearchWorkItem | null = unit.work,
  ): SignalIntakeResult {
    const result = this.options.store.appendIntakeUnit(unit)
    return {
      mode: this.mode,
      signal: signalResult.value,
      decision: result.decision.value,
      // Observe mode reports the work it deliberately did not admit.
      work: result.work?.value ?? derivedWork,
      disposition: result.disposition.value,
      recovered: false,
      held: null,
      persisted: {
        signalInserted: signalResult.inserted,
        decisionInserted: result.decision.inserted,
        dispositionInserted: result.disposition.inserted,
        workInserted: result.work?.inserted ?? false,
      },
    }
  }

  private heldResult(
    signalResult: ImmutableAppendResult<Signal>,
    decision: TriageDecisionV1,
    disposition: AdmissionDispositionV1 | null,
    held: string,
  ): SignalIntakeResult {
    return {
      mode: this.mode,
      signal: signalResult.value,
      decision,
      work: null,
      disposition,
      recovered: true,
      held,
      persisted: {
        signalInserted: signalResult.inserted,
        decisionInserted: false,
        dispositionInserted: false,
        workInserted: false,
      },
    }
  }
}

function validateAdmissionWork(disposition: AdmissionDispositionV1): ResearchWorkItem {
  if (!disposition.workPayload || !disposition.workId) {
    throw new Error(`Admission ${disposition.dispositionId} requires work but froze no canonical payload`)
  }
  return disposition.workPayload
}

function assertDecisionIdentity(signal: Signal, decision: TriageDecisionV1): void {
  if (decision.signalId !== signal.signalId || decision.sourceType !== signal.sourceType) {
    throw new Error('Triage decision identity does not match the source signal')
  }
}

function notInserted<T>(value: T): ImmutableAppendResult<T> {
  return { inserted: false, value }
}

function isResearchOutcome(outcome: TriageDecisionV1['outcome']): outcome is 'light' | 'standard' | 'deep' {
  return outcome === 'light' || outcome === 'standard' || outcome === 'deep'
}
