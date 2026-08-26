import type { Signal } from './contracts'
import {
  CanonicalTraceInspector,
  type BoundedExecutionTraceReadPort,
  type TraceInspectionCanonicalReadPort,
  type TraceInspectionQuery,
  type TraceInspectionResult,
} from './operator-trace'
import { SqliteBoundedExecutionTraceReader } from './operator-trace-sqlite'
import { SqliteSignalPlatformStore } from './sqlite-platform-store'

/** Four-source read-only trace composition with physical-store failure isolation. */
export async function inspectSqliteTrace(input: {
  newsPath: string
  pipelinePath: string
  query: TraceInspectionQuery
  now: string
}): Promise<TraceInspectionResult> {
  const routes = [
    { path: input.newsPath, sourceType: 'news' },
    { path: input.pipelinePath, sourceType: 'polymarket' },
    { path: input.pipelinePath, sourceType: 'market_calendar' },
    { path: input.pipelinePath, sourceType: 'x' },
  ] as const
  const stores = routes.map((route) => openTraceStore(route.path, route.sourceType))
  const readers = routes.map((route) => openTraceReader(route.path, route.sourceType))
  try {
    return await new CanonicalTraceInspector({
      stores: stores.map((entry) => entry.value),
      executionReaders: readers.flatMap((entry) => entry.value ? [entry.value] : []),
    }).inspect(input.query, { now: input.now })
  } finally {
    const closed = new Set<object>()
    for (const entry of [...readers, ...stores]) {
      if (!entry.resource || closed.has(entry.resource)) continue
      closed.add(entry.resource)
      entry.close?.()
    }
  }
}

function openTraceStore(path: string, sourceType: Signal['sourceType']): {
  value: TraceInspectionCanonicalReadPort
  resource?: object
  close?: () => void
} {
  try {
    const store = new SqliteSignalPlatformStore(path, sourceType, { readOnly: true })
    return { value: store, resource: store, close: () => store.close() }
  } catch {
    const unavailable = () => { throw new Error(`${sourceType} trace store unavailable`) }
    return {
      value: {
        sourceType, getSignal: unavailable, listTriageDecisionsBySignal: unavailable,
        getResearchWork: unavailable, listResearchWorkBySignal: unavailable,
        getEvidence: unavailable, listEvidenceByWork: unavailable,
        getResearchPacket: unavailable, listResearchPacketsByWork: unavailable,
      },
    }
  }
}

function openTraceReader(path: string, sourceType: Signal['sourceType']): {
  value: BoundedExecutionTraceReadPort | null
  resource?: object
  close?: () => void
} {
  try {
    const reader = new SqliteBoundedExecutionTraceReader(path, sourceType)
    return { value: reader, resource: reader, close: () => reader.close() }
  } catch { return { value: null } }
}
