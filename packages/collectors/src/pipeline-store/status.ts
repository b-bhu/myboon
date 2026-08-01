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
