import type { ResearchDepth, Signal } from './contracts'
import { stableContractId } from './adapters/identity'
import { CanonicalSourceSignalIntake } from './source-intake'
import type { CanonicalPlatformStore } from './platform-store'
import type {
  CheapToollessTriageClassifier,
  MaterialityTag,
  ProviderWorkloadHealth,
  RulesFirstTriageInput,
  TriageCapacitySnapshot,
} from './triage-contracts'
import {
  createPriorityPolicyV1,
  RulesFirstTriageEngine,
  type ResearchWorkCreationPolicy,
} from './triage-engine'
import { validateTriageDecision } from './triage-validation'

export const ACTIVE_TRIAGE_POLICY_VERSION = 'feed-v3.rules-first.v1' as const
export const ACTIVE_BUDGET_POLICY_VERSION = 'feed-v3.research-budget.v1' as const
export const ACTIVE_RETRIEVAL_POLICY_VERSION = 'feed-v3.retrieval.v1' as const

export interface LocalCapacitySnapshotPort {
  snapshot(input: { sourceType: Signal['sourceType']; now: string }):
    TriageCapacitySnapshot | Promise<TriageCapacitySnapshot>
}

export interface DeterministicSourceFacts extends Omit<
  RulesFirstTriageInput,
  'signal' | 'capacity' | 'providerHealth' | 'now'
> {}

export type SourceFactsBuilder = (signal: Signal) => DeterministicSourceFacts

export interface ActiveSourceTriageOptions {
  store: CanonicalPlatformStore
  capacity: LocalCapacitySnapshotPort
  providerHealth: ProviderWorkloadHealth
  classifierEnabled?: boolean
  classifier?: CheapToollessTriageClassifier | null
  clock?: () => string
  sourceFacts?: SourceFactsBuilder
  /** Observe persists Signal+decision but never admits work; active is the live path. */
  mode?: 'observe' | 'active'
  /** Defaults to light only; standard/deep require explicit capability enablement. */
  allowedDepths?: readonly ResearchDepth[]
}

/**
 * Production-safe source composition. It has no provider construction and no
 * network behavior: a classifier is usable only when both explicitly enabled
 * and injected by the caller. Runners therefore remain rules-only by default.
 */
export function createActiveSourceTriageIntake(options: ActiveSourceTriageOptions): CanonicalSourceSignalIntake {
  const classifierEnabled = options.classifierEnabled === true
  if (classifierEnabled && !options.classifier) {
    throw new Error('Tool-less triage classifier was enabled but no classifier port was registered')
  }
  const rules = new RulesFirstTriageEngine({
    policy: createPriorityPolicyV1({
      policyVersion: ACTIVE_TRIAGE_POLICY_VERSION,
      budgetPolicyVersion: ACTIVE_BUDGET_POLICY_VERSION,
    }),
    classifier: classifierEnabled ? options.classifier : null,
  })
  const allowedDepths = validateAllowedDepths(options.allowedDepths ?? ['light'])
  const triage = {
    decide: async (input: RulesFirstTriageInput) => {
      const selected = await rules.decide(input)
      if (selected.outcome !== 'light' && selected.outcome !== 'standard' && selected.outcome !== 'deep') return selected
      if (allowedDepths.has(selected.outcome)) return selected
      return validateTriageDecision({
        ...selected,
        decisionId: stableContractId(
          'triage_capability', selected.decisionId, [...allowedDepths].sort().join(','),
        ),
        outcome: 'defer',
        budget: null,
        deepEscalationReason: null,
        reasons: [...selected.reasons, {
          code: 'unsupported_research_depth_defer',
          detail: `${selected.outcome} research is not enabled for this source intake capability policy.`,
        }],
      })
    },
  }
  const sourceFacts = options.sourceFacts ?? buildSourceTriageFacts
  const mode = options.mode ?? 'active'
  return new CanonicalSourceSignalIntake({
    mode,
    evaluate: mode === 'observe',
    store: options.store,
    triage,
    retrievalPolicy: retrievalPolicyForSignal,
    decisionPolicy: {
      priorityPolicyVersion: ACTIVE_TRIAGE_POLICY_VERSION,
      budgetPolicyVersion: ACTIVE_BUDGET_POLICY_VERSION,
    },
    buildTriageInput: async (signal) => {
      const now = options.clock?.() ?? new Date().toISOString()
      return {
        signal,
        ...sourceFacts(signal),
        capacity: await options.capacity.snapshot({ sourceType: signal.sourceType, now }),
        providerHealth: options.providerHealth,
        now,
      }
    },
  })
}

