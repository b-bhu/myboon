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
    return this.store.readTriageCapacitySnapshot(this.limits)
  }
}
