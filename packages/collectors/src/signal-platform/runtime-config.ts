import type { Signal } from './contracts'

export const FEED_V3_ENV = Object.freeze({
  intakeMode: 'FEED_V3_INTAKE_MODE',
  researchMode: 'FEED_V3_RESEARCH_MODE',
  entityMode: 'FEED_V3_ENTITY_MODE',
  activeSources: 'FEED_V3_ACTIVE_SOURCES',
  shadowSources: 'FEED_V3_SHADOW_SOURCES',
  legacyResearchDisabledSources: 'FEED_V3_LEGACY_RESEARCH_DISABLED_SOURCES',
  legacyEntityDisabledSources: 'FEED_V3_LEGACY_ENTITY_DISABLED_SOURCES',
  shadowSampleBasisPoints: 'FEED_V3_SHADOW_SAMPLE_BASIS_POINTS',
  deepEnabled: 'FEED_V3_DEEP_RESEARCH_ENABLED',
} as const)

export type FeedV3Source = Signal['sourceType']
export type FeedV3IntakeMode = 'off' | 'observe' | 'active'
export type FeedV3WorkerMode = 'off' | 'shadow' | 'active'

export interface FeedV3RuntimeConfig {
  intakeMode: FeedV3IntakeMode
  researchMode: FeedV3WorkerMode
  entityMode: FeedV3WorkerMode
  activeSources: ReadonlySet<FeedV3Source>
  shadowSources: ReadonlySet<FeedV3Source>
  legacyResearchDisabledSources: ReadonlySet<FeedV3Source>
  legacyEntityDisabledSources: ReadonlySet<FeedV3Source>
  shadowSampleBasisPoints: number
  deepResearchEnabled: boolean
}

const SOURCES = ['news', 'polymarket', 'market_calendar', 'x'] as const

export function loadFeedV3RuntimeConfig(
  env: Readonly<Record<string, string | undefined>> = process.env,
): FeedV3RuntimeConfig {
  const intakeMode = mode(env[FEED_V3_ENV.intakeMode], ['off', 'observe', 'active'], 'off', 'intake')
  const researchMode = mode(env[FEED_V3_ENV.researchMode], ['off', 'shadow', 'active'], 'off', 'research')
  const entityMode = mode(env[FEED_V3_ENV.entityMode], ['off', 'shadow', 'active'], 'off', 'entity')
  const activeSources = sources(env[FEED_V3_ENV.activeSources])
  const shadowSources = sources(env[FEED_V3_ENV.shadowSources])
  const legacyResearchDisabledSources = sources(env[FEED_V3_ENV.legacyResearchDisabledSources])
  const legacyEntityDisabledSources = sources(env[FEED_V3_ENV.legacyEntityDisabledSources])
  const shadowSampleBasisPoints = integer(
    env[FEED_V3_ENV.shadowSampleBasisPoints], 0, 10_000, 0, 'shadow sample basis points',
  )
  const deepResearchEnabled = booleanFlag(env[FEED_V3_ENV.deepEnabled], false, 'deep research enabled')

  if ((intakeMode === 'active' || researchMode === 'active' || entityMode === 'active') && activeSources.size === 0) {
    throw new FeedV3RuntimeConfigError('Active Feed V3 modes require FEED_V3_ACTIVE_SOURCES')
  }
  if ((researchMode === 'shadow' || entityMode === 'shadow')
    && (shadowSources.size === 0 || shadowSampleBasisPoints === 0)) {
    throw new FeedV3RuntimeConfigError('Shadow workers require sources and a non-zero sample basis-point value')
  }
  if (researchMode === 'active') assertDisabled(activeSources, legacyResearchDisabledSources, 'research')
  if (entityMode === 'active') assertDisabled(activeSources, legacyEntityDisabledSources, 'entity')
  if (deepResearchEnabled && researchMode !== 'active') {
    throw new FeedV3RuntimeConfigError('Deep research can be enabled only with active shared research ownership')
  }

  return Object.freeze({
    intakeMode, researchMode, entityMode,
    activeSources: new Set(activeSources), shadowSources: new Set(shadowSources),
    legacyResearchDisabledSources: new Set(legacyResearchDisabledSources),
    legacyEntityDisabledSources: new Set(legacyEntityDisabledSources),
    shadowSampleBasisPoints, deepResearchEnabled,
  })
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
