import type { Signal } from './contracts'
import type { LocalCapacitySnapshotPort } from './active-triage'
import {
  SqliteSignalPlatformStore,
  type TriageCapacityLimits,
} from './sqlite-platform-store'
import type { TriageCapacitySnapshot } from './triage-contracts'

/** Bounded, code-owned local admission limits; P0/P1 retain reserved lanes. */
export const DEFAULT_LOCAL_TRIAGE_CAPACITY: TriageCapacityLimits = Object.freeze({
  byPriority: { P0: 20, P1: 50, P2: 100, P3: 100 },
  byDepth: { light: 100, standard: 50, deep: 5 },
  reservedByPriority: { P0: 10, P1: 10 },
})

/** Explicit operator knobs for the temporary low-priority drain lane. */
export const LOCAL_TRIAGE_CAPACITY_ENV = Object.freeze({
  p3: 'FEED_V3_TRIAGE_P3_CAPACITY',
  light: 'FEED_V3_TRIAGE_LIGHT_CAPACITY',
})

const LOCAL_TRIAGE_CAPACITY_MAX = 500

/**
 * Load bounded local admission limits without changing the durable work or
 * paid-outcome accounting. P2, reserved P0/P1 lanes, standard and deep stay
 * at their code-owned defaults unless a separate policy changes them.
 */
export function loadLocalTriageCapacity(
  env: Readonly<Record<string, string | undefined>> = process.env,
): TriageCapacityLimits {
  const p3 = capacityOverride(env[LOCAL_TRIAGE_CAPACITY_ENV.p3], DEFAULT_LOCAL_TRIAGE_CAPACITY.byPriority.P3, LOCAL_TRIAGE_CAPACITY_ENV.p3)
  const light = capacityOverride(env[LOCAL_TRIAGE_CAPACITY_ENV.light], DEFAULT_LOCAL_TRIAGE_CAPACITY.byDepth.light, LOCAL_TRIAGE_CAPACITY_ENV.light)
  return Object.freeze({
    byPriority: { ...DEFAULT_LOCAL_TRIAGE_CAPACITY.byPriority, P3: p3 },
    byDepth: { ...DEFAULT_LOCAL_TRIAGE_CAPACITY.byDepth, light },
    reservedByPriority: { ...DEFAULT_LOCAL_TRIAGE_CAPACITY.reservedByPriority },
  })
}

export class SqliteLocalCapacitySnapshot implements LocalCapacitySnapshotPort {
  constructor(
    private readonly store: SqliteSignalPlatformStore,
    private readonly limits: TriageCapacityLimits = DEFAULT_LOCAL_TRIAGE_CAPACITY,
  ) {}

  snapshot(input: { sourceType: Signal['sourceType']; now: string }): TriageCapacitySnapshot {
    if (input.sourceType !== this.store.sourceType) {
      throw new Error(`Capacity store ${this.store.sourceType} cannot report ${input.sourceType}`)
    }
    if (!Number.isFinite(Date.parse(input.now))) throw new Error('Capacity snapshot now must be a timestamp')
    return this.store.readTriageCapacitySnapshot(this.limits, input.now)
  }
}

function capacityOverride(raw: string | undefined, fallback: number, field: string): number {
  if (raw === undefined) return fallback
  const value = Number(raw.trim())
  if (!/^\d+$/.test(raw.trim()) || !Number.isSafeInteger(value) || value < 1 || value > LOCAL_TRIAGE_CAPACITY_MAX) {
    throw new Error(`${field} must be an integer between 1 and ${LOCAL_TRIAGE_CAPACITY_MAX}`)
  }
  return value
}
