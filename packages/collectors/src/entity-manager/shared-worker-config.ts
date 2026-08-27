import type { Signal } from '../signal-platform/contracts'

export const ENTITY_WORKER_SOURCE_TYPES = ['news', 'polymarket', 'market_calendar', 'x'] as const
export type EntityWorkerSourceType = Signal['sourceType']
export type EntitySourceOwner = 'legacy' | 'shared'

export interface EntitySourceRuntimeTopology {
  legacyActiveClaimers: number
  sharedActiveClaimers: number
}

export interface SharedEntityWorkerConfigInput {
  ownership?: Partial<Record<EntityWorkerSourceType, EntitySourceOwner>>
  shadowSources?: readonly EntityWorkerSourceType[]
  shadowSampleBasisPoints?: number
  runtimeTopology?: Partial<Record<EntityWorkerSourceType, EntitySourceRuntimeTopology>>
}

export interface SharedEntityWorkerConfig {
  ownership: Record<EntityWorkerSourceType, EntitySourceOwner>
  shadowSources: ReadonlySet<EntityWorkerSourceType>
  shadowSampleBasisPoints: number
  runtimeTopology: Record<EntityWorkerSourceType, EntitySourceRuntimeTopology>
}

export class SharedEntityWorkerConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SharedEntityWorkerConfigError'
  }
}

/** Defaults keep every source on its legacy owner with shadow reads disabled. */
export function sharedEntityWorkerConfig(input: SharedEntityWorkerConfigInput = {}): SharedEntityWorkerConfig {
  validateSourceKeys(input.ownership, 'ownership')
  validateSourceKeys(input.runtimeTopology, 'runtimeTopology')
  for (const source of input.shadowSources ?? []) {
    if (!(ENTITY_WORKER_SOURCE_TYPES as readonly string[]).includes(source)) {
      throw new SharedEntityWorkerConfigError(`Unknown shadow source: ${String(source)}`)
    }
  }
  const ownership = Object.fromEntries(ENTITY_WORKER_SOURCE_TYPES.map((source) => [
    source,
    input.ownership?.[source] ?? 'legacy',
  ])) as Record<EntityWorkerSourceType, EntitySourceOwner>
  for (const [source, owner] of Object.entries(ownership)) {
    if (owner !== 'legacy' && owner !== 'shared') {
      throw new SharedEntityWorkerConfigError(`${source} owner must be legacy or shared.`)
    }
  }
  const shadowSources = new Set(input.shadowSources ?? [])
  const basisPoints = input.shadowSampleBasisPoints ?? 0
  if (!Number.isInteger(basisPoints) || basisPoints < 0 || basisPoints > 10_000) {
    throw new SharedEntityWorkerConfigError('shadowSampleBasisPoints must be an integer between 0 and 10000.')
  }

  const runtimeTopology = Object.fromEntries(ENTITY_WORKER_SOURCE_TYPES.map((source) => {
    const topology = input.runtimeTopology?.[source] ?? { legacyActiveClaimers: 0, sharedActiveClaimers: 0 }
    for (const [field, count] of Object.entries(topology)) {
      if (!Number.isInteger(count) || count < 0) {
        throw new SharedEntityWorkerConfigError(`${source}.${field} must be a non-negative integer.`)
      }
    }
    if (topology.legacyActiveClaimers > 0 && topology.sharedActiveClaimers > 0) {
      throw new SharedEntityWorkerConfigError(`${source} has both legacy and shared active claimers.`)
    }
    return [source, { ...topology }]
  })) as Record<EntityWorkerSourceType, EntitySourceRuntimeTopology>

  return { ownership, shadowSources, shadowSampleBasisPoints: basisPoints, runtimeTopology }
}

function validateSourceKeys(value: object | undefined, field: string): void {
  for (const source of Object.keys(value ?? {})) {
    if (!(ENTITY_WORKER_SOURCE_TYPES as readonly string[]).includes(source)) {
      throw new SharedEntityWorkerConfigError(`${field} contains unknown source: ${source}`)
    }
  }
}
