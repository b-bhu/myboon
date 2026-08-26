import type { ResearchDepth, Signal } from './contracts'
import type { ProviderWorkloadHealth } from './triage-contracts'

export const FEED_V3_ENV = Object.freeze({
  intakeMode: 'FEED_V3_INTAKE_MODE',
  researchMode: 'FEED_V3_RESEARCH_MODE',
  entityMode: 'FEED_V3_ENTITY_MODE',
  activeSources: 'FEED_V3_ACTIVE_SOURCES',
  shadowSources: 'FEED_V3_SHADOW_SOURCES',
  intakeActiveSources: 'FEED_V3_INTAKE_ACTIVE_SOURCES',
  intakeShadowSources: 'FEED_V3_INTAKE_SHADOW_SOURCES',
  researchActiveSources: 'FEED_V3_RESEARCH_ACTIVE_SOURCES',
  researchShadowSources: 'FEED_V3_RESEARCH_SHADOW_SOURCES',
  entityActiveSources: 'FEED_V3_ENTITY_ACTIVE_SOURCES',
  entityShadowSources: 'FEED_V3_ENTITY_SHADOW_SOURCES',
  legacyResearchDisabledSources: 'FEED_V3_LEGACY_RESEARCH_DISABLED_SOURCES',
  legacyEntityDisabledSources: 'FEED_V3_LEGACY_ENTITY_DISABLED_SOURCES',
  shadowSampleBasisPoints: 'FEED_V3_SHADOW_SAMPLE_BASIS_POINTS',
  deepEnabled: 'FEED_V3_DEEP_RESEARCH_ENABLED',
  triageClassifierEnabled: 'FEED_V3_TRIAGE_CLASSIFIER_ENABLED',
  triageProviderHealth: 'FEED_V3_TRIAGE_PROVIDER_HEALTH',
  triageAllowedDepths: 'FEED_V3_TRIAGE_ALLOWED_DEPTHS',
  cutoverReceiptPath: 'FEED_V3_CUTOVER_RECEIPT_PATH',
} as const)

export type FeedV3Source = Signal['sourceType']
export type FeedV3IntakeMode = 'off' | 'observe' | 'active'
export type FeedV3WorkerMode = 'off' | 'shadow' | 'active'
export type FeedV3RuntimeStage = 'intake' | 'research' | 'entity'

export interface FeedV3RuntimeConfig {
  intakeMode: FeedV3IntakeMode
  researchMode: FeedV3WorkerMode
  entityMode: FeedV3WorkerMode
  activeSources: ReadonlySet<FeedV3Source>
  shadowSources: ReadonlySet<FeedV3Source>
  intakeActiveSources: ReadonlySet<FeedV3Source>
  intakeShadowSources: ReadonlySet<FeedV3Source>
  researchActiveSources: ReadonlySet<FeedV3Source>
  researchShadowSources: ReadonlySet<FeedV3Source>
  entityActiveSources: ReadonlySet<FeedV3Source>
  entityShadowSources: ReadonlySet<FeedV3Source>
  legacyResearchDisabledSources: ReadonlySet<FeedV3Source>
  legacyEntityDisabledSources: ReadonlySet<FeedV3Source>
  shadowSampleBasisPoints: number
  deepResearchEnabled: boolean
  triageClassifierEnabled: boolean
  triageProviderHealth: ProviderWorkloadHealth
  triageAllowedDepths: ReadonlySet<ResearchDepth>
  cutoverReceiptPath: string | null
}

const SOURCES = ['news', 'polymarket', 'market_calendar', 'x'] as const

