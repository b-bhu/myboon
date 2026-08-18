import { positiveInteger } from '../pipeline-store/cli-env'

export const DEFAULT_NEWS_RESEARCH_BATCH_SIZE = 10
export const DEFAULT_NEWS_RESEARCH_CONCURRENCY = 2
export const MAX_NEWS_RESEARCH_CONCURRENCY = 4
export const DEFAULT_NEWS_RESEARCH_BACKLOG_WARN_COUNT = 20
export const DEFAULT_NEWS_RESEARCH_BACKLOG_WARN_AGE_MS = 60 * 60_000
export const DEFAULT_NEWS_FEED_INTERVAL_MS = 10 * 60_000
export const DEFAULT_NEWS_RESEARCH_INTERVAL_MS = 5 * 60_000

// Re-exported so existing importers of `positiveInteger` from this module
// keep working unchanged; the canonical definition now lives in
// pipeline-store/cli-env.ts alongside the other shared CLI-parsing helpers.
export { positiveInteger }

export function newsResearchBatchSize(value = process.env.NEWS_RESEARCHER_BATCH_SIZE): number {
  return positiveInteger(value, DEFAULT_NEWS_RESEARCH_BATCH_SIZE)
}

export function newsResearchConcurrency(value = process.env.NEWS_RESEARCHER_CONCURRENCY): number {
  return Math.min(
    positiveInteger(value, DEFAULT_NEWS_RESEARCH_CONCURRENCY),
    MAX_NEWS_RESEARCH_CONCURRENCY,
  )
}

export function newsResearchBacklogWarnCount(value = process.env.NEWS_RESEARCH_BACKLOG_WARN_COUNT): number {
  return positiveInteger(value, DEFAULT_NEWS_RESEARCH_BACKLOG_WARN_COUNT)
}

export function newsResearchBacklogWarnAgeMs(value = process.env.NEWS_RESEARCH_BACKLOG_WARN_AGE_MS): number {
  return positiveInteger(value, DEFAULT_NEWS_RESEARCH_BACKLOG_WARN_AGE_MS)
}

export function newsResearchIntervalMs(value = process.env.NEWS_RESEARCHER_INTERVAL_MS): number {
  return positiveInteger(value, DEFAULT_NEWS_RESEARCH_INTERVAL_MS)
}
