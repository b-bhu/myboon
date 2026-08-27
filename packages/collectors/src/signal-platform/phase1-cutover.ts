import {
  PHASE1_SCOPE_SOURCES,
  type FeedV3RuntimeConfig,
  type FeedV3Source,
} from './runtime-config'

export const PHASE1_CUTOVER_SCHEMA_VERSION = 'myboon.feed_v3_phase1_cutover.v1' as const

export type Phase1CutoverStage = 'research' | 'entity'

/**
 * Sources admitted under the Phase 1 cutover policy. Any other active source
 * (market_calendar, x) is out of scope and fails the guard closed.
 */
export const PHASE1_CUTOVER_SOURCES: readonly FeedV3Source[] = PHASE1_SCOPE_SOURCES

export interface Phase1CutoverSummary {
  schemaVersion: typeof PHASE1_CUTOVER_SCHEMA_VERSION
  policy: 'phase1'
  stage: Phase1CutoverStage
  activeSources: ReadonlyArray<FeedV3Source>
  triageAllowedDepths: ReadonlyArray<'light'>
  deepResearchEnabled: false
  triageClassifierEnabled: false
  triageProviderHealth: 'healthy'
}

export class Phase1CutoverPolicyError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'Phase1CutoverPolicyError'
  }
}

/**
 * Fail-closed guard for the Phase 1 cutover policy. It is a pure predicate over
 * an already-parsed runtime config: it never reads env, files, SQLite, or
 * network, and it never mutates the input sets. On success it returns a typed,
 * bounded summary that carries no secrets (no receipt path, no env values).
 *
 * The guard is intentionally NOT wired into any runner in this batch; callers
 * opt in explicitly.
 */
export function assertPhase1CutoverPolicy(
  config: FeedV3RuntimeConfig,
  stage: Phase1CutoverStage,
): Phase1CutoverSummary {
  if (stage !== 'research' && stage !== 'entity') {
    throw new Phase1CutoverPolicyError(`Unsupported Phase 1 cutover stage: ${String(stage)}`)
  }
  if (config.cutoverPolicy !== 'phase1') {
    throw new Phase1CutoverPolicyError('Phase 1 cutover requires the phase1 runtime policy')
  }

  const activeSources = stage === 'research' ? config.researchActiveSources : config.entityActiveSources
  const legacyDisabled = stage === 'research'
    ? config.legacyResearchDisabledSources
    : config.legacyEntityDisabledSources

  if (activeSources.size === 0) {
    throw new Phase1CutoverPolicyError(`Phase 1 cutover requires at least one active ${stage} source`)
  }

  const ordered = [...activeSources].sort()
  for (const source of ordered) {
    if (!(PHASE1_CUTOVER_SOURCES as readonly string[]).includes(source)) {
      throw new Phase1CutoverPolicyError(
        `Phase 1 cutover does not admit active ${stage} source: ${source}`,
      )
    }
  }

  const missingLegacy = ordered.filter((source) => !legacyDisabled.has(source))
  if (missingLegacy.length > 0) {
    throw new Phase1CutoverPolicyError(
      `Phase 1 cutover requires explicit legacy-disabled ownership for ${stage}: ${missingLegacy.join(',')}`,
    )
  }

  if (config.triageAllowedDepths.size !== 1 || !config.triageAllowedDepths.has('light')) {
    throw new Phase1CutoverPolicyError('Phase 1 cutover requires triage allowed depths to be exactly light')
  }

  if (config.deepResearchEnabled) {
    throw new Phase1CutoverPolicyError('Phase 1 cutover requires deep research to be disabled')
  }

  if (config.triageClassifierEnabled) {
    throw new Phase1CutoverPolicyError('Phase 1 cutover requires the triage classifier to be disabled')
  }

  if (config.triageProviderHealth !== 'healthy') {
    throw new Phase1CutoverPolicyError('Phase 1 cutover requires healthy triage provider health')
  }

  return {
    schemaVersion: PHASE1_CUTOVER_SCHEMA_VERSION,
    policy: 'phase1',
    stage,
    activeSources: ordered,
    triageAllowedDepths: ['light'],
    deepResearchEnabled: false,
    triageClassifierEnabled: false,
    triageProviderHealth: 'healthy',
  }
}
