import type { ResearchPacketV1 } from '../signal-platform/contracts'
import type { CanonicalPlatformStore } from '../signal-platform/platform-store'
import type {
  HeartbeatCommand,
  LeaseCommand,
  LeasedTransitionCommand,
  ReleaseLeaseCommand,
  SchedulerQuery,
  WorkLease,
} from '../signal-platform/store-adapter'
import type { EntityPacketWorkPort } from './shared-worker'

type EntityWorkStore = Pick<
  CanonicalPlatformStore,
  | 'sourceType'
  | 'peekSchedulable'
  | 'claimWithLease'
  | 'heartbeatLease'
  | 'transitionLeased'
  | 'releaseLease'
  | 'listResearchPacketsByWork'
>

/** Concrete Entity worker port over an existing canonical SQLite store. */
export class SqliteEntityPacketWorkPort implements EntityPacketWorkPort {
  readonly sourceType: EntityWorkStore['sourceType']

  constructor(private readonly store: EntityWorkStore) {
    this.sourceType = store.sourceType
  }

  peekSchedulable(query: SchedulerQuery) { return this.store.peekSchedulable(query) }
  claimWithLease(command: LeaseCommand): Promise<WorkLease | null> { return this.store.claimWithLease(command) }
  heartbeatLease(command: HeartbeatCommand): Promise<boolean> { return this.store.heartbeatLease(command) }
  transitionLeased(command: LeasedTransitionCommand): Promise<boolean> { return this.store.transitionLeased(command) }
  releaseLease(command: ReleaseLeaseCommand): Promise<boolean> { return this.store.releaseLease(command) }

  async readResearchPacket(workId: string): Promise<ResearchPacketV1 | null> {
    const packets = this.store.listResearchPacketsByWork(workId, 2)
    if (packets.length > 1) {
      throw new Error(`Canonical store returned multiple Research Packets for work ${workId}`)
    }
    return packets[0] ?? null
  }
}