function validateAllowedDepths(input: readonly ResearchDepth[]): ReadonlySet<ResearchDepth> {
  const allowed = new Set<ResearchDepth>()
  for (const depth of input) {
    if (depth !== 'light' && depth !== 'standard' && depth !== 'deep') {
      throw new Error(`Unsupported active triage depth: ${String(depth)}`)
    }
    allowed.add(depth)
  }
  return allowed
}

export function buildSourceTriageFacts(signal: Signal): DeterministicSourceFacts {
  if (signal.sourceType === 'news') return buildNewsTriageFacts(signal)
  if (signal.sourceType === 'polymarket') return buildPolymarketTriageFacts(signal)
  throw new Error(`No active triage facts builder is registered for ${signal.sourceType}`)
}

export function buildNewsTriageFacts(signal: Extract<Signal, { sourceType: 'news' }>): DeterministicSourceFacts {
  const text = `${signal.title} ${signal.visibleSummary ?? ''}`.toLowerCase()
  const tags: MaterialityTag[] = []
  if (/\b(hack|exploit|breach|security incident)\b/.test(text)) tags.push('security')
  if (/\b(regulator|regulatory|sec\b|cftc\b|court ruling)\b/.test(text)) tags.push('regulatory')
  if (/\b(earnings|quarterly results|revenue|guidance)\b/.test(text)) tags.push('earnings')
  if (/\b(rate decision|inflation|gdp|central bank|federal reserve)\b/.test(text)) tags.push('macro')
  if (tags.length === 0) tags.push(signal.visibleSummary ? 'background' : 'low_value')
  const materialChange = signal.content.materialChange === true
  const officialSource = isOfficialProvider(signal.provenance.provider)
  if (officialSource) tags.push('official_release')
  return {
    dedupeOutcome: materialChange ? 'material_change' : 'new_observation',
    sourceAuthorityScore: officialSource ? 0.9 : 0.62,
    officialSource,
    entityCanonOverlap: signal.sourceHints.entities.length > 0,
    novelty: materialChange ? 'material' : signal.sourceHints.entities.length > 0 ? 'low' : 'none',
    materialityTags: unique(tags),
    eventDeadline: signal.sourceHints.deadline,
    ambiguity: {
      isAmbiguous: tags.length === 1 && tags[0] === 'background' && text.length < 120,
      reasons: tags.length === 1 && tags[0] === 'background' && text.length < 120
        ? ['short_unclassified_news_observation'] : [],
    },
    deepEscalation: null,
  }
}

export function buildPolymarketTriageFacts(
  signal: Extract<Signal, { sourceType: 'polymarket' }>,
): DeterministicSourceFacts {
  const score = finiteNumber(signal.content.score)
  const candidateType = String(signal.content.candidateType ?? '').toLowerCase()
  const tags: MaterialityTag[] = score >= 0.7 || /spike|whale|material|volume|odds/.test(candidateType)
    ? ['market_material'] : ['background']
  return {
    dedupeOutcome: 'new_observation',
    sourceAuthorityScore: 0.86,
    officialSource: true,
    entityCanonOverlap: signal.sourceHints.entities.length > 0,
    novelty: tags.includes('market_material') ? 'material' : 'low',
    materialityTags: tags,
    eventDeadline: signal.sourceHints.deadline,
    ambiguity: { isAmbiguous: false, reasons: [] },
    deepEscalation: null,
  }
}

export function retrievalPolicyForSignal(signal: Signal): ResearchWorkCreationPolicy {
  let allowedDomains: string[] = []
  if (signal.canonicalUrl) {
    try { allowedDomains = [new URL(signal.canonicalUrl).hostname.toLowerCase()] } catch { allowedDomains = [] }
  }
  return {
    policyVersion: ACTIVE_RETRIEVAL_POLICY_VERSION,
    allowedDomains,
    maxExternalSourcesByDepth: { light: 0, standard: 3, deep: 5 },
  }
}

function isOfficialProvider(provider: string): boolean {
  return /(^|[_-])(official|government|regulator)([_-]|$)/i.test(provider)
}

function finiteNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)]
}
