import { positiveInteger } from '../pipeline-store/cli-env'

export const DEFAULT_NEWS_RESEARCH_BATCH_SIZE = 5
export const DEFAULT_NEWS_SCOUT_TIMEOUT_MS = 5 * 60_000

// Re-exported so existing importers of `positiveInteger` from this module
// keep working unchanged; the canonical definition now lives in
// pipeline-store/cli-env.ts alongside the other shared CLI-parsing helpers.
export { positiveInteger }

export function newsResearchBatchSize(value = process.env.NEWS_RUNNER_BATCH_SIZE): number {
  return positiveInteger(value, DEFAULT_NEWS_RESEARCH_BATCH_SIZE)
}