export function loadFeedV3RuntimeConfig(
  env: Readonly<Record<string, string | undefined>> = process.env,
): FeedV3RuntimeConfig {
  const intakeMode = mode(env[FEED_V3_ENV.intakeMode], ['off', 'observe', 'active'], 'off', 'intake')
  const researchMode = mode(env[FEED_V3_ENV.researchMode], ['off', 'shadow', 'active'], 'off', 'research')
  const entityMode = mode(env[FEED_V3_ENV.entityMode], ['off', 'shadow', 'active'], 'off', 'entity')
  const legacyActiveSources = sources(env[FEED_V3_ENV.activeSources])
  const legacyShadowSources = sources(env[FEED_V3_ENV.shadowSources])
  const intakeActiveSources = stageSources(env[FEED_V3_ENV.intakeActiveSources], legacyActiveSources)
  const intakeShadowSources = stageSources(env[FEED_V3_ENV.intakeShadowSources], legacyShadowSources)
  const researchActiveSources = stageSources(env[FEED_V3_ENV.researchActiveSources], legacyActiveSources)
  const researchShadowSources = stageSources(env[FEED_V3_ENV.researchShadowSources], legacyShadowSources)
  const entityActiveSources = stageSources(env[FEED_V3_ENV.entityActiveSources], legacyActiveSources)
  const entityShadowSources = stageSources(env[FEED_V3_ENV.entityShadowSources], legacyShadowSources)
  const activeSources = unionSources(intakeActiveSources, researchActiveSources, entityActiveSources)
  const shadowSources = unionSources(intakeShadowSources, researchShadowSources, entityShadowSources)
  const legacyResearchDisabledSources = sources(env[FEED_V3_ENV.legacyResearchDisabledSources])
  const legacyEntityDisabledSources = sources(env[FEED_V3_ENV.legacyEntityDisabledSources])
  const shadowSampleBasisPoints = integer(
    env[FEED_V3_ENV.shadowSampleBasisPoints], 0, 10_000, 0, 'shadow sample basis points',
  )
  const deepResearchEnabled = booleanFlag(env[FEED_V3_ENV.deepEnabled], false, 'deep research enabled')
  const triageClassifierEnabled = booleanFlag(
    env[FEED_V3_ENV.triageClassifierEnabled], false, 'triage classifier enabled',
  )
  const triageProviderHealth = providerHealth(env[FEED_V3_ENV.triageProviderHealth])
  const triageAllowedDepths = researchDepths(env[FEED_V3_ENV.triageAllowedDepths])
  const cutoverReceiptPath = env[FEED_V3_ENV.cutoverReceiptPath]?.trim() || null

  if (intakeMode === 'active' && intakeActiveSources.size === 0) requireStageSources('intake', 'active')
  if (researchMode === 'active' && researchActiveSources.size === 0) requireStageSources('research', 'active')
  if (entityMode === 'active' && entityActiveSources.size === 0) requireStageSources('entity', 'active')
  if (intakeMode === 'observe' && intakeShadowSources.size === 0) requireStageSources('intake', 'shadow')
  if (researchMode === 'shadow' && (researchShadowSources.size === 0 || shadowSampleBasisPoints === 0)) {
    throw new FeedV3RuntimeConfigError('Shadow research requires sources and a non-zero sample basis-point value')
  }
  if (entityMode === 'shadow' && (entityShadowSources.size === 0 || shadowSampleBasisPoints === 0)) {
    throw new FeedV3RuntimeConfigError('Shadow entity requires sources and a non-zero sample basis-point value')
  }
  if (researchMode === 'active') assertDisabled(researchActiveSources, legacyResearchDisabledSources, 'research')
  if (entityMode === 'active') assertDisabled(entityActiveSources, legacyEntityDisabledSources, 'entity')
  if ((researchMode === 'active' || entityMode === 'active') && cutoverReceiptPath === null) {
    throw new FeedV3RuntimeConfigError('Active shared ownership requires FEED_V3_CUTOVER_RECEIPT_PATH')
  }
  if (deepResearchEnabled && researchMode !== 'active') {
    throw new FeedV3RuntimeConfigError('Deep research can be enabled only with active shared research ownership')
  }
  if (triageAllowedDepths.has('deep') && !deepResearchEnabled) {
    throw new FeedV3RuntimeConfigError('Deep triage admission requires FEED_V3_DEEP_RESEARCH_ENABLED=1')
  }

  return Object.freeze({
    intakeMode, researchMode, entityMode,
    activeSources: new Set(activeSources), shadowSources: new Set(shadowSources),
    intakeActiveSources: new Set(intakeActiveSources), intakeShadowSources: new Set(intakeShadowSources),
    researchActiveSources: new Set(researchActiveSources), researchShadowSources: new Set(researchShadowSources),
    entityActiveSources: new Set(entityActiveSources), entityShadowSources: new Set(entityShadowSources),
    legacyResearchDisabledSources: new Set(legacyResearchDisabledSources),
    legacyEntityDisabledSources: new Set(legacyEntityDisabledSources),
    shadowSampleBasisPoints, deepResearchEnabled, triageClassifierEnabled, triageProviderHealth,
    triageAllowedDepths: new Set(triageAllowedDepths), cutoverReceiptPath,
  })
}

