import type { ResearchWorkItem, Signal } from './contracts'
import type { CanonicalPlatformStore, ImmutableAppendResult } from './platform-store'
import type { RulesFirstTriageInput, TriageDecisionV1 } from './triage-contracts'
import {
  createResearchWorkItemFromDecision,
  type ResearchWorkCreationPolicy,
} from './triage-engine'
import { validateTriageDecision } from './triage-validation'
import { validateSignal } from './validation'

export type SignalIntakeMode = 'shadow' | 'observe' | 'active'

export interface SignalIntakeStore extends Pick<
  CanonicalPlatformStore,
  'sourceType' | 'appendSignal' | 'appendTriageDecision' | 'admitResearchWork'
> {}

export interface SignalTriagePort {
  decide(input: RulesFirstTriageInput): Promise<TriageDecisionV1>
}

export interface SignalIntakeResult {
  mode: SignalIntakeMode
  signal: Signal
  decision: TriageDecisionV1
  work: ResearchWorkItem | null
  persisted: {
    signalInserted: boolean
    decisionInserted: boolean
    workInserted: boolean
  }
}

export interface SignalIntakeCoordinatorOptions {
  store: SignalIntakeStore
  triage: SignalTriagePort
  retrievalPolicy: ResearchWorkCreationPolicy
  mode?: SignalIntakeMode
}

/**
 * Durable normalization/triage boundary. Signals are written before triage,
 * so a classifier or admission failure cannot erase the source observation.
 * Immutable identities make a retry safe after any partial failure.
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
    const decision = validateTriageDecision(await this.options.triage.decide({ ...input, signal }))
    if (decision.signalId !== signal.signalId || decision.sourceType !== signal.sourceType) {
      throw new Error('Triage decision identity does not match the source signal')
    }
    const decisionResult = this.mode !== 'shadow'
      ? this.options.store.appendTriageDecision(decision)
      : notInserted(decision)
    const work = isResearchOutcome(decision.outcome)
      ? createResearchWorkItemFromDecision({ signal, decision, retrievalPolicy: this.options.retrievalPolicy })
      : null
    const workResult = work && this.mode === 'active'
      ? this.options.store.admitResearchWork(work)
      : work ? notInserted(work) : null

    return {
      mode: this.mode,
      signal: signalResult.value,
      decision: decisionResult.value,
      work: workResult?.value ?? null,
      persisted: {
        signalInserted: signalResult.inserted,
        decisionInserted: decisionResult.inserted,
        workInserted: workResult?.inserted ?? false,
      },
    }
  }
}

function notInserted<T>(value: T): ImmutableAppendResult<T> {
  return { inserted: false, value }
}

function isResearchOutcome(outcome: TriageDecisionV1['outcome']): outcome is 'light' | 'standard' | 'deep' {
  return outcome === 'light' || outcome === 'standard' || outcome === 'deep'
}
