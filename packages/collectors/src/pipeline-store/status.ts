/**
 * Pipeline backlog/status reporting.
 *
 * Issue #256 removed the Supabase dashboard, which was the only way to see
 * pipeline state. Without a replacement, the backpressure work in
 * markets-data-engineer.ts would leave the pipeline with LESS visibility
 * than it started with - an invisible backlog is the originating symptom
 * this whole effort responds to.
 *
 * This module builds a status report from `getBacklogDepth` plus a couple of
 * cheap targeted reads (terminal-failure counts are already inside
 * PipelineBacklogDepth; this adds nothing beyond a stable, printable shape
 * and multi-area support). It is intentionally store-only: no Supabase
 * client, no network calls, so it is safe to run at any time in any
 * environment that has the local SQLite file.
 */
import type { PipelineBacklogDepth, PipelineStore } from './store'
import type { WorkStatus } from '../signal-platform/contracts'
import type { SchedulerAggregateStatus } from '../signal-platform/store-adapter'

export interface PipelineAreaStatus {
  source: string
  area: string
  backlog: PipelineBacklogDepth
  /**
   * Convenience flags mirrored from `backlog` so a human or a monitor can
   * spot trouble without doing arithmetic: any terminal-failure count above
   * zero, or any lease sitting expired-but-unrecovered.
   */
  flags: {
    hasFailures: boolean
    hasStaleExpired: boolean
    hasUnrecoveredExpiredLeases: boolean
  }
}

export interface PipelineStatusReport {
  generatedAt: string
  areas: PipelineAreaStatus[]
}

export interface LegacyNewsOperationalStatus {
  sourceRuns: Record<string, number>
  candidates: Record<string, number>
  researchResults: Record<string, number>
}

export interface NewsOperationalStatusReport {
  authority: 'feed_v3'
  canonical: {
    schemaVersion: 'myboon.news_queue_status.v1'
    workItems: number
    actionableReady: number
    stalePending: number
    dueRetry: number
    staleRetry: number
    leased: number
    completed: number
    deadLetter: number
    expired: number
    byStatus: Partial<Record<WorkStatus, number>>
    oldestReadyAt: string | null
    oldestLeaseExpiresAt: string | null
  }
  legacy: LegacyNewsOperationalStatus & {
    authoritative: false
    warning: string
  }
}

const LEASED_WORK_STATUSES: WorkStatus[] = [
  'retrieval_leased', 'deep_leased', 'synthesis_leased', 'entity_leased',
]

/**
 * Makes Feed V3 the explicit queue authority while retaining legacy counts
 * only as migration/audit telemetry. Legacy candidate rows are intentionally
 * not mutated by Feed V3, so presenting them as backlog would double-count
 * completed and terminal work.
 */
export function buildNewsOperationalStatus(
  canonical: SchedulerAggregateStatus,
  legacy: LegacyNewsOperationalStatus,
): NewsOperationalStatusReport {
  const get = (status: WorkStatus) => canonical.byStatus[status] ?? 0
  const fallbackReady = get('research_pending') + get('deep_pending')
    + get('synthesis_pending') + get('entity_pending')
  return {
    authority: 'feed_v3',
    canonical: {
      schemaVersion: 'myboon.news_queue_status.v1',
      workItems: canonical.total,
      actionableReady: canonical.actionableReady ?? fallbackReady,
      stalePending: canonical.stalePending ?? 0,
      dueRetry: canonical.dueRetry ?? 0,
      staleRetry: canonical.staleRetry ?? 0,
      leased: LEASED_WORK_STATUSES.reduce((sum, status) => sum + get(status), 0),
      completed: get('complete'),
      deadLetter: get('dead_letter'),
      expired: get('expired'),
      byStatus: { ...canonical.byStatus },
      oldestReadyAt: canonical.oldestReadyAt,
      oldestLeaseExpiresAt: canonical.oldestLeaseExpiresAt,
    },
    legacy: {
      authoritative: false,
      warning: 'Legacy News statuses are audit-only and must not be interpreted as the active Feed V3 backlog.',
      sourceRuns: { ...legacy.sourceRuns },
      candidates: { ...legacy.candidates },
      researchResults: { ...legacy.researchResults },
    },
  }
}

function toAreaStatus(backlog: PipelineBacklogDepth): PipelineAreaStatus {
  return {
    source: backlog.source,
    area: backlog.area,
    backlog,
    flags: {
      hasFailures: backlog.candidatesFailed > 0,
      hasStaleExpired: backlog.candidatesStaleExpired > 0,
      hasUnrecoveredExpiredLeases: backlog.candidatesLeaseExpired > 0,
    },
  }
}

/**
 * Builds a status report for an explicit list of (source, area) pairs.
 * Every count comes from `getBacklogDepth`, which is COUNT-only - this
 * function does not fetch a single backlog row.
 */
export async function buildPipelineStatusReport(
  store: PipelineStore,
  areas: Array<{ source: string; area: string }>,
  now: string = new Date().toISOString()
): Promise<PipelineStatusReport> {
  const results: PipelineAreaStatus[] = []
  for (const { source, area } of areas) {
    const backlog = await store.getBacklogDepth({ source, area, now })
    results.push(toAreaStatus(backlog))
  }
  return { generatedAt: now, areas: results }
}
