import type { Signal } from './contracts'
import {
  SignalPlatformControlPlane,
  type ControlPlaneAlertPolicy,
  type SignalPlatformControlPlaneStatus,
  type WorkObservabilityReadPort,
} from './control-plane'
import type { ExecutionAggregateQuery, ExecutionAggregateStatus } from './execution-ledger'
import { SqliteExecutionLedger } from './sqlite-execution-ledger'
import { SqliteSignalPlatformStore } from './sqlite-platform-store'
import type { ResearchWorkStoreAdapter } from './store-adapter'

/** Read-only composition that preserves healthy source status when a physical DB is missing or corrupt. */
export async function readSqliteControlPlaneStatus(input: {
  newsPath: string
  pipelinePath: string
  now: string
  alertPolicy?: ControlPlaneAlertPolicy | null
}): Promise<SignalPlatformControlPlaneStatus> {
  const openedStores = [
    openStatusStore(input.newsPath, 'news'),
    openStatusStore(input.pipelinePath, 'polymarket'),
    openStatusStore(input.pipelinePath, 'market_calendar'),
    openStatusStore(input.pipelinePath, 'x'),
  ]
  const ledgers = [
    openLedger(input.newsPath, ['news']),
    openLedger(input.pipelinePath, ['polymarket', 'market_calendar', 'x']),
  ]
  try {
    const executionReader = {
      readAggregateStatus(query?: ExecutionAggregateQuery): ExecutionAggregateStatus {
        const reports: ExecutionAggregateStatus[] = []
        const unavailableSources: Signal['sourceType'][] = []
        for (const entry of ledgers) {
          if (!entry.ledger) { unavailableSources.push(...entry.sources); continue }
          try { reports.push(entry.ledger.readAggregateStatus(query)) } catch { unavailableSources.push(...entry.sources) }
        }
        if (reports.length === 0) throw new Error('No execution ledger is available')
        return mergeExecutionReports(reports, unavailableSources)
      },
    }
    return await new SignalPlatformControlPlane({
      stores: openedStores.map((entry) => entry.store),
      workReaders: openedStores.map((entry) => entry.reader),
      executionReader,
      alertPolicy: input.alertPolicy,
    }).readStatus({ now: input.now })
  } finally {
    for (const entry of ledgers) entry.ledger?.close()
    for (const entry of openedStores) entry.close?.()
  }
}

function mergeExecutionReports(
  reports: ExecutionAggregateStatus[],
  unavailableSources: Signal['sourceType'][],
): ExecutionAggregateStatus {
  return {
    totalEvents: reports.reduce((sum, report) => sum + report.totalEvents, 0),
    activeEvents: reports.reduce((sum, report) => sum + report.activeEvents, 0),
    rows: reports.flatMap((report) => report.rows),
    providerPerformance: reports.flatMap((report) => report.providerPerformance),
    completionUsage: {
      completedPackets: reports.reduce((sum, report) => sum + report.completionUsage.completedPackets, 0),
      inputTokens: reports.reduce((sum, report) => sum + report.completionUsage.inputTokens, 0),
      outputTokens: reports.reduce((sum, report) => sum + report.completionUsage.outputTokens, 0),
      measuredCostPackets: reports.reduce((sum, report) => sum + report.completionUsage.measuredCostPackets, 0),
      totalCostUsdMicros: reports.reduce((sum, report) => sum + report.completionUsage.totalCostUsdMicros, 0),
    },
    unavailableSources,
  }
}

function openStatusStore(path: string, sourceType: Signal['sourceType']): {
  store: ResearchWorkStoreAdapter
  reader: WorkObservabilityReadPort
  close?: () => void
} {
  try {
    const store = new SqliteSignalPlatformStore(path, sourceType, { readOnly: true })
    return { store, reader: store, close: () => store.close() }
  } catch {
    const unavailable = async () => { throw new Error(`${sourceType} store unavailable`) }
    return {
      store: { sourceType, getSchedulerStatus: unavailable } as unknown as ResearchWorkStoreAdapter,
      reader: { sourceType, readWorkObservability: unavailable },
    }
  }
}

function openLedger(path: string, sources: Signal['sourceType'][]): {
  ledger: SqliteExecutionLedger | null
  sources: Signal['sourceType'][]
} {
  try { return { ledger: new SqliteExecutionLedger(path, { readOnly: true }), sources } }
  catch { return { ledger: null, sources } }
}
