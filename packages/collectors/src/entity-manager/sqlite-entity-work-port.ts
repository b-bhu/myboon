import type { ResearchPacket } from '../signal-platform/contracts'
import type { CanonicalPlatformStore } from '../signal-platform/platform-store'
import type {
  HeartbeatCommand,
  LeaseCommand,
  LeasedTransitionCommand,
  ReleaseLeaseCommand,
  SchedulerQuery,
  WorkLease,
} from '../signal-platform/store-adapter'
import type { EntityHandoffSource, EntityPacketWorkPort } from './shared-worker'

type EntityWorkStore = Pick<
  CanonicalPlatformStore,
  | 'sourceType'
  | 'peekSchedulable'
  | 'claimWithLease'
  | 'heartbeatLease'
  | 'transitionLeased'
  | 'releaseLease'
  | 'listResearchPacketsByWork'
  | 'getResearchReadinessByWork'
  | 'getSignal'
  | 'getResearchWork'
  | 'listEvidenceByWork'
>

/** Concrete Entity worker port over an existing canonical SQLite store. */
export class SqliteEntityPacketWorkPort implements EntityPacketWorkPort {
  readonly sourceType: EntityWorkStore['sourceType']

  constructor(private readonly store: EntityWorkStore, private readonly options: { claimsEnabled?: () => boolean } = {}) {
    this.sourceType = store.sourceType
  }

  peekSchedulable(query: SchedulerQuery) { return this.claimsEnabled() ? this.store.peekSchedulable(query) : Promise.resolve([]) }
  claimWithLease(command: LeaseCommand): Promise<WorkLease | null> { return this.claimsEnabled() ? this.store.claimWithLease(command) : Promise.resolve(null) }
  heartbeatLease(command: HeartbeatCommand): Promise<boolean> { return this.store.heartbeatLease(command) }
  transitionLeased(command: LeasedTransitionCommand): Promise<boolean> { return this.store.transitionLeased(command) }
  releaseLease(command: ReleaseLeaseCommand): Promise<boolean> { return this.store.releaseLease(command) }

  private claimsEnabled(): boolean {
    try { return this.options.claimsEnabled?.() ?? true } catch { return false }
  }

  async readResearchPacket(workId: string): Promise<ResearchPacket | null> {
    const packets = this.store.listResearchPacketsByWork(workId, 2)
    if (packets.length > 1) {
      throw new Error(`Canonical store returned multiple Research Packets for work ${workId}`)
    }
    return packets[0] ?? null
  }

  /**
   * The saved Research decision together with the records it describes, read
   * from the same source-local store so the decision stays verifiable against
   * the exact work, signal, packet, and evidence it was assessed against.
   */
  async readHandoffContext(workId: string): Promise<EntityHandoffSource> {
    const work = this.store.getResearchWork(workId)
    return {
      work,
      signal: work ? this.store.getSignal(work.signalId) : null,
      persistedEvidence: this.store.listEvidenceByWork(workId, 1000),
      readiness: this.store.getResearchReadinessByWork(workId),
    }
  }
}