function providerHealth(raw: string | undefined): ProviderWorkloadHealth {
  const value = raw?.trim() || 'unavailable'
  if (!['healthy', 'degraded', 'unavailable', 'circuit_open'].includes(value)) {
    throw new FeedV3RuntimeConfigError(`Unsupported Feed V3 triage provider health: ${value}`)
  }
  return value as ProviderWorkloadHealth
}

function researchDepths(raw: string | undefined): Set<ResearchDepth> {
  const values = raw === undefined ? ['light'] : raw.split(',').map((value) => value.trim()).filter(Boolean)
  const result = new Set<ResearchDepth>()
  for (const value of values) {
    if (value !== 'light' && value !== 'standard' && value !== 'deep') {
      throw new FeedV3RuntimeConfigError(`Unsupported Feed V3 triage depth: ${value}`)
    }
    result.add(value)
  }
  return result
}

/** Resolve global stage flags to one source; unregistered sources stay off. */
export function feedV3ModeForSource(
  config: FeedV3RuntimeConfig,
  stage: 'intake',
  source: FeedV3Source,
): FeedV3IntakeMode
export function feedV3ModeForSource(
  config: FeedV3RuntimeConfig,
  stage: 'research' | 'entity',
  source: FeedV3Source,
): FeedV3WorkerMode
export function feedV3ModeForSource(
  config: FeedV3RuntimeConfig,
  stage: FeedV3RuntimeStage,
  source: FeedV3Source,
): FeedV3IntakeMode | FeedV3WorkerMode {
  const configured = stage === 'intake'
    ? config.intakeMode
    : stage === 'research' ? config.researchMode : config.entityMode
  if (configured === 'off') return 'off'
  const active = stage === 'intake' ? config.intakeActiveSources
    : stage === 'research' ? config.researchActiveSources : config.entityActiveSources
  const shadow = stage === 'intake' ? config.intakeShadowSources
    : stage === 'research' ? config.researchShadowSources : config.entityShadowSources
  if (configured === 'active') return active.has(source) ? 'active' : 'off'
  return shadow.has(source)
    ? stage === 'intake' ? 'observe' : 'shadow'
    : 'off'
}

function stageSources(raw: string | undefined, legacy: ReadonlySet<FeedV3Source>): Set<FeedV3Source> {
  return raw === undefined ? new Set(legacy) : sources(raw)
}

function unionSources(...sets: ReadonlySet<FeedV3Source>[]): Set<FeedV3Source> {
  return new Set(sets.flatMap((set) => [...set]))
}

function requireStageSources(stage: FeedV3RuntimeStage, kind: 'active' | 'shadow'): never {
  throw new FeedV3RuntimeConfigError(
    `${stage} ${kind} mode requires FEED_V3_${stage.toUpperCase()}_${kind.toUpperCase()}_SOURCES`,
  )
}

export class FeedV3RuntimeConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'FeedV3RuntimeConfigError'
  }
}

function assertDisabled(active: ReadonlySet<FeedV3Source>, disabled: ReadonlySet<FeedV3Source>, lane: string): void {
  const missing = [...active].filter((source) => !disabled.has(source))
  if (missing.length > 0) {
    throw new FeedV3RuntimeConfigError(
      `Active ${lane} ownership requires explicit legacy-disabled sources: ${missing.join(',')}`,
    )
  }
}

function mode<T extends string>(
  raw: string | undefined,
  allowed: readonly T[],
  fallback: T,
  field: string,
): T {
  const value = raw?.trim() || fallback
  if (!allowed.includes(value as T)) throw new FeedV3RuntimeConfigError(`Unsupported Feed V3 ${field} mode: ${value}`)
  return value as T
}

function sources(raw: string | undefined): Set<FeedV3Source> {
  const result = new Set<FeedV3Source>()
  for (const value of raw?.split(',').map((item) => item.trim()).filter(Boolean) ?? []) {
    if (!(SOURCES as readonly string[]).includes(value)) throw new FeedV3RuntimeConfigError(`Unknown Feed V3 source: ${value}`)
    result.add(value as FeedV3Source)
  }
  return result
}

function integer(
  raw: string | undefined, minimum: number, maximum: number, fallback: number, field: string,
): number {
  if (raw === undefined) return fallback
  const value = Number(raw)
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new FeedV3RuntimeConfigError(`${field} must be an integer between ${minimum} and ${maximum}`)
  }
  return value
}

function booleanFlag(raw: string | undefined, fallback: boolean, field: string): boolean {
  if (raw === undefined) return fallback
  if (raw === '1') return true
  if (raw === '0') return false
  throw new FeedV3RuntimeConfigError(`${field} must be 0 or 1`)
}
