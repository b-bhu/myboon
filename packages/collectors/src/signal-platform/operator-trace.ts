import type {
  ExecutionTraceEvent,
  ResearchPacketV1,
  ResearchWorkItem,
  RetrievedEvidence,
  Signal,
} from './contracts'
import type { CanonicalPlatformStore } from './platform-store'
import type { TriageDecisionV1 } from './triage-contracts'
import { redactControlPlaneValue } from './control-plane-format'

export const TRACE_INSPECTION_SCHEMA_VERSION = 'myboon.trace_inspection.v1' as const

export interface TraceInspectionCanonicalReadPort extends Pick<
  CanonicalPlatformStore,
  | 'sourceType'
  | 'getSignal'
  | 'listTriageDecisionsBySignal'
  | 'getResearchWork'
  | 'listResearchWorkBySignal'
  | 'getEvidence'
  | 'listEvidenceByWork'
  | 'getResearchPacket'
  | 'listResearchPacketsByWork'
> {}

export interface BoundedExecutionTraceReadPort {
  readonly sourceType: Signal['sourceType']
  listTraceBounded(traceId: string, limit: number): ExecutionTraceEvent[] | Promise<ExecutionTraceEvent[]>
}

export interface TraceInspectionLimits {
  decisions: number
  workItems: number
  evidencePerWork: number
  packetsPerWork: number
  events: number
}

export type TraceInspectionQuery =
  | { signalId: string; workId?: never; packetId?: never }
  | { signalId?: never; workId: string; packetId?: never }
  | { signalId?: never; workId?: never; packetId: string }

export interface TraceInspectionResult {
  schemaVersion: typeof TRACE_INSPECTION_SCHEMA_VERSION
  inspectedAt: string
  query: TraceInspectionQuery
  found: boolean
  sourceType: Signal['sourceType'] | null
  unavailableSources: Signal['sourceType'][]
  signal: Signal | null
  triageDecisions: TriageDecisionV1[]
  workItems: ResearchWorkItem[]
  evidence: RetrievedEvidence[]
  packets: ResearchPacketV1[]
  executionEvents: ExecutionTraceEvent[]
  truncated: {
    triageDecisions: boolean
    workItems: boolean
    evidence: boolean
    packets: boolean
    executionEvents: boolean
  }
}

export class CanonicalTraceInspector {
  private readonly stores: TraceInspectionCanonicalReadPort[]
  private readonly executionReaders: ReadonlyMap<Signal['sourceType'], BoundedExecutionTraceReadPort>
  private readonly limits: TraceInspectionLimits

  constructor(options: {
    stores: TraceInspectionCanonicalReadPort[]
    executionReaders?: BoundedExecutionTraceReadPort[]
    limits?: Partial<TraceInspectionLimits>
  }) {
    assertUnique(options.stores, 'trace store')
    assertUnique(options.executionReaders ?? [], 'execution trace reader')
    this.stores = [...options.stores]
    this.executionReaders = new Map((options.executionReaders ?? []).map((reader) => [reader.sourceType, reader]))
    this.limits = {
      decisions: bounded(options.limits?.decisions ?? 25, 'decisions'),
      workItems: bounded(options.limits?.workItems ?? 25, 'workItems'),
      evidencePerWork: bounded(options.limits?.evidencePerWork ?? 25, 'evidencePerWork'),
      packetsPerWork: bounded(options.limits?.packetsPerWork ?? 10, 'packetsPerWork'),
      events: bounded(options.limits?.events ?? 50, 'events'),
    }
  }

