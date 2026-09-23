import type {
  ClassificationDefinition,
  ClassificationLifecycleMode,
  ClassificationRegistry,
} from './classification-types'

const LIFECYCLE_RANK: Record<ClassificationLifecycleMode, number> = {
  disabled: 0,
  shadow: 1,
  canary: 2,
  active: 3,
}

export class StaticClassificationRegistry implements ClassificationRegistry {
  private readonly definitions = new Map<string, ClassificationDefinition>()

  constructor(definitions: readonly ClassificationDefinition[]) {
    const capacityByTarget = new Map<string, string>()
    for (const definition of definitions) {
      validateDefinition(definition)
      const key = registryKey(definition.workload, definition.decisionVersion)
      if (this.definitions.has(key)) throw new Error(`Duplicate classification definition ${key}`)
      for (const target of [definition.jevTarget, definition.hermesTarget]) {
        const targetId = `${target.provider.length}:${target.provider}|${target.model.length}:${target.model}`
        // Provider-global controls must agree across workloads sharing a
        // target. The workload ceiling is intentionally allowed to differ.
        const { workloadMaxCalls: _workloadMaxCalls, ...providerCapacity } = definition.capacity
        const capacity = JSON.stringify(providerCapacity)
        const existing = capacityByTarget.get(targetId)
        if (existing !== undefined && existing !== capacity) {
          throw new Error(`Classification capacity policy must be consistent for target ${target.provider}/${target.model}`)
        }
        capacityByTarget.set(targetId, capacity)
      }
      this.definitions.set(key, Object.freeze({ ...definition }))
    }
  }

  resolve(workload: string, decisionVersion: string): ClassificationDefinition {
    const definition = this.definitions.get(registryKey(workload, decisionVersion))
    if (!definition) throw new Error(`Unknown classification definition ${workload}@${decisionVersion}`)
    return definition
  }
}

export function tightenLifecycleMode(
  maximum: ClassificationLifecycleMode,
  configured: ClassificationLifecycleMode | undefined,
  fallback: ClassificationLifecycleMode,
): ClassificationLifecycleMode {
  const requested = configured ?? fallback
  if (LIFECYCLE_RANK[requested] > LIFECYCLE_RANK[maximum]) {
    throw new Error(`Classification lifecycle ${requested} exceeds source-controlled maximum ${maximum}`)
  }
  return requested
}

export function classificationLifecycleFromEnv(
  value: string | undefined,
): ClassificationLifecycleMode | undefined {
  if (value === undefined || value.trim() === '') return undefined
  const normalized = value.trim().toLowerCase()
  if (normalized === 'disabled' || normalized === 'shadow'
    || normalized === 'canary' || normalized === 'active') return normalized
  throw new Error(`Unsupported classification lifecycle mode ${value}`)
}

function registryKey(workload: string, version: string): string {
  return `${workload.length}:${workload}|${version.length}:${version}`
}

function validateDefinition(definition: ClassificationDefinition): void {
  for (const [field, value] of [
    ['workload', definition.workload], ['decisionVersion', definition.decisionVersion],
    ['jev provider', definition.jevTarget.provider], ['Jev model', definition.jevTarget.model],
    ['Hermes provider', definition.hermesTarget.provider], ['Hermes model', definition.hermesTarget.model],
  ]) {
    if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/.test(value)) {
      throw new Error(`Invalid classification ${field}`)
    }
  }
  if (LIFECYCLE_RANK[definition.defaultLifecycleMode] > LIFECYCLE_RANK[definition.maximumLifecycleMode]) {
    throw new Error(`Default lifecycle exceeds maximum for ${definition.workload}`)
  }
  if ([definition.shadowPercent, definition.canaryPercent].some((value) => (
    !Number.isFinite(value) || value < 0 || value > 100
  ))) {
    throw new Error(`Invalid sampling percentage for ${definition.workload}`)
  }
  for (const value of Object.values(definition.budget)) {
    if (value !== undefined && (!Number.isInteger(value) || value <= 0)) {
      throw new Error(`Invalid classification budget for ${definition.workload}`)
    }
  }
  for (const value of Object.values(definition.capacity)) {
    if (!Number.isInteger(value) || value <= 0) {
      throw new Error(`Invalid classification capacity for ${definition.workload}`)
    }
  }
  if (definition.capacity.windowMs > 86_400_000
    || definition.capacity.circuitCooldownMs > 86_400_000
    || definition.capacity.leaseMs > 60 * 60_000) {
    throw new Error(`Classification capacity duration is too large for ${definition.workload}`)
  }
  if (definition.capacity.workloadMaxCalls > definition.capacity.providerMaxCalls) {
    throw new Error(`Classification workload rate limit exceeds provider limit for ${definition.workload}`)
  }
}