  async inspect(query: TraceInspectionQuery, input: { now: string }): Promise<TraceInspectionResult> {
    if (!Number.isFinite(Date.parse(input.now))) throw new Error('now must be a timestamp')
    validateQuery(query)
    const unavailableSources: Signal['sourceType'][] = []
    const rootMatches: Array<{
      store: TraceInspectionCanonicalReadPort
      signal: Signal | null
      work: ResearchWorkItem | null
      packet: ResearchPacketV1 | null
    }> = []
    for (const store of this.stores) {
      try {
        const match = resolveRoot(store, query)
        if (match.signal || match.work || match.packet) rootMatches.push({ store, ...match })
      } catch {
        unavailableSources.push(store.sourceType)
      }
    }
    if (rootMatches.length > 1) throw new Error('Trace identity matched more than one source store')
    const root = rootMatches[0]
    if (!root) return emptyResult(query, input.now, unavailableSources)

    const signal = root.signal
      ?? (root.work ? root.store.getSignal(root.work.signalId) : null)
      ?? (root.packet ? root.store.getSignal(root.packet.signalId) : null)
    if (!signal) throw new Error('Trace linkage is incomplete: canonical signal is missing')

    const decisionsRaw = root.store.listTriageDecisionsBySignal(signal.signalId, this.limits.decisions + 1)
    const packetWork = root.packet ? root.store.getResearchWork(root.packet.workId) : null
    if (root.packet && !packetWork) throw new Error('Trace linkage is incomplete: packet work item is missing')
    const workRaw = root.work
      ? [root.work]
      : packetWork
        ? [packetWork]
        : root.store.listResearchWorkBySignal(signal.signalId, this.limits.workItems + 1)
    const workItems = workRaw.slice(0, this.limits.workItems)
    const evidence: RetrievedEvidence[] = []
    const packets: ResearchPacketV1[] = []
    let evidenceTruncated = false
    let packetsTruncated = false
    for (const work of workItems) {
      const workEvidence = root.store.listEvidenceByWork(work.workId, this.limits.evidencePerWork + 1)
      const workPackets = root.store.listResearchPacketsByWork(work.workId, this.limits.packetsPerWork + 1)
      evidenceTruncated ||= workEvidence.length > this.limits.evidencePerWork
      packetsTruncated ||= workPackets.length > this.limits.packetsPerWork
      evidence.push(...workEvidence.slice(0, this.limits.evidencePerWork))
      packets.push(...workPackets.slice(0, this.limits.packetsPerWork))
    }
    if (root.packet && !packets.some((packet) => packet.packetId === root.packet?.packetId)) {
      packets.unshift(root.packet)
      if (packets.length > this.limits.packetsPerWork) {
        packets.pop()
        packetsTruncated = true
      }
    }

    const traceIds = [...new Set([
      ...workItems.map((work) => work.traceId),
      ...packets.map((packet) => packet.execution.traceId),
    ])]
    const executionEvents: ExecutionTraceEvent[] = []
    let eventsTruncated = false
    const executionReader = this.executionReaders.get(root.store.sourceType)
    if (executionReader) {
      for (const traceId of traceIds) {
        const remaining = this.limits.events - executionEvents.length
        if (remaining <= 0) { eventsTruncated = true; break }
        const rows = await executionReader.listTraceBounded(traceId, remaining + 1)
        eventsTruncated ||= rows.length > remaining
        executionEvents.push(...rows.slice(0, remaining))
      }
    }

    return {
      schemaVersion: TRACE_INSPECTION_SCHEMA_VERSION,
      inspectedAt: input.now,
      query: { ...query },
      found: true,
      sourceType: root.store.sourceType,
      unavailableSources,
      signal,
      triageDecisions: decisionsRaw.slice(0, this.limits.decisions),
      workItems,
      evidence,
      packets,
      executionEvents,
      truncated: {
        triageDecisions: decisionsRaw.length > this.limits.decisions,
        workItems: workRaw.length > this.limits.workItems,
        evidence: evidenceTruncated,
        packets: packetsTruncated,
        executionEvents: eventsTruncated,
      },
    }
  }
}

export function formatTraceInspectionJson(
  result: TraceInspectionResult,
  options: { pretty?: boolean } = {},
): string {
  const safe = {
    ...result,
    executionEvents: result.executionEvents.map((event) => ({
      ...event,
      failureDetail: event.failureDetail ? '[REDACTED]' : null,
    })),
  }
  return JSON.stringify(redactControlPlaneValue(safe), null, options.pretty === false ? undefined : 2)
}

function resolveRoot(store: TraceInspectionCanonicalReadPort, query: TraceInspectionQuery): {
  signal: Signal | null
  work: ResearchWorkItem | null
  packet: ResearchPacketV1 | null
} {
  if (query.signalId) return { signal: store.getSignal(query.signalId), work: null, packet: null }
  if (query.workId) return { signal: null, work: store.getResearchWork(query.workId), packet: null }
  if (query.packetId) return { signal: null, work: null, packet: store.getResearchPacket(query.packetId) }
  throw new Error('Trace inspection query has no identity')
}

function emptyResult(
  query: TraceInspectionQuery,
  now: string,
  unavailableSources: Signal['sourceType'][],
): TraceInspectionResult {
  return {
    schemaVersion: TRACE_INSPECTION_SCHEMA_VERSION,
    inspectedAt: now,
    query: { ...query },
    found: false,
    sourceType: null,
    unavailableSources,
    signal: null,
    triageDecisions: [],
    workItems: [],
    evidence: [],
    packets: [],
    executionEvents: [],
    truncated: {
      triageDecisions: false, workItems: false, evidence: false,
      packets: false, executionEvents: false,
    },
  }
}

function validateQuery(query: TraceInspectionQuery): void {
  const identities = [query.signalId, query.workId, query.packetId]
    .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
  if (identities.length !== 1) throw new Error('Trace inspection requires exactly one signalId, workId, or packetId')
}

function assertUnique(
  values: Array<{ sourceType: Signal['sourceType'] }>,
  label: string,
): void {
  const seen = new Set<string>()
  for (const value of values) {
    if (seen.has(value.sourceType)) throw new Error(`Duplicate ${label} for ${value.sourceType}`)
    seen.add(value.sourceType)
  }
}

function bounded(value: number, label: string): number {
  if (!Number.isInteger(value) || value < 1 || value > 250) {
    throw new Error(`${label} limit must be between 1 and 250`)
  }
  return value
}
